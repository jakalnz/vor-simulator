import * as THREE from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { CanalType, EarSide } from '../physics/canal';
import { Quat } from '../physics/types';
import { FIRING_BASELINE_HZ } from '../physics/params';
import {
  toThreeQuaternion,
  makeAmbientAndKeyLight,
  createRenderer,
  resizeRendererToDisplaySize,
  HEAD_FRAME_TO_THREE,
} from './sceneUtils';
import { resolveAssetUrl } from './assetPaths';
import { ductPositionAtFraction } from '../physics/canalith';
import earAnatomyData from './earAnatomy.json';

/**
 * Real per-canal duct/ampulla mesh paths, from the IEMap_data_v_1_0 dataset (right ear,
 * HeadFrame meters), extracted by scripts/build-ear-assets/build.mjs. Only the mesh paths
 * are needed here now -- the old debris-position machinery (centerline stations, cupula
 * base/apex, common-crus/short-arm waypoints) was for driving a physics-arc-position
 * marker along the duct, which no longer exists in the bilateral VOR engine (see
 * physics/vorEngine.ts -- driven by head angular velocity projected onto each canal's
 * plane normal, not by a moving debris clot).
 */
interface EarAnatomyCanal {
  ductMesh: string;
  ampullaMesh: string;
  connectorMesh: string;
  ampullaBulgeMesh: string;
  canalUtricleWallMesh?: string;
}
interface EarAnatomyData {
  side: 'left' | 'right';
  canals: Record<string, EarAnatomyCanal>;
  utricleMesh: string;
  commonCrusMesh: string;
  sacculeMesh: string;
}
const EAR_ANATOMY = earAnatomyData as unknown as EarAnatomyData;

// Per-canal tint used ONLY while loading (a neutral placeholder distinguishing the 3
// canal shapes before the first setFiringRates call lands) -- once firing rates are
// flowing, the rest color is a uniform neutral grey (see COLOR_REST) so excitation (red)
// and inhibition (blue) read unambiguously. An earlier version tinted each canal's
// resting color by type (posterior pink, anterior blue, horizontal green) to also serve
// as an anatomical legend -- rejected: anterior's resting blue was visually
// indistinguishable from "inhibited" blue, and posterior's resting pink was too close to
// "excited" red, defeating the whole point of the color coding. Canal identity is instead
// read from the ring's real anatomical shape/position (see the legend's ring outlines).
const CANAL_TINT: Record<CanalType, number> = { posterior: 0xdfeaf2, anterior: 0xdfeaf2, horizontal: 0xdfeaf2 };

const DUCT_OPACITY = 0.55;
const AMPULLA_OPACITY = 0.75;

const COLOR_REST = new THREE.Color(0x9aa3ab);
const COLOR_INHIBITED = new THREE.Color(0x1a5fb4);
const COLOR_EXCITED = new THREE.Color(0xe01b24);
/**
 * Firing-rate delta (Hz, from baseline) at which the excite/inhibit color reaches FULL
 * saturation. Deliberately much smaller than the physiological ceiling/floor's full range
 * (FIRING_CEILING_HZ - FIRING_BASELINE_HZ = 310Hz, FIRING_BASELINE_HZ = 90Hz) -- lerping
 * over that full range meant an ordinary moderate head turn (tens of Hz of delta) barely
 * nudged the color, reading as "no visible change" against the base tint. This value is a
 * visualization choice (how sensitive the color should look), not a physiological one.
 */
const COLOR_SATURATION_HZ = 60;

/** Otoconia clot color -- gold, matching clinical illustration convention (old app's
 * PARTICLE_OFFSETS cluster, see physics research notes), deliberately distinct from both
 * the excite/inhibit red/blue and the glassy context-mesh tints. */
const CLOT_COLOR = 0xc9a227;
/** Small jittered offsets (meters) for a 7-sphere granular cluster, rather than one smooth
 * sphere -- reads visually as loose debris, not a single object. */
const CLOT_PARTICLE_OFFSETS: [number, number, number][] = [
  [0, 0, 0],
  [0.00018, 0.00006, 0],
  [-0.00015, 0.00012, 0.00008],
  [0.00008, -0.00016, -0.00006],
  [-0.00012, -0.00008, 0.00014],
  [0.00014, 0.00014, 0.00012],
  [-0.00018, 0, -0.00012],
];
const CLOT_PARTICLE_RADIUS = 0.00012;

/**
 * One ear's real-anatomy labyrinth (all 3 canal ducts + ampullae, common crus, utricle,
 * saccule), loaded from the IEMap dataset. Each canal's duct+ampulla mesh pair gets its
 * own material so setFiringRates can independently color-code excitation/inhibition per
 * canal, per Ewald's-laws-driven firing rate from the physics engine.
 *
 * This is a substantially simplified rewrite of the old BPPV-debris-era CanalScene: no
 * otoconia clot, no arc-length-position markers, no basic/detailed style variants, no
 * gravity arrow/mode, no orientation gizmo -- just the real anatomy mesh, tinted and
 * rotated with head orientation, colored by firing rate.
 */
export class CanalScene {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(45, 1, 0.0005, 2);
  private readonly renderer: THREE.WebGLRenderer;
  /** Rotates dynamically with head orientation each frame (see setOrientation). */
  private readonly headGroup = new THREE.Group();
  /** Child of headGroup: a STATIC conversion from the raw HeadFrame-axis mesh vertices
   * (see build.mjs) into Three's display axes, plus the left-ear mirror -- kept separate
   * from headGroup's own dynamic head-orientation rotation so the two don't compose into
   * a single (wrong) combined rotation. */
  private readonly labyrinthGroup = new THREE.Group();
  private readonly ductMaterials: Record<CanalType, THREE.MeshPhysicalMaterial> = {} as Record<
    CanalType,
    THREE.MeshPhysicalMaterial
  >;
  private readonly ampullaMaterials: Record<CanalType, THREE.MeshPhysicalMaterial> = {} as Record<
    CanalType,
    THREE.MeshPhysicalMaterial
  >;
  private boundingSphere: { center: THREE.Vector3; radius: number } | null = null;
  /** Otoconia clot cluster (BPPV canalithiasis debris marker), hidden until setDebris is
   * called with a non-null selection -- see physics/canalith.ts's arc-length model. */
  private readonly clotGroup = new THREE.Group();
  /** Canvas drawing-buffer size (px) the camera was last fit to -- see render()'s resize
   * check. Starts at 0 so the very first render after the mesh loads always fits. */
  private lastFitWidth = 0;
  private lastFitHeight = 0;

  constructor(canvas: HTMLCanvasElement, private readonly side: EarSide) {
    this.renderer = createRenderer(canvas);
    this.scene.add(...makeAmbientAndKeyLight());

    // Real-anatomy assembly is authored in raw HeadFrame axes (see build.mjs) -- rotate
    // into Three's display space with the same shared conversion every other scene uses,
    // plus a mirror across the sagittal (HeadFrame Y, i.e. Three -Z) axis for the left ear
    // since there is only a right-ear dataset. This is a fixed, one-time transform, so it
    // lives on labyrinthGroup, a child of headGroup (which carries the dynamic per-frame
    // head-orientation rotation instead -- see setOrientation).
    this.labyrinthGroup.quaternion.copy(HEAD_FRAME_TO_THREE);
    this.labyrinthGroup.scale.y = side === 'left' ? -1 : 1;
    this.headGroup.add(this.labyrinthGroup);
    this.scene.add(this.headGroup);

    this.camera.position.set(0.02, 0.012, side === 'left' ? -0.024 : 0.024);
    this.camera.lookAt(0, 0, 0);

    const clotMaterial = new THREE.MeshStandardMaterial({ color: CLOT_COLOR, emissive: CLOT_COLOR, emissiveIntensity: 0.3, roughness: 0.6 });
    const clotGeometry = new THREE.SphereGeometry(CLOT_PARTICLE_RADIUS, 8, 6);
    for (const [ox, oy, oz] of CLOT_PARTICLE_OFFSETS) {
      const mesh = new THREE.Mesh(clotGeometry, clotMaterial);
      mesh.position.set(ox, oy, oz);
      this.clotGroup.add(mesh);
    }
    this.clotGroup.visible = false;
    this.labyrinthGroup.add(this.clotGroup);

    this.loadRealAnatomy();
  }

  private async loadRealAnatomy(): Promise<void> {
    const loader = new OBJLoader();
    const glassMaterial = (color: number, opacity: number) =>
      new THREE.MeshPhysicalMaterial({
        color,
        transparent: true,
        opacity,
        roughness: 0.05,
        metalness: 0,
        clearcoat: 0.6,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
    // Separate, LESS glossy/more opaque material factory for the per-canal
    // excite/inhibit-colored meshes specifically -- a high clearcoat (near-mirror
    // specular) throws a bright white highlight across the surface that visually competes
    // with the emissive excite/inhibit color underneath (reported live: colors still hard
    // to see even after driving .emissive). The other, purely decorative context meshes
    // (utricle/connector/common crus/saccule below) don't carry a live signal, so they
    // keep the glassier look.
    const canalColorMaterial = (color: number, opacity: number) =>
      new THREE.MeshPhysicalMaterial({
        color,
        emissive: color,
        transparent: true,
        opacity,
        roughness: 0.35,
        metalness: 0,
        clearcoat: 0.1,
        depthWrite: false,
        side: THREE.DoubleSide,
      });

    for (const canal of Object.keys(EAR_ANATOMY.canals) as CanalType[]) {
      this.ductMaterials[canal] = canalColorMaterial(CANAL_TINT[canal] ?? 0xdfeaf2, DUCT_OPACITY);
      this.ampullaMaterials[canal] = canalColorMaterial(CANAL_TINT[canal] ?? 0xdfeaf2, AMPULLA_OPACITY);
    }
    const CONNECTOR_GLASS = glassMaterial(0xb87fa0, 0.18);
    const COMMON_CRUS_GLASS = glassMaterial(0xb08fe0, 0.28);
    const UTRICLE_GLASS = glassMaterial(0xd8c9a8, 0.16);
    const SACCULE_GLASS = glassMaterial(0x7fd6c9, 0.2);

    const loadInto = async (url: string, material: THREE.Material) => {
      try {
        const resolved = resolveAssetUrl(url, import.meta.env.BASE_URL, window.location.origin);
        const obj = await loader.loadAsync(resolved);
        obj.traverse((child) => {
          if (child instanceof THREE.Mesh) child.material = material;
        });
        this.labyrinthGroup.add(obj);
      } catch (err) {
        console.warn(`Real anatomy mesh at ${url} failed to load.`, err);
      }
    };

    for (const [canal, anatomy] of Object.entries(EAR_ANATOMY.canals) as [CanalType, EarAnatomyCanal][]) {
      await loadInto(anatomy.ductMesh, this.ductMaterials[canal]);
      await loadInto(anatomy.ampullaMesh, this.ampullaMaterials[canal]);
      await loadInto(anatomy.ampullaBulgeMesh, this.ductMaterials[canal]);
      await loadInto(anatomy.connectorMesh, CONNECTOR_GLASS);
      if (anatomy.canalUtricleWallMesh) await loadInto(anatomy.canalUtricleWallMesh, COMMON_CRUS_GLASS);
    }
    await loadInto(EAR_ANATOMY.commonCrusMesh, COMMON_CRUS_GLASS);
    await loadInto(EAR_ANATOMY.utricleMesh, UTRICLE_GLASS);
    await loadInto(EAR_ANATOMY.sacculeMesh, SACCULE_GLASS);

    this.boundingSphere = this.computeBoundingSphereInfo();
    this.fitCamera();
  }

  private computeBoundingSphereInfo(): { center: THREE.Vector3; radius: number } {
    // Measured with headGroup's dynamic rotation reset to identity -- an axis-aligned
    // Box3 computed while rotated would give a rotation-dependent (generally larger,
    // "diagonal") extent, not the object's true fixed shape.
    const savedQuat = this.headGroup.quaternion.clone();
    this.headGroup.quaternion.identity();
    this.headGroup.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(this.labyrinthGroup);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    this.headGroup.quaternion.copy(savedQuat);
    this.headGroup.updateWorldMatrix(true, true);
    return { center: sphere.center, radius: sphere.radius };
  }

  /**
   * Fits the camera distance to the loaded geometry's actual bounding sphere for the
   * CURRENT canvas aspect ratio. Not a one-time computation -- see render()'s resize
   * check, which re-calls this whenever the canvas's drawing-buffer size changes (mobile
   * layout settling after initial load, a fullscreen toggle, an orientation change, the
   * canal-panel view toggle re-showing this canvas, etc.). Without that, the camera
   * distance stayed fixed at whatever aspect ratio happened to be current the one time
   * this fired after the mesh finished loading -- reported live: the ear models rendered
   * too small specifically in mobile/fullscreen layouts, unlike eyeScene.ts's eyeballs
   * (which stay correctly sized at any canvas size because THAT camera uses a fixed
   * distance with no bounding-sphere fit at all, so it has no stale-fit state to go wrong).
   */
  private fitCamera(): void {
    if (!this.boundingSphere) return;
    const margin = 1.15;
    const vFov = THREE.MathUtils.degToRad(this.camera.fov);
    const aspect = this.camera.aspect > 0 ? this.camera.aspect : 1;
    const radius = this.boundingSphere.radius * margin;
    const distanceForVertical = radius / Math.tan(vFov / 2);
    const distanceForHorizontal = radius / (Math.tan(vFov / 2) * aspect);
    // Math.min ("cover" style -- fit tightly to whichever axis is MORE constraining, same
    // idea as CSS object-fit: cover), not Math.max ("contain" -- guarantees the whole
    // bounding sphere fits within frame, but on a narrow/tall aspect like a phone's
    // portrait canal panel, that pulls the camera back far enough to satisfy the WIDE
    // axis too, leaving the model looking small with large empty margins top/bottom --
    // reported live). Cover-style allows the model to slightly overflow the frame on the
    // less-constraining axis instead, matching how eyeScene.ts's fixed-distance camera
    // already reads as consistently large regardless of aspect ratio.
    const distance = Math.min(distanceForVertical, distanceForHorizontal);
    const zSign = this.side === 'left' ? -1 : 1;
    const target = this.boundingSphere.center;
    this.camera.position.set(target.x, target.y + distance * 0.25, target.z + distance * zSign);
    this.camera.lookAt(target);
  }

  /** Rotates the whole labyrinth to match the current head orientation. */
  setOrientation(qHead: Quat): void {
    this.headGroup.quaternion.copy(toThreeQuaternion(qHead));
  }

  /**
   * Colors each canal's duct+ampulla mesh by its current firing rate (Hz): baseline
   * (~FIRING_BASELINE_HZ) reads as neutral grey, rising above baseline lerps toward red
   * (excited), dropping below lerps toward blue (inhibited) -- saturating at
   * +-COLOR_SATURATION_HZ from baseline, not at the physiological floor/ceiling (see that
   * constant's doc comment for why). FIRING_BASELINE_HZ is still imported from
   * physics/params.ts (not a second hardcoded copy) so the REST point stays consistent
   * with the physics engine's own scale, even though the saturation RANGE around it is a
   * separate visualization choice.
   *
   * Drives BOTH .color (the lit albedo) AND .emissive (self-illumination) with the same
   * value, not just .color: these materials are glassy (high clearcoat, low roughness,
   * transparent) so under this scene's lighting, perceived surface color is dominated by
   * specular highlights reflecting the (white) key light, not the albedo -- confirmed
   * live (material.color read back as pure 0xe01b24 red while the rendered duct still
   * looked pale/grey). Emissive isn't subject to that lighting-dependent washout, so it's
   * what actually makes the excitation/inhibition color visible.
   */
  setFiringRates(rates: Record<CanalType, number>): void {
    for (const canal of Object.keys(rates) as CanalType[]) {
      const hz = rates[canal];
      const t = Math.max(-1, Math.min(1, (hz - FIRING_BASELINE_HZ) / COLOR_SATURATION_HZ));
      const color = t >= 0 ? COLOR_REST.clone().lerp(COLOR_EXCITED, t) : COLOR_REST.clone().lerp(COLOR_INHIBITED, -t);
      this.ductMaterials[canal]?.color.copy(color);
      this.ductMaterials[canal]?.emissive.copy(color);
      this.ampullaMaterials[canal]?.color.copy(color);
      this.ampullaMaterials[canal]?.emissive.copy(color);
    }
  }

  /**
   * Shows/hides and positions the otoconia clot cluster for canalithiasis BPPV. Pass null
   * to hide it (no BPPV selected, or a different canal/side than this scene's own). The
   * position is computed in the raw right-ear mesh frame (see canalith.ts's
   * ductPositionAtFraction) since labyrinthGroup already applies this scene's own
   * side-mirror transform -- positioning the clot there, not on headGroup, means it
   * inherits both that mirror and the per-frame head-orientation rotation automatically.
   */
  setDebris(selection: { canal: CanalType; arcFraction: number } | null): void {
    if (!selection) {
      this.clotGroup.visible = false;
      return;
    }
    const p = ductPositionAtFraction(selection.canal, selection.arcFraction);
    this.clotGroup.position.set(p[0], p[1], p[2]);
    this.clotGroup.visible = true;
  }

  render(): void {
    resizeRendererToDisplaySize(this.renderer, this.camera);
    const canvas = this.renderer.domElement;
    if (this.boundingSphere && (canvas.width !== this.lastFitWidth || canvas.height !== this.lastFitHeight)) {
      this.lastFitWidth = canvas.width;
      this.lastFitHeight = canvas.height;
      this.fitCamera();
    }
    this.renderer.render(this.scene, this.camera);
  }
}

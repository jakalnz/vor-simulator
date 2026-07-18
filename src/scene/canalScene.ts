import * as THREE from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { CanalType, EarSide } from '../physics/canal';
import { Quat } from '../physics/types';
import { FIRING_BASELINE_HZ, FIRING_CEILING_HZ } from '../physics/params';
import {
  toThreeQuaternion,
  makeAmbientAndKeyLight,
  createRenderer,
  resizeRendererToDisplaySize,
  HEAD_FRAME_TO_THREE,
} from './sceneUtils';
import { resolveAssetUrl } from './assetPaths';
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

// Per-canal tint for the loaded real duct/ampulla meshes -- the resting-color baseline
// before setFiringRates lerps toward excited (red) / inhibited (blue).
const CANAL_TINT: Record<CanalType, number> = { posterior: 0xe0507a, anterior: 0x4aa3e0, horizontal: 0x5fd17a };

const DUCT_OPACITY = 0.4;
const AMPULLA_OPACITY = 0.6;

const COLOR_INHIBITED = new THREE.Color(0x1a5fb4);
const COLOR_EXCITED = new THREE.Color(0xe01b24);

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

    for (const canal of Object.keys(EAR_ANATOMY.canals) as CanalType[]) {
      this.ductMaterials[canal] = glassMaterial(CANAL_TINT[canal] ?? 0xdfeaf2, DUCT_OPACITY);
      this.ampullaMaterials[canal] = glassMaterial(CANAL_TINT[canal] ?? 0xdfeaf2, AMPULLA_OPACITY);
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

  /** Fits a static camera distance to the loaded geometry's actual bounding sphere, once. */
  private fitCamera(): void {
    if (!this.boundingSphere) return;
    const margin = 1.15;
    const vFov = THREE.MathUtils.degToRad(this.camera.fov);
    const aspect = this.camera.aspect > 0 ? this.camera.aspect : 1;
    const radius = this.boundingSphere.radius * margin;
    const distanceForVertical = radius / Math.tan(vFov / 2);
    const distanceForHorizontal = radius / (Math.tan(vFov / 2) * aspect);
    const distance = Math.max(distanceForVertical, distanceForHorizontal);
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
   * (~FIRING_BASELINE_HZ) reads as this canal's own resting tint, rising toward
   * FIRING_CEILING_HZ lerps toward red (excited), dropping toward 0 lerps toward blue
   * (inhibited). Imports the baseline/ceiling from physics/params.ts rather than a second
   * hardcoded copy, so this stays consistent with the physics engine's own scale.
   */
  setFiringRates(rates: Record<CanalType, number>): void {
    for (const canal of Object.keys(rates) as CanalType[]) {
      const hz = rates[canal];
      const restColor = new THREE.Color(CANAL_TINT[canal] ?? 0xdfeaf2);
      let color: THREE.Color;
      if (hz >= FIRING_BASELINE_HZ) {
        const t = Math.max(0, Math.min(1, (hz - FIRING_BASELINE_HZ) / (FIRING_CEILING_HZ - FIRING_BASELINE_HZ)));
        color = restColor.clone().lerp(COLOR_EXCITED, t);
      } else {
        const t = Math.max(0, Math.min(1, (FIRING_BASELINE_HZ - hz) / FIRING_BASELINE_HZ));
        color = restColor.clone().lerp(COLOR_INHIBITED, t);
      }
      this.ductMaterials[canal]?.color.copy(color);
      this.ampullaMaterials[canal]?.color.copy(color);
    }
  }

  render(): void {
    resizeRendererToDisplaySize(this.renderer, this.camera);
    this.renderer.render(this.scene, this.camera);
  }
}

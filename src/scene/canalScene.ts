import * as THREE from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { CanalType, EarSide, CANAL_PLANE_NORMAL, AMPULLOFUGAL_SIGN } from '../physics/canal';
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
import { ductPositionAtFraction, ductTangent } from '../physics/canalith';
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
  /** The real cupula WALL mesh (build.mjs's `ls_Hsapiens_{Ant,Lat,Post}_Cup_Wall.vtk`,
   * exported as `<canal>-ampulla.obj`) -- despite the field name (kept for JSON
   * backwards-compat with earlier scene code), this IS the cupula membrane itself, not
   * the surrounding bony ampulla (that's ampullaBulgeMesh below). See
   * buildCupulaHinge/CUPULA_COLOR for how this scene renders and animates it. */
  ampullaMesh: string;
  connectorMesh: string;
  ampullaBulgeMesh: string;
  canalUtricleWallMesh?: string;
  /** Raw right-ear HeadFrame-axis anchor point (meters), used by the micro-zoom camera
   * (see focusOnCanal/updateCameraFocus) to target this canal's ampulla -- distinct from
   * ductMesh's own geometry origin, which OBJLoader leaves in the mesh's local space. */
  ampullaAnchor: [number, number, number];
  /** Real cupula base (crista/duct-floor anchor, where the membrane is physically
   * hinged) and apex (dome tip), raw right-ear HeadFrame meters -- from build.mjs's
   * H_inner/H_outer calipers. Used as the pivot point + hinge-axis reference for the
   * cupula wall mesh's deflection animation (see buildCupulaHinge). */
  cupula: { base: [number, number, number]; apex: [number, number, number] };
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

// Lowered from 0.55 -- reported live as too opaque to see the cupula/flow-band overlay
// (below) through the duct wall once those were added.
const DUCT_OPACITY = 0.4;

/**
 * Cupula membrane -- the REAL `<canal>-ampulla.obj` mesh (build.mjs's Cup_Wall.vtk, see
 * EarAnatomyCanal.ampullaMesh's doc comment), not a procedural stand-in: an earlier
 * attempt used a synthetic plane-normal-oriented disc here and it never aligned
 * convincingly with the real geometry regardless of tuning (reported live) -- using the
 * actual mesh instead sidesteps that alignment problem entirely, since there's nothing
 * to align, it just IS the cupula. Given its own solid, high-visibility color (distinct
 * from the excite/inhibit duct coloring it used to share) so it reads as its own
 * anatomical structure, and hinge-rotated by cupula deflection -- see
 * buildCupulaHinge/setFluidVisuals.
 */
const CUPULA_COLOR = 0xffe000;
const CUPULA_OPACITY = 0.85;
/**
 * Degrees the cupula wall mesh tilts (about its real base-anchored hinge, see
 * buildCupulaHinge) per unit of vorEngine.ts's cupula `beta`. A visualization gain --
 * beta itself is dimensionless (roughly O(0.1-1) for a brisk head rotation, see
 * cupula.ts's Steinhausen filter), not a physical membrane angle.
 */
const CUPULA_TILT_DEG_PER_BETA = 20;
const CUPULA_TILT_CLAMP = 1.5;

/** Endolymph-lag (orange) and head/wall-motion (green) overlay arrows shown next to the
 * currently-focused canal's ampulla in Micro fluid view -- see setFluidVisuals. The
 * reference teaching spec (claude_micro_view.MD) called for a bright WHITE fluid arrow,
 * but this scene's own ducts/ampullae are themselves pale grey/white (see CANAL_TINT) --
 * confirmed live that a white arrow all but disappeared against them. Orange (not the
 * cupula wall's own yellow, to avoid the two being confused for the same signal) keeps
 * the "distinct, high-visibility" intent without the contrast failure. */
const FLUID_ARROW_COLOR = 0xff9500;
const HEAD_ARROW_COLOR = 0x33ff66;
/** Visualization gains turning cupula beta / raw angular velocity (rad/s) into arrow
 * length (meters) -- tuned so a brisk head turn draws a clearly visible, but not
 * frame-filling, arrow at the micro-zoom's close-up scale. */
const FLUID_ARROW_LENGTH_SCALE = 0.003;
const HEAD_ARROW_LENGTH_SCALE = 0.0025;
const MAX_ARROW_LENGTH = 0.0035;
/** Cupula-beta-to-scroll-phase gain for the duct/ampulla flow-band shader (see
 * makeCupulaMaterial's sibling flow-uniform wiring in loadRealAnatomy) -- a
 * visualization-only scroll speed, not a physical fluid velocity. */
const FLOW_SCROLL_SPEED = 40;

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
  /** Per-canal group (duct + ampulla bulge + connector + cupula) -- see
   * setFocusedCanal, which hides the two non-focused canals' groups while one is
   * focused in Micro fluid view. */
  private readonly canalGroups: Partial<Record<CanalType, THREE.Group>> = {};
  /** Pivot group per canal wrapping the loaded cupula wall mesh, positioned at that
   * canal's real cupula.base landmark so rotating the pivot tilts the mesh about its
   * true anatomical hinge point -- see buildCupulaHinge/setFluidVisuals. */
  private readonly cupulaPivots: Partial<Record<CanalType, THREE.Group>> = {};
  /** Hinge axis per canal (labyrinthGroup-local, raw right-ear frame), perpendicular to
   * both the ampullofugal flow tangent and the cupula's own base->apex axis -- see
   * buildCupulaHinge for the derivation. */
  private readonly cupulaHingeAxes: Partial<Record<CanalType, THREE.Vector3>> = {};
  private boundingSphere: { center: THREE.Vector3; radius: number } | null = null;
  /** Otoconia clot cluster (BPPV canalithiasis debris marker), hidden until setDebris is
   * called with a non-null selection -- see physics/canalith.ts's arc-length model. */
  private readonly clotGroup = new THREE.Group();
  /** Canvas drawing-buffer size (px) the camera was last fit to -- see render()'s resize
   * check. Starts at 0 so the very first render after the mesh loads always fits. */
  private lastFitWidth = 0;
  private lastFitHeight = 0;

  // Micro-zoom camera state (see setFocusedCanal/updateCameraFocus) -- lets the "Micro
  // fluid view" toggle glide the camera in on one canal's ampulla to demonstrate fluid
  // microdynamics up close, then glide back out to the whole-labyrinth overview.
  /** Per-canal ampulla anchor in labyrinthGroup-LOCAL space (raw right-ear HeadFrame
   * axes -- labyrinthGroup's own quaternion+mirror scale, already applied to the loaded
   * meshes, applies to this too via localToWorld). Populated synchronously in the
   * constructor from earAnatomy.json (a static import), unlike the meshes themselves
   * which load asynchronously -- the anchor position doesn't need the mesh geometry. */
  private readonly ampullaLocalPositions: Partial<Record<CanalType, THREE.Vector3>> = {};
  /** Which canal's ampulla the camera should be gliding toward; null = whole-labyrinth
   * overview (see fitCamera's overviewTarget/overviewDistance). */
  private focusedCanal: CanalType | null = null;
  private readonly overviewTarget = new THREE.Vector3();
  private overviewDistance = 0;
  /** Camera's current (smoothed) look-at point and distance -- lerped toward the
   * overview or focused-ampulla target each frame in updateCameraFocus, rather than
   * snapping instantly, so the "Micro fluid view" toggle reads as a camera glide. */
  private readonly currentLookTarget = new THREE.Vector3();
  private currentDistance = 0;
  /** Fixed viewing direction (anterior + slight elevation), UNNORMALIZED to match
   * fitCamera's own target+viewDir*distance convention exactly (see its doc comment) --
   * both the overview and the micro-zoomed close-up view from the same angle, just at
   * different distances/targets, so the camera never re-orients, only glides. */
  private readonly viewDir = new THREE.Vector3(1, 0.25, 0);

  // Fluid/head-motion overlay arrows (see setFluidVisuals) -- need this scene's own
  // `side` for the physics sign conventions (CANAL_PLANE_NORMAL/AMPULLOFUGAL_SIGN are
  // side-dependent even though the mesh geometry itself is shared right-ear data,
  // mirrored by labyrinthGroup.scale.y).
  private readonly flowPhaseUniforms: Partial<Record<CanalType, { value: number }>> = {};
  private readonly fluidArrow = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(), 0, FLUID_ARROW_COLOR);
  private readonly headArrow = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(), 0, HEAD_ARROW_COLOR);

  constructor(canvas: HTMLCanvasElement, private readonly side: EarSide) {
    this.renderer = createRenderer(canvas);
    this.scene.add(...makeAmbientAndKeyLight());

    // Ampulla anchors are plain JSON data (no mesh geometry needed), so these can be
    // populated synchronously here rather than waiting on loadRealAnatomy's async
    // OBJLoader calls below.
    for (const canal of Object.keys(EAR_ANATOMY.canals) as CanalType[]) {
      const [x, y, z] = EAR_ANATOMY.canals[canal].ampullaAnchor;
      this.ampullaLocalPositions[canal] = new THREE.Vector3(x, y, z);
    }

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

    // View from anterior (Three +X, see HEAD_FRAME_TO_THREE / headScene.ts's identical
    // "nose toward +X" convention) so the ear model's default view matches the head
    // model's default front-on view, rather than the old default of looking along Z
    // (lateral), which put the horizontal canal face-on instead.
    this.camera.position.set(0.024, 0.012, 0);
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

    // Children of labyrinthGroup (not headGroup/scene directly), same as the clot group
    // above -- their positions/directions are set in labyrinthGroup-LOCAL (raw right-ear)
    // space below, and the parent's own static frame-conversion + left-ear mirror scale
    // carries them into the right place automatically, exactly like ductPositionAtFraction's
    // clot marker. Hidden until setFluidVisuals turns them on for a focused canal.
    this.fluidArrow.visible = false;
    this.headArrow.visible = false;
    this.labyrinthGroup.add(this.fluidArrow, this.headArrow);

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
    const canalColorMaterial = (color: number, opacity: number, flowCanal?: CanalType) => {
      const material = new THREE.MeshPhysicalMaterial({
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
      if (flowCanal) {
        // Endolymph-flow illustration: a moving band pattern travelling along this
        // canal's own duct-tangent-at-the-ampulla axis (a fixed direction, not a true
        // per-vertex tangent field along the whole curved duct -- a simplification, see
        // this constant's own doc comment) -- phase driven by cupula beta (ampullofugal-
        // signed, same convention as vorEngine.ts), not raw instantaneous head velocity,
        // so it decays/persists the same way the cupula membrane's own skew does.
        const flowUniform = this.flowPhaseUniforms[flowCanal] ?? { value: 0 };
        this.flowPhaseUniforms[flowCanal] = flowUniform;
        const t = ductTangent(flowCanal, 'right', 0);
        const axis = new THREE.Vector3(t[0], t[1], t[2]);
        material.onBeforeCompile = (shader) => {
          shader.uniforms.uFlowPhase = flowUniform;
          shader.uniforms.uFlowAxis = { value: axis };
          shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\nuniform vec3 uFlowAxis;\nvarying float vFlowCoord;')
            .replace('#include <begin_vertex>', '#include <begin_vertex>\n vFlowCoord = dot(position, uFlowAxis);');
          shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', '#include <common>\nuniform float uFlowPhase;\nvarying float vFlowCoord;')
            .replace(
              '#include <dithering_fragment>',
              `
  // Narrow, dark bands (not the earlier wide bright ones, which read as a lens-flare
  // wash and buried the underlying anatomy) -- higher frequency for more/thinner bands,
  // a tight smoothstep window so each band stays a crisp line rather than a broad glow,
  // and DARKENING (multiply down) instead of ADDING brightness so the duct's own
  // excite/inhibit color and the mesh's shading underneath both stay legible.
  float flowBand = smoothstep(0.94, 1.0, sin(vFlowCoord * 2400.0 - uFlowPhase));
  gl_FragColor.rgb *= 1.0 - flowBand * 0.55;
  #include <dithering_fragment>`
            );
        };
      }
      return material;
    };

    for (const canal of Object.keys(EAR_ANATOMY.canals) as CanalType[]) {
      this.ductMaterials[canal] = canalColorMaterial(CANAL_TINT[canal] ?? 0xdfeaf2, DUCT_OPACITY, canal);
    }
    const CUPULA_MATERIAL = new THREE.MeshPhysicalMaterial({
      color: CUPULA_COLOR,
      emissive: CUPULA_COLOR,
      emissiveIntensity: 0.4,
      transparent: true,
      opacity: CUPULA_OPACITY,
      roughness: 0.4,
      metalness: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const CONNECTOR_GLASS = glassMaterial(0xb87fa0, 0.18);
    // Common crus is anatomically just the shared trunk where the canal ducts join --
    // tinted the same as the ducts' resting color (COLOR_REST) and given the same emissive
    // canalColorMaterial (not the plain, non-emissive glassMaterial) so it reads at the
    // same brightness as the duct meshes it's continuous with, rather than looking dark by
    // comparison under ambient-only lighting.
    const COMMON_CRUS_GLASS = canalColorMaterial(COLOR_REST.getHex(), 0.28);
    // Utricle/saccule tinted to match the otoconia clot (CLOT_COLOR) -- these are the
    // otolith organs where the clot's otoconia debris actually originates.
    const UTRICLE_GLASS = glassMaterial(CLOT_COLOR, 0.16);
    const SACCULE_GLASS = glassMaterial(CLOT_COLOR, 0.2);

    const loadInto = async (url: string, material: THREE.Material, parent: THREE.Object3D = this.labyrinthGroup) => {
      try {
        const resolved = resolveAssetUrl(url, import.meta.env.BASE_URL, window.location.origin);
        const obj = await loader.loadAsync(resolved);
        obj.traverse((child) => {
          if (child instanceof THREE.Mesh) child.material = material;
        });
        parent.add(obj);
      } catch (err) {
        console.warn(`Real anatomy mesh at ${url} failed to load.`, err);
      }
    };

    // Cupula wall mesh, wrapped in a pivot group anchored at the REAL cupula.base
    // landmark (not the mesh's own bounding-box center or a guessed point) -- see
    // buildCupulaHinge/setFluidVisuals for why: rotating that pivot tilts the mesh about
    // its true anatomical hinge, exactly like a swinging door anchored at the base while
    // its dome tip (apex) sweeps sideways.
    const loadCupulaWall = async (canal: CanalType, anatomy: EarAnatomyCanal, parent: THREE.Object3D) => {
      try {
        const resolved = resolveAssetUrl(anatomy.ampullaMesh, import.meta.env.BASE_URL, window.location.origin);
        const obj = await loader.loadAsync(resolved);
        obj.traverse((child) => {
          if (child instanceof THREE.Mesh) child.material = CUPULA_MATERIAL;
        });
        const base = new THREE.Vector3(...anatomy.cupula.base);
        const pivot = new THREE.Group();
        pivot.position.copy(base);
        // The mesh's own vertices are already absolute (labyrinthGroup-local) positions
        // (see build.mjs's ASSEMBLY_ANCHOR translation) -- offsetting the mesh by -base
        // under a pivot placed AT base keeps its rendered position unchanged while
        // idle (pivot.position + mesh.position == base + (-base) == 0 relative
        // displacement), so rotating the pivot rotates the mesh about that real point,
        // not about the mesh's own (anatomically meaningless) local origin.
        obj.position.copy(base).negate();
        pivot.add(obj);
        parent.add(pivot);
        this.cupulaPivots[canal] = pivot;

        const apex = new THREE.Vector3(...anatomy.cupula.apex);
        const hingeStem = apex.clone().sub(base).normalize();
        const tangent = ductTangent(canal, 'right', 0);
        const tangentVec = new THREE.Vector3(tangent[0], tangent[1], tangent[2]);
        // Perpendicular to both the ampullofugal flow direction and the base->apex
        // "stem" axis -- the natural bending axis for a membrane hinged at its base and
        // swept sideways (in the flow direction) at its apex, same idea as swinging a
        // door: the hinge axis is perpendicular to both the door's own face-normal-ish
        // swing direction and the vertical hinge line itself.
        const hingeAxis = new THREE.Vector3().crossVectors(tangentVec, hingeStem).normalize();
        this.cupulaHingeAxes[canal] = hingeAxis;
      } catch (err) {
        console.warn(`Cupula wall mesh at ${anatomy.ampullaMesh} failed to load.`, err);
      }
    };

    for (const [canal, anatomy] of Object.entries(EAR_ANATOMY.canals) as [CanalType, EarAnatomyCanal][]) {
      // Everything specific to this ONE canal (its own duct, ampulla bulge, connector,
      // cupula) lives under a per-canal group -- see setFocusedCanal, which hides the
      // OTHER two canals' groups while one is focused in Micro fluid view (reported
      // live: with all three canals rendered, the non-focused ones were confusing
      // clutter around the one actually being demonstrated). Shared central structures
      // (common crus, utricle, saccule, below) are NOT per-canal, so they stay visible
      // regardless of focus.
      const canalGroup = new THREE.Group();
      this.canalGroups[canal] = canalGroup;
      this.labyrinthGroup.add(canalGroup);

      await loadInto(anatomy.ductMesh, this.ductMaterials[canal], canalGroup);
      await loadCupulaWall(canal, anatomy, canalGroup);
      await loadInto(anatomy.ampullaBulgeMesh, this.ductMaterials[canal], canalGroup);
      await loadInto(anatomy.connectorMesh, CONNECTOR_GLASS, canalGroup);
      if (anatomy.canalUtricleWallMesh) await loadInto(anatomy.canalUtricleWallMesh, COMMON_CRUS_GLASS, canalGroup);
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
    // View from anterior (+X), matching this scene's constructor and headScene.ts's
    // default front-on view of the head -- not a lateral (+-Z) view, which put the
    // horizontal canal face-on instead (see setOrientation's caller / user request).
    this.overviewTarget.copy(this.boundingSphere.center);
    this.overviewDistance = distance;
    // Only snap the camera directly when NOT mid-micro-zoom -- if a canal is currently
    // focused, updateCameraFocus's own per-frame lerp owns the camera this tick instead
    // (a resize firing fitCamera while zoomed in shouldn't yank the camera back out to
    // the overview).
    if (!this.focusedCanal) {
      this.currentLookTarget.copy(this.overviewTarget);
      this.currentDistance = this.overviewDistance;
      this.camera.position.copy(this.overviewTarget).addScaledVector(this.viewDir, distance);
      this.camera.lookAt(this.overviewTarget);
    }
  }

  /**
   * Rotates the whole labyrinth to match the current head orientation -- EXCEPT while a
   * canal is focused (Micro fluid view), when the labyrinth instead stays frozen upright
   * (see setFocusedCanal): the point of that view is to isolate the fluid/cupula motion
   * itself, not to also show the whole model tumbling around under it (reported live --
   * "no need to have the ear model rotating, we just want to see the fluid movement").
   */
  setOrientation(qHead: Quat): void {
    if (this.focusedCanal) return;
    this.headGroup.quaternion.copy(toThreeQuaternion(qHead));
  }

  /**
   * Sets which canal's ampulla the "Micro fluid view" camera should glide in on, or null
   * to glide back out to the whole-labyrinth overview -- see updateCameraFocus (called
   * every render()) for the actual per-frame glide. Also freezes/unfreezes headGroup's
   * rotation (see setOrientation) on the null<->canal transition: entering focus snaps
   * the labyrinth to upright once (so the camera glide's target is stable, not still
   * tumbling from whatever orientation the head happened to be in when focus started).
   *
   * Also hides the OTHER two canals' own groups while one is focused (reported live:
   * with all three rendered, the non-focused canals cluttered/confused the close-up on
   * the one actually being demonstrated) -- shared central structures (utricle, common
   * crus, saccule) aren't part of any canalGroup, so they stay visible regardless.
   */
  setFocusedCanal(canal: CanalType | null): void {
    if (canal && !this.focusedCanal) this.headGroup.quaternion.identity();
    this.focusedCanal = canal;
    for (const [otherCanal, group] of Object.entries(this.canalGroups) as [CanalType, THREE.Group][]) {
      group.visible = canal === null || otherCanal === canal;
    }
  }

  /**
   * Glides the camera's look-at point and distance toward either the focused canal's
   * ampulla (in current, head-orientation-rotated world space -- recomputed every frame
   * via labyrinthGroup.localToWorld, since the labyrinth itself rotates under a
   * world-fixed camera) or the whole-labyrinth overview, at a fixed viewing angle
   * (viewDir) throughout -- only the distance and target change, so the camera glides
   * rather than re-orienting. Exponential smoothing (not a fixed-duration tween/easing
   * library) since this runs once per rendered frame with no explicit dt of its own.
   */
  private updateCameraFocus(): void {
    if (!this.boundingSphere) return;
    // Reported live as "way too zoomed in" at 0.045 (camera ended up clipping through
    // neighboring geometry) -- widened so the focused ampulla + its cupula sit clearly
    // isolated in frame without the view reading as an abstract close-up of nothing.
    const MICRO_ZOOM_DISTANCE_FACTOR = 0.11;
    const LERP = 0.12;

    let targetLookAt = this.overviewTarget;
    let targetDistance = this.overviewDistance;
    const focusedLocal = this.focusedCanal ? this.ampullaLocalPositions[this.focusedCanal] : undefined;
    if (focusedLocal) {
      this.labyrinthGroup.updateWorldMatrix(true, false);
      targetLookAt = this.labyrinthGroup.localToWorld(focusedLocal.clone());
      targetDistance = this.overviewDistance * MICRO_ZOOM_DISTANCE_FACTOR;
    }

    this.currentLookTarget.lerp(targetLookAt, LERP);
    this.currentDistance += (targetDistance - this.currentDistance) * LERP;
    this.camera.position.copy(this.currentLookTarget).addScaledVector(this.viewDir, this.currentDistance);
    this.camera.lookAt(this.currentLookTarget);
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
    }
  }

  /**
   * Drives the cupula wall mesh's hinge tilt, the duct/ampulla flow-band scroll, and the
   * fluid-lag/head-motion overlay arrows (Micro fluid view only -- see
   * claude_micro_view.MD) from this tick's per-canal cupula state (vorEngine.ts's
   * `beta`, ampullofugal-signed) and the current head angular velocity (HeadFrame).
   *
   * The cupula tilt and flow-band scroll run for EVERY canal, all the time (cheap
   * per-canal updates, and the cupula membrane is meant to be visible in the normal
   * overview too, not just when zoomed -- see CUPULA_COLOR's doc comment). The overlay
   * arrows only make sense for the single canal the camera is currently focused on, so
   * they're hidden entirely outside Micro fluid view.
   */
  setFluidVisuals(cupulaBetas: Record<CanalType, number>, headAngularVelocityHead: [number, number, number]): void {
    for (const canal of Object.keys(cupulaBetas) as CanalType[]) {
      const beta = cupulaBetas[canal];
      const flowPhase = this.flowPhaseUniforms[canal];
      if (flowPhase) flowPhase.value += beta * FLOW_SCROLL_SPEED;

      const pivot = this.cupulaPivots[canal];
      const hingeAxis = this.cupulaHingeAxes[canal];
      if (pivot && hingeAxis) {
        const deg = THREE.MathUtils.clamp(beta, -CUPULA_TILT_CLAMP, CUPULA_TILT_CLAMP) * CUPULA_TILT_DEG_PER_BETA;
        pivot.quaternion.setFromAxisAngle(hingeAxis, THREE.MathUtils.degToRad(deg));
      }
    }

    const canal = this.focusedCanal;
    const anchor = canal ? this.ampullaLocalPositions[canal] : undefined;
    if (!canal || !anchor) {
      this.fluidArrow.visible = false;
      this.headArrow.visible = false;
      return;
    }

    const tangent = ductTangent(canal, 'right', 0);
    const tangentVec = new THREE.Vector3(tangent[0], tangent[1], tangent[2]);
    const n = CANAL_PLANE_NORMAL[canal][this.side];
    const omegaProj = new THREE.Vector3(...headAngularVelocityHead).dot(new THREE.Vector3(n[0], n[1], n[2]));
    // Same ampullofugal-signed convention vorEngine.ts's own `rotationalFlow` term uses
    // (AMPULLOFUGAL_SIGN * omegaProj) -- see that file/physics/canal.ts's doc comments.
    const rotationalFlow = AMPULLOFUGAL_SIGN[canal][this.side] * omegaProj;
    const beta = cupulaBetas[canal] ?? 0;

    // Fluid (endolymph) arrow: driven by the LAGGED cupula beta, so it keeps pointing
    // (and shrinks only gradually, over cupula.ts's tau) even after the head stops --
    // this is what actually reproduces the "endolymph momentum" teaching point, not any
    // special-cased "sudden stop" logic.
    this.setOverlayArrow(this.fluidArrow, anchor, tangentVec, beta, FLUID_ARROW_LENGTH_SCALE);
    // Head/wall-motion arrow: driven by the INSTANTANEOUS rotational flow, so it
    // disappears immediately once the head actually stops, unlike the fluid arrow above.
    // Deliberately the OPPOSITE sign from the fluid arrow's beta -- physically, the wall
    // moves opposite to the fluid's RELATIVE (ampullofugal-positive) lag direction (see
    // physics/canal.ts's AMPULLOFUGAL_SIGN doc comment).
    this.setOverlayArrow(this.headArrow, anchor, tangentVec, -rotationalFlow, HEAD_ARROW_LENGTH_SCALE);
  }

  /** Shared helper for the two overlay arrows in setFluidVisuals -- both are positioned
   * at the same ampulla anchor and point along the same duct-tangent axis, only their
   * driving signed value and length gain differ. */
  private setOverlayArrow(
    arrow: THREE.ArrowHelper,
    anchor: THREE.Vector3,
    tangentVec: THREE.Vector3,
    signedValue: number,
    lengthScale: number
  ): void {
    const length = Math.min(MAX_ARROW_LENGTH, Math.abs(signedValue) * lengthScale);
    arrow.visible = length > 1e-6;
    if (!arrow.visible) return;
    arrow.position.copy(anchor);
    arrow.setDirection(tangentVec.clone().multiplyScalar(Math.sign(signedValue) || 1).normalize());
    // headLength/headWidth as a LARGE fraction of the total length (not the
    // library-default ~0.2/0.2) -- at this scene's tiny (sub-millimeter) scale, a
    // thin 1px line is barely distinguishable from the surrounding geometry (confirmed
    // live), so most of the arrow's visible presence needs to come from the cone.
    arrow.setLength(length, length * 0.6, length * 0.4);
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
    this.updateCameraFocus();
    this.renderer.render(this.scene, this.camera);
  }
}

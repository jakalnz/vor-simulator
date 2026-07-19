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

// Distinct per-canal hue for the duct walls -- restores the "which duct is which" legend
// an earlier all-white/all-grey scheme lost (reported live: with every duct the same pale
// tint and ~0.4 opacity, overlapping ducts were impossible to tell apart until the model
// was rotated). This is the duct's fixed identity color, permanently untouched by
// setFiringRates -- excite/inhibit is instead an additive red/blue GLOW layered on top
// (see GLOW_MAX_INTENSITY's doc comment), so these hues just need to stay visually
// distinct from that red/blue glow and from the cupula's fixed yellow (CUPULA_COLOR), not
// from each other's crossfade path. Anterior was originally a cyan-teal (0x50c8dc) --
// reported live as too close to the inhibitory blue glow (only ~60 degrees away on the
// color wheel), swapped for violet/purple instead, which sits far from both red and blue.
// Posterior's amber was similarly nudged more golden/less red-adjacent for the same
// reason. Green (horizontal) was already well-separated from both signal colors.
const CANAL_TINT: Record<CanalType, number> = { posterior: 0xd9a441, anterior: 0x9b7ed8, horizontal: 0x74c69d };

// Lowered from 0.55 -- reported live as too opaque to see the cupula/flow-band overlay
// (below) through the duct wall once those were added.
const DUCT_OPACITY = 0.4;

/**
 * Excite/inhibit is now a red/blue GLOW layered on top of the duct's own fixed CANAL_TINT
 * identity color, not a replacement for it -- see setFiringRates. `.color` (the lit
 * albedo) stays permanently at CANAL_TINT; only `.emissive`/`.emissiveIntensity` (additive
 * self-illumination) swings toward these colors, at zero intensity at rest (no glow) and
 * up to GLOW_MAX_INTENSITY at the firing-rate extremes. Two prior approaches were tried
 * and rejected (reported live): a full hue crossfade toward red/blue (collided with/
 * overwrote the identity hue), then an HSL lightness/saturation-only shift (didn't read as
 * strongly as the original red/blue). This keeps the identity hue fully intact while still
 * getting a strong, unambiguous red/blue signal via the glow.
 */
const COLOR_EXCITED = new THREE.Color(0xe01b24);
const COLOR_INHIBITED = new THREE.Color(0x1a5fb4);
const GLOW_MAX_INTENSITY = 2.2;
// Eases the firing-rate->glow magnitude curve so a moderate stimulus already reads as a
// strong, obvious color change instead of needing to approach full COLOR_SATURATION_HZ --
// exponent < 1 front-loads the swing (e.g. 0.5 magnitude input reaches ~71% of the full
// swing instead of 50%).
const DUCT_SIGNAL_EASE_EXPONENT = 0.55;

// Fresnel rim-darkening strength for duct/cupula materials -- grazing-angle surface (the
// silhouette edge of each duct as seen from the camera) is multiplied down by up to this
// fraction. Purely a depth/silhouette cue: darkening (not adding a bright/colored rim)
// avoids introducing any new hue that could compete with the excite/inhibit color coding.
const RIM_DARKEN_STRENGTH = 0.18;

/**
 * Cupula membrane -- the REAL `<canal>-ampulla.obj` mesh (build.mjs's Cup_Wall.vtk, see
 * EarAnatomyCanal.ampullaMesh's doc comment), not a procedural stand-in: an earlier
 * attempt used a synthetic plane-normal-oriented disc here and it never aligned
 * convincingly with the real geometry regardless of tuning (reported live) -- using the
 * actual mesh instead sidesteps that alignment problem entirely, since there's nothing
 * to align, it just IS the cupula. Fixed, solid, high-visibility color (distinct from any
 * duct hue or excite/inhibit signal color) purely for anatomical identification -- an
 * intermediate version made this the PRIMARY excite/inhibit signal instead, one material
 * per canal swinging grey->red/blue; reverted (reported live: the clear ampulla wall that
 * change required to keep the signal visible made the surrounding bony structure hard to
 * read). The excite/inhibit signal now lives entirely on the duct via HSL
 * lightness/saturation modulation -- see setFiringRates. Hinge-rotated by cupula
 * deflection -- see buildCupulaHinge/setFluidVisuals.
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
/**
 * Shared visualization gain turning an arrow's driving value into a length, as a
 * FRACTION of the camera's current distance-to-target (not a fixed meters constant) --
 * a fixed-meters length went through two wrong tunings in a row (first way too long,
 * spanning almost the whole frame at the wider zoom; then, overcorrected, so short it
 * read as "barely visible") because the right absolute size depends on how far the
 * camera currently is, which changes (MICRO_ZOOM_DISTANCE_FACTOR, or any future zoom
 * retuning). Scaling by currentDistance instead makes the arrows self-correct: a
 * max-magnitude arrow is always ARROW_LENGTH_FRACTION of the current view distance,
 * clearly visible regardless of exactly how tight the zoom is.
 *
 * ONE shared scale (not a separate gain per arrow) -- reported live that the head
 * arrow read as oversized next to the fluid arrow. That wasn't just a scale mismatch:
 * the fluid arrow's driver (cupula beta) is tau-damped and stays roughly bounded,
 * while the head arrow's driver (raw instantaneous angular velocity, rad/s) is
 * unbounded and commonly reaches a larger peak magnitude for the same "brisk head
 * turn" -- so ARROW_INPUT_CLAMP clamps BOTH drivers to the same domain before this
 * same fraction is applied, making the two arrows' sizes genuinely comparable.
 */
const ARROW_LENGTH_FRACTION = 0.5;
const ARROW_INPUT_CLAMP = 1.5;
/**
 * Exponential smoothing factor (per setFluidVisuals call, i.e. per rendered frame) for
 * the head-rotation arrow's driving value. NOT literally instantaneous -- raw angular
 * velocity sampled once a frame can spike for only 1-2 frames during real mouse-drag
 * input (each frame's velocity is derived from the delta since the last orientation
 * sample, which is noisy/bursty when the pointer isn't moving perfectly smoothly),
 * making a truly instantaneous arrow flicker in and out too fast to see (reported
 * live: "the green arrows do not appear at all"). A short smoothing window keeps it
 * visible for a few frames around any real head motion while still reading as
 * distinctly more responsive than the fluid arrow's much slower cupula-tau decay.
 */
const HEAD_ARROW_SMOOTHING = 0.35;

/**
 * A simple directional indicator: one cone, base at local origin, apex at local +Y --
 * NOT a THREE.ArrowHelper (see fluidArrow/headArrow's own doc comment for why).
 * Positioning + orienting one of these (see setOverlayArrow) just means: put its
 * origin at the desired start point, quaternion.setFromUnitVectors(+Y, direction), and
 * scale.y by the desired length (scale.x/z for width) -- the cone then visually spans
 * from that origin to origin + direction*length.
 */
function makeIndicatorCone(color: number): THREE.Mesh {
  const geometry = new THREE.ConeGeometry(0.4, 1, 10);
  geometry.translate(0, 0.5, 0); // base at y=0, apex at y=1 (default is centered on y=0)
  const material = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    depthTest: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 999;
  mesh.frustumCulled = false;
  mesh.visible = false;
  // Zero scale, not just visible:false -- computeBoundingSphereInfo's Box3.setFromObject
  // walks the whole labyrinthGroup regardless of each object's .visible flag, so this
  // mesh's full UNIT-scale geometry (radius 0.4, height 1 -- i.e. ~1m, vastly bigger
  // than the ~2cm labyrinth) blew up the computed bounding sphere and wrecked the
  // camera framing for the ENTIRE scene the moment this was added, confirmed live
  // (radius came back ~0.75 instead of the expected ~0.02). The old THREE.ArrowHelper
  // this replaced started at length=0 for the same reason.
  mesh.scale.set(0, 0, 0);
  return mesh;
}

/** Cupula-beta-to-scroll-phase gain for the duct/ampulla flow-band shader (see
 * makeCupulaMaterial's sibling flow-uniform wiring in loadRealAnatomy) -- a
 * visualization-only scroll speed, not a physical fluid velocity. */
const FLOW_SCROLL_SPEED = 40;

/**
 * Orientation gizmo (see buildGizmo/renderGizmo) -- reintroduced from the pre-VOR app
 * (see that app's own doc comment, git commit 35b847a) per direct user request ("look
 * at the old gimbal and just replicate that"): a small always-visible axis triad
 * rendered into a corner viewport of the SAME canvas/renderer (the standard "navigation
 * cube" technique used by Blender/CAD/ParaView viewports), labeling anterior/posterior/
 * superior/inferior/lateral/medial. Rotates WITH the anatomy every frame (mirrors
 * labyrinthGroup's current world rotation), unlike a fixed corner label, so it stays
 * correct as the head turns.
 */
const GIZMO_SIZE_PX = 64;
const GIZMO_MARGIN_PX = 6;
const GIZMO_AXIS_LENGTH = 1;
const GIZMO_CAMERA_DISTANCE = 3;
const GIZMO_COLOR_AP = 0xd9756a;
const GIZMO_COLOR_SI = 0x6aa8d9;
const GIZMO_COLOR_LATMED = 0x6ad98a;

const COLOR_REST = new THREE.Color(0x9aa3ab);
/**
 * Firing-rate delta (Hz, from baseline) at which the excite/inhibit color reaches FULL
 * saturation. Deliberately much smaller than the physiological ceiling/floor's full range
 * (FIRING_CEILING_HZ - FIRING_BASELINE_HZ = 310Hz, FIRING_BASELINE_HZ = 90Hz) -- lerping
 * over that full range meant an ordinary moderate head turn (tens of Hz of delta) barely
 * nudged the color, reading as "no visible change" against the base tint. This value is a
 * visualization choice (how sensitive the color should look), not a physiological one.
 * Lowered from 60 -- even with the cupula as the primary indicator (see cupulaMaterials),
 * reported live as still too subtle at 60; a smaller saturation window means an ordinary
 * head turn now reaches much closer to full red/blue.
 */
const COLOR_SATURATION_HZ = 30;

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
  /** One material per canal (not one shared instance) so the cupula's primary
   * excite/inhibit swing (see setFiringRates) can differ per canal, same reasoning as
   * ductMaterials above. */
  private readonly cupulaMaterials: Record<CanalType, THREE.MeshPhysicalMaterial> = {} as Record<
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
   * different distances/targets, so the camera never re-orients, only glides.
   *
   * A per-side camera-angle offset was tried here (to stop the two ear panels' Micro
   * fluid view close-ups from reading as mirror images of each other at the shared
   * panel boundary) and reverted the same day -- it changed the fluid/head arrows'
   * on-screen READING (reported live as "now incorrect") even though their underlying
   * direction vectors/signs were untouched, since rotating the camera changes how a
   * fixed 3D arrow direction projects visually. Arrow-direction correctness takes
   * priority over that cosmetic mirror-symmetry concern, so both ear panels use this
   * same fixed angle. */
  private readonly viewDir = new THREE.Vector3(1, 0.25, 0);
  /** "Lateral view" mode's camera direction -- the ORIGINAL default this scene used
   * before it was switched to the anterior-facing viewDir above (see that constant's
   * git history), brought back as a selectable alternative rather than replaced
   * outright: some users want the horizontal canal face-on (this), others the
   * front-on view matching the head model (viewDir) -- see setViewMode/main.ts's "Ear
   * view" toggle. Side-dependent (unlike viewDir) since it's a lateral offset, which
   * needs to point outward from the head on each side, not a shared anterior direction. */
  private readonly lateralViewDir: THREE.Vector3;
  /** Which of the two camera directions above the OVERVIEW (not Micro fluid view's own
   * separate zoom logic) currently uses -- see setViewMode. */
  private overviewViewMode: 'head' | 'lateral' = 'head';

  // Orientation gizmo -- see GIZMO_SIZE_PX's doc comment. A separate scene/camera (not a
  // child of labyrinthGroup/scene) so it can be drawn into its own small corner
  // viewport of the same canvas independently of the main render's camera/target/zoom.
  private readonly gizmoScene = new THREE.Scene();
  private readonly gizmoCamera = new THREE.OrthographicCamera(-1.4, 1.4, 1.4, -1.4, 0.1, 10);
  /** Outer group -- receives ONLY the live head-orientation rotation each frame (see
   * renderGizmo), mirroring headGroup.quaternion, which is always a pure rotation (no
   * reflection) since qHead itself isn't mirrored. */
  private readonly gizmoGroup = new THREE.Group();
  /** Inner, static child of gizmoGroup -- carries the left-ear MIRROR as an actual
   * scale transform, same split as labyrinthGroup/headGroup. This split matters
   * specifically because a quaternion CANNOT represent a reflection (determinant -1):
   * an earlier version of this gizmo tried to mirror it by extracting
   * labyrinthGroup.getWorldQuaternion() directly, which silently discards the mirror
   * (quaternions only ever encode pure rotations), so the left ear's gizmo rendered
   * identically to the right ear's instead of mirrored -- confirmed live (both showed
   * "Lat" on the same screen side). Splitting the mirror out as a real scale on this
   * child group, structurally separate from the live rotation on the parent, sidesteps
   * that entirely. */
  private readonly gizmoStaticGroup = new THREE.Group();

  // Fluid/head-motion overlay arrows (see setFluidVisuals) -- need this scene's own
  // `side` for the physics sign conventions (CANAL_PLANE_NORMAL/AMPULLOFUGAL_SIGN are
  // side-dependent even though the mesh geometry itself is shared right-ear data,
  // mirrored by labyrinthGroup.scale.y).
  private readonly flowPhaseUniforms: Partial<Record<CanalType, { value: number }>> = {};
  /** Shared by every canal's duct/ampulla material (see canalColorMaterial's
   * onBeforeCompile) -- 1 shows the flow-band overlay, 0 hides it entirely. One toggle
   * for the whole scene, not per-canal: users found the effect "overwhelming... useful
   * for teaching but not nice to look at all the time" and wanted a single on/off, not
   * a busier per-canal control -- see main.ts's flow-shading toggle. */
  private readonly flowIntensityUniform = { value: 0 };
  // Simple custom cone meshes, NOT THREE.ArrowHelper -- ArrowHelper splits into two
  // child objects (a Line "shaft" + a Mesh "head") that share geometry cached at the
  // library level, and one of the two (the cone) was found live to silently submit its
  // triangles to the GPU (confirmed via renderer.info.render.triangles) while producing
  // ZERO visible pixels (confirmed via direct WebGL readPixels) -- extensive live
  // debugging (matrix/material/geometry all checked valid) never isolated why, so
  // rather than keep chasing an ArrowHelper-specific quirk, this sidesteps it with a
  // single ordinary cone Mesh per arrow instead. See makeIndicatorCone.
  private readonly fluidArrow = makeIndicatorCone(FLUID_ARROW_COLOR);
  private readonly headArrow = makeIndicatorCone(HEAD_ARROW_COLOR);
  /** Smoothed head-arrow driving value, per canal (see HEAD_ARROW_SMOOTHING). */
  private readonly headArrowSmoothed: Partial<Record<CanalType, number>> = {};

  constructor(canvas: HTMLCanvasElement, private readonly side: EarSide) {
    this.renderer = createRenderer(canvas);
    this.scene.add(...makeAmbientAndKeyLight());
    this.lateralViewDir = new THREE.Vector3(0, 0.25, side === 'left' ? -1 : 1);

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
    // clot marker. Already built hidden, depthTest-disabled, and high-renderOrder (see
    // makeIndicatorCone) -- the depthTest/renderOrder combination is what lets them
    // render on top of the translucent utricle/common-crus/saccule context meshes
    // (which are never hidden by setFocusedCanal, so they'd otherwise blend back over
    // an arrow positioned near them).
    this.labyrinthGroup.add(this.fluidArrow, this.headArrow);

    this.buildGizmo();

    this.loadRealAnatomy();
  }

  /**
   * Builds the orientation gizmo's three axis pairs -- anterior (+X), superior (+Z),
   * and lateral. All three are expressed as RAW right-ear HeadFrame vectors (the
   * lateral pair always -Y, the RIGHT ear's true lateral direction, regardless of this
   * scene's own side) -- the SAME convention as ductTangent(canal,'right',...)/
   * CANAL_PLANE_NORMAL[canal]['right'] elsewhere in this file: mirroring for the left
   * ear is handled structurally, by gizmoStaticGroup's own scale (see its doc comment),
   * not by flipping vector components here. Attached to gizmoStaticGroup (not
   * gizmoGroup directly) so that mirror scale actually applies to them.
   */
  private buildGizmo(): void {
    const anteriorDir = new THREE.Vector3(1, 0, 0);
    const superiorDir = new THREE.Vector3(0, 0, 1);
    const lateralDir = new THREE.Vector3(0, -1, 0);
    this.gizmoStaticGroup.add(this.makeGizmoAxisPair(anteriorDir, 'A', 'P', GIZMO_COLOR_AP));
    this.gizmoStaticGroup.add(this.makeGizmoAxisPair(superiorDir, 'S', 'I', GIZMO_COLOR_SI));
    this.gizmoStaticGroup.add(this.makeGizmoAxisPair(lateralDir, 'Lat', 'Med', GIZMO_COLOR_LATMED));
    this.gizmoStaticGroup.quaternion.copy(HEAD_FRAME_TO_THREE);
    this.gizmoStaticGroup.scale.y = this.side === 'left' ? -1 : 1;
    this.gizmoGroup.add(this.gizmoStaticGroup);
    this.gizmoScene.add(this.gizmoGroup);
  }

  /** One bidirectional axis line plus its two end labels, for the orientation gizmo. */
  private makeGizmoAxisPair(dir: THREE.Vector3, posLabel: string, negLabel: string, color: number): THREE.Group {
    const group = new THREE.Group();
    const geometry = new THREE.BufferGeometry().setFromPoints([
      dir.clone().multiplyScalar(-GIZMO_AXIS_LENGTH),
      dir.clone().multiplyScalar(GIZMO_AXIS_LENGTH),
    ]);
    const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color }));
    group.add(line);
    const posSprite = this.makeGizmoLabel(posLabel, color);
    posSprite.position.copy(dir.clone().multiplyScalar(GIZMO_AXIS_LENGTH * 1.3));
    group.add(posSprite);
    const negSprite = this.makeGizmoLabel(negLabel, color);
    negSprite.position.copy(dir.clone().multiplyScalar(-GIZMO_AXIS_LENGTH * 1.3));
    group.add(negSprite);
    return group;
  }

  /** Text sprite (canvas-texture billboard) for one gizmo axis-end label. */
  private makeGizmoLabel(text: string, color: number): THREE.Sprite {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 64;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
    ctx.font = 'bold 44px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);
    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(0.9, 0.45, 1);
    return sprite;
  }

  /**
   * Draws the orientation gizmo into a small corner viewport of the SAME canvas/renderer,
   * after the main scene render -- the standard technique (Blender/CAD viewport nav
   * cubes) for an inset that doesn't need its own canvas element. Two things track the
   * main view every frame: gizmoGroup's rotation mirrors headGroup's current (live head
   * orientation) rotation -- the static HEAD_FRAME_TO_THREE conversion and left-ear
   * mirror live separately on gizmoStaticGroup's own fixed transform (see its doc
   * comment for why) -- and gizmoCamera's rotation mirrors the main camera's rotation
   * (so the mini triad's
   * on-screen layout always matches what the main viewport is actually looking at,
   * including the Head-orientation/Lateral-view angle and Micro fluid view's own zoom)
   * -- only gizmoCamera's fixed DISTANCE differs from the main camera, since the gizmo
   * has its own small orthographic frustum.
   */
  private renderGizmo(): void {
    // headGroup.quaternion only (a pure rotation, safe to copy directly) -- NOT
    // labyrinthGroup's world quaternion, which would silently drop the left ear's
    // mirror (see gizmoStaticGroup's doc comment). The mirror is instead already baked
    // into gizmoStaticGroup's own fixed scale, exactly like labyrinthGroup/headGroup.
    this.gizmoGroup.quaternion.copy(this.headGroup.quaternion);
    this.gizmoCamera.quaternion.copy(this.camera.quaternion);
    this.gizmoCamera.position
      .set(0, 0, 1)
      .applyQuaternion(this.camera.quaternion)
      .multiplyScalar(GIZMO_CAMERA_DISTANCE);

    const canvas = this.renderer.domElement;
    const cssWidth = canvas.clientWidth;
    const cssHeight = canvas.clientHeight;
    // setViewport/setScissor take the SAME "logical" (CSS-pixel) units as setSize, not
    // raw drawing-buffer pixels -- three.js applies the renderer's pixel ratio internally.
    const size = Math.max(0, Math.min(GIZMO_SIZE_PX, cssWidth * 0.3, cssHeight * 0.3));
    const x = cssWidth - size - GIZMO_MARGIN_PX;
    const y = cssHeight - size - GIZMO_MARGIN_PX; // three.js viewport/scissor origin is bottom-left

    this.renderer.setScissorTest(true);
    this.renderer.setScissor(x, y, size, size);
    this.renderer.setViewport(x, y, size, size);
    // Depth only -- the main render's color buffer should show through around/behind the
    // gizmo's own small square, only that square's own depth needs resetting so the
    // gizmo's axis lines/labels aren't depth-tested against the (unrelated) main scene.
    this.renderer.clearDepth();
    this.renderer.render(this.gizmoScene, this.gizmoCamera);
    this.renderer.setScissorTest(false);
    this.renderer.setViewport(0, 0, cssWidth, cssHeight);
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
      const flowUniform = flowCanal ? this.flowPhaseUniforms[flowCanal] ?? { value: 0 } : null;
      const flowAxis = flowCanal ? ductTangent(flowCanal, 'right', 0) : null;
      if (flowCanal && flowUniform) {
        this.flowPhaseUniforms[flowCanal] = flowUniform;
      }
      material.onBeforeCompile = (shader) => {
        // Fresnel rim darkening -- applied to every duct/cupula mesh unconditionally
        // (not just the flow-carrying canals) so the whole set gets a consistent
        // silhouette-depth cue. See RIM_DARKEN_STRENGTH's doc comment.
        shader.uniforms.uRimStrength = { value: RIM_DARKEN_STRENGTH };
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nvarying vec3 vRimViewDir;\nvarying vec3 vRimNormal;')
          .replace(
            '#include <begin_vertex>',
            '#include <begin_vertex>\n vRimNormal = normalize(normalMatrix * normal);\n vRimViewDir = normalize(-(modelViewMatrix * vec4(position, 1.0)).xyz);'
          );
        shader.fragmentShader = shader.fragmentShader
          .replace(
            '#include <common>',
            '#include <common>\nuniform float uRimStrength;\nvarying vec3 vRimViewDir;\nvarying vec3 vRimNormal;'
          )
          .replace(
            '#include <dithering_fragment>',
            `
  float rimFresnel = 1.0 - clamp(dot(normalize(vRimNormal), normalize(vRimViewDir)), 0.0, 1.0);
  gl_FragColor.rgb *= 1.0 - rimFresnel * uRimStrength;
  #include <dithering_fragment>`
          );

        // Endolymph-flow illustration: a moving band pattern travelling along this
        // canal's own duct-tangent-at-the-ampulla axis (a fixed direction, not a true
        // per-vertex tangent field along the whole curved duct -- a simplification, see
        // this constant's own doc comment) -- phase driven by cupula beta (ampullofugal-
        // signed, same convention as vorEngine.ts), not raw instantaneous head velocity,
        // so it decays/persists the same way the cupula membrane's own skew does.
        if (flowCanal && flowUniform && flowAxis) {
          const axis = new THREE.Vector3(flowAxis[0], flowAxis[1], flowAxis[2]);
          shader.uniforms.uFlowPhase = flowUniform;
          shader.uniforms.uFlowAxis = { value: axis };
          shader.uniforms.uFlowIntensity = this.flowIntensityUniform;
          shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\nuniform vec3 uFlowAxis;\nvarying float vFlowCoord;')
            .replace('#include <begin_vertex>', '#include <begin_vertex>\n vFlowCoord = dot(position, uFlowAxis);');
          shader.fragmentShader = shader.fragmentShader
            .replace(
              '#include <common>',
              '#include <common>\nuniform float uFlowPhase;\nuniform float uFlowIntensity;\nvarying float vFlowCoord;'
            )
            .replace(
              '#include <dithering_fragment>',
              `
  // Narrow, dark bands (not the earlier wide bright ones, which read as a lens-flare
  // wash and buried the underlying anatomy) -- higher frequency for more/thinner bands,
  // a tight smoothstep window so each band stays a crisp line rather than a broad glow,
  // and DARKENING (multiply down) instead of ADDING brightness so the duct's own
  // excite/inhibit color and the mesh's shading underneath both stay legible.
  // uFlowIntensity (0 or 1, see main.ts's flow-shading toggle) lets this be turned off
  // entirely -- reported live as "overwhelming... useful for teaching but not nice to
  // look at all the time".
  float flowBand = smoothstep(0.94, 1.0, sin(vFlowCoord * 2400.0 - uFlowPhase));
  gl_FragColor.rgb *= 1.0 - flowBand * 0.55 * uFlowIntensity;
  #include <dithering_fragment>`
            );
        }
      };
      return material;
    };

    for (const canal of Object.keys(EAR_ANATOMY.canals) as CanalType[]) {
      this.ductMaterials[canal] = canalColorMaterial(CANAL_TINT[canal] ?? 0xdfeaf2, DUCT_OPACITY, canal);
      // No glow until the first setFiringRates call -- canalColorMaterial defaults
      // .emissive to the same value as .color at full intensity (right for the
      // non-signal-carrying materials that also use this factory, e.g. COMMON_CRUS_GLASS
      // below), which would otherwise flash the duct as an unwanted extra-bright
      // color-doubled glow before any real firing rate has landed.
      this.ductMaterials[canal].emissive.set(0x000000);
      this.ductMaterials[canal].emissiveIntensity = 0;
      // Fixed high-visibility color, not touched by setFiringRates -- see CUPULA_COLOR's
      // doc comment for why this reverted from a per-canal excite/inhibit signal.
      this.cupulaMaterials[canal] = new THREE.MeshPhysicalMaterial({
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
    }
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
          if (child instanceof THREE.Mesh) child.material = this.cupulaMaterials[canal];
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
      const dir = this.overviewViewMode === 'lateral' ? this.lateralViewDir : this.viewDir;
      this.camera.position.copy(this.overviewTarget).addScaledVector(dir, distance);
      this.camera.lookAt(this.overviewTarget);
    }
  }

  /** Switches the whole-labyrinth OVERVIEW's camera angle -- 'head' (default, matches
   * the head model's own front-on view) or 'lateral' (this scene's original default,
   * before that change, showing the horizontal canal face-on -- brought back as a
   * selectable option per user request, not a replacement). Doesn't affect Micro fluid
   * view's own separate zoom/angle logic. Applied on the NEXT fitCamera/
   * updateCameraFocus call, not instantly, so it glides like any other camera change
   * here rather than snapping. */
  setOverviewMode(mode: 'head' | 'lateral'): void {
    this.overviewViewMode = mode;
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
    // Went 0.045 (reported "way too zoomed in", clipped through neighboring geometry)
    // -> 0.11 -> widened again here per further feedback wanting more of the ampulla
    // head and leading duct visible, not just the cupula itself.
    const MICRO_ZOOM_DISTANCE_FACTOR = 0.16;
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
    // Micro fluid view always uses the fixed anterior viewDir (arrow-direction
    // correctness depends on a consistent angle there -- see viewDir's own doc
    // comment); only the whole-labyrinth OVERVIEW respects the "Ear view" mode toggle.
    const dir = this.focusedCanal ? this.viewDir : this.overviewViewMode === 'lateral' ? this.lateralViewDir : this.viewDir;
    this.camera.position.copy(this.currentLookTarget).addScaledVector(dir, this.currentDistance);
    this.camera.lookAt(this.currentLookTarget);
  }

  /**
   * Glows each canal's duct+ampulla mesh red (excited) or blue (inhibited) by its current
   * firing rate (Hz), ON TOP OF its fixed CANAL_TINT identity color -- `.color` (the lit
   * albedo) is set once at material creation and never touched here; only
   * `.emissive`/`.emissiveIntensity` (additive self-illumination) respond to firing rate,
   * at zero intensity (no glow) at baseline (~FIRING_BASELINE_HZ) ramping up to
   * GLOW_MAX_INTENSITY at +-COLOR_SATURATION_HZ from baseline (not the physiological
   * floor/ceiling -- see that constant's doc comment for why). FIRING_BASELINE_HZ is still
   * imported from physics/params.ts (not a second hardcoded copy) so the REST point stays
   * consistent with the physics engine's own scale.
   *
   * Two prior approaches (full hue crossfade, then HSL lightness/saturation shift -- see
   * GLOW_MAX_INTENSITY's doc comment) are superseded by this one: an additive colored glow
   * reads as strongly as the original red/blue crossfade while leaving the base albedo
   * (and therefore per-canal identity) completely untouched.
   */
  setFiringRates(rates: Record<CanalType, number>): void {
    for (const canal of Object.keys(rates) as CanalType[]) {
      const hz = rates[canal];
      const t = Math.max(-1, Math.min(1, (hz - FIRING_BASELINE_HZ) / COLOR_SATURATION_HZ));
      const magnitude = Math.pow(Math.abs(t), DUCT_SIGNAL_EASE_EXPONENT);
      const glowColor = t >= 0 ? COLOR_EXCITED : COLOR_INHIBITED;

      const material = this.ductMaterials[canal];
      if (!material) continue;
      material.emissive.copy(glowColor);
      material.emissiveIntensity = magnitude * GLOW_MAX_INTENSITY;
    }
  }

  /** Shows/hides the duct/ampulla flow-band overlay (see canalColorMaterial's
   * onBeforeCompile) across every canal in this scene. Off by default (see
   * flowIntensityUniform's own doc comment) -- a deliberate teaching-moment toggle, not
   * a permanent visual. */
  setFlowShadingEnabled(enabled: boolean): void {
    this.flowIntensityUniform.value = enabled ? 1 : 0;
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
        // Negated -- verified live (comparing the mesh's actual world displacement
        // against the fluid arrow's direction via their dot product) that the
        // un-negated rotation tilted the cupula AGAINST the endolymph flow direction,
        // not with it. The infinitesimal-rotation derivation this hinge axis was built
        // from (cross(tangent, base->apex stem)) assumed the mesh's bulk sits along the
        // stem direction from the pivot -- true for an idealized disc, but not
        // necessarily for the real Cup_Wall mesh's actual shape/centroid, which is
        // presumably why the sign came out backwards in practice.
        const deg = -THREE.MathUtils.clamp(beta, -CUPULA_TILT_CLAMP, CUPULA_TILT_CLAMP) * CUPULA_TILT_DEG_PER_BETA;
        pivot.quaternion.setFromAxisAngle(hingeAxis, THREE.MathUtils.degToRad(deg));
      }
    }

    const canal = this.focusedCanal;
    const anchor = canal ? this.ampullaLocalPositions[canal] : undefined;
    if (!canal || !anchor) {
      this.fluidArrow.visible = false;
      this.headArrow.visible = false;
      for (const c of Object.keys(this.headArrowSmoothed) as CanalType[]) this.headArrowSmoothed[c] = 0;
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

    // Fluid (endolymph) arrow: anchored right at the ampulla/cupula (that's what it's
    // annotating), driven by the LAGGED cupula beta, so it keeps pointing (and shrinks
    // only gradually, over cupula.ts's tau) even after the head stops -- this is what
    // actually reproduces the "endolymph momentum" teaching point, not any
    // special-cased "sudden stop" logic.
    this.setOverlayArrow(this.fluidArrow, anchor, tangentVec, beta);

    // Head/wall-motion arrow: reported live as sitting right on top of the anatomy at
    // the ampulla anchor, competing visually with the cupula/duct it was overlapping --
    // moved to a fixed point below the focused canal, outside the ring, near the bottom
    // of the camera's current view (currentDistance-scaled so it stays proportionally
    // placed whether zoomed in or out). Driven by the INSTANTANEOUS rotational flow, so
    // it disappears immediately once the head actually stops, unlike the fluid arrow
    // above. Deliberately the OPPOSITE sign from the fluid arrow's beta -- physically,
    // the wall moves opposite to the fluid's RELATIVE (ampullofugal-positive) lag
    // direction (see physics/canal.ts's AMPULLOFUGAL_SIGN doc comment).
    // Anchored at currentLookTarget (the frame's own center, X/Z as well as Y), NOT the
    // ampulla anchor -- using the ampulla anchor's X/Z here left the arrow offset toward
    // whichever side that anchor happened to sit on within the frame, not centered in
    // the empty space below the model (reported live). currentLookTarget IS the point
    // the camera looks straight at, so offsetting only its Y is what actually centers
    // the arrow horizontally in the visible frame.
    // 0.32 (not the whole currentDistance) -- currentDistance is the CAMERA's distance
    // along viewDir from the look target, not the frame's own vertical half-extent;
    // offsetting by the full distance shot the arrow well outside the visible frustum
    // (confirmed live: computed position was ~2x the frame's actual vertical extent at
    // that distance, i.e. entirely off-screen). ~0.35x the distance approximates the
    // frame's vertical half-extent at this camera's 45deg FOV (tan(22.5deg) ~= 0.41),
    // staying just inside the visible bottom edge instead of at/past it.
    const headArrowPos = this.currentLookTarget.clone().addScaledVector(new THREE.Vector3(0, -1, 0), this.currentDistance * 0.32);
    // Smoothed (see HEAD_ARROW_SMOOTHING's doc comment), not the raw instantaneous
    // -rotationalFlow directly -- otherwise a single noisy/bursty velocity sample can
    // make the arrow flash for under a frame, too fast to actually see.
    const prevSmoothed = this.headArrowSmoothed[canal] ?? 0;
    const smoothedHeadValue = prevSmoothed + (-rotationalFlow - prevSmoothed) * HEAD_ARROW_SMOOTHING;
    this.headArrowSmoothed[canal] = smoothedHeadValue;
    this.setOverlayArrow(this.headArrow, headArrowPos, tangentVec, smoothedHeadValue);
  }

  /** Shared helper for the two overlay arrows in setFluidVisuals -- both point along the
   * same duct-tangent axis and share one length fraction (ARROW_INPUT_CLAMP keeps their
   * driving values on the same domain first, so the two end up genuinely comparable in
   * size, not just nominally sharing a constant -- see ARROW_LENGTH_FRACTION's doc
   * comment), only their position and driving value differ. Length is a FRACTION of
   * the camera's current distance-to-target, not a fixed meters constant -- see that
   * same doc comment for why. */
  private setOverlayArrow(arrow: THREE.Mesh, position: THREE.Vector3, tangentVec: THREE.Vector3, signedValue: number): void {
    const clamped = THREE.MathUtils.clamp(signedValue, -ARROW_INPUT_CLAMP, ARROW_INPUT_CLAMP);
    const length = (Math.abs(clamped) / ARROW_INPUT_CLAMP) * this.currentDistance * ARROW_LENGTH_FRACTION;
    arrow.visible = length > 1e-9;
    if (!arrow.visible) {
      arrow.scale.set(0, 0, 0);
      return;
    }
    arrow.position.copy(position);
    const direction = tangentVec.clone().multiplyScalar(Math.sign(clamped) || 1).normalize();
    arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
    arrow.scale.set(length * 0.5, length, length * 0.5);
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
    this.renderGizmo();
  }
}

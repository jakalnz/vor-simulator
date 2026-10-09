import { Quat, Vec3, angularVelocityBody, v3, rotateVec, quatInvert } from './physics/types';
import { CanalType, EarSide, ALL_CANAL_TYPES } from './physics/canal';
import { CanalFunction, normalCanalFunction, withCanalFunction } from './physics/pathology';
import { VorEngineState, initialVorEngineState, stepVorEngine, PerCanalSide } from './physics/vorEngine';
import { CanalithState, initialCanalithState, stepCanalith, sMax, BppvSelection } from './physics/canalith';
import { CupulolithState, initialCupulolithState, stepCupulolith } from './physics/cupulolith';
import { G_WORLD } from './physics/params';
import QRCode from 'qrcode';

import { OrientationSource } from './sensors/orientationSource';
import { DeviceOrientationSource, requestOrientationPermission } from './sensors/deviceOrientation';
import { SampleRotationSpreader } from './sensors/sampleRotationSpreader';
import { MouseDragSource } from './sensors/mouseDragSource';

import { EyeScene } from './scene/eyeScene';
import { CanalScene } from './scene/canalScene';
import { HeadScene } from './scene/headScene';

import { Controls, PlaybackMode, ManeuverKey } from './ui/controls';
import { Maneuver } from './maneuvers/types';
import { ManeuverPlayer } from './maneuvers/playback';
import { dixHallpikeRight, dixHallpikeLeft } from './maneuvers/dixHallpike';
import {
  semontDiagnosticRight,
  semontDiagnosticLeft,
  semontLiberatoryRight,
  semontLiberatoryLeft,
} from './maneuvers/semont';
import { epleyRight, epleyLeft } from './maneuvers/epley';
import { rollTestRight, rollTestLeft } from './maneuvers/rollTest';
import { bbqRollRight, bbqRollLeft } from './maneuvers/bbqRoll';
import { zumaRight, zumaLeft } from './maneuvers/zuma';
import { VngTrace } from './ui/vngTrace';
import { CanalHexPlot } from './ui/canalHexPlot';
import { CanalDiffMeters } from './ui/canalDiffMeters';
import { keepScreenAwake } from './ui/wakeLock';
import { initTheme, toggleTheme } from './ui/theme';

keepScreenAwake();
initTheme();

const eyeCanvasLeft = document.getElementById('eye-canvas-left') as HTMLCanvasElement;
const eyeCanvasRight = document.getElementById('eye-canvas-right') as HTMLCanvasElement;
const canalCanvasLeft = document.getElementById('canal-canvas-left') as HTMLCanvasElement;
const canalCanvasRight = document.getElementById('canal-canvas-right') as HTMLCanvasElement;
const canalHexCanvas = document.getElementById('canal-hex-canvas') as HTMLCanvasElement;
const canalDiffMetersCanvas = document.getElementById('canal-diff-meters-canvas') as HTMLCanvasElement;
const headCanvas = document.getElementById('head-canvas') as HTMLCanvasElement;
const vngCanvas = document.getElementById('vng-canvas') as HTMLCanvasElement;
const controlsContainer = document.getElementById('controls') as HTMLDivElement;
const themeToggleBtn = document.getElementById('theme-toggle') as HTMLButtonElement;
themeToggleBtn.addEventListener('click', () => toggleTheme());

/**
 * Small one-off notification toast (fade in, auto-hide after a few seconds), one per
 * ear panel -- fires once on the rising edge of the debris clearing into the utricle
 * (see stepPhysicsOnce's clearedIntoUtricle check), not a persistent status label.
 */
function makeToast(elementId: string) {
  const el = document.getElementById(elementId) as HTMLDivElement;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  return {
    show(): void {
      el.hidden = false;
      // Force a layout flush before adding the class -- otherwise the browser can
      // coalesce the hidden->visible and opacity 0->1 changes into a single paint,
      // skipping the fade-in transition entirely.
      void el.offsetWidth;
      el.classList.add('show');
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        el.classList.remove('show');
        hideTimer = setTimeout(() => (el.hidden = true), 300);
      }, 3500);
    },
    hideImmediately(): void {
      clearTimeout(hideTimer);
      el.classList.remove('show');
      el.hidden = true;
    },
  };
}
const clearedToastLeft = makeToast('canal-cleared-toast-left');
const clearedToastRight = makeToast('canal-cleared-toast-right');
/** Fires once when a cupulolithiasis lesion detaches from the cupula (see
 * stepPhysicsOnce's cupulolithDetached handling) -- distinct from clearedToast*, which
 * fires once the now-mobile debris subsequently clears into the utricle, since those are
 * two separate clinical events for cupulolithiasis (contrast canalithiasis, which only
 * has the one). */
const detachedToastLeft = makeToast('canal-detached-toast-left');
const detachedToastRight = makeToast('canal-detached-toast-right');

// Fullscreen (Fullscreen API): on mobile, this hides the browser's own address bar/nav
// chrome, handing that vertical space to the viewport. Hidden entirely where unsupported
// (document.fullscreenEnabled is false, notably iOS Safari before iOS 16) rather than
// showing a button that would silently no-op.
const fullscreenToggleBtn = document.getElementById('fullscreen-toggle') as HTMLButtonElement;
if (!document.fullscreenEnabled) {
  fullscreenToggleBtn.style.display = 'none';
} else {
  fullscreenToggleBtn.addEventListener('click', () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      document.documentElement.requestFullscreen().catch(() => {});
    }
  });
  document.addEventListener('fullscreenchange', () => {
    const isFullscreen = document.fullscreenElement != null;
    fullscreenToggleBtn.classList.toggle('is-fullscreen', isFullscreen);
    const label = isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen';
    fullscreenToggleBtn.title = label;
    fullscreenToggleBtn.setAttribute('aria-label', label);
  });
}

const eyeSceneLeft = new EyeScene(eyeCanvasLeft);
const eyeSceneRight = new EyeScene(eyeCanvasRight);
const canalSceneLeft = new CanalScene(canalCanvasLeft, 'left');
const canalSceneRight = new CanalScene(canalCanvasRight, 'right');
const headScene = new HeadScene(headCanvas);
const vngTrace = new VngTrace(vngCanvas);
const canalHexPlot = new CanalHexPlot(canalHexCanvas);
const canalDiffMeters = new CanalDiffMeters(canalDiffMetersCanvas);

// Canal panel view toggle: 3D dual-ear model (default) vs. a hexagonal neural
// firing-rate plot showing all 6 canals at once (see ui/canalHexPlot.ts). Panel-local
// (not part of the Controls class) since it only affects this one panel's own content,
// same pattern as the removed canal-style/gravity-mode selects used to be.
const canalViewToggleBtn = document.getElementById('canal-view-toggle') as HTMLButtonElement;
const canalEarView = document.getElementById('canal-ear-view') as HTMLDivElement;
const canalHexView = document.getElementById('canal-hex-view') as HTMLDivElement;
const canalLegendEar = document.getElementById('canal-legend-ear') as HTMLDivElement;
const canalLegendHex = document.getElementById('canal-legend-hex') as HTMLDivElement;
let canalView: 'ear' | 'firing' = 'ear';
function applyCanalView(): void {
  const showFiring = canalView === 'firing';
  canalEarView.hidden = showFiring;
  canalHexView.hidden = !showFiring;
  canalLegendEar.hidden = showFiring;
  canalLegendHex.hidden = !showFiring;
  // Button shows the view a click would switch TO, same convention as this app's other
  // toggle-style buttons (e.g. the gyro on/off toggle).
  canalViewToggleBtn.textContent = showFiring ? 'Ear model' : 'Neural firing';
}
canalViewToggleBtn.addEventListener('click', () => {
  canalView = canalView === 'ear' ? 'firing' : 'ear';
  // The hex plot has no per-canal 3D camera to zoom -- micro view only makes sense over
  // the 3D ear model, so switching to it turns micro view back off rather than leaving
  // it in a state with nothing visible to show it.
  if (canalView === 'firing' && microZoomEnabled) {
    microZoomEnabled = false;
    applyMicroUI();
  }
  applyCanalView();
});
applyCanalView();

// "Micro fluid view" -- zooms each ear's own 3D camera in on the actively-stimulated
// canal's ampulla to demonstrate fluid microdynamics up close (see
// canalScene.ts's setFocusedCanal/updateCameraFocus for the actual camera glide).
// Auto/Horizontal/LARP/RALP mirrors the anatomical canal-PLANE pairing from claude.MD
// section 2.1 (LARP = Left Anterior + Right Posterior, RALP = Right Anterior + Left
// Posterior, coplanar pairs that share one functional axis) -- not this app's
// per-(canal,side) CanalType, which the physics engine models independently per ear.
type MicroPlane = 'horizontal' | 'larp' | 'ralp';
const PLANE_CANAL_BY_SIDE: Record<MicroPlane, Record<EarSide, CanalType>> = {
  horizontal: { left: 'horizontal', right: 'horizontal' },
  larp: { left: 'anterior', right: 'posterior' },
  ralp: { left: 'posterior', right: 'anterior' },
};
/** Combined (both ears') firing-rate deviation from baseline a plane needs before "Auto"
 * treats it as the actively-stimulated plane, rather than chasing sensor/engine noise
 * around near-rest -- a visualization tuning choice, not a physiological threshold. */
const MICRO_AUTO_ACTIVATION_THRESHOLD_HZ = 3;

const canalMicroToggleBtn = document.getElementById('canal-micro-toggle') as HTMLButtonElement;
const canalMicroSubmenu = document.getElementById('canal-micro-submenu') as HTMLDivElement;
let microZoomEnabled = false;
let microPlaneMode: 'auto' | MicroPlane = 'auto';
/** In 'auto' mode, sticks with the last actively-stimulated plane while the head is
 * momentarily still (deviation below threshold) rather than snapping back out to the
 * overview -- matches the reference spec's "stay at last position if head stationary". */
let lastAutoPlane: MicroPlane | null = null;

// Endolymph flow-band overlay toggle -- only meaningful (and only offered) inside Micro
// fluid view: the bands are a close-up teaching detail, and showing the control while
// zoomed out to the whole-labyrinth overview just added clutter with nothing to explain
// it. Declared here (ahead of applyMicroUI, which shows/hides it) rather than down by
// its own click handler below.
const canalFlowShadingToggleBtn = document.getElementById('canal-flow-shading-toggle') as HTMLButtonElement;
let flowShadingEnabled = false;

function applyMicroUI(): void {
  canalMicroSubmenu.hidden = !microZoomEnabled;
  canalMicroToggleBtn.classList.toggle('is-active', microZoomEnabled);
  canalMicroToggleBtn.textContent = microZoomEnabled ? 'Exit micro view' : 'Micro fluid view';
  canalFlowShadingToggleBtn.hidden = !microZoomEnabled;
  if (!microZoomEnabled) {
    lastAutoPlane = null;
    canalSceneLeft.setFocusedCanal(null);
    canalSceneRight.setFocusedCanal(null);
    // Also turn the effect itself off on exit, not just hide the control -- otherwise
    // it would keep running invisibly and reappear already-on next time Micro view opens.
    if (flowShadingEnabled) {
      flowShadingEnabled = false;
      canalSceneLeft.setFlowShadingEnabled(false);
      canalSceneRight.setFlowShadingEnabled(false);
      canalFlowShadingToggleBtn.classList.remove('is-active');
      canalFlowShadingToggleBtn.textContent = 'Flow shading: Off';
    }
  }
}
canalMicroToggleBtn.addEventListener('click', () => {
  microZoomEnabled = !microZoomEnabled;
  if (microZoomEnabled && canalView !== 'ear') {
    canalView = 'ear';
    applyCanalView();
  }
  applyMicroUI();
});
applyMicroUI();

for (const btn of canalMicroSubmenu.querySelectorAll<HTMLButtonElement>('button[data-plane]')) {
  btn.addEventListener('click', () => {
    microPlaneMode = btn.dataset.plane as 'auto' | MicroPlane;
    for (const other of canalMicroSubmenu.querySelectorAll('button')) other.classList.remove('is-active');
    btn.classList.add('is-active');
  });
}

canalSceneLeft.setFlowShadingEnabled(flowShadingEnabled);
canalSceneRight.setFlowShadingEnabled(flowShadingEnabled);
canalFlowShadingToggleBtn.addEventListener('click', () => {
  flowShadingEnabled = !flowShadingEnabled;
  canalSceneLeft.setFlowShadingEnabled(flowShadingEnabled);
  canalSceneRight.setFlowShadingEnabled(flowShadingEnabled);
  canalFlowShadingToggleBtn.classList.toggle('is-active', flowShadingEnabled);
  canalFlowShadingToggleBtn.textContent = `Flow shading: ${flowShadingEnabled ? 'On' : 'Off'}`;
});

// Display submenu, View group -- 'head' (default, matches the head model's own front-on view) or
// 'lateral' (this app's ORIGINAL default before that change, showing the horizontal
// canal face-on -- brought back as a selectable option, not a replacement). Independent
// of Micro fluid view, which always keeps its own fixed zoom angle regardless of this.
const canalOrientToggleBtn = document.getElementById('canal-orient-toggle') as HTMLButtonElement;
const canalOrientSubmenu = document.getElementById('canal-orient-submenu') as HTMLDivElement;
let orientSubmenuOpen = false;

canalOrientToggleBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  orientSubmenuOpen = !orientSubmenuOpen;
  canalOrientSubmenu.hidden = !orientSubmenuOpen;
});
document.addEventListener('click', (e) => {
  if (orientSubmenuOpen && e.target !== canalOrientToggleBtn && !canalOrientSubmenu.contains(e.target as Node)) {
    orientSubmenuOpen = false;
    canalOrientSubmenu.hidden = true;
  }
});
/** Wires one labelled option group in the "Display" submenu: marks the clicked button
 * active among its OWN group's siblings only (the other groups keep their selection),
 * and leaves the submenu open so several options can be set in one go. */
function wireDisplayGroup(attr: string, onSelect: (value: string) => void): void {
  const buttons = canalOrientSubmenu.querySelectorAll<HTMLButtonElement>(`button[data-${attr}]`);
  for (const btn of buttons) {
    btn.addEventListener('click', () => {
      for (const other of buttons) other.classList.remove('is-active');
      btn.classList.add('is-active');
      onSelect(btn.dataset[attr]!);
    });
  }
}

wireDisplayGroup('orient', (value) => {
  const mode = value as 'head' | 'lateral';
  canalSceneLeft.setOverviewMode(mode);
  canalSceneRight.setOverviewMode(mode);
});

// Single-ear option -- hides the other ear's pane so the remaining one fills the panel
// width (its CanalScene refits to the new aspect on its next render; see render()'s
// resize check). renderFrame skips rendering the hidden scene, but every other per-frame
// setter still runs for both, so switching back is seamless.
const canalPaneLeft = document.getElementById('canal-pane-left') as HTMLDivElement;
const canalPaneRight = document.getElementById('canal-pane-right') as HTMLDivElement;
let earsShown: 'both' | EarSide = 'both';
wireDisplayGroup('ears', (value) => {
  earsShown = value as 'both' | EarSide;
  canalPaneLeft.hidden = earsShown === 'right';
  canalPaneRight.hidden = earsShown === 'left';
});

const canalLegendCupulaLabel = document.getElementById('canal-legend-cupula-label') as HTMLSpanElement;
wireDisplayGroup('signal', (value) => {
  const signal = value as 'duct' | 'cupula';
  canalSceneLeft.setSignalMode(signal);
  canalSceneRight.setSignalMode(signal);
  canalLegendCupulaLabel.textContent = signal === 'cupula' ? 'Cupula (at rest)' : 'Cupula';
});

wireDisplayGroup('otoconia', (value) => {
  const size = value as 'regular' | 'large';
  canalSceneLeft.setOtoconiaSize(size);
  canalSceneRight.setOtoconiaSize(size);
});

wireDisplayGroup('envelope', (value) => {
  canalSceneLeft.setEnvelopeVisible(value === 'shown');
  canalSceneRight.setEnvelopeVisible(value === 'shown');
});

/** Combined (left+right) firing-rate deviation from baseline for one canal PLANE --
 * horizontal is that canal on both ears, LARP/RALP each combine two DIFFERENT canal
 * types across the two ears (see PLANE_CANAL_BY_SIDE's doc comment). */
function planeActivation(rates: typeof lastFiringRates, plane: MicroPlane): number {
  const canals = PLANE_CANAL_BY_SIDE[plane];
  return Math.abs(rates[canals.left].left - 90) + Math.abs(rates[canals.right].right - 90);
}

/** Picks whichever plane has the largest combined deviation from baseline, or null if
 * none clears MICRO_AUTO_ACTIVATION_THRESHOLD_HZ (head roughly stationary). */
function computeAutoActivePlane(rates: typeof lastFiringRates): MicroPlane | null {
  let best: MicroPlane | null = null;
  let bestScore = MICRO_AUTO_ACTIVATION_THRESHOLD_HZ;
  for (const plane of ['horizontal', 'larp', 'ralp'] as MicroPlane[]) {
    const score = planeActivation(rates, plane);
    if (score > bestScore) {
      bestScore = score;
      best = plane;
    }
  }
  return best;
}

// About popover -- cites the academic source for the real-anatomy meshes (IE-Map).
const canalAboutPill = document.getElementById('canal-about-pill') as HTMLButtonElement;
const canalAboutPopover = document.getElementById('canal-about-popover') as HTMLDivElement;
const aboutQrCanvas = document.getElementById('about-qr-canvas') as HTMLCanvasElement;
let aboutQrRendered = false;
canalAboutPill.addEventListener('click', () => {
  const opening = canalAboutPopover.hidden;
  canalAboutPopover.hidden = !opening;
  if (opening) {
    const rect = canalAboutPill.getBoundingClientRect();
    canalAboutPopover.style.top = `${rect.bottom + 4}px`;
    canalAboutPopover.style.right = `${window.innerWidth - rect.right}px`;
    if (!aboutQrRendered) {
      aboutQrRendered = true;
      QRCode.toCanvas(aboutQrCanvas, 'https://jakalnz.github.io/vor-simulator/', { width: 132, margin: 1 }).catch(
        () => {
          aboutQrRendered = false;
        }
      );
    }
  }
});
document.addEventListener('click', (e) => {
  if (
    !canalAboutPopover.hidden &&
    e.target !== canalAboutPill &&
    !canalAboutPopover.contains(e.target as Node)
  ) {
    canalAboutPopover.hidden = true;
  }
});

// White paper modal -- opened from a link inside the about popover.
const whitepaperOpen = document.getElementById('whitepaper-open') as HTMLButtonElement;
const whitepaperModal = document.getElementById('whitepaper-modal') as HTMLDivElement;
const whitepaperClose = document.getElementById('whitepaper-close') as HTMLButtonElement;
whitepaperOpen.addEventListener('click', () => {
  canalAboutPopover.hidden = true;
  whitepaperModal.hidden = false;
});
whitepaperClose.addEventListener('click', () => {
  whitepaperModal.hidden = true;
});
whitepaperModal.querySelector('.whitepaper-backdrop')!.addEventListener('click', () => {
  whitepaperModal.hidden = true;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !whitepaperModal.hidden) {
    whitepaperModal.hidden = true;
  }
});

const mouseDragSource = new MouseDragSource(headCanvas);
const gyroSource = new DeviceOrientationSource();

// Same breakpoint as styles.css's mobile layout switch -- a phone-sized screen is
// actually being carried/tilted by the user, so real gyroscope motion is the natural
// interaction there; on desktop mouse-drag is the only option anyway.
const IS_MOBILE_SCREEN = window.matchMedia('(max-width: 760px)').matches;

let mode: PlaybackMode = IS_MOBILE_SCREEN ? 'gyro' : 'mouse';
let canalFunction: CanalFunction = normalCanalFunction();

// Scripted maneuver playback (Dix-Hallpike/Epley/Semont/BBQ-roll/Zuma/roll-test) --
// drives head orientation the same way live gyro/mouse-drag do, via the shared
// OrientationSource interface (see maneuverSource below), so stepPhysicsOnce doesn't
// need to know which kind of source is active.
const MANEUVERS_BY_SIDE_AND_KEY: Record<EarSide, Record<ManeuverKey, Maneuver>> = {
  right: {
    dixHallpike: dixHallpikeRight,
    semontDiagnostic: semontDiagnosticRight,
    semontLiberatory: semontLiberatoryRight,
    epley: epleyRight,
    rollTest: rollTestRight,
    bbqRoll: bbqRollRight,
    zuma: zumaRight,
  },
  left: {
    dixHallpike: dixHallpikeLeft,
    semontDiagnostic: semontDiagnosticLeft,
    semontLiberatory: semontLiberatoryLeft,
    epley: epleyLeft,
    rollTest: rollTestLeft,
    bbqRoll: bbqRollLeft,
    zuma: zumaLeft,
  },
};
let maneuverKey: ManeuverKey = 'dixHallpike';
const maneuverPlayer = new ManeuverPlayer(dixHallpikeRight);
// Thin OrientationSource adapter -- ManeuverPlayer always has a definite orientation
// (never null) and has no real sample timestamp of its own (it recomputes/applies its
// orientation every physics tick, same as mouse-drag), so sampleTimestampMs is omitted.
const maneuverSource: OrientationSource = {
  currentOrientation: () => maneuverPlayer.currentOrientation(),
};

function activeOrientationSource(): OrientationSource {
  return mode === 'gyro' ? gyroSource : mode === 'maneuver' ? maneuverSource : mouseDragSource;
}

// BPPV (canalithiasis) selection -- see physics/canalith.ts. The single (canal, side)
// currently modeled as having free-floating debris (null = no BPPV, the default), set
// via the Controls "Pathology" popover's BPPV radio group. Declared here (ahead of the
// Controls construction below, and ahead of the rest of the physics state further down)
// because Controls' constructor synchronously calls onSelectManeuver once while
// populating its maneuver dropdown, which reaches applyManeuver's read of
// bppvSelection immediately -- a `let` declared any later would still be in its
// temporal dead zone at that point (confirmed live: threw "Cannot access
// 'bppvSelection' before initialization").
let bppvSelection: BppvSelection = null;

/** Rebuilds the active maneuver from the current key + the BPPV-selected side (defaults
 * to 'right' if no BPPV side is selected yet, since a maneuver still needs some side to
 * be parametrized by). */
function applyManeuver(): void {
  const side = bppvSelection?.side ?? 'right';
  maneuverPlayer.setManeuver(MANEUVERS_BY_SIDE_AND_KEY[side][maneuverKey]);
  const duration = maneuverPlayer.duration;
  controls?.setChapters(maneuverPlayer.chapters.map((c) => ({ fraction: c.t / duration, label: c.label })));
  // controls itself isn't constructed yet the FIRST time this runs -- Controls'
  // constructor synchronously fires its own onSelectManeuver callback once while
  // populating the maneuver dropdown, which reaches here before `new Controls(...)`
  // has returned (confirmed live: an unguarded `controls.setPlayingLabel` call here
  // threw "Cannot read properties of undefined" at construction time). Harmless to skip
  // that first call -- main.ts calls applyManeuver() again right after construction.
  controls?.setPlayingLabel(false);
}

/**
 * Requests motion permission (a no-op prompt on Android/desktop, an explicit grant on
 * iOS 13+) and starts the gyro source if granted. Shared by the manual "Gyroscope: Off"
 * toggle tap and the automatic attempt on load when the screen is phone-sized.
 */
function enableGyro(): void {
  requestOrientationPermission().then((granted) => {
    if (granted) {
      gyroSource.start();
      controls.setGyroEnabled(true);
    } else {
      controls.setGyroEnabled(false);
      controls.setGyroStatus('Tap "Gyroscope: Off" to allow motion access');
    }
  });
}

// Declared (uninitialized) before construction, not `const controls = new Controls(...)`
// directly -- Controls' own constructor synchronously calls back into applyManeuver
// (see its doc comment), which reads this variable, so it must already be out of its
// temporal dead zone (even if still `undefined`) by the time that happens.
let controls: Controls;
controls = new Controls(
  controlsContainer,
  {
    onReset: () => resetPhysics(),
    onModeChange: (next: PlaybackMode) => {
      mode = next;
      if (mode === 'mouse') mouseDragSource.reset();
    },
    onToggleGyro: (enable: boolean) => {
      if (!enable) {
        gyroSource.stop();
        controls.setGyroStatus('');
        return;
      }
      enableGyro();
    },
    onCalibrateGyro: () => {
      gyroSource.calibrateZero();
    },
    onToggleCanalFunction: (canal: CanalType, side: EarSide, enabled: boolean) => {
      canalFunction = withCanalFunction(canalFunction, canal, side, enabled ? 1 : 0);
    },
    onBppvSelectionChange: (selection) => {
      bppvSelection = selection;
      canalithState = initialCanalithState();
      cupulolithState = initialCupulolithState();
      cupulolithDetached = false;
      clearedToastLeft.hideImmediately();
      clearedToastRight.hideImmediately();
      detachedToastLeft.hideImmediately();
      detachedToastRight.hideImmediately();
      wasClearedIntoUtricle = false;
      controls.setManeuverCanal(selection?.canal ?? 'posterior');
      applyManeuver();
    },
    onSelectManeuver: (key: ManeuverKey) => {
      maneuverKey = key;
      applyManeuver();
    },
    onPlay: () => maneuverPlayer.play(),
    onPause: () => maneuverPlayer.pause(),
    onScrub: (fraction: number) => maneuverPlayer.scrubTo(fraction * maneuverPlayer.duration),
    onChapterStep: (direction) => seekChapter(direction),
    onChapterSelect: (index: number) => seekManeuver(maneuverPlayer.chapters[index]?.t ?? 0),
  },
  mode
);
applyManeuver();

// Best-effort auto-start on phone-sized screens (see IS_MOBILE_SCREEN/enableGyro) --
// works on Android/desktop (no permission prompt to begin with), silently falls back to
// requiring a manual tap on iOS (permission requests there only work from inside a real
// user-gesture handler, not page load).
if (IS_MOBILE_SCREEN) enableGyro();

// Physics state (bppvSelection declared earlier, ahead of the Controls construction --
// see its own doc comment).
let vorState: VorEngineState = initialVorEngineState();
let canalithState: CanalithState = initialCanalithState();
let cupulolithState: CupulolithState = initialCupulolithState();
/** Once a cupulolithiasis lesion detaches from the cupula, it becomes free-floating
 * debris and behaves exactly like canalithiasis from then on (see stepPhysicsOnce) --
 * this flag marks that conversion, sticky until the next onBppvSelectionChange/reset. */
let cupulolithDetached = false;
let lastDebrisArcFraction = 0;
/** Tracks the previous tick's cleared-into-utricle state so the toast fires once on the
 * rising edge (debris just settled in the utricle), not every tick while it stays there. */
let wasClearedIntoUtricle = false;
let lastQHead: Quat = activeOrientationSource().currentOrientation() ?? [0, 0, 0, 1];
let simulationTimeSeconds = 0;
// Angular-velocity tracking: needs the TRUE elapsed time between orientation samples,
// not the fixed physics timestep, since device gyro delivers deviceorientation events
// well below the 120Hz physics rate (see OrientationSource.sampleTimestampMs's doc
// comment) -- dividing a multi-tick jump by a single tick-width would inflate the
// computed angular velocity.
let prevQHeadForVelocity: Quat = lastQHead;
let prevSampleTimestampMs: number | null = null;

/** Spreads each gyro sample's rotation across physics ticks -- see SampleRotationSpreader.
 * Declared here, ahead of resetPhysics, which resets it. */
const sampleSpreader = new SampleRotationSpreader();

function resetPhysics(): void {
  vorState = initialVorEngineState();
  canalithState = initialCanalithState();
  cupulolithState = initialCupulolithState();
  cupulolithDetached = false;
  wasClearedIntoUtricle = false;
  clearedToastLeft.hideImmediately();
  clearedToastRight.hideImmediately();
  detachedToastLeft.hideImmediately();
  detachedToastRight.hideImmediately();
  maneuverPlayer.reset();
  maneuverPlayer.pause();
  controls.setPlayingLabel(false);
  simulationTimeSeconds = 0;
  prevQHeadForVelocity = activeOrientationSource().currentOrientation() ?? lastQHead;
  prevSampleTimestampMs = activeOrientationSource().sampleTimestampMs?.() ?? null;
  sampleSpreader.reset();
  vngTrace.reset();
}

const FIXED_DT = 1 / 120;

let lastFiringRates = {
  horizontal: { left: 90, right: 90 },
  anterior: { left: 90, right: 90 },
  posterior: { left: 90, right: 90 },
};
let lastHeadAngularVelocity: [number, number, number] = [0, 0, 0];
let lastEye = { horizontalDeg: 0, verticalDeg: 0, torsionalDeg: 0 };

/**
 * Gyroscope-mode head velocities below this are treated as sensor noise, not head
 * movement (see softDeadband) -- complements DeviceOrientationSource's heading-drift
 * filter so leftover jitter can't feed a faint false nystagmus with the phone still.
 * Far below any VOR-relevant head movement (tens to hundreds of °/s).
 */
const GYRO_DEADBAND_RAD_S = (1.5 * Math.PI) / 180;

/** Shrinks a vector's magnitude by `threshold` (zero below it) -- a soft dead-band, so
 * there's no jump in velocity as a real movement crosses the threshold. */
function softDeadband(v: Vec3, threshold: number): Vec3 {
  const magnitude = Math.hypot(v[0], v[1], v[2]);
  if (magnitude <= threshold) return v3(0, 0, 0);
  const k = (magnitude - threshold) / magnitude;
  return v3(v[0] * k, v[1] * k, v[2] * k);
}

/** One fixed-timestep physics update: orientation -> angular velocity -> VOR engine. */
function stepPhysicsOnce(dt: number): void {
  const source = activeOrientationSource();
  const qHead = source.currentOrientation() ?? lastQHead;
  lastQHead = qHead;

  // Same real-elapsed-time-vs-fixed-timestep reasoning as the old BPPV-era
  // stepPhysicsOnce: mouse-drag recomputes orientation every physics tick (so the fixed
  // timestep IS the true elapsed time), but device gyro does not, so use its own reported
  // sample timestamp when available.
  const sampleTimestampMs = source.sampleTimestampMs?.() ?? null;
  let velocityDt = dt;
  let isNewSample = false;
  if (sampleTimestampMs !== null && prevSampleTimestampMs !== null) {
    const elapsedSeconds = (sampleTimestampMs - prevSampleTimestampMs) / 1000;
    if (elapsedSeconds > 0) {
      velocityDt = elapsedSeconds;
      isNewSample = true;
    }
  }
  if (sampleTimestampMs !== null) prevSampleTimestampMs = sampleTimestampMs;
  // Per-sample velocity: non-zero only on the tick a new sensor sample lands. The
  // cupulolithiasis jolt detector is built around exactly these sparse samples (see
  // cupulolith.ts's leaky accumulator), so it keeps receiving them unchanged.
  const omegaBody = angularVelocityBody(prevQHeadForVelocity, qHead, velocityDt);
  prevQHeadForVelocity = qHead;
  // The VOR engine instead gets each sample's rotation spread evenly over the ticks until
  // the next sample (see SampleRotationSpreader) -- otherwise, with the gyro reporting at
  // ~60Hz against 120Hz physics, the cupula integrated only one tick's worth of each
  // sample's movement and the gyro-mode response came out at roughly half strength.
  let omegaForVor = sampleTimestampMs !== null ? sampleSpreader.step(omegaBody, velocityDt, isNewSample, dt) : omegaBody;
  if (mode === 'gyro') omegaForVor = softDeadband(omegaForVor, GYRO_DEADBAND_RAD_S);
  lastHeadAngularVelocity = [omegaForVor[0], omegaForVor[1], omegaForVor[2]];

  if (mode === 'maneuver') maneuverPlayer.tick(dt);

  let debrisFlow: Partial<PerCanalSide<number>> | undefined;
  if (bppvSelection) {
    // Gravity direction in HeadFrame this tick: qHead maps head->world (see
    // physics/types.ts's rotateVec doc comment), so rotating world gravity by qHead's
    // inverse gives gravity's direction as seen in the head's own frame -- what
    // canalith.ts/cupulolith.ts need to know which way debris is pulled/biased.
    const gHead = rotateVec(quatInvert(qHead), v3(...G_WORLD));
    const { canal, side, type } = bppvSelection;

    // Cupulolithiasis debris that has DETACHED from the cupula is no longer stuck --
    // clinically, it's now free-floating debris in the duct, exactly canalithiasis's
    // physics, starting from the cupula end (s=0, where it just came free). So a
    // detached cupulolithiasis selection reuses the same stepCanalith/clearedToast path
    // canalithiasis itself uses, rather than having its own separate "cleared" concept --
    // the ONLY thing distinguishing it from a plain canalithiasis selection at that point
    // is that it was preceded by a detach event (see the cupulolith branch below).
    if (type === 'canalithiasis' || cupulolithDetached) {
      const stepResult = stepCanalith(canalithState, canal, side, gHead, dt);
      canalithState = stepResult.state;
      debrisFlow = { [canal]: { [side]: stepResult.flow } } as Partial<PerCanalSide<number>>;
      const max = sMax(canal, side);
      lastDebrisArcFraction = canalithState.s / max;

      // Rising edge only -- fires once when the debris settles into the utricle, not on
      // every subsequent tick while it stays there (see wasClearedIntoUtricle's doc comment).
      const clearedIntoUtricle = canalithState.s >= max;
      if (clearedIntoUtricle && !wasClearedIntoUtricle) {
        (side === 'left' ? clearedToastLeft : clearedToastRight).show();
      }
      wasClearedIntoUtricle = clearedIntoUtricle;
    } else {
      const omegaSpeed = Math.hypot(omegaBody[0], omegaBody[1], omegaBody[2]);
      const wasAttached = cupulolithState.attached;
      const stepResult = stepCupulolith(cupulolithState, canal, side, gHead, omegaSpeed, velocityDt);
      cupulolithState = stepResult.state;
      debrisFlow = { [canal]: { [side]: stepResult.flow } } as Partial<PerCanalSide<number>>;
      lastDebrisArcFraction = 0;

      // Rising edge only -- fires once when the clump detaches, not on every subsequent
      // tick. This is the "debris detached, now free-floating" event, distinct from
      // clearedToast* (fired above once the now-mobile debris subsequently clears into
      // the utricle) -- clinically these are two separate milestones for cupulolithiasis,
      // where canalithiasis only has the one.
      if (wasAttached && !cupulolithState.attached) {
        (side === 'left' ? detachedToastLeft : detachedToastRight).show();
        cupulolithDetached = true;
        canalithState = initialCanalithState();
      }
    }
  }

  const result = stepVorEngine(vorState, omegaForVor, dt, canalFunction, undefined, debrisFlow);
  vorState = result.state;
  lastFiringRates = result.firingRates;
  lastEye = result.eye;

  simulationTimeSeconds += dt;
  vngTrace.pushSample({
    t: simulationTimeSeconds,
    horizontalDeg: lastEye.horizontalDeg,
    verticalDeg: lastEye.verticalDeg,
    torsionalDeg: lastEye.torsionalDeg,
  });
}

// Physics runs on a fixed-rate timer rather than requestAnimationFrame: rAF is
// throttled/paused for hidden or occluded tabs (correct for rendering, since there's no
// point drawing what isn't shown), but that would also freeze the vestibular simulation.
let accumulator = 0;
let lastPhysicsTimeMs = performance.now();
setInterval(() => {
  const nowMs = performance.now();
  const dtFrame = Math.min((nowMs - lastPhysicsTimeMs) / 1000, 0.25);
  lastPhysicsTimeMs = nowMs;
  accumulator += dtFrame;
  while (accumulator >= FIXED_DT) {
    stepPhysicsOnce(FIXED_DT);
    accumulator -= FIXED_DT;
  }
}, 1000 / 120);

/**
 * Chapter navigation for scripted maneuvers: jumps playback to `targetSeconds` by
 * actually SIMULATING the skipped time (the same fixed-step physics as real-time
 * playback, just run back-to-back), not by setting the clock like the scrub bar does --
 * otherwise the otoconia/cupula/eye state would be left wherever it was, e.g. debris
 * still sitting at the start of the canal at Epley's final "Sit up" stage. Seeking
 * backwards replays from the start. Keeps the play/pause state it found.
 */
function seekManeuver(targetSeconds: number): void {
  // stepPhysicsOnce only advances the maneuver clock in maneuver mode -- anywhere else
  // the loop below would never finish.
  if (mode !== 'maneuver') return;
  const wasPlaying = maneuverPlayer.isPlaying;
  if (targetSeconds < maneuverPlayer.elapsedSeconds) {
    resetPhysics();
  }
  maneuverPlayer.play();
  // At most one fixed step past the target -- a chapter start is just a waypoint time.
  while (maneuverPlayer.elapsedSeconds < targetSeconds - 1e-9 && !maneuverPlayer.isFinished()) {
    stepPhysicsOnce(FIXED_DT);
  }
  // Summed 1/120s steps can land a hair BEFORE the target (float accumulation), which
  // would leave the stage label showing the previous segment -- snap onto it exactly.
  if (maneuverPlayer.elapsedSeconds < targetSeconds) maneuverPlayer.scrubTo(targetSeconds);
  if (wasPlaying) maneuverPlayer.play();
  else maneuverPlayer.pause();
  controls.setPlayingLabel(maneuverPlayer.isPlaying);
}

/** Stage-jump targets: the previous chapter is the one before the stage currently
 * playing, unless we're more than CHAPTER_RESTART_S into it, in which case it restarts
 * the current stage -- the usual media-player "previous track" behaviour. */
const CHAPTER_RESTART_S = 1.5;
function seekChapter(direction: 'previous' | 'next'): void {
  const now = maneuverPlayer.elapsedSeconds;
  const starts = maneuverPlayer.chapters.map((c) => c.t);
  if (direction === 'next') {
    const next = starts.find((t) => t > now + 1e-6);
    if (next !== undefined) seekManeuver(next);
    return;
  }
  const current = [...starts].reverse().find((t) => t <= now + 1e-6) ?? 0;
  const target = now - current > CHAPTER_RESTART_S ? current : ([...starts].reverse().find((t) => t < current - 1e-6) ?? 0);
  seekManeuver(target);
}

function renderFrame(): void {
  eyeSceneLeft.setEyeAngle(lastEye);
  eyeSceneRight.setEyeAngle(lastEye);

  canalSceneLeft.setOrientation(lastQHead);
  canalSceneRight.setOrientation(lastQHead);
  canalSceneLeft.setFiringRates({
    horizontal: lastFiringRates.horizontal.left,
    anterior: lastFiringRates.anterior.left,
    posterior: lastFiringRates.posterior.left,
  });
  canalSceneRight.setFiringRates({
    horizontal: lastFiringRates.horizontal.right,
    anterior: lastFiringRates.anterior.right,
    posterior: lastFiringRates.posterior.right,
  });
  // stuck (pinned-at-cupula, dull clump visual) only while a cupulolithiasis lesion is
  // still attached -- once detached it's free-floating debris and reads as the normal
  // mobile canalithiasis marker (see stepPhysicsOnce's cupulolithDetached conversion).
  const debrisStuck = bppvSelection?.type === 'cupulolithiasis' && !cupulolithDetached;
  canalSceneLeft.setDebris(
    bppvSelection && bppvSelection.side === 'left'
      ? { canal: bppvSelection.canal, arcFraction: lastDebrisArcFraction, stuck: debrisStuck }
      : null
  );
  canalSceneRight.setDebris(
    bppvSelection && bppvSelection.side === 'right'
      ? { canal: bppvSelection.canal, arcFraction: lastDebrisArcFraction, stuck: debrisStuck }
      : null
  );

  if (microZoomEnabled) {
    const plane = microPlaneMode === 'auto' ? computeAutoActivePlane(lastFiringRates) ?? lastAutoPlane : microPlaneMode;
    if (plane) lastAutoPlane = plane;
    const canals = plane ? PLANE_CANAL_BY_SIDE[plane] : null;
    canalSceneLeft.setFocusedCanal(canals?.left ?? null);
    canalSceneRight.setFocusedCanal(canals?.right ?? null);
  }

  // After setFocusedCanal above, so the fluid/head overlay arrows (only meaningful for
  // the currently-focused canal) reflect THIS frame's focus, not last frame's.
  canalSceneLeft.setFluidVisuals(
    { horizontal: vorState.cupula.horizontal.left, anterior: vorState.cupula.anterior.left, posterior: vorState.cupula.posterior.left },
    lastHeadAngularVelocity
  );
  canalSceneRight.setFluidVisuals(
    { horizontal: vorState.cupula.horizontal.right, anterior: vorState.cupula.anterior.right, posterior: vorState.cupula.posterior.right },
    lastHeadAngularVelocity
  );

  headScene.setOrientation(lastQHead);

  if (mode === 'maneuver') {
    const fraction = maneuverPlayer.duration > 0 ? maneuverPlayer.elapsedSeconds / maneuverPlayer.duration : 0;
    controls.setProgress(fraction, maneuverPlayer.currentLabel);
    controls.setPlayingLabel(maneuverPlayer.isPlaying);
  }

  eyeSceneLeft.render();
  eyeSceneRight.render();
  if (canalView === 'ear') {
    if (earsShown !== 'right') canalSceneLeft.render();
    if (earsShown !== 'left') canalSceneRight.render();
  } else {
    canalHexPlot.setFiringRates(lastFiringRates);
    canalHexPlot.render();
    canalDiffMeters.setFiringRates(lastFiringRates);
    canalDiffMeters.render();
  }
  headScene.render();
  vngTrace.render(simulationTimeSeconds);

  const firingLine = ALL_CANAL_TYPES.map(
    (canal) =>
      `${canal[0].toUpperCase()}: L=${lastFiringRates[canal].left.toFixed(0)} R=${lastFiringRates[canal].right.toFixed(0)}`
  ).join('  ');
  controls.setDebugReadout(
    `omega=[${lastHeadAngularVelocity.map((v) => v.toFixed(2)).join(', ')}] rad/s\n${firingLine}\nH=${lastEye.horizontalDeg.toFixed(
      2
    )} V=${lastEye.verticalDeg.toFixed(2)} T=${lastEye.torsionalDeg.toFixed(2)}`
  );

  requestAnimationFrame(renderFrame);
}

requestAnimationFrame(renderFrame);

if (import.meta.env.DEV) {
  // Manual physics stepping for debugging/testing, bypassing both the setInterval timer
  // and requestAnimationFrame -- useful when a browser automation harness reports the
  // tab as hidden/occluded and throttles both. Not used by the app itself.
  (window as unknown as { __vorDebugPump: (steps: number) => void }).__vorDebugPump = (steps: number) => {
    for (let i = 0; i < steps; i++) stepPhysicsOnce(FIXED_DT);
    renderFrame();
  };
  (window as unknown as { __vorDebugScenes: unknown }).__vorDebugScenes = { canalSceneLeft, canalSceneRight };
}

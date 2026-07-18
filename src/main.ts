import { Quat, angularVelocityBody } from './physics/types';
import { CanalType, EarSide, ALL_CANAL_TYPES } from './physics/canal';
import { CanalFunction, normalCanalFunction, withCanalFunction } from './physics/pathology';
import { VorEngineState, initialVorEngineState, stepVorEngine } from './physics/vorEngine';
import QRCode from 'qrcode';

import { OrientationSource } from './sensors/orientationSource';
import { DeviceOrientationSource, requestOrientationPermission } from './sensors/deviceOrientation';
import { MouseDragSource } from './sensors/mouseDragSource';

import { EyeScene } from './scene/eyeScene';
import { CanalScene } from './scene/canalScene';
import { HeadScene } from './scene/headScene';

import { Controls, PlaybackMode } from './ui/controls';
import { VngTrace } from './ui/vngTrace';
import { keepScreenAwake } from './ui/wakeLock';
import { initTheme, toggleTheme } from './ui/theme';

keepScreenAwake();
initTheme();

const eyeCanvasLeft = document.getElementById('eye-canvas-left') as HTMLCanvasElement;
const eyeCanvasRight = document.getElementById('eye-canvas-right') as HTMLCanvasElement;
const canalCanvasLeft = document.getElementById('canal-canvas-left') as HTMLCanvasElement;
const canalCanvasRight = document.getElementById('canal-canvas-right') as HTMLCanvasElement;
const headCanvas = document.getElementById('head-canvas') as HTMLCanvasElement;
const vngCanvas = document.getElementById('vng-canvas') as HTMLCanvasElement;
const controlsContainer = document.getElementById('controls') as HTMLDivElement;
const themeToggleBtn = document.getElementById('theme-toggle') as HTMLButtonElement;
themeToggleBtn.addEventListener('click', () => toggleTheme());

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
      QRCode.toCanvas(aboutQrCanvas, 'https://jakalnz.github.io/bppv-simulator/', { width: 132, margin: 1 }).catch(
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

const mouseDragSource = new MouseDragSource(headCanvas);
const gyroSource = new DeviceOrientationSource();

// Same breakpoint as styles.css's mobile layout switch -- a phone-sized screen is
// actually being carried/tilted by the user, so real gyroscope motion is the natural
// interaction there; on desktop mouse-drag is the only option anyway.
const IS_MOBILE_SCREEN = window.matchMedia('(max-width: 760px)').matches;

let mode: PlaybackMode = IS_MOBILE_SCREEN ? 'gyro' : 'mouse';
let canalFunction: CanalFunction = normalCanalFunction();

function activeOrientationSource(): OrientationSource {
  return mode === 'gyro' ? gyroSource : mouseDragSource;
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

const controls = new Controls(
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
  },
  mode
);

// Best-effort auto-start on phone-sized screens (see IS_MOBILE_SCREEN/enableGyro) --
// works on Android/desktop (no permission prompt to begin with), silently falls back to
// requiring a manual tap on iOS (permission requests there only work from inside a real
// user-gesture handler, not page load).
if (IS_MOBILE_SCREEN) enableGyro();

// Physics state.
let vorState: VorEngineState = initialVorEngineState();
let lastQHead: Quat = activeOrientationSource().currentOrientation() ?? [0, 0, 0, 1];
let simulationTimeSeconds = 0;
// Angular-velocity tracking: needs the TRUE elapsed time between orientation samples,
// not the fixed physics timestep, since device gyro delivers deviceorientation events
// well below the 120Hz physics rate (see OrientationSource.sampleTimestampMs's doc
// comment) -- dividing a multi-tick jump by a single tick-width would inflate the
// computed angular velocity.
let prevQHeadForVelocity: Quat = lastQHead;
let prevSampleTimestampMs: number | null = null;

function resetPhysics(): void {
  vorState = initialVorEngineState();
  simulationTimeSeconds = 0;
  prevQHeadForVelocity = activeOrientationSource().currentOrientation() ?? lastQHead;
  prevSampleTimestampMs = activeOrientationSource().sampleTimestampMs?.() ?? null;
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
  if (sampleTimestampMs !== null && prevSampleTimestampMs !== null) {
    const elapsedSeconds = (sampleTimestampMs - prevSampleTimestampMs) / 1000;
    if (elapsedSeconds > 0) velocityDt = elapsedSeconds;
  }
  if (sampleTimestampMs !== null) prevSampleTimestampMs = sampleTimestampMs;
  const omegaBody = angularVelocityBody(prevQHeadForVelocity, qHead, velocityDt);
  prevQHeadForVelocity = qHead;
  lastHeadAngularVelocity = [omegaBody[0], omegaBody[1], omegaBody[2]];

  const result = stepVorEngine(vorState, omegaBody, dt, canalFunction);
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
  headScene.setOrientation(lastQHead);

  eyeSceneLeft.render();
  eyeSceneRight.render();
  canalSceneLeft.render();
  canalSceneRight.render();
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
}

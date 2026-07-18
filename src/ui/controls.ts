import { CanalType, EarSide, ALL_CANAL_TYPES, ALL_EAR_SIDES } from '../physics/canal';

export type PlaybackMode = 'gyro' | 'mouse';

export interface ControlsCallbacks {
  onReset: () => void;
  onModeChange: (mode: PlaybackMode) => void;
  /** enable=true: request permission and start listening; enable=false: stop listening. */
  onToggleGyro: (enable: boolean) => void;
  onCalibrateGyro: () => void;
  /** Toggles one (canal, side)'s function scale between normal (1) and absent (0) --
   * simulating unilateral/selective vestibular loss for that canal. */
  onToggleCanalFunction: (canal: CanalType, side: EarSide, enabled: boolean) => void;
  /** Selects which single (canal, side) has canalithiasis (free-floating debris) BPPV
   * enabled, or null for none. Single-selection (radio-style), not per-canal toggles like
   * onToggleCanalFunction -- this minimal-slice model only supports one affected
   * canal+side at a time. */
  onBppvSelectionChange: (selection: { canal: CanalType; side: EarSide } | null) => void;
}

const CANAL_LABELS: Record<CanalType, string> = {
  horizontal: 'Horizontal',
  anterior: 'Anterior',
  posterior: 'Posterior',
};

/** Plain-DOM control bar: mode switch, gyro on/off+calibrate, per-canal pathology
 * toggles, reset, debug readout. Full rewrite for the bilateral 6-canal VOR engine --
 * see this file's git history for the old BPPV-debris-era maneuver/canal-select/
 * pathology-select controls this replaces. */
export class Controls {
  private readonly gyroToggleBtn: HTMLButtonElement;
  private readonly gyroCalibrateBtn: HTMLButtonElement;
  private readonly gyroStatus: HTMLSpanElement;
  private readonly debug: HTMLPreElement;
  private readonly gyroGroup: HTMLDivElement;
  private gyroEnabled = false;

  constructor(container: HTMLElement, callbacks: ControlsCallbacks, initialMode: PlaybackMode = 'mouse') {
    const MODE_OPTIONS: { value: PlaybackMode; label: string }[] = [
      { value: 'mouse', label: 'Mouse-drag (desktop)' },
      { value: 'gyro', label: 'Gyroscope (phone)' },
    ];
    const MODE_LABELS = Object.fromEntries(MODE_OPTIONS.map((o) => [o.value, o.label])) as Record<
      PlaybackMode,
      string
    >;
    const modeOptionButtons = MODE_OPTIONS.map((opt) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = opt.label;
      b.addEventListener('click', () => {
        modePopover.hidden = true;
        modeButton.textContent = `Mode: ${MODE_LABELS[opt.value]}`;
        this.updateModeVisibility(opt.value);
        callbacks.onModeChange(opt.value);
      });
      return b;
    });
    const { button: modeButton, popover: modePopover } = this.makePopoverButton(
      `Mode: ${MODE_LABELS[initialMode]}`,
      modeOptionButtons
    );

    // One toggle checkbox per (canal, side) -- simulates selective/unilateral canal
    // hypofunction (see physics/pathology.ts's CanalFunction). Grouped in a popover to
    // keep the always-visible control row short.
    const pathologyToggles: HTMLElement[] = [];
    for (const side of ALL_EAR_SIDES) {
      for (const canal of ALL_CANAL_TYPES) {
        const row = document.createElement('label');
        row.className = 'canal-function-row';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = true;
        const sideLabel = side === 'right' ? 'Right' : 'Left';
        checkbox.addEventListener('change', () => {
          callbacks.onToggleCanalFunction(canal, side, checkbox.checked);
        });
        const text = document.createElement('span');
        text.textContent = `${sideLabel} ${CANAL_LABELS[canal]}`;
        row.append(checkbox, text);
        pathologyToggles.push(row);
      }
    }
    // BPPV (canalithiasis) selection, nested in the same "Pathology" popover as the
    // canal-function toggles above rather than a separate control -- both are pathology
    // concepts and users asked for one control surface, not two (see plan). Radio-style
    // (a plain <input type=radio> group, one shared name) since this minimal-slice model
    // only supports a single affected canal+side at a time, unlike the independent
    // per-canal checkboxes above.
    const bppvDivider = document.createElement('div');
    bppvDivider.className = 'popover-section-label';
    bppvDivider.textContent = 'BPPV (canalithiasis)';

    const bppvRadios: HTMLElement[] = [];
    const noneRow = document.createElement('label');
    noneRow.className = 'canal-function-row';
    const noneRadio = document.createElement('input');
    noneRadio.type = 'radio';
    noneRadio.name = 'bppv-selection';
    noneRadio.checked = true;
    noneRadio.addEventListener('change', () => {
      if (noneRadio.checked) callbacks.onBppvSelectionChange(null);
    });
    const noneText = document.createElement('span');
    noneText.textContent = 'None';
    noneRow.append(noneRadio, noneText);
    bppvRadios.push(noneRow);

    for (const side of ALL_EAR_SIDES) {
      for (const canal of ALL_CANAL_TYPES) {
        const row = document.createElement('label');
        row.className = 'canal-function-row';
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'bppv-selection';
        const sideLabel = side === 'right' ? 'Right' : 'Left';
        radio.addEventListener('change', () => {
          if (radio.checked) callbacks.onBppvSelectionChange({ canal, side });
        });
        const text = document.createElement('span');
        text.textContent = `${sideLabel} ${CANAL_LABELS[canal]}`;
        row.append(radio, text);
        bppvRadios.push(row);
      }
    }

    const { button: pathologyButton } = this.makePopoverButton('Pathology', [
      ...pathologyToggles,
      bppvDivider,
      ...bppvRadios,
    ]);

    const resetBtn = document.createElement('button');
    resetBtn.textContent = 'Reset';
    resetBtn.title = 'Reset cupula/eye physics state';
    resetBtn.addEventListener('click', () => callbacks.onReset());

    // Toggle button (not a one-shot "Enable motion" action) so its own label/indicator
    // always reflects whether the gyroscope is actually listening -- tapping it again
    // turns it back off (see onToggleGyro/gyroSource.stop in main.ts).
    this.gyroToggleBtn = document.createElement('button');
    this.gyroToggleBtn.addEventListener('click', () => {
      this.setGyroEnabled(!this.gyroEnabled);
      callbacks.onToggleGyro(this.gyroEnabled);
    });
    this.updateGyroToggleLabel();

    this.gyroCalibrateBtn = document.createElement('button');
    this.updateCalibrateLabel(false);
    this.gyroCalibrateBtn.title =
      'Hold the phone naturally, then tap to set this as head-neutral (tap again anytime to re-center)';
    this.gyroCalibrateBtn.addEventListener('click', () => {
      callbacks.onCalibrateGyro();
      this.updateCalibrateLabel(true);
    });

    this.gyroStatus = document.createElement('span');

    this.debug = document.createElement('pre');
    this.debug.className = 'debug-readout';

    this.gyroGroup = document.createElement('div');
    this.gyroGroup.className = 'control-group';
    this.gyroGroup.append(this.gyroToggleBtn, this.gyroCalibrateBtn, this.gyroStatus);

    this.updateModeVisibility(initialMode);

    const contextRow = document.createElement('div');
    contextRow.className = 'control-row';
    contextRow.append(modeButton, pathologyButton, resetBtn);

    const playbackRow = document.createElement('div');
    playbackRow.className = 'control-row';
    playbackRow.append(this.gyroGroup, this.debug);

    container.append(contextRow, playbackRow);
  }

  /**
   * A trigger button + a popup of arbitrary content, positioned ABOVE the button (not
   * below) since the control bar this is used from sits at the page's bottom edge
   * (sticky on mobile) -- opening downward would usually overflow off the viewport.
   * Closes on any outside click.
   */
  private makePopoverButton(
    label: string,
    content: HTMLElement[]
  ): { button: HTMLButtonElement; popover: HTMLDivElement } {
    const popover = document.createElement('div');
    popover.className = 'variant-popover';
    popover.hidden = true;
    popover.append(...content);
    document.body.appendChild(popover);

    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      const opening = popover.hidden;
      popover.hidden = !opening;
      if (opening) {
        const rect = button.getBoundingClientRect();
        popover.style.left = `${rect.left}px`;
        popover.style.bottom = `${window.innerHeight - rect.top + 6}px`;
      }
    });
    document.addEventListener('click', (e) => {
      if (!popover.hidden && e.target !== button && !popover.contains(e.target as Node)) {
        popover.hidden = true;
      }
    });
    return { button, popover };
  }

  private updateModeVisibility(mode: PlaybackMode): void {
    this.gyroGroup.style.display = mode === 'gyro' ? '' : 'none';
  }

  private updateGyroToggleLabel(): void {
    this.gyroToggleBtn.innerHTML = `<span class="status-dot ${this.gyroEnabled ? 'on' : 'off'}"></span>Gyroscope: ${
      this.gyroEnabled ? 'On' : 'Off'
    }`;
  }

  private updateCalibrateLabel(calibrated: boolean): void {
    this.gyroCalibrateBtn.textContent = calibrated ? 'Recalibrate' : 'Uncalibrated';
  }

  setGyroEnabled(enabled: boolean): void {
    this.gyroEnabled = enabled;
    this.updateGyroToggleLabel();
    this.updateCalibrateLabel(false);
  }

  setGyroStatus(text: string): void {
    this.gyroStatus.textContent = text;
  }

  setDebugReadout(text: string): void {
    this.debug.textContent = text;
  }
}

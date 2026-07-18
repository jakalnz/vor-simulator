import { CanalType, EarSide, ALL_CANAL_TYPES, ALL_EAR_SIDES } from '../physics/canal';

export type PlaybackMode = 'maneuver' | 'gyro' | 'mouse';

export type ManeuverKey =
  | 'dixHallpike'
  | 'semontDiagnostic'
  | 'semontLiberatory'
  | 'epley'
  | 'rollTest'
  | 'bbqRoll'
  | 'zuma';

/** Which scripted maneuvers are offered for each canal -- anterior canal BPPV is rare
 * and provoked/treated the same way as posterior (same Dix-Hallpike-family positions),
 * so it reuses the posterior list rather than getting its own. */
const MANEUVERS_BY_CANAL: Record<CanalType, { key: ManeuverKey; label: string }[]> = {
  posterior: [
    { key: 'dixHallpike', label: 'Dix-Hallpike' },
    { key: 'semontDiagnostic', label: 'Semont (diagnostic)' },
    { key: 'semontLiberatory', label: 'Semont (liberatory)' },
    { key: 'epley', label: 'Epley' },
  ],
  anterior: [
    { key: 'dixHallpike', label: 'Dix-Hallpike' },
    { key: 'semontDiagnostic', label: 'Semont (diagnostic)' },
    { key: 'semontLiberatory', label: 'Semont (liberatory)' },
    { key: 'epley', label: 'Epley' },
  ],
  horizontal: [
    { key: 'rollTest', label: 'Supine roll test' },
    { key: 'bbqRoll', label: 'BBQ roll' },
    { key: 'zuma', label: 'Zuma (apogeotropic HC cupulolithiasis)' },
  ],
};

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
  onSelectManeuver: (key: ManeuverKey) => void;
  onPlay: () => void;
  onPause: () => void;
  /** fraction is normalized 0..1 of the maneuver's total duration. */
  onScrub: (fraction: number) => void;
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

  private readonly maneuverSelect: HTMLSelectElement;
  private readonly maneuverGroup: HTMLDivElement;
  private readonly playBtn: HTMLButtonElement;
  private readonly scrub: HTMLInputElement;
  private readonly maneuverLabel: HTMLSpanElement;
  private readonly scrubColumn: HTMLDivElement;
  private scrubbing = false;
  /** Repopulates the maneuver dropdown for a given canal -- assigned in the constructor
   * (needs `callbacks` from the constructor's closure) and exposed via setManeuverCanal. */
  private populateManeuverOptionsFn!: (canal: CanalType) => void;

  constructor(container: HTMLElement, callbacks: ControlsCallbacks, initialMode: PlaybackMode = 'mouse') {
    const MODE_OPTIONS: { value: PlaybackMode; label: string }[] = [
      { value: 'maneuver', label: 'Scripted maneuver' },
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
          if (radio.checked) {
            callbacks.onBppvSelectionChange({ canal, side });
            this.setManeuverCanal(canal);
          }
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

    // Scripted maneuver select + transport (Play/Pause + scrub) -- only meaningful in
    // "maneuver" mode, since there's no scripted position to play/scrub through in
    // gyro/mouse-drag mode (see updateModeVisibility).
    this.maneuverSelect = document.createElement('select');
    const populateManeuverOptions = (canal: CanalType): void => {
      const previous = this.maneuverSelect.value as ManeuverKey | '';
      this.maneuverSelect.innerHTML = MANEUVERS_BY_CANAL[canal]
        .map((m) => `<option value="${m.key}">${m.label}</option>`)
        .join('');
      // Keep the previous selection if the new canal still offers it (e.g. switching
      // between posterior and anterior, which share the same maneuver list), rather than
      // always resetting to the first option.
      const stillOffered = MANEUVERS_BY_CANAL[canal].some((m) => m.key === previous);
      if (stillOffered) this.maneuverSelect.value = previous;
      callbacks.onSelectManeuver(this.maneuverSelect.value as ManeuverKey);
    };
    populateManeuverOptions('posterior');
    this.maneuverSelect.addEventListener('change', () =>
      callbacks.onSelectManeuver(this.maneuverSelect.value as ManeuverKey)
    );
    this.populateManeuverOptionsFn = populateManeuverOptions;

    this.playBtn = document.createElement('button');
    this.playBtn.className = 'primary-btn';
    this.playBtn.textContent = 'Play';
    this.playBtn.addEventListener('click', () => {
      if (this.playBtn.textContent === 'Pause') {
        callbacks.onPause();
        this.setPlayingLabel(false);
      } else {
        callbacks.onPlay();
        this.setPlayingLabel(true);
      }
    });

    this.maneuverLabel = document.createElement('span');
    this.maneuverLabel.textContent = 'Seated upright';

    this.scrub = document.createElement('input');
    this.scrub.type = 'range';
    this.scrub.min = '0';
    this.scrub.max = '1';
    this.scrub.step = '0.001';
    this.scrub.value = '0';
    this.scrub.addEventListener('pointerdown', () => (this.scrubbing = true));
    this.scrub.addEventListener('pointerup', () => (this.scrubbing = false));
    this.scrub.addEventListener('input', () => callbacks.onScrub(parseFloat(this.scrub.value)));

    this.scrubColumn = document.createElement('div');
    this.scrubColumn.className = 'scrub-column';
    this.scrubColumn.append(this.maneuverLabel, this.scrub);

    this.maneuverGroup = document.createElement('div');
    this.maneuverGroup.className = 'control-group';
    this.maneuverGroup.append(this.maneuverSelect, this.playBtn, this.scrubColumn);

    this.updateModeVisibility(initialMode);

    const contextRow = document.createElement('div');
    contextRow.className = 'control-row';
    contextRow.append(modeButton, pathologyButton, resetBtn);

    const playbackRow = document.createElement('div');
    playbackRow.className = 'control-row';
    playbackRow.append(this.maneuverGroup, this.gyroGroup, this.debug);

    container.append(contextRow, playbackRow);
  }

  /** Repopulates the maneuver dropdown for the given canal (posterior/anterior share one
   * list, horizontal has its own) -- called whenever the BPPV selection's canal changes,
   * so the offered maneuvers always match the currently-selected pathology. */
  setManeuverCanal(canal: CanalType): void {
    this.populateManeuverOptionsFn(canal);
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
    this.maneuverGroup.style.display = mode === 'maneuver' ? '' : 'none';
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

  /** fraction is normalized 0..1 of the maneuver's total duration. Skipped while the
   * user is actively dragging the scrub handle (this.scrubbing) so the live physics
   * update doesn't fight the user's own drag position. */
  setProgress(fraction: number, label: string): void {
    if (!this.scrubbing) this.scrub.value = String(fraction);
    this.maneuverLabel.textContent = label;
  }

  setPlayingLabel(playing: boolean): void {
    this.playBtn.textContent = playing ? 'Pause' : 'Play';
  }
}

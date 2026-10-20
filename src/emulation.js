/**
 * Document-mode ("browser emulation") map.
 *
 * The value is written to
 *   HKCU\Software\Microsoft\Internet Explorer\Main\FeatureControl\
 *     FEATURE_BROWSER_EMULATION\iebox-host.exe
 *
 * MSHTML reads that DWORD when it creates the document object. Without it the
 * WebBrowser control defaults to IE7 mode, which breaks most real intranet
 * pages. 11001 is "IE11 edge" mode; the lower values exist because some old
 * line-of-business apps intentionally check for an older mode.
 */

export const EMULATION_MODES = Object.freeze({
  ie11: Object.freeze({ mode: 'ie11', value: 11001, label: 'IE11', description: 'IE11 edge mode (recommended)' }),
  ie10: Object.freeze({ mode: 'ie10', value: 10001, label: 'IE10', description: 'IE10 standards mode' }),
  ie9: Object.freeze({ mode: 'ie9', value: 9999, label: 'IE9', description: 'IE9 standards mode' }),
  ie8: Object.freeze({ mode: 'ie8', value: 8888, label: 'IE8', description: 'IE8 standards mode' }),
  ie7: Object.freeze({ mode: 'ie7', value: 7000, label: 'IE7', description: 'IE7 standards mode' }),
});

export const EMULATION_ORDER = Object.freeze(['ie11', 'ie10', 'ie9', 'ie8', 'ie7']);

export const DEFAULT_EMULATION = 'ie11';

export function isEmulation(value) {
  if (typeof value !== 'string') return false;
  const key = value.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(EMULATION_MODES, key);
}

/** Normalise user input to a known mode, or null. */
export function parseEmulation(value) {
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase();
  if (isEmulation(key)) return key;
  // Accept "11", "ie 11", "IE11", "11001".
  const numeric = key.replace(/^ie\s*/, '');
  if (numeric === '11') return 'ie11';
  if (numeric === '10') return 'ie10';
  if (numeric === '9') return 'ie9';
  if (numeric === '8') return 'ie8';
  if (numeric === '7') return 'ie7';
  return null;
}

export function emulationValue(mode) {
  const parsed = parseEmulation(mode);
  if (!parsed) throw new RangeError(`Unknown emulation mode: ${mode}`);
  return EMULATION_MODES[parsed].value;
}

export function emulationLabel(mode) {
  const parsed = parseEmulation(mode);
  return parsed ? EMULATION_MODES[parsed].label : null;
}

export function emulationFromValue(value) {
  const numeric = Number(value);
  for (const mode of EMULATION_ORDER) {
    if (EMULATION_MODES[mode].value === numeric) return mode;
  }
  return null;
}

/** Options for a drop-down: [{ mode, value, label, description }]. */
export function emulationOptions() {
  return EMULATION_ORDER.map((mode) => ({ ...EMULATION_MODES[mode] }));
}

/** Human-readable one-liner used by `iebox emulation` and `doctor`. */
export function describeEmulation(mode) {
  const parsed = parseEmulation(mode);
  if (!parsed) return 'unknown';
  const item = EMULATION_MODES[parsed];
  return `${item.label} (${item.value})`;
}

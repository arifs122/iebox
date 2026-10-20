/**
 * Small shared helpers: errors, exit codes, platform guards, ANSI, formatting.
 * No dependencies, no side effects beyond reading package.json for the version.
 */

import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export const PRODUCT = 'iebox';
export const VERSION = pkg.version;
export const REPOSITORY = 'https://github.com/arifs122/iebox';
export const IS_WINDOWS = process.platform === 'win32';

/** Exit codes used by the CLI and documented in the README. */
export const EXIT = Object.freeze({
  OK: 0,
  USER: 1,
  OPERATIONAL: 2,
});

export class IeBoxError extends Error {
  constructor(message, exitCode = EXIT.OPERATIONAL, options = {}) {
    super(message, options);
    this.name = 'IeBoxError';
    this.exitCode = exitCode;
  }
}

/** Bad input from the user: malformed URL, unknown mode, unexpected flag. */
export class UserError extends IeBoxError {
  constructor(message, options = {}) {
    super(message, EXIT.USER, options);
    this.name = 'UserError';
  }
}

/** The machine could not do the job: no compiler, no engine, spawn failure. */
export class OperationalError extends IeBoxError {
  constructor(message, options = {}) {
    super(message, EXIT.OPERATIONAL, options);
    this.name = 'OperationalError';
  }
}

/**
 * Unsupported platform. Hard rule 3 asks for exit code 2 on macOS/Linux, even
 * though "unsupported platform" is listed under user errors; the explicit
 * platform rule wins.
 */
export class PlatformError extends IeBoxError {
  constructor(platform = process.platform, options = {}) {
    super(
      `iebox is Windows-only (this machine reports "${platform}"). ` +
        'The legacy Trident/MSHTML engine only exists on Windows 10 and 11.',
      EXIT.OPERATIONAL,
      options,
    );
    this.name = 'PlatformError';
    this.platform = platform;
  }
}

export function isWindows(platform = process.platform) {
  return platform === 'win32';
}

/** Throws PlatformError unless the current (or injected) platform is win32. */
export function assertWindows(platform = process.platform) {
  if (!isWindows(platform)) throw new PlatformError(platform);
  return true;
}

/** Map any thrown value to a process exit code. */
export function exitCodeFor(error) {
  if (error && Number.isInteger(error.exitCode)) return error.exitCode;
  return EXIT.OPERATIONAL;
}

/** Normalise an unknown thrown value into an Error. */
export function toError(value) {
  if (value instanceof Error) return value;
  return new Error(typeof value === 'string' ? value : String(value));
}

const ANSI_RE = /\u001b\[[0-9;]*m/g;

export function stripAnsi(text) {
  return String(text).replace(ANSI_RE, '');
}

/**
 * Build a tiny colour palette. Disabled colours are identity functions, so
 * callers never need to branch.
 */
export function makeColors(enabled = true) {
  const wrap = (code) => (text) => (enabled ? `\u001b[${code}m${text}\u001b[0m` : String(text));
  return {
    enabled,
    reset: wrap('0'),
    bold: wrap('1'),
    dim: wrap('2'),
    red: wrap('31'),
    green: wrap('32'),
    yellow: wrap('33'),
    blue: wrap('34'),
    magenta: wrap('35'),
    cyan: wrap('36'),
    gray: wrap('90'),
    violet: wrap('38;5;99'),
    teal: wrap('38;5;44'),
  };
}

/**
 * Decide whether ANSI colour should be used. Explicit --no-color and the
 * NO_COLOR convention always win; non-TTY streams stay plain.
 */
export function shouldUseColor(options = {}) {
  const env = options.env || process.env;
  const stream = options.stream || process.stdout;
  if (options.noColor) return false;
  if (options.quiet) return false;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR === '0') return false;
  if (env.TERM === 'dumb') return false;
  if (env.FORCE_COLOR && env.FORCE_COLOR !== '0') return true;
  return Boolean(stream && stream.isTTY);
}

/** 46592 -> "45.5 KB". Keeps one decimal for MB/GB, none for bytes. */
export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return 'unknown size';
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const decimals = size >= 100 ? 0 : 1;
  return `${size.toFixed(decimals)} ${units[unit]}`;
}

export function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

export function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Shorten long paths from the middle for terminal output. */
export function shortenPath(value, max = 76) {
  const text = String(value);
  if (text.length <= max) return text;
  const keep = max - 3;
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return `${text.slice(0, head)}...${text.slice(-tail)}`;
}

/** Titles for the window: "<page title> - iebox" is built in the host. */
export function productTitle() {
  return `${PRODUCT} ${VERSION}`;
}

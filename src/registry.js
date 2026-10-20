/**
 * HKCU registry access for FEATURE_BROWSER_EMULATION.
 *
 * MSHTML chooses its document mode from a per-process DWORD named after the
 * executable. The DWORD is a *value*, not a subkey:
 *
 *   HKCU\Software\Microsoft\Internet Explorer\Main\FeatureControl\
 *     FEATURE_BROWSER_EMULATION
 *       iebox-host.exe = 11001   (REG_DWORD)
 *
 * We only ever write that one value, only under HKCU, and uninstall deletes
 * only that value. Other applications' values in the same key (games and
 * internal tools commonly set them) are left untouched.
 *
 * The argument builders are pure so tests can assert the exact reg.exe
 * command line without touching a real registry.
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { isWindows, assertWindows, OperationalError, UserError } from './util.js';
import { HOST_EXE_NAME } from './config.js';

export const FEATURE_KEY =
  'HKCU\\Software\\Microsoft\\Internet Explorer\\Main\\FeatureControl\\FEATURE_BROWSER_EMULATION';

export { HOST_EXE_NAME };

/** Registry value names are file names, never paths. */
export function assertExeName(exe = HOST_EXE_NAME) {
  if (typeof exe !== 'string' || exe.trim() === '') {
    throw new UserError('A host executable name is required for the registry value.');
  }
  if (exe.includes('\\') || exe.includes('/') || exe.includes(':')) {
    throw new UserError(`Invalid host executable name "${exe}": it must be a file name, not a path.`);
  }
  if (exe === '.' || exe === '..') {
    throw new UserError(`Invalid host executable name "${exe}".`);
  }
  return exe;
}

/** The key that holds every process's emulation value. */
export function emulationKeyPath() {
  return FEATURE_KEY;
}

/** Human-readable location of one value (not a subkey). */
export function emulationValueLabel(exe = HOST_EXE_NAME) {
  return `${FEATURE_KEY}\\${assertExeName(exe)}`;
}

/** reg.exe query <key> /v <exe> - reads the value for one process. */
export function queryArgs(exe = HOST_EXE_NAME) {
  return ['query', FEATURE_KEY, '/v', assertExeName(exe)];
}

/** reg.exe add <key> /v <exe> /t REG_DWORD /d <value> /f */
export function addArgs(exe = HOST_EXE_NAME, value = 11001) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 0 || numeric > 0xffffffff) {
    throw new UserError(`Invalid emulation value "${value}".`);
  }
  return ['add', FEATURE_KEY, '/v', assertExeName(exe), '/t', 'REG_DWORD', '/d', String(numeric), '/f'];
}

/** reg.exe delete <key> /v <exe> /f - removes only our value. */
export function deleteArgs(exe = HOST_EXE_NAME) {
  return ['delete', FEATURE_KEY, '/v', assertExeName(exe), '/f'];
}

/** Full path to reg.exe. Using the absolute path avoids PATH hijacking. */
export function regExePath(env = process.env) {
  const root = env.SystemRoot || env.WINDIR || 'C:\\Windows';
  return path.win32.join(root, 'System32', 'reg.exe');
}

export function defaultRegRunner(args, options = {}) {
  return execFileSync(regExePath(options.env), args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: options.timeout || 15000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Pull the DWORD out of `reg query` output, or null when absent. */
export function parseRegQuery(stdout) {
  const text = String(stdout || '');
  const hex = /REG_DWORD\s+0x([0-9a-fA-F]+)/.exec(text);
  if (hex) return Number.parseInt(hex[1], 16);
  const dec = /REG_DWORD\s+(\d+)/.exec(text);
  if (dec) return Number.parseInt(dec[1], 10);
  return null;
}

function regErrorMessage(error) {
  if (!error) return 'unknown registry error';
  const stderr = error.stderr ? String(error.stderr).trim() : '';
  const stdout = error.stdout ? String(error.stdout).trim() : '';
  return stderr || stdout || error.message || 'unknown registry error';
}

/**
 * Read the current value. Returns { ok, value, error } and never throws for
 * a missing key or a locked-down registry.
 */
export function readEmulation(options = {}) {
  if (!isWindows(options.platform || process.platform)) return { ok: false, value: null, error: 'not Windows' };
  const run = options.run || defaultRegRunner;
  const exe = options.exe || HOST_EXE_NAME;
  try {
    const stdout = run(queryArgs(exe), options);
    const value = parseRegQuery(stdout);
    return { ok: value !== null, value, error: value === null ? 'value not found' : null, raw: String(stdout || '') };
  } catch (error) {
    return { ok: false, value: null, error: regErrorMessage(error) };
  }
}

/** Write the DWORD for one process name. Never elevates, never touches HKLM. */
export function writeEmulation(value, options = {}) {
  assertWindows(options.platform || process.platform);
  const run = options.run || defaultRegRunner;
  const exe = options.exe || HOST_EXE_NAME;
  try {
    run(addArgs(exe, value), options);
    return { ok: true, error: null, key: FEATURE_KEY, value: Number(value), exe };
  } catch (error) {
    return { ok: false, error: regErrorMessage(error), key: FEATURE_KEY, value: Number(value), exe };
  }
}

/**
 * Remove the value. A missing key is success: uninstall must be idempotent.
 */
export function removeEmulation(options = {}) {
  assertWindows(options.platform || process.platform);
  const run = options.run || defaultRegRunner;
  const exe = options.exe || HOST_EXE_NAME;

  const current = readEmulation({ ...options, run, exe });
  if (current.ok && current.value !== null) {
    try {
      run(deleteArgs(exe), options);
      return { ok: true, removed: true, key: FEATURE_KEY, exe, error: null };
    } catch (error) {
      return { ok: false, removed: false, key: FEATURE_KEY, exe, error: regErrorMessage(error) };
    }
  }

  if (current.error && !/not found|unable to find|bulunamad/i.test(current.error)) {
    // A real access error is worth reporting, but still not fatal for
    // uninstall; the rest of the cleanup can continue.
    return { ok: true, removed: false, key: FEATURE_KEY, exe, error: current.error };
  }
  return { ok: true, removed: false, key: FEATURE_KEY, exe, error: null };
}

/** Fail loudly when the host could not persist its own mode. */
export function writeEmulationOrThrow(value, options = {}) {
  const result = writeEmulation(value, options);
  if (!result.ok) {
    throw new OperationalError(
      `Could not write the HKCU emulation value for ${options.exe || HOST_EXE_NAME}: ${result.error}`,
    );
  }
  return result;
}

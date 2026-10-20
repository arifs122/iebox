/**
 * Config file handling.
 *
 * Location (Windows): %LOCALAPPDATA%\iebox\config.json
 *
 * The file is intentionally flat JSON so the C# host can read and write it
 * with a ~200 line parser instead of pulling in a JSON library. Unknown keys
 * written by newer versions are preserved on save.
 *
 * Nothing in this module may throw because of a malformed file: a broken
 * config must never stop the browser from opening.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_EMULATION, parseEmulation } from './emulation.js';
import { clamp, isPlainObject } from './util.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const APP_DIR_NAME = 'iebox';
export const CONFIG_FILE_NAME = 'config.json';
export const HOST_EXE_NAME = 'iebox-host.exe';

export const DEFAULTS = Object.freeze({
  homeUrl: 'https://example.com/',
  lastUrl: '',
  emulation: DEFAULT_EMULATION,
  seenWarning: false,
  zoom: 100,
  windowX: -1,
  windowY: -1,
  windowWidth: 1200,
  windowHeight: 800,
  windowMaximized: false,
});

/**
 * The bundled demo page makes a better first run than a blank tab: it proves
 * that the compiled host and the engine actually work, offline.
 */
export function defaultHomeUrl(options = {}) {
  const exists = options.exists || fs.existsSync;
  const demo = path.join(ROOT, 'docs', 'demo', 'legacy-page.html');
  try {
    if (exists(demo)) return pathToFileURL(demo).href;
  } catch {
    /* fall through */
  }
  return DEFAULTS.homeUrl;
}

export function configDir(env = process.env) {
  const local =
    env.LOCALAPPDATA ||
    (env.USERPROFILE ? path.join(env.USERPROFILE, 'AppData', 'Local') : null) ||
    path.join(os.homedir(), 'AppData', 'Local');
  return path.join(local, APP_DIR_NAME);
}

export function configPaths(options = {}) {
  const dir = options.dir || configDir(options.env);
  const hostDir = path.join(dir, 'bin');
  return {
    dir,
    file: path.join(dir, CONFIG_FILE_NAME),
    hostDir,
    hostExe: path.join(hostDir, HOST_EXE_NAME),
    buildMeta: path.join(hostDir, 'build.json'),
    logFile: path.join(dir, 'iebox.log'),
  };
}

export function defaultConfig(options = {}) {
  return {
    ...DEFAULTS,
    homeUrl: options.homeUrl || defaultHomeUrl(options),
  };
}

function asBool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function asInt(value, fallback, min, max) {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  return Math.round(clamp(n, min, max));
}

function validPageUrl(value, fallback, allowEmpty = false) {
  if (typeof value !== 'string') return fallback;
  const text = value.trim();
  if (text === '') return allowEmpty ? '' : fallback;
  // Only page-ish schemes. A config file must not be able to inject a
  // javascript: URL into the host's home button or last-URL restore.
  if (/^(?:https?|file|ftp|about|data):/i.test(text)) return text;
  return allowEmpty ? '' : fallback;
}

/** Coerce arbitrary JSON into a safe config object. */
export function normalizeConfig(raw, fallback = DEFAULTS) {
  if (!isPlainObject(raw)) return { ...fallback };

  const emulation = parseEmulation(raw.emulation) || fallback.emulation || DEFAULT_EMULATION;

  return {
    ...fallback,
    homeUrl: validPageUrl(raw.homeUrl, fallback.homeUrl, false),
    lastUrl: validPageUrl(raw.lastUrl, fallback.lastUrl || '', true),
    emulation,
    seenWarning: asBool(raw.seenWarning, fallback.seenWarning === true),
    zoom: asInt(raw.zoom, fallback.zoom, 25, 400),
    windowX: asInt(raw.windowX, fallback.windowX, -100000, 100000),
    windowY: asInt(raw.windowY, fallback.windowY, -100000, 100000),
    windowWidth: asInt(raw.windowWidth, fallback.windowWidth, 480, 10000),
    windowHeight: asInt(raw.windowHeight, fallback.windowHeight, 320, 10000),
    windowMaximized: asBool(raw.windowMaximized, fallback.windowMaximized === true),
  };
}

/**
 * Read the config plus diagnostics. Never throws.
 * @returns {{ config: object, path: string, exists: boolean, warning: string|null }}
 */
export function loadConfigReport(options = {}) {
  const paths = configPaths(options);
  const fallback = defaultConfig(options);

  let exists = false;
  try {
    exists = fs.existsSync(paths.file);
  } catch {
    exists = false;
  }

  if (!exists) {
    return { config: fallback, path: paths.file, exists: false, warning: null };
  }

  try {
    const text = fs.readFileSync(paths.file, 'utf8').replace(/^\uFEFF/, '');
    const raw = JSON.parse(text);
    if (!isPlainObject(raw)) {
      return {
        config: fallback,
        path: paths.file,
        exists: true,
        warning: 'config.json does not contain a JSON object; using defaults.',
      };
    }
    return { config: normalizeConfig(raw, fallback), path: paths.file, exists: true, warning: null };
  } catch (error) {
    return {
      config: fallback,
      path: paths.file,
      exists: true,
      warning: `config.json could not be read (${error.message}); using defaults.`,
    };
  }
}

export function loadConfig(options = {}) {
  return loadConfigReport(options).config;
}

function readRawObject(file) {
  try {
    if (!fs.existsSync(file)) return {};
    const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return isPlainObject(raw) ? raw : {};
  } catch {
    return {};
  }
}

/**
 * Merge a patch into config.json, preserving unknown keys.
 * Returns { ok, path, error }; never throws.
 */
export function saveConfig(patch, options = {}) {
  const paths = configPaths(options);
  const fallback = defaultConfig(options);
  const current = loadConfigReport({ ...options, dir: paths.dir }).config;

  let merged;
  try {
    const raw = readRawObject(paths.file);
    const next = { ...raw, ...(isPlainObject(patch) ? patch : {}) };
    merged = normalizeConfig(next, { ...fallback, ...current });
    // Keep keys this version does not know about, so an older CLI does not
    // destroy settings written by a newer host.
    merged = { ...next, ...merged };
  } catch {
    merged = { ...current };
  }

  const json = `${JSON.stringify(merged, null, 2)}\n`;
  const tmp = `${paths.file}.${process.pid}.tmp`;

  try {
    fs.mkdirSync(paths.dir, { recursive: true });
    fs.writeFileSync(tmp, json, 'utf8');
    try {
      fs.renameSync(tmp, paths.file);
    } catch {
      // Windows can refuse a rename over an existing file on some file
      // systems; fall back to delete-then-rename.
      try {
        fs.unlinkSync(paths.file);
      } catch {
        /* ignore */
      }
      fs.renameSync(tmp, paths.file);
    }
    return { ok: true, path: paths.file, error: null, config: merged };
  } catch (error) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    return { ok: false, path: paths.file, error: error.message, config: merged };
  }
}

/** Ensure a config file exists, creating it from defaults on first run. */
export function ensureConfig(options = {}) {
  const report = loadConfigReport(options);
  if (report.exists) return { ...report, created: false };
  const saved = saveConfig(report.config, options);
  return {
    config: saved.config || report.config,
    path: report.path,
    exists: true,
    warning: report.warning || (saved.ok ? null : `Could not create config: ${saved.error}`),
    created: saved.ok,
  };
}

/** Short human-readable view used by `iebox config`. */
export function describeConfig(config) {
  return [
    ['homeUrl', config.homeUrl],
    ['lastUrl', config.lastUrl || '(none)'],
    ['emulation', config.emulation],
    ['seenWarning', String(config.seenWarning)],
    ['zoom', `${config.zoom}%`],
    ['window', `${config.windowWidth}x${config.windowHeight} at ${config.windowX},${config.windowY}`],
    ['windowMaximized', String(config.windowMaximized)],
  ];
}

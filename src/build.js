/**
 * Build the C# host with the .NET Framework compiler that ships with Windows.
 *
 * No SDK, no MSBuild, no NuGet. csc.exe 4.0.30319 is present on every Windows
 * 10/11 install that has .NET Framework 4.x (which includes the WebBrowser
 * control this product depends on).
 *
 * The output lives at %LOCALAPPDATA%\iebox\bin\iebox-host.exe and is cached by
 * a SHA-256 of the C# source, so a normal `iebox <url>` never recompiles.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, configPaths, HOST_EXE_NAME } from './config.js';
import { VERSION, isWindows, OperationalError } from './util.js';

export const BUILD_CACHE_VERSION = 2;
export const HOST_SOURCE_RELATIVE = path.join('host', 'IeBoxHost.cs');

/** 32-bit by default: almost every legacy ActiveX control (camera and NVR
 *  web plugins in particular) ships as x86 only, and a 64-bit process cannot
 *  load it. `--arch x64` is there for the rare 64-bit control. */
export const DEFAULT_ARCH = 'x86';
const ARCHES = new Set(['x86', 'x64', 'anycpu']);

/**
 * @param {string | null | undefined} value raw `--arch` value
 * @returns {'x86' | 'x64' | 'anycpu'}
 */
export function normalizeArch(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_ARCH;
  const text = String(value).trim().toLowerCase();
  if (text === 'x86' || text === '32' || text === 'ia32') return 'x86';
  if (text === 'x64' || text === '64' || text === 'amd64') return 'x64';
  if (text === 'any' || text === 'anycpu') return 'anycpu';
  throw new OperationalError(`Unknown architecture "${value}". Use x86, x64 or anycpu.`);
}

export function hostSourcePath(root = ROOT) {
  return path.join(root, HOST_SOURCE_RELATIVE);
}

/** Candidate compiler locations, most specific first. */
export function cscCandidates(env = process.env) {
  const root = env.WINDIR || env.SystemRoot || 'C:\\Windows';
  const list = [];
  if (env.IEBOX_CSC) list.push(env.IEBOX_CSC);
  list.push(path.win32.join(root, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'));
  list.push(path.win32.join(root, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'));
  return list;
}

/**
 * Find csc.exe. Returns null (rather than throwing) so `doctor` can explain
 * exactly what is missing.
 */
export function findCsc(options = {}) {
  const platform = options.platform || process.platform;
  if (!isWindows(platform)) return null;
  const env = options.env || process.env;
  const exists = options.exists || ((p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  });

  for (const candidate of cscCandidates(env)) {
    try {
      if (exists(candidate)) return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

export function sourceHash(source) {
  return crypto.createHash('sha256').update(String(source), 'utf8').digest('hex');
}

/** Pure argument list, tested without invoking the compiler. */
export function buildArgs(options = {}) {
  const source = options.source;
  const out = options.out;
  if (!source || !out) throw new Error('buildArgs requires source and out');
  return [
    '/nologo',
    '/target:winexe',
    `/platform:${normalizeArch(options.arch)}`,
    '/optimize+',
    '/codepage:65001',
    '/warn:4',
    `/out:${out}`,
    '/r:System.dll',
    '/r:System.Drawing.dll',
    '/r:System.Windows.Forms.dll',
    source,
  ];
}

export function readHostSource(sourcePath = hostSourcePath()) {
  try {
    return fs.readFileSync(sourcePath, 'utf8');
  } catch (error) {
    throw new OperationalError(
      `Could not read the host source at ${sourcePath}: ${error.message}. ` +
        'Reinstall iebox or run it from a full checkout of the repository.',
    );
  }
}

export function readBuildMeta(metaPath) {
  try {
    const raw = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Pure cache decision. The exe must exist with the recorded size, the source
 * hash must match, and the cache format version must be current.
 */
export function isCacheValid(meta, expected) {
  if (!meta || typeof meta !== 'object') return false;
  if (meta.cacheVersion !== BUILD_CACHE_VERSION) return false;
  if (meta.hash !== expected.hash) return false;
  if (expected.arch && meta.arch !== expected.arch) return false;
  if (!expected.exeExists) return false;
  if (!Number.isFinite(expected.exeSize) || expected.exeSize <= 0) return false;
  if (Number(meta.size) !== Number(expected.exeSize)) return false;
  return true;
}

function statSize(file) {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() ? stat.size : -1;
  } catch {
    return -1;
  }
}

function looksLikeExe(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const header = Buffer.alloc(2);
      const read = fs.readSync(fd, header, 0, 2, 0);
      return read === 2 && header[0] === 0x4d && header[1] === 0x5a; // "MZ"
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

/**
 * Read the machine type out of a PE executable's COFF header.
 * Used by `doctor` to tell you whether the compiled host is 32-bit — which is
 * what decides whether a 32-bit ActiveX control can load in it.
 *
 * @param {string} file
 * @returns {'x86' | 'x64' | null}
 */
export function readPeMachine(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const dos = Buffer.alloc(64);
      if (fs.readSync(fd, dos, 0, 64, 0) < 64) return null;
      if (dos[0] !== 0x4d || dos[1] !== 0x5a) return null;
      const peOffset = dos.readUInt32LE(0x3c);
      const head = Buffer.alloc(6);
      if (fs.readSync(fd, head, 0, 6, peOffset) < 6) return null;
      if (head[0] !== 0x50 || head[1] !== 0x45 || head[2] !== 0 || head[3] !== 0) return null;
      const machine = head.readUInt16LE(4);
      if (machine === 0x014c) return 'x86'; // IMAGE_FILE_MACHINE_I386
      if (machine === 0x8664) return 'x64'; // IMAGE_FILE_MACHINE_AMD64
      return null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

export function extractCompilerErrors(stdout, stderr) {
  const text = `${stderr || ''}\n${stdout || ''}`.trim();
  if (!text) return 'csc.exe produced no output.';
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const errors = lines.filter((line) => /\berror\b/i.test(line));
  const selected = (errors.length > 0 ? errors : lines).slice(0, 15);
  return selected.join('\n');
}

function defaultRunner(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: options.timeout || 180000,
    maxBuffer: 8 * 1024 * 1024,
    cwd: options.cwd,
  });
}

function runCompile(csc, args, options = {}) {
  const runner = options.runner || defaultRunner;
  let result;
  try {
    result = runner(csc, args, { timeout: options.timeout || 180000, cwd: options.cwd });
  } catch (error) {
    throw new OperationalError(`Could not start the .NET compiler at ${csc}: ${error.message}`);
  }

  if (!result) throw new OperationalError('The .NET compiler returned no result.');
  if (result.error) {
    throw new OperationalError(
      `Could not run the .NET compiler at ${csc}: ${result.error.message || result.error}`,
    );
  }
  if (result.status !== 0) {
    const details = extractCompilerErrors(result.stdout, result.stderr);
    throw new OperationalError(
      `The C# host failed to compile (csc exit code ${result.status}).\n${details}\n` +
        `Compiler: ${csc}`,
    );
  }
  return result;
}

/**
 * Compile (or reuse) the host.
 *
 * @param {object} [options]
 * @param {boolean} [options.force] recompile even when the cache is valid
 * @param {string}  [options.dir] override the per-user data directory
 * @param {string}  [options.cscPath] override compiler discovery
 * @param {string}  [options.sourcePath] override host/IeBoxHost.cs (tests)
 * @param {function} [options.runner] injectable compiler runner (tests)
 */
export function buildHost(options = {}) {
  const platform = options.platform || process.platform;
  if (!isWindows(platform)) {
    throw new OperationalError(
      `iebox is Windows-only (this machine reports "${platform}"); the host cannot be compiled here.`,
    );
  }

  const paths = configPaths(options);
  const sourcePath = options.sourcePath || hostSourcePath(options.root || ROOT);
  const source = readHostSource(sourcePath);
  const hash = sourceHash(source);
  const arch = normalizeArch(options.arch ?? (options.env || process.env).IEBOX_ARCH);

  const csc = options.cscPath || findCsc(options);
  if (!csc) {
    throw new OperationalError(
      'Could not find the built-in .NET Framework compiler (csc.exe).\n' +
        'Expected one of:\n' +
        cscCandidates(options.env)
          .map((p) => `  - ${p}`)
          .join('\n') +
        '\nInstall .NET Framework 4.x (it is included with Windows 10/11) or set IEBOX_CSC to csc.exe.',
    );
  }

  const exe = options.outExe || paths.hostExe;
  const metaPath = options.metaPath || paths.buildMeta;
  fs.mkdirSync(path.dirname(exe), { recursive: true });

  const exeSize = statSize(exe);
  const meta = readBuildMeta(metaPath);

  if (!options.force && isCacheValid(meta, { hash, arch, exeExists: exeSize > 0, exeSize })) {
    return {
      ok: true,
      reused: true,
      exe,
      csc,
      hash,
      arch,
      size: exeSize,
      metaPath,
      warnings: [],
      durationMs: 0,
    };
  }

  const tempExe = path.join(path.dirname(exe), `.iebox-host-${process.pid}-${Date.now()}.tmp.exe`);
  const args = buildArgs({ source: sourcePath, out: tempExe, csc, arch });
  const started = Date.now();

  try {
    runCompile(csc, args, options);

    if (!fs.existsSync(tempExe)) {
      throw new OperationalError(
        `csc.exe reported success but did not produce ${tempExe}. Check that the output folder is writable.`,
      );
    }
    if (!looksLikeExe(tempExe)) {
      throw new OperationalError(`csc.exe produced an invalid executable at ${tempExe} (no MZ header).`);
    }

    const size = statSize(tempExe);
    if (size <= 0) throw new OperationalError('csc.exe produced an empty executable.');

    try {
      try {
        fs.rmSync(exe, { force: true });
      } catch {
        /* the rename/copy below will report a useful error */
      }
      try {
        fs.renameSync(tempExe, exe);
      } catch {
        fs.copyFileSync(tempExe, exe);
        fs.rmSync(tempExe, { force: true });
      }
    } catch (error) {
      throw new OperationalError(
        `Could not replace ${exe}: ${error.message}. ` +
          'Close any open iebox window and run `iebox build --force` again.',
      );
    }

    const metaOut = {
      cacheVersion: BUILD_CACHE_VERSION,
      name: 'iebox-host',
      version: VERSION,
      hash,
      arch,
      csc,
      source: path.relative(options.root || ROOT, sourcePath) || sourcePath,
      builtAt: new Date().toISOString(),
      size: statSize(exe),
    };
    try {
      fs.writeFileSync(metaPath, `${JSON.stringify(metaOut, null, 2)}\n`, 'utf8');
    } catch {
      // A read-only data folder is unusual; the exe still works, it will just
      // be rebuilt next time.
    }

    return {
      ok: true,
      reused: false,
      exe,
      csc,
      hash,
      arch,
      size: metaOut.size,
      metaPath,
      warnings: [],
      durationMs: Date.now() - started,
    };
  } finally {
    try {
      if (fs.existsSync(tempExe)) fs.unlinkSync(tempExe);
    } catch {
      /* ignore */
    }
  }
}

/** Alias used by the launcher and CI. */
export function ensureHost(options = {}) {
  return buildHost(options);
}

/** Read-only view for `doctor`: never compiles. */
export function inspectHost(options = {}) {
  const paths = configPaths(options);
  const size = statSize(paths.hostExe);
  const meta = readBuildMeta(paths.buildMeta);

  let hash = null;
  try {
    hash = sourceHash(readHostSource(options.sourcePath || hostSourcePath(options.root || ROOT)));
  } catch {
    hash = null;
  }

  return {
    path: paths.hostExe,
    exists: size > 0,
    size: size > 0 ? size : 0,
    meta,
    arch: (meta && meta.arch) || readPeMachine(paths.hostExe),
    sourceHash: hash,
    fresh: isCacheValid(meta, { hash, exeExists: size > 0, exeSize: size }),
    valid: size > 0 && looksLikeExe(paths.hostExe),
  };
}

export { HOST_EXE_NAME };

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Create a throwaway LOCALAPPDATA-style root. */
export function makeTempEnv(prefix = 'iebox-test-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    root,
    env: { ...process.env, LOCALAPPDATA: root },
    cleanup() {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

/** Capture io writes from main(). */
export function captureIo() {
  const out = [];
  const err = [];
  return {
    out,
    err,
    io: {
      out: (line = '') => out.push(String(line)),
      err: (line = '') => err.push(String(line)),
    },
    text() {
      return out.join('\n');
    },
    errorText() {
      return err.join('\n');
    },
  };
}

export function fakeBuild(overrides = {}) {
  return {
    ok: true,
    reused: true,
    exe: 'C:\\fake\\iebox-host.exe',
    csc: 'C:\\fake\\csc.exe',
    hash: 'a'.repeat(64),
    size: 46592,
    durationMs: 12,
    warnings: [],
    ...overrides,
  };
}

export function fakeLaunch(overrides = {}) {
  return {
    ok: true,
    pid: 4242,
    exe: 'C:\\fake\\iebox-host.exe',
    args: [],
    url: 'http://example.com/',
    emulation: 'ie11',
    status: 'running',
    exitCode: null,
    registry: { ok: true, error: null },
    ...overrides,
  };
}

export function writeFile(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, 'utf8');
}

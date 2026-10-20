import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { EXPORT_EXE, exportHost, writeLauncher, writeReadme } from '../src/export.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'iebox-export-'));
}

function fakeExe(dir) {
  const file = path.join(dir, 'built-host.exe');
  fs.writeFileSync(file, Buffer.from('MZ fake executable'));
  return file;
}

test('exportHost copies the exe and writes a launcher and a readme', () => {
  const work = tempDir();
  const out = path.join(work, 'portable');
  try {
    const result = exportHost({
      dir: out,
      exePath: fakeExe(work),
      url: 'http://192.168.1.64/',
      arch: 'x86',
    });

    assert.ok(fs.existsSync(path.join(out, EXPORT_EXE)));
    assert.equal(fs.readFileSync(path.join(out, EXPORT_EXE), 'utf8'), 'MZ fake executable');
    assert.ok(result.launcher.endsWith('Open legacy site.cmd'));
    assert.ok(fs.existsSync(result.readme));

    const launcher = fs.readFileSync(result.launcher, 'utf8');
    assert.match(launcher, /iebox-host\.exe/);
    assert.match(launcher, /http:\/\/192\.168\.1\.64\//);
    assert.match(launcher, /%~dp0/);

    const readme = fs.readFileSync(result.readme, 'utf8');
    assert.match(readme, /ActiveX/);
    assert.match(readme, /Trusted sites/);
    assert.match(readme, /32-bit/);
    assert.match(readme, /no security updates/i);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('a launcher without a URL just opens the host', () => {
  const dir = tempDir();
  try {
    const file = writeLauncher(dir, null);
    assert.ok(file.endsWith('iebox.cmd'));
    const body = fs.readFileSync(file, 'utf8');
    assert.equal(body.includes('http'), false);
    assert.match(body, /start "" "%~dp0iebox-host\.exe"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('URLs cannot break out of the quoted launcher argument', () => {
  const dir = tempDir();
  try {
    const file = writeLauncher(dir, 'http://x/".exe & calc.exe & "');
    const body = fs.readFileSync(file, 'utf8');
    assert.equal(body.includes('".exe & calc.exe'), false, 'quotes are stripped');
    assert.match(body, /http:\/\/x\/\.exe & calc\.exe/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeReadme records the architecture and the emulation hint', () => {
  const dir = tempDir();
  try {
    const file = writeReadme(dir, { url: 'http://cam/', arch: 'x64' });
    const body = fs.readFileSync(file, 'utf8');
    assert.match(body, /x64/);
    assert.match(body, /--emulation ie8/);
    assert.match(body, /http:\/\/cam\//);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('exportHost fails clearly when the host has not been built', () => {
  const dir = tempDir();
  try {
    assert.throws(
      () => exportHost({ dir, exePath: path.join(dir, 'missing.exe') }),
      /Run `iebox build` first/,
    );
    assert.throws(() => exportHost({ exePath: 'x' }), /target directory/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

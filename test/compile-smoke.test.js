import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildArgs, findCsc, hostSourcePath } from '../src/build.js';

const csc = findCsc();
const skip =
  process.platform !== 'win32'
    ? 'Windows-only: csc.exe and the WinForms host are not available here'
    : !csc
      ? 'csc.exe was not found'
      : false;

test('the C# host compiles with the built-in .NET Framework compiler', { skip, timeout: 180000 }, () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'iebox-compile-'));
  const exe = path.join(temp, 'iebox-host.exe');
  try {
    const args = buildArgs({ source: hostSourcePath(), out: exe });
    const result = spawnSync(csc, args, { encoding: 'utf8', windowsHide: true, timeout: 150000 });

    assert.equal(result.status, 0, `csc failed:\n${result.stderr || ''}\n${result.stdout || ''}`);
    assert.doesNotMatch(result.stderr || '', /error CS\d+/i);
    assert.ok(fs.existsSync(exe), 'csc did not produce an exe');

    const stat = fs.statSync(exe);
    assert.ok(stat.size > 10000, `expected a real executable, got ${stat.size} bytes`);

    const fd = fs.openSync(exe, 'r');
    const header = Buffer.alloc(2);
    fs.readSync(fd, header, 0, 2, 0);
    fs.closeSync(fd);
    assert.equal(header.toString('ascii'), 'MZ');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

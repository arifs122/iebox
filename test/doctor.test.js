import test from 'node:test';
import assert from 'node:assert/strict';
import { runDoctor, formatDoctor } from '../src/doctor.js';
import { EXIT } from '../src/util.js';

function baseProbe(overrides = {}) {
  return {
    platform: 'win32',
    arch: 'x64',
    node: 'v20.11.0',
    windir: 'C:\\Windows',
    osVersion: () => 'Windows 11 Pro',
    osRelease: () => '10.0.22631',
    fileExists: () => true,
    fileSize: () => 24000000,
    fileVersion: () => '11.00.22621.1',
    findCsc: () => 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
    cscCandidates: () => [
      'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
      'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
    ],
    inspectHost: () => ({
      exists: true,
      valid: true,
      fresh: true,
      size: 46592,
      path: 'C:\\Users\\me\\AppData\\Local\\iebox\\bin\\iebox-host.exe',
      meta: {},
    }),
    readEmulation: () => ({ ok: true, value: 11001, error: null }),
    configReport: () => ({
      config: { homeUrl: 'https://example.com/', emulation: 'ie11', seenWarning: true },
      path: 'C:\\Users\\me\\AppData\\Local\\iebox\\config.json',
      exists: true,
      warning: null,
    }),
    ...overrides,
  };
}

function findCheck(report, id) {
  return report.checks.find((item) => item.id === id);
}

test('doctor reports a healthy Windows machine', () => {
  const report = runDoctor({ probe: baseProbe() });
  assert.equal(report.supported, true);
  assert.equal(report.ok, true);
  assert.equal(report.exitCode, EXIT.OK);
  assert.equal(report.summary.fail, 0);
  assert.match(report.verdict, /Ready/);
  assert.equal(report.checks.length, 9);

  assert.equal(findCheck(report, 'platform').status, 'ok');
  assert.equal(findCheck(report, 'mshtml').status, 'ok');
  assert.match(findCheck(report, 'mshtml').detail, /11\.00\.22621\.1/);
  assert.equal(findCheck(report, 'csc').status, 'ok');
  assert.equal(findCheck(report, 'clr').status, 'ok');
  assert.equal(findCheck(report, 'host').status, 'ok');
  assert.equal(findCheck(report, 'registry').status, 'ok');
  assert.match(findCheck(report, 'registry').detail, /IE11/);
  assert.equal(findCheck(report, 'config').status, 'ok');
  assert.equal(findCheck(report, 'iexplore').status, 'info');
});

test('doctor fails when mshtml.dll is missing', () => {
  const report = runDoctor({
    probe: baseProbe({
      fileExists: (file) => !String(file).endsWith('mshtml.dll'),
    }),
  });
  assert.equal(report.ok, false);
  assert.equal(report.exitCode, EXIT.OPERATIONAL);
  assert.equal(findCheck(report, 'mshtml').status, 'fail');
  assert.match(report.verdict, /MSHTML/i);
  assert.match(findCheck(report, 'mshtml').hint, /Windows Features/i);
});

test('doctor fails when the C# compiler is missing', () => {
  const report = runDoctor({
    probe: baseProbe({
      findCsc: () => null,
      fileExists: (file) => !String(file).endsWith('csc.exe'),
    }),
  });
  assert.equal(report.ok, false);
  assert.equal(report.exitCode, EXIT.OPERATIONAL);
  assert.equal(findCheck(report, 'csc').status, 'fail');
  assert.match(report.verdict, /compiler/i);
});

test('doctor warns but stays ready when the host is not built yet', () => {
  const report = runDoctor({
    probe: baseProbe({
      inspectHost: () => ({
        exists: false,
        valid: false,
        fresh: false,
        size: 0,
        path: 'C:\\Users\\me\\AppData\\Local\\iebox\\bin\\iebox-host.exe',
        meta: null,
      }),
    }),
  });
  assert.equal(report.ok, true);
  assert.equal(report.exitCode, EXIT.OK);
  assert.equal(findCheck(report, 'host').status, 'warn');
  assert.match(report.verdict, /compiled on first launch/i);
});

test('doctor flags a stale host and an unset registry value', () => {
  const report = runDoctor({
    probe: baseProbe({
      inspectHost: () => ({
        exists: true,
        valid: true,
        fresh: false,
        size: 46592,
        path: 'C:\\host.exe',
        meta: {},
      }),
      readEmulation: () => ({ ok: false, value: null, error: 'value not found' }),
    }),
  });
  assert.equal(findCheck(report, 'host').status, 'warn');
  assert.match(findCheck(report, 'host').detail, /recompiles/);
  assert.equal(findCheck(report, 'registry').status, 'info');
  assert.equal(findCheck(report, 'registry').hint, null);
  assert.equal(report.exitCode, EXIT.OK);
});

test('doctor never throws on a hostile/broken probe', () => {
  const probe = {
    platform: 'win32',
    osVersion: () => {
      throw new Error('boom');
    },
    osRelease: () => {
      throw new Error('boom');
    },
    fileExists: () => {
      throw new Error('boom');
    },
    fileSize: () => {
      throw new Error('boom');
    },
    fileVersion: () => {
      throw new Error('boom');
    },
    findCsc: () => {
      throw new Error('boom');
    },
    cscCandidates: () => {
      throw new Error('boom');
    },
    inspectHost: () => {
      throw new Error('boom');
    },
    readEmulation: () => {
      throw new Error('boom');
    },
    configReport: () => {
      throw new Error('boom');
    },
  };
  let report;
  assert.doesNotThrow(() => {
    report = runDoctor({ probe });
  });
  assert.equal(report.supported, true);
  assert.equal(report.exitCode, EXIT.OPERATIONAL);
  assert.equal(findCheck(report, 'mshtml').status, 'fail');
  assert.equal(findCheck(report, 'csc').status, 'fail');
});

test('doctor on macOS/Linux is one unsupported line and exit 2', () => {
  for (const platform of ['linux', 'darwin']) {
    const report = runDoctor({ probe: { platform } });
    assert.equal(report.supported, false);
    assert.equal(report.ok, false);
    assert.equal(report.exitCode, EXIT.OPERATIONAL);
    assert.equal(report.checks.length, 1);
    assert.match(report.verdict, /Windows-only/);
    assert.match(report.verdict, new RegExp(platform));
    assert.doesNotMatch(report.verdict, /Trident engine is missing/);
  }
});

test('formatDoctor renders statuses, hints and a verdict', () => {
  const report = runDoctor({ probe: baseProbe() });
  const text = formatDoctor(report);
  assert.match(text, /^iebox doctor/);
  assert.match(text, /\[OK\]/);
  assert.match(text, /Verdict:/);
  assert.match(text, /Ready/);
  assert.match(text, /ok, 0 warning/);
  assert.doesNotMatch(text, /\u001b\[/);

  const failing = runDoctor({
    probe: baseProbe({ fileExists: () => false, findCsc: () => null }),
  });
  const failingText = formatDoctor(failing);
  assert.match(failingText, /\[XX\]/);
  assert.match(failingText, /hint:/);
});

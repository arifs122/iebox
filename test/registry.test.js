import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FEATURE_KEY,
  HOST_EXE_NAME,
  assertExeName,
  emulationKeyPath,
  emulationValueLabel,
  queryArgs,
  addArgs,
  deleteArgs,
  regExePath,
  parseRegQuery,
  readEmulation,
  writeEmulation,
  removeEmulation,
} from '../src/registry.js';
import { PlatformError, UserError } from '../src/util.js';

test('registry key is scoped to HKCU and the exact process name', () => {
  assert.ok(FEATURE_KEY.startsWith('HKCU\\'));
  assert.ok(!FEATURE_KEY.includes('HKLM'));
  assert.ok(FEATURE_KEY.endsWith('FEATURE_BROWSER_EMULATION'));
  assert.equal(HOST_EXE_NAME, 'iebox-host.exe');
  assert.equal(emulationKeyPath(), FEATURE_KEY);
  assert.ok(!emulationKeyPath().includes('iebox-host.exe'));
  assert.equal(emulationValueLabel(), `${FEATURE_KEY}\\iebox-host.exe`);
});

test('query/add/delete argument builders produce exact reg.exe args', () => {
  assert.deepEqual(queryArgs(), ['query', FEATURE_KEY, '/v', 'iebox-host.exe']);
  assert.deepEqual(addArgs('iebox-host.exe', 11001), [
    'add',
    FEATURE_KEY,
    '/v',
    'iebox-host.exe',
    '/t',
    'REG_DWORD',
    '/d',
    '11001',
    '/f',
  ]);
  assert.deepEqual(deleteArgs(), ['delete', FEATURE_KEY, '/v', 'iebox-host.exe', '/f']);
  assert.deepEqual(addArgs('custom.exe', 9999), [
    'add',
    FEATURE_KEY,
    '/v',
    'custom.exe',
    '/t',
    'REG_DWORD',
    '/d',
    '9999',
    '/f',
  ]);
});

test('the builders never point outside the process subkey', () => {
  for (const args of [queryArgs(), addArgs(), deleteArgs()]) {
    assert.equal(args[1], FEATURE_KEY);
    assert.equal(args[3], 'iebox-host.exe');
    assert.ok(!args.includes('HKLM'));
  }
});

test('invalid executable names and values are rejected', () => {
  assert.throws(() => queryArgs(''), UserError);
  assert.throws(() => assertExeName(''), UserError);
  assert.throws(() => assertExeName('..\\evil.exe'), UserError);
  assert.throws(() => assertExeName('C:\\Windows\\evil.exe'), UserError);
  assert.throws(() => assertExeName('sub/dir.exe'), UserError);
  assert.throws(() => assertExeName('..'), UserError);
  assert.equal(assertExeName('iebox-host.exe'), 'iebox-host.exe');
  assert.throws(() => addArgs('iebox-host.exe', 'not-a-number'), UserError);
  assert.throws(() => addArgs('iebox-host.exe', -1), UserError);
  assert.throws(() => addArgs('iebox-host.exe', 1.5), UserError);
});

test('reg.exe path is absolute and never relies on PATH', () => {
  assert.equal(
    regExePath({ SystemRoot: 'C:\\Windows' }),
    'C:\\Windows\\System32\\reg.exe',
  );
  assert.equal(regExePath({ WINDIR: 'D:\\Win' }), 'D:\\Win\\System32\\reg.exe');
});

test('parseRegQuery understands hex, decimal and missing values', () => {
  const hex =
    '\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Internet Explorer\\Main\\FeatureControl\\FEATURE_BROWSER_EMULATION\\iebox-host.exe\r\n' +
    '    (Default)    REG_DWORD    0x2af9\r\n\r\n';
  assert.equal(parseRegQuery(hex), 0x2af9);
  assert.equal(parseRegQuery('    (Default)    REG_DWORD    11001'), 11001);
  assert.equal(parseRegQuery('value not found'), null);
  assert.equal(parseRegQuery(''), null);
  assert.equal(parseRegQuery(undefined), null);
});

test('readEmulation parses a fake reg.exe run', () => {
  const calls = [];
  const result = readEmulation({
    platform: 'win32',
    run: (args) => {
      calls.push(args);
      return '    (Default)    REG_DWORD    0x2af9';
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.value, 11001);
  assert.deepEqual(calls, [queryArgs()]);
});

test('readEmulation never throws when reg.exe fails', () => {
  const result = readEmulation({
    platform: 'win32',
    run: () => {
      const error = new Error('reg failed');
      error.stderr = 'ERROR: The system was unable to find the specified registry key or value.';
      throw error;
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.value, null);
  assert.match(result.error, /unable to find/i);
});

test('writeEmulation calls the exact add command and reports failures', () => {
  const calls = [];
  const ok = writeEmulation(9999, {
    platform: 'win32',
    run: (args) => {
      calls.push(args);
      return '';
    },
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(calls, [addArgs('iebox-host.exe', 9999)]);

  const failed = writeEmulation(11001, {
    platform: 'win32',
    run: () => {
      throw new Error('access denied');
    },
  });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /access denied/);
});

test('removeEmulation deletes only iebox-host.exe and is idempotent', () => {
  const calls = [];
  const removed = removeEmulation({
    platform: 'win32',
    run: (args) => {
      calls.push(args);
      if (args[0] === 'query') return '    (Default)    REG_DWORD    0x2af9';
      return '';
    },
  });
  assert.equal(removed.ok, true);
  assert.equal(removed.removed, true);
  assert.deepEqual(calls, [queryArgs(), deleteArgs()]);

  const missingCalls = [];
  const missing = removeEmulation({
    platform: 'win32',
    run: (args) => {
      missingCalls.push(args);
      const error = new Error('not found');
      error.stderr = 'ERROR: The system was unable to find the specified registry key or value.';
      throw error;
    },
  });
  assert.equal(missing.ok, true);
  assert.equal(missing.removed, false);
  assert.deepEqual(missingCalls, [queryArgs()]);
});

test('registry operations refuse to run on non-Windows', () => {
  assert.throws(() => writeEmulation(11001, { platform: 'linux' }), PlatformError);
  assert.throws(() => removeEmulation({ platform: 'darwin' }), PlatformError);
  const read = readEmulation({ platform: 'linux' });
  assert.equal(read.ok, false);
});

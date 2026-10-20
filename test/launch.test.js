import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { launchHost } from '../src/launch.js';
import { addArgs } from '../src/registry.js';
import { OperationalError, PlatformError } from '../src/util.js';

function fakeChild(pid = 4242) {
  const child = new EventEmitter();
  child.pid = pid;
  child.unrefCalled = false;
  child.unref = () => {
    child.unrefCalled = true;
  };
  return child;
}

test('launchHost spawns the winexe detached with no console hiding', async () => {
  const child = fakeChild(777);
  let captured = null;
  const registryCalls = [];

  const result = await launchHost({
    platform: 'win32',
    url: 'http://localhost:3000/',
    exe: 'C:\\data\\iebox-host.exe',
    config: { emulation: 'ie11' },
    waitMs: 20,
    registryRun: (args) => {
      registryCalls.push(args);
      return '';
    },
    spawn: (exe, args, options) => {
      captured = { exe, args, options };
      return child;
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.pid, 777);
  assert.equal(result.emulation, 'ie11');
  assert.equal(result.status, 'running');
  assert.equal(child.unrefCalled, true);

  assert.equal(captured.exe, 'C:\\data\\iebox-host.exe');
  assert.deepEqual(captured.args, ['http://localhost:3000/']);
  assert.equal(captured.options.detached, true);
  assert.equal(captured.options.stdio, 'ignore');
  assert.equal(captured.options.windowsHide, false);
  assert.deepEqual(registryCalls, [addArgs('iebox-host.exe', 11001)]);
});

test('launchHost passes a per-run emulation override to the host', async () => {
  const child = fakeChild();
  const registryCalls = [];
  let captured = null;

  await launchHost({
    platform: 'win32',
    url: 'http://intranet.example/',
    emulation: 'ie7',
    exe: 'C:\\host.exe',
    config: { emulation: 'ie11' },
    waitMs: 20,
    registryRun: (args) => {
      registryCalls.push(args);
      return '';
    },
    spawn: (exe, args) => {
      captured = { exe, args };
      return child;
    },
  });

  assert.deepEqual(captured.args, ['--emulation', 'ie7', 'http://intranet.example/']);
  assert.deepEqual(registryCalls, [addArgs('iebox-host.exe', 7000)]);
});

test('launchHost reports an immediate non-zero exit as a headless failure', async () => {
  const child = fakeChild();
  setTimeout(() => child.emit('exit', 1, null), 5);

  await assert.rejects(
    () =>
      launchHost({
        platform: 'win32',
        url: 'http://example.com/',
        exe: 'C:\\host.exe',
        config: { emulation: 'ie11' },
        waitMs: 100,
        registryRun: () => '',
        spawn: () => child,
      }),
    (error) =>
      error instanceof OperationalError &&
      /exited immediately with code 1/.test(error.message) &&
      /interactive desktop/.test(error.message),
  );
});

test('launchHost reports spawn errors and refuses non-Windows', async () => {
  await assert.rejects(
    () =>
      launchHost({
        platform: 'win32',
        url: 'http://example.com/',
        exe: 'C:\\missing.exe',
        config: { emulation: 'ie11' },
        waitMs: 20,
        registryRun: () => '',
        spawn: () => {
          throw new Error('ENOENT');
        },
      }),
    (error) => error instanceof OperationalError && /Could not start/.test(error.message),
  );

  await assert.rejects(
    () =>
      launchHost({
        platform: 'linux',
        url: 'http://example.com/',
        exe: 'C:\\host.exe',
        config: { emulation: 'ie11' },
      }),
    (error) => error instanceof PlatformError && /Windows-only/.test(error.message),
  );
});

test('launchHost validates its URL and emulation inputs', async () => {
  await assert.rejects(
    () =>
      launchHost({
        platform: 'win32',
        url: '',
        exe: 'C:\\host.exe',
        config: { emulation: 'ie11' },
      }),
    (error) => error instanceof OperationalError && /requires a URL/.test(error.message),
  );

  await assert.rejects(
    () =>
      launchHost({
        platform: 'win32',
        url: 'http://example.com/',
        exe: 'C:\\host.exe',
        config: { emulation: 'ie6' },
      }),
    (error) => error instanceof OperationalError && /Unknown emulation mode/.test(error.message),
  );
});

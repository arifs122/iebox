import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, main, helpText } from '../src/cli.js';
import { configPaths, ensureConfig, loadConfig } from '../src/config.js';
import { makeTempEnv, captureIo, fakeBuild, fakeLaunch } from './helpers.js';

test('parseArgs handles the documented commands and defaults', () => {
  assert.equal(parseArgs([]).command, 'open');
  assert.equal(parseArgs([]).url, null);
  assert.equal(parseArgs(['example.com']).url, 'example.com');
  assert.equal(parseArgs(['build']).command, 'build');
  assert.equal(parseArgs(['build', '--force']).force, true);
  assert.equal(parseArgs(['doctor']).command, 'doctor');
  assert.equal(parseArgs(['doctor', '--json']).json, true);
  assert.equal(parseArgs(['config']).command, 'config');
  assert.equal(parseArgs(['uninstall']).command, 'uninstall');
  assert.equal(parseArgs(['emulation', 'ie9']).emulation, 'ie9');
  assert.equal(parseArgs(['open', 'localhost:3000']).url, 'localhost:3000');
  assert.equal(parseArgs(['help']).help, true);
  assert.equal(parseArgs(['version']).version, true);
});

test('parseArgs handles flags, overrides and quiet mode', () => {
  const parsed = parseArgs(['--home', '--emulation=ie8', '--no-color']);
  assert.equal(parsed.home, true);
  assert.equal(parsed.emulation, 'ie8');
  assert.equal(parsed.noColor, true);

  const emulation = parseArgs(['--emulation', 'IE 10', 'example.com']);
  assert.equal(emulation.emulation, 'ie10');
  assert.equal(emulation.url, 'example.com');

  const quiet = parseArgs(['-q']);
  assert.equal(quiet.quiet, true);
  assert.equal(quiet.noColor, true);

  assert.equal(parseArgs(['-h']).help, true);
  assert.equal(parseArgs(['-v']).version, true);
  assert.equal(parseArgs(['--', '--not-a-flag']).url, '--not-a-flag');
});

test('parseArgs rejects malformed input', () => {
  assert.throws(() => parseArgs(['--nope']), /Unknown option/);
  assert.throws(() => parseArgs(['-z']), /Unknown option/);
  assert.throws(() => parseArgs(['emulation']), /needs a mode/);
  assert.throws(() => parseArgs(['emulation', 'ie9', 'ie10']), /Unexpected argument/);
  assert.throws(() => parseArgs(['build', 'extra']), /Unexpected argument/);
  assert.throws(() => parseArgs(['--emulation']), /needs a mode/);
  assert.throws(() => parseArgs(['--emulation', 'ie6']), /Unknown emulation mode/);
  assert.throws(() => parseArgs(['--home', 'example.com']), /cannot be combined/);
  assert.throws(() => parseArgs(['a', 'b']), /Unexpected argument/);
});

test('help and version work without touching Windows', async () => {
  const help = captureIo();
  assert.equal(await main(['--help'], { platform: 'linux', io: help.io }), 0);
  assert.match(help.text(), /Usage/);
  assert.match(help.text(), /Windows-only/);
  assert.match(helpText(), /iebox \d+\.\d+\.\d+/);

  const version = captureIo();
  assert.equal(await main(['--version'], { platform: 'darwin', io: version.io }), 0);
  assert.match(version.text(), /^iebox \d+\.\d+\.\d+$/);
});

test('every real command fails on non-Windows with exit 2', async () => {
  for (const argv of [
    ['example.com'],
    ['build'],
    ['config'],
    ['uninstall'],
    ['emulation', 'ie9'],
  ]) {
    const captured = captureIo();
    const code = await main(argv, { platform: 'linux', io: captured.io });
    assert.equal(code, 2, `expected exit 2 for ${argv.join(' ')}`);
    assert.match(captured.errorText(), /iebox is Windows-only/);
  }
});

test('doctor on non-Windows prints one clear line and exits 2', async () => {
  const captured = captureIo();
  const code = await main(['doctor'], { platform: 'linux', io: captured.io });
  assert.equal(code, 2);
  assert.equal(captured.err.length, 1);
  assert.match(captured.err[0], /unsupported platform/i);
  assert.match(captured.err[0], /Windows-only/);
  assert.equal(captured.out.length, 0);
});

test('config prints paths and values without creating anything', async () => {
  const temp = makeTempEnv();
  try {
    const captured = captureIo();
    const code = await main(['config'], {
      platform: 'win32',
      env: temp.env,
      io: captured.io,
      readEmulation: () => ({ ok: false, value: null }),
    });
    assert.equal(code, 0);
    assert.match(captured.text(), /iebox config/);
    assert.match(captured.text(), /config\.json/);
    assert.match(captured.text(), /homeUrl/);
    assert.match(captured.text(), /emulation\s+ie11/);
    assert.match(captured.text(), /not set for iebox-host\.exe/);
    assert.equal(fs.existsSync(path.join(temp.root, 'iebox')), false);
  } finally {
    temp.cleanup();
  }
});

test('emulation command saves config and writes the registry value', async () => {
  const temp = makeTempEnv();
  try {
    const calls = [];
    const captured = captureIo();
    const code = await main(['emulation', 'ie9'], {
      platform: 'win32',
      env: temp.env,
      io: captured.io,
      writeEmulation: (value, options) => {
        calls.push({ value, options });
        return { ok: true, error: null };
      },
    });
    assert.equal(code, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].value, 9999);
    assert.equal(calls[0].options.exe, 'iebox-host.exe');
    assert.equal(loadConfig({ env: temp.env }).emulation, 'ie9');
    assert.match(captured.text(), /IE9/);
    assert.match(captured.text(), /9999/);
  } finally {
    temp.cleanup();
  }
});

test('emulation command rejects an unknown mode with exit 1', async () => {
  const captured = captureIo();
  const code = await main(['emulation', 'ie6'], {
    platform: 'win32',
    io: captured.io,
    writeEmulation: () => ({ ok: true }),
  });
  assert.equal(code, 1);
  assert.match(captured.errorText(), /Unknown emulation mode/);
});

test('build command reports the compiler and executable', async () => {
  const captured = captureIo();
  const code = await main(['build', '--force'], {
    platform: 'win32',
    io: captured.io,
    buildHost: (options) => {
      assert.equal(options.force, true);
      assert.equal(options.platform, 'win32');
      return fakeBuild({ reused: false, durationMs: 234, exe: 'C:\\data\\iebox-host.exe' });
    },
  });
  assert.equal(code, 0);
  assert.match(captured.text(), /Compiled the Trident host/);
  assert.match(captured.text(), /234 ms/);
  assert.match(captured.text(), /C:\\data\\iebox-host\.exe/);
});

test('open builds, saves lastUrl, launches and reports the pid', async () => {
  const temp = makeTempEnv();
  try {
    let launchOptions = null;
    let buildCalled = false;
    const captured = captureIo();
    const code = await main(['localhost:3000'], {
      platform: 'win32',
      env: temp.env,
      io: captured.io,
      buildHost: () => {
        buildCalled = true;
        return fakeBuild();
      },
      launchHost: async (options) => {
        launchOptions = options;
        return fakeLaunch({ url: options.url, pid: 777 });
      },
    });

    assert.equal(code, 0);
    assert.equal(buildCalled, true);
    assert.equal(launchOptions.url, 'http://localhost:3000/');
    assert.equal(launchOptions.emulation, undefined);
    assert.equal(loadConfig({ env: temp.env }).lastUrl, 'http://localhost:3000/');
    assert.match(captured.text(), /Opened http:\/\/localhost:3000\//);
    assert.match(captured.text(), /pid 777/);
  } finally {
    temp.cleanup();
  }
});

test('open --home uses the saved home page', async () => {
  const temp = makeTempEnv();
  try {
    const config = ensureConfig({ env: temp.env }).config;
    let launched = null;
    const captured = captureIo();
    const code = await main(['--home'], {
      platform: 'win32',
      env: temp.env,
      io: captured.io,
      buildHost: () => fakeBuild(),
      launchHost: async (options) => {
        launched = options;
        return fakeLaunch({ url: options.url });
      },
    });
    assert.equal(code, 0);
    assert.equal(launched.url, config.homeUrl);
    assert.match(launched.url, /^file:\/\/\//);
    assert.match(launched.url, /legacy-page\.html$/);
  } finally {
    temp.cleanup();
  }
});

test('an --emulation override is passed through but not saved', async () => {
  const temp = makeTempEnv();
  try {
    let launched = null;
    const captured = captureIo();
    const code = await main(['example.com', '--emulation', 'ie8'], {
      platform: 'win32',
      env: temp.env,
      io: captured.io,
      buildHost: () => fakeBuild(),
      launchHost: async (options) => {
        launched = options;
        return fakeLaunch({ url: options.url, emulation: 'ie8' });
      },
    });
    assert.equal(code, 0);
    assert.equal(launched.emulation, 'ie8');
    assert.equal(loadConfig({ env: temp.env }).emulation, 'ie11');
    assert.match(captured.text(), /this run only/);
  } finally {
    temp.cleanup();
  }
});

test('open rejects blocked URLs and reports launch failures', async () => {
  const temp = makeTempEnv();
  try {
    const blocked = captureIo();
    const blockedCode = await main(['javascript:alert(1)'], {
      platform: 'win32',
      env: temp.env,
      io: blocked.io,
      buildHost: () => fakeBuild(),
      launchHost: async () => fakeLaunch(),
    });
    assert.equal(blockedCode, 1);
    assert.match(blocked.errorText(), /blocked/);

    const failed = captureIo();
    const failedCode = await main(['example.com'], {
      platform: 'win32',
      env: temp.env,
      io: failed.io,
      buildHost: () => {
        throw new Error('compiler exploded');
      },
      launchHost: async () => fakeLaunch(),
    });
    assert.equal(failedCode, 2);
    assert.match(failed.errorText(), /compiler exploded/);
  } finally {
    temp.cleanup();
  }
});

test('uninstall removes only the iebox data directory and registry value', async () => {
  const temp = makeTempEnv();
  try {
    const report = ensureConfig({ env: temp.env });
    const paths = configPaths({ env: temp.env });
    fs.mkdirSync(paths.hostDir, { recursive: true });
    fs.writeFileSync(paths.hostExe, 'MZ fake', 'utf8');
    fs.writeFileSync(path.join(temp.root, 'unrelated.txt'), 'keep me', 'utf8');

    let removedOptions = null;
    const captured = captureIo();
    const code = await main(['uninstall'], {
      platform: 'win32',
      env: temp.env,
      io: captured.io,
      removeEmulation: (options) => {
        removedOptions = options;
        return { ok: true, removed: true, error: null };
      },
    });

    assert.equal(code, 0);
    assert.equal(removedOptions.exe, 'iebox-host.exe');
    assert.equal(report.exists, true);
    assert.equal(fs.existsSync(paths.dir), false);
    assert.equal(fs.existsSync(path.join(temp.root, 'unrelated.txt')), true);
    assert.match(captured.text(), /Removed/);

    const second = captureIo();
    const secondCode = await main(['uninstall'], {
      platform: 'win32',
      env: temp.env,
      io: second.io,
      removeEmulation: () => ({ ok: true, removed: false, error: null }),
    });
    assert.equal(secondCode, 0);
    assert.match(second.text(), /Nothing to remove/);
  } finally {
    temp.cleanup();
  }
});

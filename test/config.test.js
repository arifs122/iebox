import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ROOT,
  DEFAULTS,
  defaultHomeUrl,
  defaultConfig,
  normalizeConfig,
  configDir,
  configPaths,
  loadConfig,
  loadConfigReport,
  saveConfig,
  ensureConfig,
  describeConfig,
} from '../src/config.js';
import { makeTempEnv } from './helpers.js';

test('configDir honours LOCALAPPDATA and falls back to the user profile', () => {
  assert.equal(configDir({ LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }), path.join('C:\\Users\\me\\AppData\\Local', 'iebox'));
  assert.match(configDir({ USERPROFILE: 'C:\\Users\\me' }), /iebox$/);
  assert.match(configDir({}), /iebox$/);
});

test('configPaths keeps every artefact under the iebox directory', () => {
  const paths = configPaths({ dir: 'C:\\data\\iebox' });
  assert.equal(paths.dir, 'C:\\data\\iebox');
  assert.equal(paths.file, path.join('C:\\data\\iebox', 'config.json'));
  assert.equal(paths.hostDir, path.join('C:\\data\\iebox', 'bin'));
  assert.equal(paths.hostExe, path.join('C:\\data\\iebox', 'bin', 'iebox-host.exe'));
  assert.equal(paths.buildMeta, path.join('C:\\data\\iebox', 'bin', 'build.json'));
});

test('default home is the bundled demo when available', () => {
  assert.equal(defaultHomeUrl({ exists: () => false }), DEFAULTS.homeUrl);
  assert.equal(
    defaultHomeUrl({ exists: () => true }),
    pathToFileURL(path.join(ROOT, 'docs', 'demo', 'legacy-page.html')).href,
  );
  assert.equal(defaultConfig({ homeUrl: 'https://home.example/' }).homeUrl, 'https://home.example/');
});

test('normalizeConfig repairs every invalid field', () => {
  const config = normalizeConfig({
    homeUrl: 'javascript:alert(1)',
    lastUrl: 42,
    emulation: 'ie6',
    seenWarning: 'yes',
    zoom: 9999,
    windowX: 'abc',
    windowY: 999999,
    windowWidth: 1,
    windowHeight: 999999,
    windowMaximized: 'true',
  });
  assert.equal(config.homeUrl, DEFAULTS.homeUrl);
  assert.equal(config.lastUrl, '');
  assert.equal(config.emulation, 'ie11');
  assert.equal(config.seenWarning, false);
  assert.equal(config.zoom, 400);
  assert.equal(config.windowX, -1);
  assert.equal(config.windowY, 100000);
  assert.equal(config.windowWidth, 480);
  assert.equal(config.windowHeight, 10000);
  assert.equal(config.windowMaximized, false);
});

test('normalizeConfig refuses script URLs in home and last URL', () => {
  const config = normalizeConfig({ homeUrl: 'javascript:alert(1)', lastUrl: 'vbscript:msgbox(1)' });
  assert.equal(config.homeUrl, DEFAULTS.homeUrl);
  assert.equal(config.lastUrl, '');
  assert.equal(normalizeConfig({ lastUrl: '' }).lastUrl, '');
  assert.equal(normalizeConfig({ lastUrl: 'data:text/html,hi' }).lastUrl, 'data:text/html,hi');
});

test('normalizeConfig keeps good values', () => {  const config = normalizeConfig({
    homeUrl: 'https://intranet.example/',
    lastUrl: 'http://intranet.example/a',
    emulation: 'ie9',
    seenWarning: true,
    zoom: 150,
    windowX: 20,
    windowY: 30,
    windowWidth: 900,
    windowHeight: 700,
    windowMaximized: true,
  });
  assert.equal(config.homeUrl, 'https://intranet.example/');
  assert.equal(config.lastUrl, 'http://intranet.example/a');
  assert.equal(config.emulation, 'ie9');
  assert.equal(config.seenWarning, true);
  assert.equal(config.zoom, 150);
  assert.equal(config.windowX, 20);
  assert.equal(config.windowY, 30);
  assert.equal(config.windowWidth, 900);
  assert.equal(config.windowHeight, 700);
  assert.equal(config.windowMaximized, true);
});

test('config round-trips through a temp directory', () => {
  const temp = makeTempEnv();
  try {
    const saved = saveConfig(
      {
        homeUrl: 'https://intranet.example/',
        lastUrl: 'http://intranet.example/report?id=7',
        emulation: 'ie8',
        seenWarning: true,
        zoom: 125,
        windowX: 40,
        windowY: 50,
        windowWidth: 1111,
        windowHeight: 777,
        windowMaximized: true,
      },
      { env: temp.env },
    );
    assert.equal(saved.ok, true);
    assert.ok(fs.existsSync(saved.path));

    const report = loadConfigReport({ env: temp.env });
    assert.equal(report.exists, true);
    assert.equal(report.warning, null);
    assert.equal(report.config.homeUrl, 'https://intranet.example/');
    assert.equal(report.config.lastUrl, 'http://intranet.example/report?id=7');
    assert.equal(report.config.emulation, 'ie8');
    assert.equal(report.config.seenWarning, true);
    assert.equal(report.config.zoom, 125);
    assert.equal(report.config.windowWidth, 1111);
    assert.equal(report.config.windowMaximized, true);
    assert.equal(loadConfig({ env: temp.env }).emulation, 'ie8');
  } finally {
    temp.cleanup();
  }
});

test('saveConfig merges and preserves unknown keys', () => {
  const temp = makeTempEnv();
  try {
    const paths = configPaths({ env: temp.env });
    fs.mkdirSync(paths.dir, { recursive: true });
    fs.writeFileSync(
      paths.file,
      JSON.stringify({ homeUrl: 'https://kept.example/', futureKey: { nested: true }, emulation: 'ie10' }),
      'utf8',
    );

    const result = saveConfig({ zoom: 200 }, { env: temp.env });
    assert.equal(result.ok, true);
    assert.equal(result.config.homeUrl, 'https://kept.example/');
    assert.equal(result.config.emulation, 'ie10');
    assert.equal(result.config.zoom, 200);

    const raw = JSON.parse(fs.readFileSync(paths.file, 'utf8'));
    assert.deepEqual(raw.futureKey, { nested: true });
  } finally {
    temp.cleanup();
  }
});

test('malformed config never throws and keeps a warning', () => {
  const temp = makeTempEnv();
  try {
    const paths = configPaths({ env: temp.env });
    fs.mkdirSync(paths.dir, { recursive: true });
    fs.writeFileSync(paths.file, '{ this is not json', 'utf8');

    let report;
    assert.doesNotThrow(() => {
      report = loadConfigReport({ env: temp.env });
    });
    assert.equal(report.exists, true);
    assert.match(report.warning, /could not be read/i);
    assert.equal(report.config.emulation, 'ie11');
    assert.equal(report.config.homeUrl, defaultHomeUrl());

    fs.writeFileSync(paths.file, '[]', 'utf8');
    const arrayReport = loadConfigReport({ env: temp.env });
    assert.match(arrayReport.warning, /JSON object/i);
  } finally {
    temp.cleanup();
  }
});

test('ensureConfig creates the file once', () => {
  const temp = makeTempEnv();
  try {
    const first = ensureConfig({ env: temp.env });
    assert.equal(first.created, true);
    assert.equal(first.exists, true);
    assert.ok(fs.existsSync(path.join(temp.root, 'iebox', 'config.json')));

    const second = ensureConfig({ env: temp.env });
    assert.equal(second.created, false);
    assert.equal(second.exists, true);
  } finally {
    temp.cleanup();
  }
});

test('saveConfig reports failure instead of throwing', () => {
  const temp = makeTempEnv();
  try {
    // Make the intended directory a file, so mkdir/ write fails.
    const blocker = path.join(temp.root, 'iebox');
    fs.writeFileSync(blocker, 'not a directory', 'utf8');
    let result;
    assert.doesNotThrow(() => {
      result = saveConfig({ zoom: 110 }, { env: temp.env });
    });
    assert.equal(result.ok, false);
    assert.equal(typeof result.error, 'string');
  } finally {
    temp.cleanup();
  }
});

test('describeConfig lists the important values', () => {
  const rows = describeConfig({ ...DEFAULTS, zoom: 130, lastUrl: '' });
  const flat = rows.map(([key, value]) => `${key}=${value}`).join('|');
  assert.match(flat, /homeUrl=/);
  assert.match(flat, /zoom=130%/);
  assert.match(flat, /lastUrl=\(none\)/);
  assert.equal(rows.length, 7);
});

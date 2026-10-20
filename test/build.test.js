import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  BUILD_CACHE_VERSION,
  hostSourcePath,
  cscCandidates,
  findCsc,
  sourceHash,
  buildArgs,
  normalizeArch,
  readPeMachine,
  readBuildMeta,
  isCacheValid,
  extractCompilerErrors,
  buildHost,
  inspectHost,
} from '../src/build.js';
import { OperationalError } from '../src/util.js';
import { makeTempEnv } from './helpers.js';

const MZ = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(2048, 0x90)]);

function makeFakeRunner(counter) {
  return (_command, args) => {
    counter.calls += 1;
    const outArg = args.find((arg) => arg.startsWith('/out:'));
    assert.ok(outArg, 'compiler was called without /out:');
    fs.writeFileSync(outArg.slice('/out:'.length), MZ);
    return { status: 0, stdout: '', stderr: '' };
  };
}

function makeSource(dir, body = 'class Host { static void Main() { } }') {
  const file = path.join(dir, 'host.cs');
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

test('csc discovery uses the Framework64 path first', () => {
  const candidates = cscCandidates({ WINDIR: 'C:\\Windows' });
  assert.equal(candidates[0], 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe');
  assert.equal(candidates[1], 'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe');

  const chosen = findCsc({
    platform: 'win32',
    env: { WINDIR: 'C:\\Windows' },
    exists: (file) => file.includes('Framework64'),
  });
  assert.equal(chosen, candidates[0]);

  const fallback = findCsc({
    platform: 'win32',
    env: { WINDIR: 'C:\\Windows' },
    exists: (file) => file.includes('Framework\\'),
  });
  assert.equal(fallback, candidates[1]);
});

test('csc discovery supports IEBOX_CSC and returns null off Windows', () => {
  const override = findCsc({
    platform: 'win32',
    env: { WINDIR: 'C:\\Windows', IEBOX_CSC: 'D:\\tools\\csc.exe' },
    exists: (file) => file === 'D:\\tools\\csc.exe',
  });
  assert.equal(override, 'D:\\tools\\csc.exe');
  assert.equal(findCsc({ platform: 'linux', env: {} }), null);
  assert.equal(findCsc({ platform: 'darwin', env: {} }), null);
  assert.equal(findCsc({ platform: 'win32', env: { WINDIR: 'C:\\Windows' }, exists: () => false }), null);
});

test('buildArgs lists the exact csc command line and defaults to x86', () => {
  const args = buildArgs({ source: 'host\\IeBoxHost.cs', out: 'C:\\out\\iebox-host.exe' });
  assert.deepEqual(args, [
    '/nologo',
    '/target:winexe',
    '/platform:x86',
    '/optimize+',
    '/codepage:65001',
    '/warn:4',
    '/out:C:\\out\\iebox-host.exe',
    '/r:System.dll',
    '/r:System.Drawing.dll',
    '/r:System.Windows.Forms.dll',
    'host\\IeBoxHost.cs',
  ]);
  assert.ok(buildArgs({ source: 'a.cs', out: 'b.exe', arch: 'x64' }).includes('/platform:x64'));
  assert.ok(buildArgs({ source: 'a.cs', out: 'b.exe', arch: 'anycpu' }).includes('/platform:anycpu'));
  assert.throws(() => buildArgs({}), /source and out/);
  assert.ok(hostSourcePath().endsWith(path.join('host', 'IeBoxHost.cs')));
});

test('normalizeArch accepts the documented aliases and rejects nonsense', () => {
  assert.equal(normalizeArch(), 'x86');
  assert.equal(normalizeArch(''), 'x86');
  assert.equal(normalizeArch('X86'), 'x86');
  assert.equal(normalizeArch('32'), 'x86');
  assert.equal(normalizeArch('ia32'), 'x86');
  assert.equal(normalizeArch('64'), 'x64');
  assert.equal(normalizeArch('amd64'), 'x64');
  assert.equal(normalizeArch('any'), 'anycpu');
  assert.throws(() => normalizeArch('arm'), /Unknown architecture/);
});

test('sourceHash is stable, versioned and sensitive to content', () => {
  const a = sourceHash('class A {}');
  const b = sourceHash('class A {}');
  const c = sourceHash('class B {}');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(BUILD_CACHE_VERSION, 2);
});

test('isCacheValid requires hash, size, version and a real exe', () => {
  const meta = { cacheVersion: BUILD_CACHE_VERSION, hash: 'abc', size: 100, arch: 'x86' };
  assert.equal(isCacheValid(meta, { hash: 'abc', exeExists: true, exeSize: 100 }), true);
  assert.equal(isCacheValid(meta, { hash: 'abc', arch: 'x86', exeExists: true, exeSize: 100 }), true);
  assert.equal(isCacheValid(meta, { hash: 'abc', arch: 'x64', exeExists: true, exeSize: 100 }), false);
  assert.equal(isCacheValid(meta, { hash: 'abc', exeExists: false, exeSize: 100 }), false);
  assert.equal(isCacheValid(meta, { hash: 'other', exeExists: true, exeSize: 100 }), false);
  assert.equal(isCacheValid(meta, { hash: 'abc', exeExists: true, exeSize: 99 }), false);
  assert.equal(isCacheValid({ ...meta, cacheVersion: 1 }, { hash: 'abc', exeExists: true, exeSize: 100 }), false);
  assert.equal(isCacheValid(null, { hash: 'abc', exeExists: true, exeSize: 100 }), false);
});

test('extractCompilerErrors keeps error lines and always returns text', () => {
  const text = extractCompilerErrors(
    'warning CS0168: unused\nIeBoxHost.cs(1,1): error CS1002: ; expected\n',
    '',
  );
  assert.match(text, /error CS1002/);
  assert.doesNotMatch(text, /warning CS0168/);
  assert.match(extractCompilerErrors('', ''), /no output/i);
  assert.match(extractCompilerErrors('', 'fatal boom'), /fatal boom/);
});

test('buildHost compiles, caches by hash, and recompiles on change', () => {
  const temp = makeTempEnv();
  try {
    const source = makeSource(temp.root, 'class One { }');
    const counter = { calls: 0 };
    const options = {
      platform: 'win32',
      dir: path.join(temp.root, 'data'),
      sourcePath: source,
      cscPath: 'C:\\fake\\csc.exe',
      runner: makeFakeRunner(counter),
    };

    const first = buildHost(options);
    assert.equal(first.ok, true);
    assert.equal(first.reused, false);
    assert.equal(counter.calls, 1);
    assert.ok(fs.existsSync(first.exe));
    assert.equal(fs.statSync(first.exe).size, MZ.length);

    const meta = readBuildMeta(path.join(temp.root, 'data', 'bin', 'build.json'));
    assert.equal(meta.cacheVersion, BUILD_CACHE_VERSION);
    assert.equal(meta.hash, sourceHash('class One { }'));
    assert.equal(meta.size, MZ.length);

    const second = buildHost(options);
    assert.equal(second.reused, true);
    assert.equal(counter.calls, 1);
    assert.equal(second.exe, first.exe);

    const forced = buildHost({ ...options, force: true });
    assert.equal(forced.reused, false);
    assert.equal(counter.calls, 2);

    fs.writeFileSync(source, 'class Two { }', 'utf8');
    const changed = buildHost(options);
    assert.equal(changed.reused, false);
    assert.equal(counter.calls, 3);
    assert.notEqual(changed.hash, first.hash);
  } finally {
    temp.cleanup();
  }
});

test('buildHost rebuilds when the cached exe is truncated', () => {
  const temp = makeTempEnv();
  try {
    const source = makeSource(temp.root);
    const counter = { calls: 0 };
    const options = {
      platform: 'win32',
      dir: path.join(temp.root, 'data'),
      sourcePath: source,
      cscPath: 'C:\\fake\\csc.exe',
      runner: makeFakeRunner(counter),
    };
    const first = buildHost(options);
    fs.truncateSync(first.exe, 10);
    const second = buildHost(options);
    assert.equal(second.reused, false);
    assert.equal(counter.calls, 2);
    assert.equal(fs.statSync(second.exe).size, MZ.length);
  } finally {
    temp.cleanup();
  }
});

test('buildHost reports compiler failures as OperationalError', () => {
  const temp = makeTempEnv();
  try {
    const source = makeSource(temp.root);
    const options = {
      platform: 'win32',
      dir: path.join(temp.root, 'data'),
      sourcePath: source,
      cscPath: 'C:\\fake\\csc.exe',
      runner: () => ({ status: 1, stdout: '', stderr: 'host.cs(1,1): error CS1002: ; expected' }),
    };
    assert.throws(
      () => buildHost(options),
      (error) => error instanceof OperationalError && /CS1002/.test(error.message),
    );
  } finally {
    temp.cleanup();
  }
});

test('buildHost refuses non-Windows and a missing compiler', () => {
  const temp = makeTempEnv();
  try {
    const source = makeSource(temp.root);
    assert.throws(
      () => buildHost({ platform: 'linux', dir: temp.root, sourcePath: source }),
      (error) => error instanceof OperationalError && /Windows-only/.test(error.message),
    );
    assert.throws(
      () =>
        buildHost({
          platform: 'win32',
          dir: temp.root,
          sourcePath: source,
          env: { WINDIR: 'C:\\Windows' },
          exists: () => false,
        }),
      (error) => error instanceof OperationalError && /csc\.exe/.test(error.message),
    );
  } finally {
    temp.cleanup();
  }
});

test('inspectHost reports missing, stale and fresh states', () => {
  const temp = makeTempEnv();
  try {
    const source = makeSource(temp.root);
    const dir = path.join(temp.root, 'data');
    const missing = inspectHost({ dir, sourcePath: source });
    assert.equal(missing.exists, false);
    assert.equal(missing.fresh, false);
    assert.equal(missing.size, 0);

    const counter = { calls: 0 };
    const options = {
      platform: 'win32',
      dir,
      sourcePath: source,
      cscPath: 'C:\\fake\\csc.exe',
      runner: makeFakeRunner(counter),
    };
    buildHost(options);
    const fresh = inspectHost({ dir, sourcePath: source });
    assert.equal(fresh.exists, true);
    assert.equal(fresh.valid, true);
    assert.equal(fresh.fresh, true);
    assert.equal(fresh.size, MZ.length);

    fs.writeFileSync(source, 'class Changed { }', 'utf8');
    const stale = inspectHost({ dir, sourcePath: source });
    assert.equal(stale.exists, true);
    assert.equal(stale.fresh, false);
  } finally {
    temp.cleanup();
  }
});

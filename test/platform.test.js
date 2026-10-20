import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EXIT,
  IeBoxError,
  UserError,
  OperationalError,
  PlatformError,
  isWindows,
  assertWindows,
  exitCodeFor,
  toError,
  stripAnsi,
  makeColors,
  shouldUseColor,
  formatBytes,
  clamp,
  isPlainObject,
  escapeRegExp,
  shortenPath,
  productTitle,
  PRODUCT,
  VERSION,
} from '../src/util.js';

test('platform guards are explicit and exit with code 2', () => {
  assert.equal(isWindows('win32'), true);
  assert.equal(isWindows('linux'), false);
  assert.equal(isWindows('darwin'), false);
  assert.equal(assertWindows('win32'), true);

  for (const platform of ['linux', 'darwin', 'freebsd']) {
    assert.throws(
      () => assertWindows(platform),
      (error) =>
        error instanceof PlatformError &&
        error.exitCode === EXIT.OPERATIONAL &&
        /iebox is Windows-only/.test(error.message) &&
        error.message.includes(platform),
    );
  }
});

test('error classes carry the documented exit codes', () => {
  const user = new UserError('bad input');
  const operational = new OperationalError('bad machine');
  const base = new IeBoxError('base');
  assert.equal(user.exitCode, 1);
  assert.equal(operational.exitCode, 2);
  assert.equal(base.exitCode, 2);
  assert.equal(exitCodeFor(user), 1);
  assert.equal(exitCodeFor(operational), 2);
  assert.equal(exitCodeFor(new Error('plain')), 2);
  assert.equal(exitCodeFor(null), 2);
  assert.equal(toError('text').message, 'text');
  assert.equal(toError(new Error('kept')).message, 'kept');
});

test('ANSI colours can be disabled and stripped', () => {
  const plain = makeColors(false);
  assert.equal(plain.red('hello'), 'hello');
  assert.equal(plain.bold('x'), 'x');

  const colour = makeColors(true);
  const painted = colour.green('ok');
  assert.match(painted, /\u001b\[32m/);
  assert.equal(stripAnsi(painted), 'ok');
  assert.equal(stripAnsi(`${colour.red('a')}${colour.cyan('b')}`), 'ab');
  assert.equal(colour.enabled, true);
});

test('shouldUseColor respects flags, NO_COLOR and non-TTY streams', () => {
  assert.equal(shouldUseColor({ noColor: true, env: {}, stream: { isTTY: true } }), false);
  assert.equal(shouldUseColor({ quiet: true, env: {}, stream: { isTTY: true } }), false);
  assert.equal(shouldUseColor({ env: { NO_COLOR: '1' }, stream: { isTTY: true } }), false);
  assert.equal(shouldUseColor({ env: { TERM: 'dumb' }, stream: { isTTY: true } }), false);
  assert.equal(shouldUseColor({ env: {}, stream: { isTTY: false } }), false);
  assert.equal(shouldUseColor({ env: {}, stream: { isTTY: true } }), true);
  assert.equal(shouldUseColor({ env: { FORCE_COLOR: '1' }, stream: { isTTY: false } }), true);
  assert.equal(shouldUseColor({ env: { FORCE_COLOR: '0' }, stream: { isTTY: true } }), false);
});

test('formatBytes is stable and human-readable', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(46592), '45.5 KB');
  assert.equal(formatBytes(1024 * 1024), '1.0 MB');
  assert.equal(formatBytes(1024 * 1024 * 850), '850 MB');
  assert.equal(formatBytes(-1), 'unknown size');
  assert.equal(formatBytes('nope'), 'unknown size');
});

test('small helpers behave under bad input', () => {
  assert.equal(clamp(5, 1, 10), 5);
  assert.equal(clamp(-5, 1, 10), 1);
  assert.equal(clamp(50, 1, 10), 10);
  assert.equal(clamp('nope', 1, 10), 1);
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject([]), false);
  assert.equal(isPlainObject(null), false);
  assert.equal(escapeRegExp('a.b*c'), 'a\\.b\\*c');
  assert.equal(shortenPath('short', 20), 'short');
  assert.match(shortenPath('C:\\very\\long\\path\\that\\goes\\on\\and\\on', 20), /\.\.\./);
  assert.equal(productTitle(), `${PRODUCT} ${VERSION}`);
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EMULATION_MODES,
  EMULATION_ORDER,
  DEFAULT_EMULATION,
  isEmulation,
  parseEmulation,
  emulationValue,
  emulationLabel,
  emulationFromValue,
  emulationOptions,
  describeEmulation,
} from '../src/emulation.js';

test('emulation map has the exact registry values', () => {
  assert.equal(EMULATION_MODES.ie11.value, 11001);
  assert.equal(EMULATION_MODES.ie10.value, 10001);
  assert.equal(EMULATION_MODES.ie9.value, 9999);
  assert.equal(EMULATION_MODES.ie8.value, 8888);
  assert.equal(EMULATION_MODES.ie7.value, 7000);
  assert.equal(DEFAULT_EMULATION, 'ie11');
  assert.deepEqual(EMULATION_ORDER, ['ie11', 'ie10', 'ie9', 'ie8', 'ie7']);
});

test('emulation labels and descriptions are present', () => {
  for (const mode of EMULATION_ORDER) {
    assert.equal(typeof EMULATION_MODES[mode].label, 'string');
    assert.ok(EMULATION_MODES[mode].label.length > 0);
    assert.equal(typeof EMULATION_MODES[mode].description, 'string');
    assert.ok(EMULATION_MODES[mode].description.length > 0);
  }
  assert.equal(emulationLabel('ie9'), 'IE9');
  assert.equal(emulationLabel('IE10'), 'IE10');
  assert.equal(emulationLabel('nope'), null);
  assert.equal(describeEmulation('ie8'), 'IE8 (8888)');
  assert.equal(describeEmulation('nope'), 'unknown');
});

test('isEmulation accepts only known modes, case-insensitively', () => {
  for (const mode of EMULATION_ORDER) {
    assert.equal(isEmulation(mode), true);
    assert.equal(isEmulation(mode.toUpperCase()), true);
    assert.equal(isEmulation(` ${mode} `), true);
  }
  assert.equal(isEmulation('ie12'), false);
  assert.equal(isEmulation(''), false);
  assert.equal(isEmulation(null), false);
  assert.equal(isEmulation(11001), false);
  assert.equal(isEmulation('toString'), false);
});

test('parseEmulation accepts friendly spellings', () => {
  assert.equal(parseEmulation('IE 11'), 'ie11');
  assert.equal(parseEmulation('ie11'), 'ie11');
  assert.equal(parseEmulation('11'), 'ie11');
  assert.equal(parseEmulation('10'), 'ie10');
  assert.equal(parseEmulation('9'), 'ie9');
  assert.equal(parseEmulation('8'), 'ie8');
  assert.equal(parseEmulation('7'), 'ie7');
  assert.equal(parseEmulation(' IE9 '), 'ie9');
  assert.equal(parseEmulation('ie6'), null);
  assert.equal(parseEmulation(''), null);
  assert.equal(parseEmulation(undefined), null);
});

test('emulationValue maps modes and rejects unknown ones', () => {
  assert.equal(emulationValue('ie11'), 11001);
  assert.equal(emulationValue('IE7'), 7000);
  assert.equal(emulationValue('ie 10'), 10001);
  assert.throws(() => emulationValue('ie6'), RangeError);
});

test('emulationFromValue reverses the map', () => {
  assert.equal(emulationFromValue(11001), 'ie11');
  assert.equal(emulationFromValue(10001), 'ie10');
  assert.equal(emulationFromValue(9999), 'ie9');
  assert.equal(emulationFromValue(8888), 'ie8');
  assert.equal(emulationFromValue(7000), 'ie7');
  assert.equal(emulationFromValue(11002), null);
  assert.equal(emulationFromValue('11001'), 'ie11');
});

test('emulationOptions returns ordered copies', () => {
  const options = emulationOptions();
  assert.equal(options.length, 5);
  assert.deepEqual(options.map((o) => o.mode), EMULATION_ORDER);
  assert.equal(options[0].value, 11001);
  options[0].mode = 'mutated';
  assert.equal(EMULATION_MODES.ie11.mode, 'ie11');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { hostSourcePath } from '../src/build.js';

const source = fs.readFileSync(hostSourcePath(), 'utf8');

test('host source contains the mandatory security warning', () => {
  assert.match(
    source,
    /The legacy Trident engine is unsandboxed and no longer receives security updates\./,
  );
  assert.match(source, /Use iebox only for trusted legacy sites\. Continue\?/);
  assert.match(source, /Don't show this warning again/);
  assert.match(source, /WarningForm/);
});

test('host never overrides certificate validation', () => {
  assert.doesNotMatch(source, /ServerCertificateValidationCallback/);
  assert.doesNotMatch(source, /ServicePointManager/);
  assert.doesNotMatch(source, /CertificateValidation/);
  assert.doesNotMatch(source, /RemoteCertificateValidationCallback/);
});

test('host targets the Trident WebBrowser control and HKCU emulation', () => {
  assert.match(source, /using System\.Windows\.Forms;/);
  assert.match(source, /new WebBrowser\(\)/);
  assert.match(source, /FEATURE_BROWSER_EMULATION/);
  assert.match(source, /Registry\.CurrentUser/);
  assert.doesNotMatch(source, /Registry\.LocalMachine/);
  assert.doesNotMatch(source, /HKLM/);
  assert.match(source, /11001/);
  assert.match(source, /10001/);
  assert.match(source, /9999/);
  assert.match(source, /8888/);
  assert.match(source, /7000/);
});

test('emulation is applied before the WebBrowser is created', () => {
  const applyIndex = source.indexOf('Emulation.Apply(exeName, Emulation.Value(emulation));');
  const formIndex = source.indexOf('new MainForm(config, url, exeName)');
  assert.ok(applyIndex > 0, 'Emulation.Apply call is missing');
  assert.ok(formIndex > applyIndex, 'emulation must be written before the form/control exists');
});

test('host handles popups (NewWindow2/NewWindow3) and never opens IE windows', () => {
  assert.match(source, /NewWindow3/);
  assert.match(source, /NewWindow2/);
  assert.match(source, /DispId\(273\)/);
  assert.match(source, /DispId\(251\)/);
  assert.match(source, /34A715A0-6587-11D0-924A-0020AFC7AC4D/);
  assert.match(source, /e\.Cancel = true;/);
});

test('host has the required toolbar, status bar and overlay', () => {
  assert.match(source, /Trident \(legacy engine\)/);
  assert.match(source, /"Modern"/);
  assert.match(source, /"Home"/);
  assert.match(source, /"Go"/);
  assert.match(source, /Open in modern browser/);
  assert.match(source, /This page could not be opened/);
  assert.match(source, /UseShellExecute = true/);
});

test('host implements the documented keyboard shortcuts and commands', () => {
  assert.match(source, /Keys\.Control \| Keys\.L/);
  assert.match(source, /Keys\.Alt \| Keys\.Left/);
  assert.match(source, /Keys\.Alt \| Keys\.Right/);
  assert.match(source, /Keys\.F5/);
  assert.match(source, /Keys\.Control \| Keys\.R/);
  assert.match(source, /Keys\.Control \| Keys\.P/);
  assert.match(source, /Keys\.Control \| Keys\.D0/);
  assert.match(source, /Keys\.Escape/);
  assert.match(source, /ExecCommand\(6, 1, null\)/);
  assert.match(source, /ExecCommand\(63, 2, percent\)/);
  assert.match(source, /ApplyCssZoom/);
});

test('the host blocks script and shell schemes in the address bar', () => {
  assert.match(source, /That URL scheme is not allowed\./);
  assert.match(source, /scheme != "http" && scheme != "https" && scheme != "file"/);
  assert.match(source, /scheme != "ftp" && scheme != "about" && scheme != "data"/);
  assert.match(source, /There is no web URL to open in the default browser\./);
});

test('host keeps the page title format and window state', () => {
  assert.match(source, /\\u2014 iebox/);
  assert.match(source, /DocumentTitle/);
  assert.match(source, /WindowMaximized/);
  assert.match(source, /WindowWidth/);
  assert.match(source, /RestoreBounds/);
});

test('host source is ASCII-only and self-contained', () => {
  // Keeping the source ASCII means csc reads it correctly regardless of the
  // machine's ANSI code page. Typographic characters use \\uXXXX escapes.
  assert.ok(!/[^\x00-\x7F]/.test(source), 'host/IeBoxHost.cs must contain only ASCII characters');
  assert.doesNotMatch(source, /https?:\/\/[^\s"']+\.(?:png|jpg|gif|css|js)/i);
  assert.doesNotMatch(source, /AutoUpdate|updater/i);
});

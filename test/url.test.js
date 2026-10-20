import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  normalizeUrl,
  hasScheme,
  stripTrailingDots,
  windowsPathToFileUrl,
  describeUrl,
} from '../src/url.js';
import { UserError } from '../src/util.js';

const isUserError = (error) => error instanceof UserError && error.exitCode === 1;

test('normalizeUrl: bare hosts get http:// and a trailing slash', () => {
  assert.equal(normalizeUrl('example.com'), 'http://example.com/');
  assert.equal(normalizeUrl('www.example.com'), 'http://www.example.com/');
  assert.equal(normalizeUrl('intranet'), 'http://intranet/');
  assert.equal(normalizeUrl('localhost'), 'http://localhost/');
});

test('normalizeUrl: host:port is not mistaken for a scheme', () => {
  assert.equal(normalizeUrl('localhost:3000'), 'http://localhost:3000/');
  assert.equal(normalizeUrl('127.0.0.1:8080'), 'http://127.0.0.1:8080/');
  assert.equal(normalizeUrl('example.com:8080/path'), 'http://example.com:8080/path');
  assert.equal(normalizeUrl('[::1]:5173'), 'http://[::1]:5173/');
});

test('normalizeUrl: existing http/https URLs are preserved and normalised', () => {
  assert.equal(normalizeUrl('https://example.com/a/b?c=d#e'), 'https://example.com/a/b?c=d#e');
  assert.equal(normalizeUrl('HTTPS://EXAMPLE.COM/Path'), 'https://example.com/Path');
  assert.equal(normalizeUrl('http://example.com'), 'http://example.com/');
  assert.equal(normalizeUrl('ftp://files.example.com/pub'), 'ftp://files.example.com/pub');
  assert.equal(normalizeUrl('http://user:pass@example.com/'), 'http://user:pass@example.com/');
});

test('normalizeUrl: trailing dots are stripped from host names', () => {
  assert.equal(normalizeUrl('example.com.'), 'http://example.com/');
  assert.equal(normalizeUrl('http://example.com./page'), 'http://example.com/page');
  assert.equal(normalizeUrl('example.com.:8080/x'), 'http://example.com:8080/x');
  assert.equal(stripTrailingDots('example.com...'), 'example.com');
  assert.equal(stripTrailingDots('.'), '.');
});

test('normalizeUrl: unicode hosts and paths are encoded safely', () => {
  assert.equal(normalizeUrl('münchen.example'), 'http://xn--mnchen-3ya.example/');
  assert.equal(normalizeUrl('http://münchen.example/straße'), 'http://xn--mnchen-3ya.example/stra%C3%9Fe');
  assert.equal(normalizeUrl('http://example.com/a b'), 'http://example.com/a%20b');
  assert.equal(normalizeUrl('http://example.com/?q=a b'), 'http://example.com/?q=a%20b');
});

test('normalizeUrl: Windows paths become file URLs', () => {
  assert.equal(normalizeUrl('C:\\pages\\index.html'), 'file:///C:/pages/index.html');
  assert.equal(normalizeUrl('C:/pages/index.html'), 'file:///C:/pages/index.html');
  assert.equal(
    normalizeUrl('C:\\Users\\Arif\\My Page.html'),
    'file:///C:/Users/Arif/My%20Page.html',
  );
  assert.equal(
    normalizeUrl('C:\\Users\\Arif\\Türkçe\\sayfa.html'),
    'file:///C:/Users/Arif/T%C3%BCrk%C3%A7e/sayfa.html',
  );
  assert.equal(normalizeUrl('C:\\'), 'file:///C:/');
});

test('normalizeUrl: UNC paths become file URLs', () => {
  assert.equal(
    normalizeUrl('\\\\server\\share\\folder name\\x.html'),
    'file://server/share/folder%20name/x.html',
  );
  assert.match(windowsPathToFileUrl('\\\\server\\share\\x.txt'), /^file:\/\/server\/share\/x\.txt$/);
});

test('normalizeUrl: about:, data: and file: are supported', () => {
  assert.equal(normalizeUrl('about:blank'), 'about:blank');
  assert.equal(normalizeUrl('ABOUT:blank'), 'about:blank');
  assert.equal(normalizeUrl('about:blank#fragment'), 'about:blank#fragment');
  assert.equal(normalizeUrl('data:text/html,<h1>hi</h1>'), 'data:text/html,<h1>hi</h1>');
  assert.equal(normalizeUrl('file:///C:/My%20Page.html'), 'file:///C:/My%20Page.html');
  assert.match(normalizeUrl('file:C:/plain.txt'), /^file:\/\/\/C:\/plain\.txt$/);
});

test('normalizeUrl: quotes, angle brackets and wrapped whitespace are removed', () => {
  assert.equal(normalizeUrl('  "example.com"  '), 'http://example.com/');
  assert.equal(normalizeUrl("'example.com'"), 'http://example.com/');
  assert.equal(normalizeUrl('<https://example.com/>'), 'https://example.com/');
  assert.equal(normalizeUrl('exa\nmple.com'), 'http://example.com/');
});

test('normalizeUrl: protocol-relative URLs use http', () => {
  assert.equal(normalizeUrl('//example.com/x'), 'http://example.com/x');
  assert.equal(hasScheme('//example.com'), false);
  assert.equal(hasScheme('https://example.com'), true);
});

test('normalizeUrl: an existing local file wins over a host guess', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iebox-url-'));
  try {
    const file = path.join(root, 'legacy page.html');
    fs.writeFileSync(file, '<html></html>', 'utf8');
    assert.equal(
      normalizeUrl('legacy page.html', { cwd: root, fileExists: fs.existsSync }),
      pathToFileURL(file).href,
    );
    assert.equal(
      normalizeUrl('./legacy page.html', { cwd: root, fileExists: fs.existsSync }),
      pathToFileURL(file).href,
    );
    assert.equal(
      normalizeUrl('does-not-exist.html', { cwd: root, fileExists: fs.existsSync }),
      'http://does-not-exist.html/',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('normalizeUrl: dangerous and unsupported schemes are rejected', () => {
  for (const input of [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'vbscript:msgbox(1)',
    'blob:https://example.com/abc',
    'chrome-extension://abc/x.html',
    'edge://settings',
    'steam://run/1',
    'ms-settings:privacy',
  ]) {
    assert.throws(
      () => normalizeUrl(input),
      isUserError,
      `expected ${input} to be rejected`,
    );
  }
});

test('normalizeUrl: empty and invalid input throws UserError', () => {
  assert.throws(() => normalizeUrl(''), isUserError);
  assert.throws(() => normalizeUrl('   '), isUserError);
  assert.throws(() => normalizeUrl(null), isUserError);
  assert.throws(() => normalizeUrl(42), isUserError);
  assert.throws(() => normalizeUrl('http://'), isUserError);
  assert.throws(() => normalizeUrl('https://exa mple.com'), isUserError);
});

test('describeUrl returns a useful status hint', () => {
  assert.equal(describeUrl('https://example.com/a'), 'example.com');
  assert.equal(describeUrl('http://localhost:3000/'), 'localhost:3000');
  assert.equal(describeUrl('not a url'), 'not a url');
  assert.match(describeUrl('file:///C:/My%20Page.html'), /My Page\.html$/);
});

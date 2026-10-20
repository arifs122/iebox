/**
 * URL normalisation for the address bar and the CLI.
 *
 * The goal is not to be a full URL parser (WHATWG URL already is one) but to
 * turn the many things a person types into something the legacy engine can
 * navigate to:
 *
 *   example.com              -> http://example.com/
 *   localhost:3000           -> http://localhost:3000/
 *   example.com:8080/x       -> http://example.com:8080/x
 *   C:\pages\index.html      -> file:///C:/pages/index.html
 *   docs/demo/legacy-page.html (if the file exists) -> file:///...
 *   münchen.example          -> http://xn--mnchen-3ya.example/
 *   example.com.             -> http://example.com/
 *   about:blank, data:, file: are preserved
 *
 * Anything the engine cannot or should not open (javascript:, vbscript:, ...)
 * is rejected with a UserError.
 */

import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { UserError } from './util.js';

const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;
const WINDOWS_DRIVE_RE = /^[a-zA-Z]:[\\/]/;
const UNC_RE = /^\\\\[^\\]/;
const HOST_PORT_RE = /^(?:[a-z0-9._-]+|\[[0-9a-f:.]+\]):\d+(?:[/?#]|$)/i;
const TRAILING_DOTS_RE = /\.+$/;

export const SUPPORTED_SCHEMES = Object.freeze(['http', 'https', 'file', 'about', 'data', 'ftp']);

const BLOCKED_SCHEMES = new Set([
  'javascript',
  'vbscript',
  'blob',
  'chrome',
  'chrome-extension',
  'edge',
]);

/** True when the input already starts with something that looks like a scheme. */
export function hasScheme(input) {
  return SCHEME_RE.test(String(input).trim());
}

export function stripTrailingDots(hostname) {
  if (!hostname) return hostname;
  const stripped = String(hostname).replace(TRAILING_DOTS_RE, '');
  return stripped.length > 0 ? stripped : hostname;
}

/**
 * Convert a Windows path to a file:// URL without relying on the host
 * platform, so tests can exercise Windows paths on Linux CI.
 */
export function windowsPathToFileUrl(value) {
  const normalised = String(value).replace(/\\/g, '/');

  if (UNC_RE.test(String(value))) {
    const rest = normalised.replace(/^\/+/, '');
    const parts = rest.split('/');
    const server = parts.shift() || '';
    const encoded = parts.map(encodeURIComponent).join('/');
    return `file://${server}/${encoded}`;
  }

  if (WINDOWS_DRIVE_RE.test(String(value))) {
    const parts = normalised.split('/');
    const drive = parts.shift(); // "C:"
    const encoded = parts.map(encodeURIComponent).join('/');
    return `file:///${drive}/${encoded}`;
  }

  return pathToFileURL(normalised).href;
}

function normaliseHttp(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    // Last attempt: percent-encode characters the URL parser rejects (some
    // legacy intranet links contain raw spaces or non-ASCII query strings).
    try {
      url = new URL(encodeURI(value));
    } catch {
      throw new UserError(`"${value}" is not a valid URL.`);
    }
  }

  if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'ftp:') {
    if (!url.hostname) throw new UserError(`"${value}" has no host name.`);
    const cleanHost = stripTrailingDots(url.hostname);
    if (cleanHost !== url.hostname) {
      try {
        url.hostname = cleanHost;
      } catch {
        /* keep the original host if the setter rejects it */
      }
    }
  }

  return url.href;
}

function normaliseFile(value) {
  try {
    return new URL(value).href;
  } catch {
    const rest = value.replace(/^file:\/*/i, '');
    if (WINDOWS_DRIVE_RE.test(rest)) return windowsPathToFileUrl(rest);
    throw new UserError(`"${value}" is not a valid file URL.`);
  }
}

function normaliseAbout(value) {
  return value.replace(/^about:/i, 'about:').trim();
}

function normaliseData(value) {
  // Leave data: payloads untouched: re-encoding would corrupt them.
  return value;
}

function looksLikeLocalPath(value) {
  if (value.startsWith('./') || value.startsWith('../') || value.startsWith('/')) return true;
  if (value.startsWith('~')) return true;
  if (value.includes('\\') || value.includes('/')) return true;
  return /\.(?:html?|xhtml|pdf|txt|xml|svg|png|jpe?g|gif|webp|css|js|json|md)$/i.test(value);
}

function existingFileUrl(value, options) {
  if (typeof options.fileExists !== 'function') return null;
  let candidate = value;
  if (candidate.startsWith('~')) {
    const home = options.homeDir || os.homedir();
    candidate = path.join(home, candidate.slice(1));
  }
  const cwd = options.cwd || process.cwd();
  const absolute = path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate);
  try {
    if (!options.fileExists(absolute)) return null;
  } catch {
    return null;
  }
  return pathToFileURL(absolute).href;
}

/**
 * Normalise user input into an absolute URL string.
 *
 * @param {string} input
 * @param {{ cwd?: string, homeDir?: string, fileExists?: (p: string) => boolean }} [options]
 * @returns {string}
 */
export function normalizeUrl(input, options = {}) {
  if (typeof input !== 'string') throw new UserError('A URL must be a string.');

  let value = input.trim();

  // People paste URLs wrapped in quotes or angle brackets.
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
    (value.startsWith("'") && value.endsWith("'") && value.length > 1) ||
    (value.startsWith('<') && value.endsWith('>') && value.length > 1)
  ) {
    value = value.slice(1, -1).trim();
  }

  // Embedded newlines/tabs come from wrapped terminal output; drop them.
  value = value.replace(/[\r\n\t]+/g, '');
  if (value.length === 0) {
    throw new UserError('No URL was given. Try: iebox https://example.com/');
  }

  // Local filesystem paths are unambiguous and must be checked before the
  // scheme heuristic ("C:" looks like a scheme).
  if (WINDOWS_DRIVE_RE.test(value) || UNC_RE.test(value)) {
    return windowsPathToFileUrl(value);
  }

  const schemeMatch = SCHEME_RE.exec(value);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();

    if (BLOCKED_SCHEMES.has(scheme)) {
      throw new UserError(
        `The "${scheme}:" scheme is blocked. iebox only opens pages, not script URLs.`,
      );
    }

    // "example.com:8080", "localhost:3000" and "[::1]:5173" are hosts with a
    // port, not schemes, even though the regex matches the dot-separated part.
    if (!SUPPORTED_SCHEMES.includes(scheme)) {
      if (HOST_PORT_RE.test(value)) return normaliseHttp(`http://${value}`);
      throw new UserError(
        `Unsupported URL scheme "${scheme}:". Supported schemes: ${SUPPORTED_SCHEMES.join(', ')}.`,
      );
    }

    if (scheme === 'about') return normaliseAbout(value);
    if (scheme === 'data') return normaliseData(value);
    if (scheme === 'file') return normaliseFile(value);
    return normaliseHttp(value);
  }

  // A relative or absolute path that actually exists is almost certainly
  // meant as a local page ("iebox docs/demo/legacy-page.html").
  if (looksLikeLocalPath(value)) {
    const local = existingFileUrl(value, options);
    if (local) return local;
  }

  if (value.startsWith('//')) value = `http:${value}`;
  else value = `http://${value}`;

  return normaliseHttp(value);
}

/** Extract the host (or a friendly fallback) for status lines. */
export function describeUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'file:') return decodeURIComponent(url.pathname);
    if (url.protocol === 'about:') return url.href;
    return url.host || url.href;
  } catch {
    return String(value);
  }
}

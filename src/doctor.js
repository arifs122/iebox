/**
 * Environment diagnostics.
 *
 * `runDoctor` is pure with respect to the probe object: tests pass a fake
 * probe and never touch the real registry, filesystem or PowerShell.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { cscCandidates, findCsc, inspectHost } from './build.js';
import { configPaths, loadConfigReport } from './config.js';
import { emulationFromValue, emulationLabel } from './emulation.js';
import { readEmulation } from './registry.js';
import { isWindows, formatBytes, EXIT } from './util.js';

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function powershellFileVersion(file) {
  try {
    const script = `(Get-Item -LiteralPath ${psQuote(file)}).VersionInfo.FileVersion`;
    const out = execFileSync(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', windowsHide: true, timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const text = String(out || '').trim();
    return text || null;
  } catch {
    return null;
  }
}

/** Real probe. Every method is defensive: doctor must never throw. */
export function createSystemProbe(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const windir = env.WINDIR || env.SystemRoot || 'C:\\Windows';
  const versionCache = new Map();

  return {
    platform,
    arch: process.arch,
    node: process.version,
    env,
    windir,
    osVersion() {
      try {
        return os.version() || os.release();
      } catch {
        return os.release();
      }
    },
    osRelease() {
      try {
        return os.release();
      } catch {
        return 'unknown';
      }
    },
    fileExists(file) {
      try {
        return fs.statSync(file).isFile();
      } catch {
        return false;
      }
    },
    fileSize(file) {
      try {
        return fs.statSync(file).size;
      } catch {
        return 0;
      }
    },
    fileVersion(file) {
      if (!isWindows(platform)) return null;
      if (versionCache.has(file)) return versionCache.get(file);
      const value = powershellFileVersion(file);
      versionCache.set(file, value);
      return value;
    },
    findCsc() {
      return findCsc({ env, platform });
    },
    inspectHost() {
      return inspectHost({ env });
    },
    readEmulation() {
      return readEmulation({ env, platform });
    },
    configReport() {
      return loadConfigReport({ env });
    },
    cscCandidates() {
      return cscCandidates(env);
    },
    configPaths() {
      return configPaths({ env });
    },
  };
}

function check(id, label, status, detail, hint = null) {
  return { id, label, status, detail, hint };
}

function safe(fn, fallback) {
  try {
    const value = fn();
    return value === undefined || value === null ? fallback : value;
  } catch {
    return fallback;
  }
}

function unsupportedReport(platform) {
  return {
    generatedAt: new Date().toISOString(),
    platform,
    supported: false,
    ok: false,
    exitCode: EXIT.OPERATIONAL,
    checks: [
      check(
        'platform',
        'Platform',
        'fail',
        `iebox is Windows-only (running ${platform}).`,
        'Run iebox on Windows 10 or 11. The host is a WinForms/MSHTML program.',
      ),
    ],
    verdict: `iebox is Windows-only (running ${platform}).`,
    summary: { ok: 0, warn: 0, fail: 1, info: 0 },
  };
}

/**
 * @param {object} [options]
 * @param {object} [options.probe] injected probe (tests)
 * @param {string} [options.platform]
 */
export function runDoctor(options = {}) {
  const probe = options.probe || createSystemProbe(options);
  const platform = options.platform || probe.platform || process.platform;

  if (!isWindows(platform)) return unsupportedReport(platform);

  const checks = [];

  const osVersion = safe(() => probe.osVersion(), 'Windows');
  const osRelease = safe(() => probe.osRelease(), 'unknown');
  const arch = safe(() => probe.arch, process.arch);
  checks.push(check('platform', 'Windows', 'ok', `${osVersion} (${osRelease}, ${arch})`));

  const node = safe(() => probe.node, process.version);
  const nodeMajor = Number.parseInt(String(node).replace(/^v/, '').split('.')[0], 10);
  checks.push(
    nodeMajor >= 18
      ? check('node', 'Node.js', 'ok', `${node}`)
      : check('node', 'Node.js', 'warn', `${node} is older than the supported Node.js 18.`, 'Install Node.js 18 or newer.'),
  );

  const windir = safe(() => probe.windir, 'C:\\Windows');
  const system32 = path.join(windir, 'System32', 'mshtml.dll');
  const syswow64 = path.join(windir, 'SysWOW64', 'mshtml.dll');
  const mshtmlPath = safe(() => probe.fileExists(system32), false)
    ? system32
    : safe(() => probe.fileExists(syswow64), false)
      ? syswow64
      : null;
  const mshtmlVersion = mshtmlPath ? safe(() => probe.fileVersion(mshtmlPath), null) : null;
  const mshtmlSize = mshtmlPath ? safe(() => probe.fileSize(mshtmlPath), 0) : 0;

  if (mshtmlPath) {
    checks.push(
      check(
        'mshtml',
        'MSHTML engine',
        'ok',
        `${mshtmlPath}${mshtmlVersion ? ` (version ${mshtmlVersion})` : ''}, ${formatBytes(mshtmlSize)}`,
      ),
    );
  } else {
    checks.push(
      check(
        'mshtml',
        'MSHTML engine',
        'fail',
        'mshtml.dll was not found in System32 or SysWOW64.',
        'Enable the Internet Explorer / MSHTML feature in Windows Features, then reboot.',
      ),
    );
  }

  const candidates = safe(() => probe.cscCandidates(), cscCandidates());
  const csc = safe(() => probe.findCsc(), null);
  const cscDetail = candidates
    .map((candidate) => `${safe(() => probe.fileExists(candidate), false) ? 'found' : 'missing'}  ${candidate}`)
    .join('\n');
  checks.push(
    csc
      ? check('csc', 'C# compiler', 'ok', `${csc}\n${cscDetail}`)
      : check(
          'csc',
          'C# compiler',
          'fail',
          `csc.exe was not found.\n${cscDetail}`,
          'Install .NET Framework 4.x (included with Windows 10/11) or set IEBOX_CSC to csc.exe.',
        ),
  );

  const mscorlib64 = path.join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'mscorlib.dll');
  const mscorlib32 = path.join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'mscorlib.dll');
  const mscorlib = safe(() => probe.fileExists(mscorlib64), false)
    ? mscorlib64
    : safe(() => probe.fileExists(mscorlib32), false)
      ? mscorlib32
      : null;
  const clrVersion = mscorlib ? safe(() => probe.fileVersion(mscorlib), null) : null;
  checks.push(
    check(
      'clr',
      'WebBrowser / CLR',
      mscorlib ? 'ok' : 'warn',
      mscorlib
        ? `CLR ${clrVersion || '4.x'} (${mscorlib}); WebBrowser control ${mshtmlVersion ? `MSHTML ${mshtmlVersion}` : 'MSHTML present'}`
        : 'The .NET Framework 4.x runtime was not found.',
      mscorlib ? null : 'Install .NET Framework 4.x. Windows 10/11 usually has it already.',
    ),
  );

  const iexplorePaths = [
    path.join(windir, 'System32', 'iexplore.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Internet Explorer', 'iexplore.exe'),
  ];
  const iexplore = iexplorePaths.find((candidate) => safe(() => probe.fileExists(candidate), false));
  checks.push(
    check(
      'iexplore',
      'iexplore.exe',
      'info',
      iexplore
        ? `${iexplore} (informational; not required)`
        : 'Not installed. That is fine: the WebBrowser control uses mshtml.dll directly.',
    ),
  );

  const host = safe(() => probe.inspectHost(), {
    exists: false,
    size: 0,
    fresh: false,
    valid: false,
    meta: null,
    arch: null,
    path: '',
  });
  let hostStatus = 'warn';
  let hostDetail;
  const archLabel = host && host.arch === 'x86'
    ? '32-bit (x86)'
    : host && host.arch === 'x64'
      ? '64-bit (x64)'
      : host && host.arch
        ? String(host.arch)
        : 'unknown architecture';
  if (host && host.exists && host.valid) {
    hostStatus = host.fresh ? 'ok' : 'warn';
    hostDetail = `${host.path} (${formatBytes(host.size)}, ${archLabel})${host.fresh ? ', cache matches the source' : ', stale or built without cache metadata; the next launch recompiles'}`;
  } else if (host && host.exists) {
    hostStatus = 'warn';
    hostDetail = `${host.path} exists but is not a valid executable; run iebox build --force.`;
  } else {
    hostStatus = 'warn';
    hostDetail = `${host && host.path ? host.path : '%LOCALAPPDATA%\\iebox\\bin\\iebox-host.exe'} is not built yet; the first launch compiles it automatically.`;
  }
  checks.push(check('host', 'Compiled host', hostStatus, hostDetail));

  const registry = safe(() => probe.readEmulation(), { ok: false, value: null, error: 'probe failed' });
  const mode = registry && registry.value !== null ? emulationFromValue(registry.value) : null;
  const registryError =
    registry && registry.error && !/not found|unable to find|bulunamad/i.test(registry.error)
      ? registry.error
      : null;
  if (registry && registry.value !== null) {
    checks.push(
      check(
        'registry',
        'Emulation (HKCU)',
        'ok',
        `${registry.value}${mode ? ` (${emulationLabel(mode)})` : ' (unrecognised value)'} for iebox-host.exe`,
      ),
    );
  } else {
    checks.push(
      check(
        'registry',
        'Emulation (HKCU)',
        'info',
        'No value yet for iebox-host.exe. The host writes it before creating the WebBrowser control.',
        registryError,
      ),
    );
  }

  const configReport = safe(() => probe.configReport(), {
    config: null,
    path: '%LOCALAPPDATA%\\iebox\\config.json',
    exists: false,
    warning: null,
  });
  const config = configReport.config || {};
  checks.push(
    check(
      'config',
      'Config',
      configReport.warning ? 'warn' : 'ok',
      `${configReport.path}${configReport.exists ? '' : ' (not created yet; defaults will be used)'}\n` +
        `homeUrl: ${config.homeUrl || '(default)'}; emulation: ${config.emulation || '(default)'}; seenWarning: ${String(config.seenWarning)}`,
      configReport.warning,
    ),
  );

  const hasFail = checks.some((item) => item.status === 'fail');
  const hasWarn = checks.some((item) => item.status === 'warn');
  const mshtmlOk = Boolean(mshtmlPath);
  const cscOk = Boolean(csc);

  let verdict;
  if (!mshtmlOk) {
    verdict = 'Not ready: the MSHTML/Trident engine is missing.';
  } else if (!cscOk) {
    verdict = 'Not ready: no .NET Framework C# compiler was found.';
  } else if (!host || !host.exists || !host.valid) {
    verdict = 'Ready. The host will be compiled on first launch (about one second).';
  } else if (hasWarn) {
    verdict = 'Ready, with warnings. See the lines marked !!.';
  } else {
    verdict = 'Ready. Run `iebox <url>` to open a page in the Trident engine.';
  }

  const summary = { ok: 0, warn: 0, fail: 0, info: 0 };
  for (const item of checks) summary[item.status] += 1;

  return {
    generatedAt: new Date().toISOString(),
    platform,
    supported: true,
    ok: mshtmlOk && cscOk && !hasFail,
    exitCode: mshtmlOk && cscOk ? EXIT.OK : EXIT.OPERATIONAL,
    checks,
    verdict,
    summary,
    paths: {
      mshtml: mshtmlPath,
      csc,
      host: host && host.path ? host.path : null,
      config: configReport.path,
    },
  };
}

const STATUS_BADGE = {
  ok: 'OK',
  warn: '!!',
  fail: 'XX',
  info: '--',
};

/** Render a report as plain text (ANSI colours optional). */
export function formatDoctor(report, colors = null) {
  const paint = colors || {
    bold: (t) => t,
    dim: (t) => t,
    green: (t) => t,
    yellow: (t) => t,
    red: (t) => t,
    cyan: (t) => t,
  };
  const colorFor = (status) =>
    status === 'ok'
      ? paint.green
      : status === 'warn'
        ? paint.yellow
        : status === 'fail'
          ? paint.red
          : paint.cyan;

  const lines = [];
  lines.push(paint.bold('iebox doctor'));
  lines.push('');

  for (const item of report.checks) {
    const badge = colorFor(item.status)(`[${STATUS_BADGE[item.status] || '??'}]`);
    const label = item.label.padEnd(18, ' ');
    const detailLines = String(item.detail).split('\n');
    lines.push(`  ${badge} ${paint.bold(label)} ${detailLines[0]}`);
    for (const extra of detailLines.slice(1)) {
      lines.push(`       ${' '.repeat(18)} ${paint.dim(extra)}`);
    }
    if (item.hint) lines.push(`       ${' '.repeat(18)} ${paint.dim(`hint: ${item.hint}`)}`);
  }

  lines.push('');
  const verdictColor = report.ok ? paint.green : paint.red;
  lines.push(`${paint.bold('Verdict:')} ${verdictColor(report.verdict)}`);
  if (report.summary) {
    lines.push(
      paint.dim(
        `${report.summary.ok} ok, ${report.summary.warn} warning(s), ${report.summary.fail} failure(s), ${report.summary.info} note(s)`,
      ),
    );
  }
  return lines.join('\n');
}

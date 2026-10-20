/**
 * Launch the compiled host in its own process.
 *
 * The host is a GUI (winexe) program: the CLI returns immediately after
 * spawning it, detached and without a console window. If the host dies right
 * away we surface a clear diagnostic instead of pretending it worked (this is
 * what happens in a service/SSH session with no interactive desktop).
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { buildHost } from './build.js';
import { loadConfig } from './config.js';
import { HOST_EXE_NAME, writeEmulation } from './registry.js';
import { emulationValue, parseEmulation } from './emulation.js';
import { assertWindows, OperationalError } from './util.js';

const DEFAULT_WAIT_MS = 900;

function watchChild(child, waitMs) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;

    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(outcome);
    };

    timer = setTimeout(() => finish({ status: 'running', pid: child.pid || null }), waitMs);

    if (typeof child.once !== 'function') {
      finish({ status: 'running', pid: child.pid || null });
      return;
    }

    child.once('error', (error) => finish({ status: 'error', error, pid: null }));
    child.once('exit', (code, signal) => finish({ status: 'exited', code, signal, pid: child.pid || null }));
  });
}

/**
 * @param {object} options
 * @param {string} options.url normalised URL
 * @param {string} [options.emulation] override for this run
 * @param {string} [options.exe] already built host path
 * @param {object} [options.config]
 * @param {number} [options.waitMs]
 */
export async function launchHost(options = {}) {
  const platform = options.platform || process.platform;
  assertWindows(platform);

  const config = options.config || loadConfig(options);
  const requested = options.emulation || config.emulation;
  const mode = parseEmulation(requested);
  if (!mode) {
    throw new OperationalError(`Unknown emulation mode "${requested}".`);
  }

  if (typeof options.url !== 'string' || options.url.trim() === '') {
    throw new OperationalError('launchHost requires a URL.');
  }

  let exe = options.exe;
  if (!exe) {
    exe = buildHost({
      ...options,
      platform,
      cscPath: options.cscPath,
      force: Boolean(options.forceBuild),
    }).exe;
  }

  // Write the mode for the real process name before the host starts. The host
  // does this too, before creating the WebBrowser control; doing it here means
  // it is already correct even if the host's registry access is blocked.
  const registry = writeEmulation(emulationValue(mode), {
    platform,
    exe: HOST_EXE_NAME,
    run: options.registryRun,
    env: options.env,
  });

  const args = [];
  if (options.emulation) args.push('--emulation', mode);
  args.push(options.url);

  const spawnFn = options.spawn || spawn;
  let child;
  try {
    child = spawnFn(exe, args, {
      detached: true,
      stdio: 'ignore',
      // The host is a /target:winexe program: it has no console to hide.
      // Passing windowsHide:true here would set STARTF_USESHOWWINDOW/SW_HIDE,
      // and Windows would apply that to the first ShowWindow call, leaving the
      // WinForms window invisible.
      windowsHide: false,
      cwd: path.dirname(exe),
      env: options.env || process.env,
    });
  } catch (error) {
    throw new OperationalError(
      `Could not start the iebox host at ${exe}: ${error.message}. ` +
        'Make sure %LOCALAPPDATA% is writable and run iebox build --force.',
    );
  }

  const outcome = await watchChild(child, options.waitMs ?? DEFAULT_WAIT_MS);
  try {
    if (child && typeof child.unref === 'function') child.unref();
  } catch {
    /* ignore */
  }

  if (outcome.status === 'error') {
    throw new OperationalError(
      `The iebox host could not start (${outcome.error && outcome.error.message ? outcome.error.message : 'spawn error'}).\n` +
        'If you are in a service, SSH or scheduled-task session without an interactive desktop, ' +
        'run iebox from a normal Windows desktop instead.',
    );
  }

  if (outcome.status === 'exited' && outcome.code !== 0) {
    throw new OperationalError(
      `The iebox host exited immediately with code ${outcome.code}.\n` +
        'This usually means there is no interactive desktop for this session, or the engine could not be created.\n' +
        'Run `iebox doctor` and try again from a normal Windows desktop.',
    );
  }

  return {
    ok: true,
    pid: outcome.pid,
    exe,
    args,
    url: options.url,
    emulation: mode,
    status: outcome.status,
    exitCode: outcome.status === 'exited' ? outcome.code : null,
    registry,
  };
}

export { DEFAULT_WAIT_MS };

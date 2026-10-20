/**
 * Command-line interface: argument parsing, orchestration, exit codes.
 *
 * Exit codes:
 *   0  success
 *   1  user error (bad URL, unknown mode, unexpected argument)
 *   2  operational error (unsupported platform, compiler missing, engine missing)
 */

import fs from 'node:fs';
import path from 'node:path';
import { buildHost, normalizeArch } from './build.js';
import { exportHost } from './export.js';
import {
  configPaths,
  ensureConfig,
  loadConfigReport,
  saveConfig,
  describeConfig,
} from './config.js';
import {
  EMULATION_ORDER,
  parseEmulation,
  emulationValue,
  emulationLabel,
} from './emulation.js';
import { runDoctor, formatDoctor } from './doctor.js';
import { launchHost } from './launch.js';
import {
  HOST_EXE_NAME,
  readEmulation,
  removeEmulation,
  writeEmulation,
} from './registry.js';
import { normalizeUrl } from './url.js';
import {
  PRODUCT,
  VERSION,
  EXIT,
  UserError,
  OperationalError,
  PlatformError,
  assertWindows,
  exitCodeFor,
  formatBytes,
  makeColors,
  shouldUseColor,
} from './util.js';

const COMMANDS = new Set(['open', 'build', 'doctor', 'emulation', 'export', 'config', 'uninstall', 'help', 'version']);

/* ------------------------------------------------------------------ */
/* Argument parsing                                                    */
/* ------------------------------------------------------------------ */

/**
 * Parse argv into a plain object. Throws UserError for anything malformed;
 * never touches the filesystem.
 */
export function parseArgs(argv = []) {
  const parsed = {
    command: 'open',
    url: null,
    emulation: null,
    emulationArg: null,
    arch: null,
    exportDir: null,
    exportUrl: null,
    home: false,
    force: false,
    json: false,
    noColor: false,
    quiet: false,
    help: false,
    version: false,
  };

  const positionals = [];
  let endOfOptions = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i]);

    if (!endOfOptions && arg === '--') {
      endOfOptions = true;
      continue;
    }

    if (!endOfOptions && arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq >= 0 ? arg.slice(0, eq) : arg;
      const inline = eq >= 0 ? arg.slice(eq + 1) : null;

      switch (name) {
        case '--home':
          parsed.home = true;
          break;
        case '--force':
          parsed.force = true;
          break;
        case '--json':
          parsed.json = true;
          break;
        case '--no-color':
          parsed.noColor = true;
          break;
        case '--quiet':
          parsed.quiet = true;
          parsed.noColor = true;
          break;
        case '--emulation': {
          const value = inline !== null ? inline : argv[i + 1];
          if (inline === null) i += 1;
          if (!value || String(value).startsWith('-')) {
            throw new UserError(`--emulation needs a mode (${EMULATION_ORDER.join(', ')}).`);
          }
          parsed.emulationArg = String(value);
          break;
        }
        case '--arch': {
          const value = inline !== null ? inline : argv[i + 1];
          if (inline === null) i += 1;
          if (!value || String(value).startsWith('-')) {
            throw new UserError('--arch needs a value: x86, x64 or anycpu.');
          }
          parsed.arch = String(value);
          break;
        }
        case '--url': {
          const value = inline !== null ? inline : argv[i + 1];
          if (inline === null) i += 1;
          if (!value || String(value).startsWith('-')) {
            throw new UserError('--url needs a page URL.');
          }
          parsed.exportUrl = String(value);
          break;
        }
        case '--help':
          parsed.help = true;
          break;
        case '--version':
          parsed.version = true;
          break;
        default:
          throw new UserError(`Unknown option "${name}". Run iebox --help.`);
      }
      continue;
    }

    if (!endOfOptions && arg.startsWith('-') && arg !== '-') {
      if (arg === '-h') parsed.help = true;
      else if (arg === '-v') parsed.version = true;
      else if (arg === '-q') {
        parsed.quiet = true;
        parsed.noColor = true;
      } else {
        throw new UserError(`Unknown option "${arg}". Run iebox --help.`);
      }
      continue;
    }

    positionals.push(arg);
  }

  if (!parsed.help && !parsed.version) {
    const rest = positionals.slice();
    if (rest.length > 0 && COMMANDS.has(rest[0].toLowerCase())) {
      const command = rest.shift().toLowerCase();
      if (command === 'help') parsed.help = true;
      else if (command === 'version') parsed.version = true;
      else parsed.command = command;
    }

    if (!parsed.help && !parsed.version) {
      if (parsed.command === 'emulation') {
        if (rest.length === 0) {
          throw new UserError(`emulation needs a mode (${EMULATION_ORDER.join(', ')}).`);
        }
        if (rest.length > 1) throw new UserError(`Unexpected argument "${rest[1]}".`);
        parsed.emulationArg = rest[0];
      } else if (parsed.command === 'open') {
        if (rest.length > 1) throw new UserError(`Unexpected argument "${rest[1]}". Quote URLs that contain spaces.`);
        parsed.url = rest[0] || null;
      } else if (parsed.command === 'export') {
        if (rest.length === 0) {
          throw new UserError('export needs a target folder: iebox export <dir> [--url <url>].');
        }
        if (rest.length > 1) {
          throw new UserError(`Unexpected argument "${rest[1]}". Quote paths that contain spaces.`);
        }
        parsed.exportDir = rest[0];
      } else if (rest.length > 0) {
        throw new UserError(`Unexpected argument "${rest[0]}" for "${parsed.command}".`);
      }
    }
  }

  if (parsed.emulationArg) {
    const mode = parseEmulation(parsed.emulationArg);
    if (!mode) {
      throw new UserError(
        `Unknown emulation mode "${parsed.emulationArg}". Choose one of: ${EMULATION_ORDER.join(', ')}.`,
      );
    }
    parsed.emulation = mode;
  }

  if (parsed.arch) {
    try {
      parsed.arch = normalizeArch(parsed.arch);
    } catch (error) {
      throw new UserError(error.message);
    }
  }

  if (parsed.home && parsed.url) {
    throw new UserError('--home cannot be combined with a URL.');
  }

  return parsed;
}

/* ------------------------------------------------------------------ */
/* Help                                                                */
/* ------------------------------------------------------------------ */

export function helpText(colors = makeColors(false)) {
  const b = colors.bold;
  const d = colors.dim;
  return [
    b(`${PRODUCT} ${VERSION}`),
    'A free, open-source IE Tab alternative for Windows.',
    '',
    b('Usage'),
    '  iebox [url]                  Open a URL (or the saved home page) in the legacy engine',
    '  iebox build [--force]        Compile the C# host (automatic on first run)',
    '  iebox doctor [--json]        Diagnose the environment',
    '  iebox emulation <mode>       Set the default document mode',
    '  iebox export <dir> [--url]   Copy a portable folder for another Windows PC',
    '  iebox config                 Print config paths and values',
    '  iebox uninstall              Remove %LOCALAPPDATA%\\iebox and the HKCU value',
    '',
    b('Modes'),
    '  ie11 (11001)  ie10 (10001)  ie9 (9999)  ie8 (8888)  ie7 (7000)',
    '',
    b('Options'),
    '  --home                       Open the saved home page',
    '  --emulation <mode>           Override the mode for this run only',
    '  --arch <x86|x64|anycpu>      Host architecture; x86 is the default because',
    '                               32-bit ActiveX (camera/NVR plugins) needs it',
    '  --url <url>                  URL baked into the launcher written by `export`',
    '  --json                       Machine-readable output (doctor, config)',
    '  --no-color, -q               Plain output; -q also hides progress lines',
    '  -h, --help                   Show this help',
    '  -v, --version                Show the version',
    '',
    b('Examples'),
    d('  iebox https://intranet.local/'),
    d('  iebox localhost:3000'),
    d('  iebox docs/demo/legacy-page.html'),
    d('  iebox emulation ie9'),
    d('  iebox doctor --json'),
    '',
    b('Security'),
    '  The Trident engine is unsandboxed and no longer receives security updates.',
    '  Use iebox only for trusted legacy sites. See SECURITY.md.',
    '',
    d('Windows-only. Exit codes: 0 success, 1 user error, 2 operational error.'),
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* Command implementations                                             */
/* ------------------------------------------------------------------ */

function defaultIo() {
  return {
    out: (line = '') => process.stdout.write(`${line}\n`),
    err: (line = '') => process.stderr.write(`${line}\n`),
  };
}

function printWarning(io, colors, message) {
  io.err(`${colors.yellow('iebox: warning:')} ${message}`);
}

function resolveOpenTarget(input, deps) {
  const fileExists = deps.fileExists || ((file) => {
    try {
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  });
  return normalizeUrl(input, {
    cwd: deps.cwd || process.cwd(),
    fileExists,
    homeDir: deps.homeDir,
  });
}

function commandBuild(parsed, context) {
  const { io, colors, env, platform, deps } = context;
  const build = deps.buildHost || buildHost;

  if (!parsed.quiet) io.out(colors.dim('Checking the Trident host ...'));

  const result = build({ env, platform, force: parsed.force, arch: parsed.arch || undefined });
  if (result.reused) {
    io.out(`${colors.green('Host is up to date.')} ${colors.dim(result.exe)}`);
  } else {
    io.out(`${colors.green('Compiled the Trident host.')} ${colors.dim(`${result.durationMs} ms`)}`);
  }
  io.out(`  executable  ${result.exe} (${formatBytes(result.size)})`);
  io.out(`  architecture ${result.arch === 'x86' ? '32-bit (x86) — required by most legacy ActiveX' : (result.arch || 'x86')}`);
  io.out(`  compiler    ${result.csc}`);
  io.out(`  source hash ${result.hash.slice(0, 16)}...`);
  return EXIT.OK;
}

function commandExport(parsed, context) {
  const { io, colors, env, platform, deps } = context;

  const build = (deps.buildHost || buildHost)({
    env,
    platform,
    force: false,
    arch: parsed.arch || undefined,
  });
  if (!parsed.quiet) {
    io.out(colors.dim(`Host ready: ${build.exe}`));
  }

  const dir = path.resolve(parsed.exportDir);
  const exporter = deps.exportHost || exportHost;
  const result = exporter({
    dir,
    exePath: build.exe,
    url: parsed.exportUrl || null,
    arch: build.arch,
  });

  io.out(`${colors.green('Exported a portable iebox folder.')} ${colors.dim(result.dir)}`);
  io.out(`  ${result.exe}`);
  io.out(`  ${result.launcher}`);
  io.out(`  ${result.readme}`);
  io.out(colors.dim('  Node.js is not needed in that folder — copy it to the target PC and double-click the .cmd file.'));
  return EXIT.OK;
}

async function commandOpen(parsed, context) {
  const { io, colors, env, platform, deps } = context;

  const configReport = ensureConfig({ env });
  if (configReport.warning && !parsed.quiet) printWarning(io, colors, configReport.warning);

  const config = configReport.config;
  const target = parsed.url ? resolveOpenTarget(parsed.url, deps) : config.homeUrl;

  if (!/^(?:https?|file|ftp|about|data):/i.test(target)) {
    throw new UserError(`Refusing to open "${target}": not a page URL.`);
  }

  const saved = saveConfig({ lastUrl: target }, { env });
  if (!saved.ok && !parsed.quiet) {
    printWarning(io, colors, `could not save the last URL to ${saved.path}: ${saved.error}`);
  }

  const build = (deps.buildHost || buildHost)({ env, platform, force: false, arch: parsed.arch || undefined });
  if (!parsed.quiet) {
    if (build.reused) io.out(`${colors.green('Host ready.')} ${colors.dim(build.exe)}`);
    else io.out(`${colors.green('Host compiled.')} ${colors.dim(`${build.durationMs} ms`)}`);
  }

  const launcher = deps.launchHost || launchHost;
  const result = await launcher({
    url: target,
    emulation: parsed.emulation || undefined,
    exe: build.exe,
    config: { ...config, lastUrl: target },
    env,
    platform,
    spawn: deps.spawn,
    waitMs: deps.waitMs,
    registryRun: deps.registryRun,
  });

  if (result.status === 'exited') {
    io.out(
      `The host exited before showing a window (code ${result.exitCode === null ? 'unknown' : result.exitCode}).` +
        (result.exitCode === 0 ? ' If you cancelled the security warning, this is expected.' : ''),
    );
  } else {
    io.out(`${colors.green('Opened')} ${target}`);
    io.out(colors.dim(`  Trident host pid ${result.pid}; mode ${emulationLabel(result.emulation)} (${emulationValue(result.emulation)})`));
  }

  if (result.registry && !result.registry.ok) {
    printWarning(
      io,
      colors,
      `the HKCU emulation value could not be written (${result.registry.error}). The page will open in IE7 mode.`,
    );
  }
  if (parsed.emulation) {
    io.out(colors.dim('  This emulation override applies to this run only. Save it with: iebox emulation ' + parsed.emulation));
  }
  return EXIT.OK;
}

function commandDoctor(parsed, context) {
  const { io, colors, env, platform, deps } = context;
  const report = runDoctor({ env, platform, probe: deps.probe });

  if (parsed.json) {
    io.out(JSON.stringify(report, null, 2));
    return report.exitCode;
  }

  if (!report.supported) {
    io.err(`iebox: unsupported platform - iebox is Windows-only (running ${report.platform}).`);
    return report.exitCode;
  }

  io.out(formatDoctor(report, colors));
  return report.exitCode;
}

function commandEmulation(parsed, context) {
  const { io, colors, env, platform, deps } = context;
  const mode = parseEmulation(parsed.emulationArg);
  if (!mode) {
    throw new UserError(
      `Unknown emulation mode "${parsed.emulationArg}". Choose one of: ${EMULATION_ORDER.join(', ')}.`,
    );
  }

  const value = emulationValue(mode);
  const saved = saveConfig({ emulation: mode }, { env });
  if (!saved.ok) {
    throw new OperationalError(`Could not save the emulation mode to ${saved.path}: ${saved.error}`);
  }

  const write = deps.writeEmulation || writeEmulation;
  const registry = write(value, {
    env,
    platform,
    exe: HOST_EXE_NAME,
    run: deps.registryRun,
  });

  io.out(`Default document mode: ${colors.bold(emulationLabel(mode))} (${value}).`);
  io.out(colors.dim(`  saved to ${saved.path}`));
  if (registry.ok) {
    io.out(colors.dim(`  HKCU value written for ${HOST_EXE_NAME}`));
  } else {
    printWarning(io, colors, `the HKCU value could not be written: ${registry.error}`);
  }
  return EXIT.OK;
}

function commandConfig(parsed, context) {
  const { io, colors, env, deps } = context;
  const report = loadConfigReport({ env });
  const paths = configPaths({ env });
  const read = deps.readEmulation || readEmulation;
  const registry = read({ env, run: deps.registryRun });

  if (parsed.json) {
    io.out(
      JSON.stringify(
        {
          paths,
          exists: report.exists,
          warning: report.warning,
          config: report.config,
          registry: { value: registry.value, ok: registry.ok },
        },
        null,
        2,
      ),
    );
    return EXIT.OK;
  }

  io.out(colors.bold('iebox config'));
  io.out(`  directory   ${paths.dir}`);
  io.out(`  config      ${paths.file}${report.exists ? '' : colors.dim(' (not created yet)')}`);
  io.out(`  host exe    ${paths.hostExe}`);
  io.out(`  build meta  ${paths.buildMeta}`);
  io.out('');
  for (const [key, value] of describeConfig(report.config)) {
    io.out(`  ${key.padEnd(15, ' ')} ${value}`);
  }
  io.out('');
  io.out(
    `  ${'registry'.padEnd(15, ' ')} ${
      registry.value !== null
        ? `${registry.value} for ${HOST_EXE_NAME}`
        : colors.dim(`not set for ${HOST_EXE_NAME}`)
    }`,
  );
  if (report.warning) printWarning(io, colors, report.warning);
  return EXIT.OK;
}

function commandUninstall(parsed, context) {
  const { io, colors, env, platform, deps } = context;
  const paths = configPaths({ env });

  if (path.basename(paths.dir) !== 'iebox' || path.dirname(paths.dir) === paths.dir) {
    throw new OperationalError(`Refusing to remove "${paths.dir}": it is not an iebox data directory.`);
  }

  const remove = deps.removeEmulation || removeEmulation;
  const registry = remove({ env, platform, exe: HOST_EXE_NAME, run: deps.registryRun });

  if (registry.removed) {
    io.out(`${colors.green('Removed')} HKCU value for ${HOST_EXE_NAME}.`);
  } else if (registry.error) {
    printWarning(io, colors, `registry cleanup: ${registry.error}`);
  } else {
    io.out(colors.dim(`No HKCU value was present for ${HOST_EXE_NAME}.`));
  }

  let dirExists = false;
  try {
    dirExists = fs.existsSync(paths.dir);
  } catch {
    dirExists = false;
  }

  if (!dirExists) {
    io.out(colors.dim(`Nothing to remove at ${paths.dir}.`));
    return EXIT.OK;
  }

  try {
    fs.rmSync(paths.dir, { recursive: true, force: true });
  } catch (error) {
    throw new OperationalError(`Could not remove ${paths.dir}: ${error.message}`);
  }

  io.out(`${colors.green('Removed')} ${paths.dir}`);
  io.out(colors.dim('The compiled host, build cache and config.json are gone. Nothing outside that folder was touched.'));
  return EXIT.OK;
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

/**
 * Run the CLI. Returns an exit code instead of calling process.exit, so tests
 * can invoke it directly.
 *
 * @param {string[]} argv
 * @param {{ io?: object, env?: object, platform?: string, cwd?: string, probe?: object }} [deps]
 */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const io = deps.io || defaultIo();
  let parsed;

  try {
    parsed = parseArgs(argv);
  } catch (error) {
    const colors = makeColors(false);
    io.err(`${colors.red('iebox:')} ${error.message}`);
    return exitCodeFor(error);
  }

  const env = deps.env || process.env;
  const platform = deps.platform || process.platform;
  const colors = makeColors(
    shouldUseColor({
      noColor: parsed.noColor,
      quiet: parsed.quiet,
      env,
      stream: deps.stdout || process.stdout,
    }),
  );
  const context = { io, colors, env, platform, deps };

  if (parsed.help) {
    io.out(helpText(colors));
    return EXIT.OK;
  }
  if (parsed.version) {
    io.out(`${PRODUCT} ${VERSION}`);
    return EXIT.OK;
  }

  try {
    if (parsed.command === 'doctor') {
      return commandDoctor(parsed, context);
    }

    assertWindows(platform);

    switch (parsed.command) {
      case 'build':
        return commandBuild(parsed, context);
      case 'open':
        return await commandOpen(parsed, context);
      case 'emulation':
        return commandEmulation(parsed, context);
      case 'export':
        return commandExport(parsed, context);
      case 'config':
        return commandConfig(parsed, context);
      case 'uninstall':
        return commandUninstall(parsed, context);
      default:
        throw new UserError(`Unknown command "${parsed.command}". Run iebox --help.`);
    }
  } catch (error) {
    if (error instanceof PlatformError) {
      io.err(error.message);
      return error.exitCode;
    }
    const message = error && error.message ? error.message : String(error);
    io.err(`${colors.red('iebox:')} ${message}`);
    if (deps.debug && error && error.stack) io.err(colors.dim(error.stack));
    return exitCodeFor(error);
  }
}

export { COMMANDS };

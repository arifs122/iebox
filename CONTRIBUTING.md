# Contributing to iebox

Thanks for taking the time to look at iebox. This project is deliberately
small: one C# file, a handful of Node modules, no dependencies. Keeping it
that way is part of the design.

## Ground rules

- Be kind. Read [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
- This tool renders pages with a retired, unsandboxed engine. Do not propose
  changes that hide that fact, weaken the warning, add certificate bypasses,
  or imply the result is a secure browser.
- No npm dependencies, runtime or development. Tests use `node:test` and
  `node:assert/strict` only.
- No telemetry, analytics, auto-update, network calls, elevation, services,
  HKLM writes, or writes outside `%LOCALAPPDATA%\iebox` and the single HKCU
  emulation value.
- Windows-only is a feature, not a bug. Non-Windows behaviour must stay a
  clean exit 2 with `iebox is Windows-only`.

## Getting started

Requirements: Windows 10/11, Node.js 18+, and the .NET Framework 4.x that
ships with Windows. No `npm install` is needed.

```powershell
git clone https://github.com/arifs122/iebox.git
cd iebox
node bin/iebox.js doctor
npm test
node bin/iebox.js docs/demo/legacy-page.html
```

The first launch compiles `host/IeBoxHost.cs` into
`%LOCALAPPDATA%\iebox\bin\iebox-host.exe`. `node bin/iebox.js build --force`
rebuilds it after a source change.

## What to work on

- Reproducible bugs on Windows 10 or 11.
- URL normalisation edge cases (with a test).
- Better failure messages, especially around headless sessions and missing
  engines.
- Accessibility and keyboard navigation in the host.
- Documentation corrections.

Please open an issue before large features. A standalone legacy-engine window
has a narrow scope on purpose; "add a modern engine" or "make it sandboxed"
are not in scope.

## Code style

### Node.js

- ESM only (`"type": "module"`), Node 18-compatible syntax.
- Two-space indentation, single quotes, semicolons, trailing commas where the
  surrounding code uses them.
- Keep modules dependency-free and injectable where it helps tests (see
  `src/doctor.js` and `src/build.js`).
- Never throw from config or cleanup paths. A malformed `config.json` must not
  stop the browser from opening.
- New behaviour needs a test in `test/`. Tests must not touch the real
  registry, network or `%LOCALAPPDATA%`; use a temp directory.

### C# host

- `host/IeBoxHost.cs` must stay **ASCII-only**. `csc.exe` reads source with the
  machine's ANSI code page when there is no BOM, so typographic characters are
  written as `\uXXXX` escapes.
- C# 5 syntax only. No string interpolation, no `?.`, no `nameof`, no
  expression-bodied members, no auto-property initialisers.
- Wrap every COM call in `try`/`catch`. A hostile page must never take the
  window down.
- No external assets, no network calls, no updater.
- Comment the non-obvious parts. This file is the product's heart.

Compile it directly while iterating:

```powershell
& "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" `
  /nologo /target:winexe /platform:anycpu /optimize+ /codepage:65001 `
  /out:"$env:TEMP\iebox-host.exe" `
  /r:System.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll `
  host\IeBoxHost.cs
```

The smoke test does the same thing:

```powershell
node --test test/compile-smoke.test.js
```

There is also a runtime self-test that creates the window and the WebBrowser
control, closes itself, and writes a small JSON result:

```powershell
& "$env:LOCALAPPDATA\iebox\bin\iebox-host.exe" --selftest "$env:TEMP\selftest.json" about:blank
Get-Content "$env:TEMP\selftest.json"
```

## Tests

```powershell
npm test
```

The suite covers URL normalisation, emulation values, config round-trips in a
temp directory, registry argument builders (never the real registry), build
cache logic, `doctor` with injected probes, platform guards, CLI parsing and
exit codes, the host source's security properties, and a Windows-only compile
smoke test.

On macOS/Linux the suite still runs; Windows-only tests are skipped. If you
change a test, make sure it also passes there.

## Commit and pull request

- Small, focused commits with an imperative subject
  (`fix: strip trailing dots from host names`).
- Describe the user-visible change and how you tested it.
- Include the output of `npm test` and, for host changes, the compiler result.
- Update `CHANGELOG.md` for user-visible changes.
- By contributing you agree that your work is licensed under the MIT license.

## Security issues

Do not open a public issue for a vulnerability in iebox. Follow
[SECURITY.md](SECURITY.md). Vulnerabilities in MSHTML itself are Microsoft's
to fix (and are, by design, out of scope for this project).

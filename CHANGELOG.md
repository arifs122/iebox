# Changelog

All notable changes to iebox are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-20

The first working release.

### Added

- **The host.** A single-file C# WinForms application (`host/IeBoxHost.cs`) that
  hosts the real MSHTML/Trident engine through the `WebBrowser` control.
- **No-SDK build.** The host is compiled on first run with the built-in
  .NET Framework compiler (`csc.exe` 4.0.30319), cached by a SHA-256 of the
  source. `iebox build --force` is available for manual rebuilds.
- **Toolbar:** Back, Forward, Stop/Reload, Home, editable address bar, Go,
  Modern (default browser), zoom out/reset/in, and an IE11/10/9/8/7 document
  mode drop-down that writes HKCU and reloads.
- **Status bar** with a "Trident (legacy engine)" badge, progress, status text
  and an HTTP/HTTPS hint.
- **First-run security warning** with a persisted "Don't show this warning
  again" checkbox.
- **Error overlay** for pages Trident cannot render (usually TLS), with Retry,
  Open in modern browser, Copy URL and Back to page.
- **Popups** (`target=_blank`, `window.open`) are intercepted through
  `NewWindow3`/`NewWindow2` and opened in the same window.
- **Keyboard shortcuts:** `Ctrl+L`, `Alt+Left/Right`, `F5`/`Ctrl+R`,
  `Ctrl+0/+/-`, `Ctrl+P`, `Esc`.
- **Persistence:** window size/position/maximised, zoom, last URL, home URL,
  emulation mode and the warning acknowledgement in
  `%LOCALAPPDATA%\iebox\config.json`.
- **CLI:** `iebox [url]`, `build [--force]`, `doctor [--json]`,
  `emulation <mode>`, `config`, `uninstall`, `--home`, `--emulation`,
  `--no-color`/`-q`, `--help`, `--version`.
- **Diagnostics:** Windows version, `mshtml.dll` presence and version,
  `iexplore.exe` (informational), WebBrowser/CLR version, both `csc.exe`
  paths, compiled host and cache state, current HKCU value, config path and a
  verdict line.
- **URL normalisation:** scheme-less hosts, `localhost:3000`, Windows and UNC
  paths, existing relative files, `about:`, `file:`, `data:`, unicode and
  percent-encoding, trailing dots, and rejection of `javascript:`/`vbscript:`
  and other unsupported schemes.
- **Uninstall** that removes exactly the `iebox-host.exe` HKCU value and
  `%LOCALAPPDATA%\iebox`, leaving other applications' emulation values alone.
- **Tests:** 101 `node:test` tests with no dependencies, including a
  Windows-only compile smoke test and a hostile-probe test for `doctor`.
- **Docs:** README, SECURITY, CONTRIBUTING, CODE_OF_CONDUCT, PUBLISH, a
  hand-authored SVG illustration and a deliberately old-school demo page.
- **CI:** Ubuntu and macOS run the test suite (Windows-only tests skip);
  Windows runs the tests, `doctor` and `build --force`.

### Security

- The engine is unsandboxed and unmaintained. This is documented prominently
  in the README, the startup warning, SECURITY.md and `--help`.
- No certificate validation override. No telemetry. No network calls beyond
  the page the user navigates to. No elevation. HKCU only.

### Known limitations

- Windows-only by design.
- The document-mode drop-down may require a host restart for pages that read
  the mode at process start; the dialog says so.
- `NewWindow3` interception uses a late-bound `DWebBrowserEvents2` sink. If a
  machine refuses the connection point, popups are still cancelled but cannot
  be redirected automatically.
- The SVG in `docs/` is an illustration, not a screenshot. The real window uses
  native WinForms chrome.

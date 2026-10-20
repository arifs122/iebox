# Security policy

## The short version

**iebox is not a secure browser and does not try to be.** It renders pages with
the retired MSHTML/Trident engine, in your user account, without a sandbox. The
engine has unfixed vulnerabilities that Microsoft will not patch for this use.
Use iebox only for trusted legacy sites that you must use, ideally on a
disposable or low-privilege Windows account.

If that trade-off is not acceptable, do not install iebox. Use Edge IE mode for
a managed legacy surface, or replace the legacy page.

## What the engine risk actually means

- **No sandbox.** A page, an ActiveX control, or an exploit in MSHTML runs with
  your user token. It can read your files, reach your network, and persist in
  your profile, subject only to normal Windows user permissions.
- **No security updates for this surface.** The IE11 desktop application was
  retired on 15 June 2022. `mshtml.dll` remains for compatibility (including
  Edge IE mode), but it is not a supported general browsing engine.
- **ActiveX is enabled by design.** That is often why a page needs iebox, and
  it is also why a malicious page is dangerous.
- **No site isolation.** There is one engine instance in one process for the
  window. Navigating to a different origin does not create a new sandbox.
- **Old TLS.** Trident does not support TLS 1.3. Some HTTPS sites fail; iebox
  reports the failure and offers the Modern button rather than lowering
  security.
- **No certificate bypass.** iebox does not override certificate validation,
  install a certificate handler, disable warnings, or add a "proceed anyway"
  path. If Schannel rejects a certificate, iebox does not paper over it.

## Supported versions

Only the latest release on the `main` branch is supported. This is a
volunteer project; there is no commercial support or SLA.

| Version | Supported |
| --- | --- |
| 0.1.x | Yes (best effort) |
| Older / forks | No |

## Reporting a vulnerability in iebox

Please **do not open a public issue** for a security problem in the iebox code
itself (the CLI, the builder, the config handling, the host's own logic, or the
registry writes).

Use GitHub's private vulnerability reporting on
[github.com/arifs122/iebox/security/advisories](https://github.com/arifs122/iebox/security/advisories),
or contact the maintainer through [github.com/arifs122](https://github.com/arifs122).

Please include:

- The iebox version (`iebox --version`) and your Windows version.
- A description of the issue and its impact.
- Reproduction steps or a proof of concept.
- Whether the issue requires a malicious page, a local attacker, or only
  normal use.

You can expect an acknowledgement within a reasonable best-effort window and
credit in the release notes if you want it. There is no bug bounty.

## Out of scope

- **Vulnerabilities in MSHTML, Trident, ActiveX controls, Schannel, or Windows
  itself.** These are Microsoft's, and the whole point of the project is to
  run that engine. "MSHTML is unsandboxed" is documented, not a finding.
- **A malicious page doing malicious things.** iebox is for trusted pages. Do
  not browse untrusted content with it.
- **TLS 1.3 or modern cipher failures.** Expected; use the Modern button.
- **Social engineering, physical access, or an attacker who already has your
  user account.**
- **The absence of features** such as sandboxing, site isolation, tracking
  protection, extensions or automatic updates.

## What iebox writes, and how to remove it

iebox writes exactly:

- `%LOCALAPPDATA%\iebox\config.json` — settings.
- `%LOCALAPPDATA%\iebox\bin\iebox-host.exe` — the compiled host.
- `%LOCALAPPDATA%\iebox\bin\build.json` — the build cache metadata.
- `HKCU\Software\Microsoft\Internet Explorer\Main\FeatureControl\FEATURE_BROWSER_EMULATION`
  value `iebox-host.exe` (`REG_DWORD`, one of 11001, 10001, 9999, 8888, 7000).

It does not write HKLM, does not create services, scheduled tasks, startup
entries, firewall rules, or drivers, and does not request elevation.

`iebox uninstall` removes the iebox directory and only the `iebox-host.exe`
value. Other applications' values in the same registry key are preserved.

## Hardening suggestions

- Run iebox as a standard user, never an administrator.
- Use a separate Windows account or a disposable VM with no access to
  production credentials.
- Keep the host window to one trusted origin at a time; do not use it as a
  general browser.
- Do not enable "Don't show this warning again" on a shared machine.
- Prefer Edge IE mode if your organization can manage it.
- Keep Windows and Edge updated: the shared MSHTML components still receive
  fixes for the supported surfaces, even though iebox's use of them is not a
  supported browsing scenario.

## No warranty

iebox is provided under the MIT license, without warranty of any kind. You are
responsible for deciding whether running a retired engine is acceptable for
your data and your network.

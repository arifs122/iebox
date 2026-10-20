# Pull request

## What changed

<!-- One or two sentences. Link the issue if there is one. -->

## Why

<!-- The user-visible problem, not just the implementation. -->

## How it was tested

<!-- Paste the relevant output: npm test summary, csc compile result, manual launch. -->

```text
$ npm test
...
```

For host changes, also run:

```powershell
node --test test/compile-smoke.test.js
```

## Checklist

- [ ] `npm test` passes (on this machine and, for cross-platform code, on a non-Windows host or CI).
- [ ] No npm dependencies were added (runtime or development).
- [ ] No telemetry, network calls, certificate bypass, elevation or HKLM writes were added.
- [ ] New behaviour has a test in `test/`.
- [ ] `host/IeBoxHost.cs` stays ASCII-only and C# 5-compatible (if touched).
- [ ] The security warning and the "not a secure browser" language were not weakened.
- [ ] `CHANGELOG.md` is updated for user-visible changes.
- [ ] I agree to license my contribution under the MIT license.

## Screenshots / notes

<!-- Optional. Remove secrets, internal host names and personal data. -->

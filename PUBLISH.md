# Publishing iebox

This is a private checklist for the maintainer. It assumes the repository is

- `<path-to-iebox>` locally,
- published as `arifs122/iebox` on GitHub,
- and optionally mirrored to npm as `iebox`.

Nothing here is required to use the tool. iebox has **zero dependencies** and
**no build step**; `npm publish` is optional and the package is Windows-only.

## 1. Pre-flight

```powershell
cd <path-to-iebox>

node --version                 # 18 or newer
npm test                       # must be 100% green
node bin/iebox.js doctor       # verdict must be Ready
node bin/iebox.js build --force
node bin/iebox.js docs/demo/legacy-page.html
```

Check that the working tree contains no local artifacts:

```powershell
git status --short
```

`%LOCALAPPDATA%\iebox` lives outside the repository. The `.gitignore` excludes
`*.exe`, `host/bin`, `bin/Debug` and the usual build litter anyway.

Review the files that will be published:

```powershell
npm pack --dry-run
```

`package.json` has `"os": ["win32"]`. That is deliberate: installing the npm
package on Linux or macOS should fail at install time rather than at first run.
The test suite itself still runs on Linux/macOS from a clone (Windows-only
tests skip).

## 2. Create the private repository and push

Using the GitHub CLI (authenticate once with `gh auth login`):

```powershell
git init
git add .
git commit -m "feat: initial iebox 0.1.0"
git branch -M main

gh repo create arifs122/iebox --private --source . --remote origin --push
```

If the repository already exists:

```powershell
git remote add origin https://github.com/arifs122/iebox.git
git push -u origin main
```

Verify CI before making anything public:

```powershell
gh run list --limit 5
gh run watch
```

The Windows job runs `npm test`, `node bin/iebox.js doctor` and
`node bin/iebox.js build --force`. The Ubuntu and macOS jobs run `npm test`;
the compile smoke test skips there.

## 3. Make it public

```powershell
gh repo edit arifs122/iebox --visibility public --accept-visibility-change-consequences
```

Then:

- Enable **Private vulnerability reporting** under Settings -> Code security.
  This is the channel promised in `SECURITY.md`.
- Enable Issues and Discussions if you want them.
- Add the repository description:
  `A free, open-source IE Tab alternative for Windows: open legacy IE-only sites in the real Trident engine.`
- Add topics: `internet-explorer`, `trident`, `mshtml`, `ie-tab`, `windows`,
  `legacy`, `activex`, `winforms`.
- Check the About section links to the README and the MIT license.
- Confirm the CI badge renders (the workflow file must be on the default
  branch).

## 4. Tag the release

```powershell
git tag -a v0.1.0 -m "iebox 0.1.0"
git push origin v0.1.0

gh release create v0.1.0 --title "iebox 0.1.0" --notes-file CHANGELOG.md
```

The project ships **source only**. Do not attach a compiled
`iebox-host.exe`: it is built on the user's machine by their own .NET
Framework compiler, which is the whole point. If you attach anything, attach a
zip of the source and a checksum.

## 5. Optional: publish to npm

Only do this if you want `npx iebox` / `npm install -g iebox` to work on
Windows. The tool is fully usable from a git clone without npm.

```powershell
npm login
npm whoami
npm publish --access public
```

Notes:

- `os: ["win32"]` makes the package refuse to install on other platforms.
- There are no lifecycle scripts, so `npm publish` does not run a build.
- The `files` list includes `bin`, `src`, `host`, `docs`, README, LICENSE,
  CHANGELOG, CONTRIBUTING and SECURITY. The C# source must ship, or the first
  run cannot compile the host.
- Bump the version in `package.json` and `src/util.js` reads it from there, so
  there is only one place to change. Add a CHANGELOG entry and tag again.
- To unpublish a broken release within 72 hours:
  `npm unpublish iebox@0.1.0`.

## 6. Post-release smoke test (fresh machine or clean profile)

On a Windows 10/11 machine that has never run iebox:

```powershell
git clone https://github.com/arifs122/iebox.git
cd iebox
node bin/iebox.js doctor
node bin/iebox.js docs/demo/legacy-page.html
```

Confirm:

- the first-run warning appears,
- the demo page renders and reports `Trident, document mode 11`,
- the **Modern** button opens the default browser,
- `HKCU\...\FEATURE_BROWSER_EMULATION\iebox-host.exe` is `11001` and no other
  values were touched,
- `iebox uninstall` removes the folder and only that value,
- `iebox` on macOS/Linux exits 2 with `iebox is Windows-only`.

## 7. Rollback

- Bad source release: `gh release delete v0.1.0` and revert the commit; users
  who cloned can `git checkout` the previous tag.
- Bad npm release: `npm unpublish iebox@0.1.0` (within the registry window) or
  publish a patch.
- There is no auto-update, so no update channel to break. That is a feature.

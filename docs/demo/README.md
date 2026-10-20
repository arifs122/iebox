# iebox demo

This folder contains a deliberately old-fashioned page that exercises the real
Trident engine. It is safe: the "ActiveX" bar is a visual imitation, no control
is loaded, and every link is local except a `target=_blank` link to
`https://example.com/` used to demonstrate popup handling.

## Try it with iebox

From the repository root:

```powershell
node bin/iebox.js doctor
node bin/iebox.js docs/demo/legacy-page.html
```

The CLI turns the existing file into a `file:///...` URL. The first run compiles
the host, shows the security warning, and then opens the window. The window
title should become:

```text
Legacy intranet page - Northwind Manufacturing - iebox
```

Inside the page, the line **"Engine: Trident, document mode 11"** is written by
JavaScript from `document.documentMode`. If it says "a modern browser (not
Trident)", you are looking at the page in Edge/Chrome/Firefox, not in iebox.

## What to look for

- The masthead, sidebar and reports table render with HTML 4 table layout and
  `<font>` tags. Modern browsers still support them; the point is that they look
  like 2009.
- The yellow "This website wants to run the following add-on" bar looks like an
  Internet Explorer information bar. The buttons only show an `alert()`.
- The `marquee` at the bottom still scrolls in Trident.
- The "Vendor portal (new window)" link uses `target="_blank"`. iebox intercepts
  `NewWindow3`, cancels the popup, and opens the URL in the same window. This is
  the documented behaviour: there is only ever one unsandboxed engine window.
- The **Modern** button in the toolbar sends the current URL to your default
  browser. Use it for anything that needs modern TLS.
- `Ctrl+L`, `Alt+Left`, `F5`, `Ctrl++`, `Ctrl+0` and `Ctrl+P` work in the host,
  not in the page.

## Serve it over HTTP (optional)

`file://` pages run in the local-machine zone, which is not the same as an
intranet site. To see zone-sensitive behaviour, serve the folder on loopback:

```powershell
node docs/demo/serve.js
# http://127.0.0.1:8000/
```

or, if you have Python:

```powershell
python -m http.server 8000 --directory docs/demo
```

Then open `http://127.0.0.1:8000/` with iebox. The server binds to `127.0.0.1`
only, has no dependencies, and serves files from this folder only.

## Why this page exists

It is a stable, offline fixture for manual checks:

- Does the engine render at all (not just the WinForms chrome)?
- Does the document mode apply (the `documentMode` line)?
- Does the error overlay stay hidden for a trivial local page?
- Do the toolbar, status badge and title updates work?
- Does a `target=_blank` link behave as documented?

`docs/demo/cli.txt` contains real command output from the development machine.

## A note on the engine

This page is harmless, but the engine is not. Trident is retired and
unsandboxed. Do not point iebox at untrusted sites, and do not treat a
successful render here as a security endorsement. See
[../../SECURITY.md](../../SECURITY.md).

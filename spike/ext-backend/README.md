# SPIKE: opencli `/ext` backend impersonator (Architecture Option A)

**Verdict: PASS.** A non-extension WebSocket client we control registered with the
opencli daemon as the active browser profile and served real `opencli` browser
commands (`google search`, `dianping search`) by driving a Chromium WE control
over CDP. The user's system Chrome was quit and never drove either command.

Throwaway proof. Real daemon traffic, no mocks.

## What this proves

`opencli`'s Browser Bridge is a WS **client** that connects OUT to the daemon's
`ws://127.0.0.1:19825/ext`. The daemon is the WS **server**; it forwards CLI
`/command` HTTP bodies verbatim onto that socket and routes the reply back by `id`.
So anything that can (a) pass the `/ext` upgrade gate, (b) send a `hello`, and
(c) answer Command frames with Result frames *is* the browser opencli drives.
We did exactly that, backed by Playwright's "Google Chrome for Testing" on a
private `--remote-debugging-port`.

## Minimal protocol spec (decoded + captured)

Upgrade gate (`daemon.js` verifyClient): accept if `Origin` absent **or** starts
with `chrome-extension://`. Node `ws` sends no Origin → passes. We also set a
fake `chrome-extension://…` Origin.

Frames:
```
hello   (us→daemon, first):  {type:"hello", contextId, version, compatRange}
                             no ack; compatRange/version stored, never gated on hot path
Command (daemon→us):         {id, action, session, surface, page?, ...actionFields}
Result  (us→daemon):         {id, ok:true, data, page}
                             {id, ok:false, error, errorCode?, errorHint?}
```
- `id` = `cmd_<pid>_<ts>_<n>`, correlated by the daemon's `pending` map.
- `page` = a CDP **targetId** string. Omitted on the first `navigate`; the
  Result's `page` is cached by `Page.goto` and echoed on every later command.
- `session` / `surface` (`browser`|`adapter`) scope the extension's tab lease;
  for our backend we keep a single leased CDP target.

Actions exercised:
- **google search** (public strategy): `navigate` → `exec`(stealth+DOM-settle) →
  `exec`(waitForSelector `#rso a h3`) → `exec`(scrape IIFE → `{items:[…]}`) →
  `close-window`. No `cdp` actions. `exec` `data` = the raw JS return value.
- **dianping search** (cookie strategy): `navigate` dianping.com → `exec` →
  `navigate` search URL (**redirects to account.dianping.com/pclogin** in our tab
  because no login cookie) → `exec`(scrape → `{ok:false, sample:"登录…", url}`) →
  `close-window`. The CLI's `detectAuthOrPageFailure` reads that DOM `sample`+`url`
  and returns `AUTH_REQUIRED` — derived entirely from the page OUR backend scraped.

Routing: the CLI resolves contextId from `~/.opencli/browser-profiles.json`
(`defaultContextId: "3k59e8nw"`). We connect with that contextId, so
`resolveExtensionConnection("3k59e8nw")` returns our socket directly. Registering
an existing contextId closes the previous ws (`registerExtensionConnection`), so
our `hello` evicts a stale extension socket on the same contextId.

## Reproduce

```bash
npm install
# 1. dedicated Chromium (NOT system Chrome, NOT the Render window)
SPIKE_CDP_PORT=19333 ./launch-chromium.sh &
# 2. quit system Chrome so we are the only active browser for the daemon
osascript -e 'quit app "Google Chrome"'
# 3. backend, connecting as the profile the CLI asks for
SPIKE_CDP_PORT=19333 SPIKE_CONTEXT_ID=3k59e8nw node backend.mjs &
# 4. the kill-or-confirm
opencli google search "render spike test" -f json     # real results
opencli dianping search "咖啡" --city 杭州 -f json      # AUTH_REQUIRED (served by us)
# restore: open -a "Google Chrome"
```

`frames.dianping.ndjson` is a captured run (RX = daemon→us Command frames,
TX = our Result frames). `background.beautified.js` is the beautified extension
source the protocol was decoded from.

## Productionizing inside Render (Option A)

Replace `chrome-remote-interface` + `--remote-debugging-port` with
`webContents.debugger` on a `WebContentsView`: `attach('1.3')`, `sendCommand` for
the `cdp`/`navigate`/`screenshot` actions, `executeJavaScript` (or
`Runtime.evaluate`) for `exec`, and `session.cookies` for `cookies`. The WS client
+ envelope logic here ports unchanged.

**Stability:** `/ext` is a **private, minified, internal contract** with no
hot-path version negotiation (hello fields are advisory; `opencli doctor` only
warns). Field names (`id/action/session/surface/page/code/cdpMethod/cdpParams` ⇄
`id/ok/data/page/error`) are the stable surface to track, but they can drift
silently on any opencli bump since nothing validates them server-side. A
daemon/CLI version mismatch force-restarts the daemon (not us), so a Render-hosted
backend must re-`hello` on reconnect.

**Biggest remaining risk:** the daemon assumes a Chrome-extension execution model —
real tab leases, `chrome.debugger` targets, owned windows/tab-groups, frame
enumeration, downloads. A `WebContentsView` backend must faithfully emulate the
*lease/target lifecycle* (stable per-target ids across navigations, the
owned-tab/`tabs new|select|close` semantics, `network-capture-*`, `wait-download`)
or adapters that depend on multi-tab/foreground behaviour will break even though
single-page google/dianping flows pass.

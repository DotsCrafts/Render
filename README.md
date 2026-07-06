# Render

**An agent-native browser. Pages are generated, not installed.**

Render is a Chromium browser whose brain is an agent: `agent (brain) + opencli (app hand) + sandbox (sandbox hand) + Chromium CDP (human hand)`.

## Why — first principles

Today's internet is mediated by fixed frontends: every service ships an app, and the app decides what you can see and do. But the frontend is not the service — it is a hardcoded, one-size-fits-all *view* of the service. Once an agent can drive the service directly (through its API, its CLI adapter, or the website itself with your logged-in session), the fixed frontend becomes optional.

Render inverts the model:

- **Apps dissolve into backends.** Flights, restaurants, stocks, videos — reached through `opencli`'s 1200+ site adapters or, when a site needs a real browser and your cookies, through Render's own Chromium over CDP.
- **Pages are generated per intent.** When you ask for something, the agent gathers what's needed and *renders* a purpose-built interactive page — a dashboard, a comparison table, a map of restaurants, a booking form — as the deliverable.
- **The generated page can operate the world.** Buttons on that page route back through the agent and opencli to the real sites, with your real login state, under your confirmation.

### The user journey

1. **You say what you want** in the floating input ("compare tonight's flights to Tokyo and show the three cheapest with lounge access").
2. **The agent works**: it calls opencli adapters, opens real tabs in Render's Chromium when it needs your logged-in session, and asks you (human-in-the-loop) before anything sensitive.
3. **A generated page opens in a new tab** — a live, interactive artifact you can operate. Acting on it (refine, book, retry, log in) flows back through the agent to the real services.

## Architecture

```
┌────────────────────────────── Electron shell (apps/desktop) ──────────────────────────────┐
│                                                                                           │
│  Renderer (React chrome)      Main process (trusted broker)                               │
│  tabs / omnibox / agent panel ── IPC ──┐                                                  │
│                                        │                                                  │
│                              agent-runtime  ←— HITL (confirm / form / login / block)      │
│                                    │                                                      │
│                        ┌───────────┼──────────────┬──────────────────┐                    │
│                     BRAIN       APP HAND       HUMAN HAND        PAGE KERNEL              │
│                agent-bridge   opencli-router  cdp-human-hand     ux-server                │
│                (codex in a    (adapter class  (CDP relay into    (json-render spec        │
│                 sandbox)       → sandbox or    Render's own       → served page tab)      │
│                                → CDP bridge)   Chromium)                                  │
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

| Package | Role |
| --- | --- |
| `apps/desktop` | Electron shell: chrome UI, tabs (`WebContentsView`), agent runtime, HITL surfaces |
| `packages/protocol` | Pure contracts shared by every surface (IPC channels, `UxMessage`, sandbox seams) — the seam future mobile clients reuse |
| `packages/agent-bridge` | Drives `codex app-server` (JSON-RPC over stdio) inside a sandbox |
| `packages/sandbox` | Sandbox hand: macOS seatbelt locally, e2b drop-in for remote |
| `packages/opencli-router` | App hand: routes each opencli call by adapter class — public/API → headless sandbox, browser/cookie → CDP bridge |
| `packages/opencli-bridge` | Serves opencli's `/ext` browser backend from Render's own Chromium (profile `render`) |
| `packages/cdp-human-hand` | Human hand: loopback CDP relay attached via `webContents.debugger` |
| `packages/ux-render` | The generated-page engine: renders `UxMessage` specs through a **whitelisted component catalog** |

### Security model

- **Structure is the injection boundary.** Generated pages are json-render *specs*, not HTML/JS: the LLM can only reference whitelisted components and five actions (`ux_submit / confirm / cancel / instruct / login_done`). A hostile page spec cannot execute code.
- **Page writes are granted per command and confirmed per invocation.** A generated page reads through the token-gated `/ux/data` allowlist (`--allow`); anything mutating needs an explicit per-command `--allow-write` grant AND a human "允许" in Render for every single run (`ux-confirm-broker`); no broker ⇒ writes fail closed. Page actions (`ux_submit`/`ux_confirm`) don't run anything themselves — they round-trip to the agent as its next turn, where normal HITL applies.
- **Credentials never enter the sandbox.** Logins happen in real tabs inside Render's own session partition; the agent only learns "login done, retry."
- **Iron rule: Render never drives, opens, or closes your system Chrome.** All browser-hand traffic targets Render's embedded Chromium under a dedicated opencli profile.
- **HITL before anything sensitive.** Command escalations, payments-shaped confirmations, and logins block on explicit user decisions.

## Getting started

Prerequisites: Node ≥ 22, pnpm 10 (`corepack enable`), and for the full agent experience the external runtime deps below.

```bash
pnpm install
pnpm build        # build workspace packages
pnpm dev          # launch the desktop shell (electron-vite)
```

### External runtime dependencies

Render degrades gracefully when these are missing (the shell runs; agent features disable):

| Dependency | Used for | Resolution |
| --- | --- | --- |
| `opencli` | The app hand (site adapters, daemon on :19825) | on `PATH`, or `OPENCLI_BIN` |
| `codex` | The brain (`codex app-server`) | on `PATH`; auth via Render's Codex settings or `~/.codex` |
| `opencli-ux` (`ux.mjs`) | Page kernel + home portal | sibling checkout `~/workspace/opencli-ux`, or `RENDER_PORTAL_UX_MJS` |

### Tests

```bash
pnpm typecheck                                  # all 8 projects
pnpm --filter @render/opencli-bridge test       # 29 unit tests, no external deps
cd apps/desktop && pnpm test:nav                # e2e: real Electron, nav guard
cd apps/desktop && pnpm test:cdp                # e2e: opencli drives Render over CDP (needs opencli)
cd apps/desktop && pnpm proof                   # headless full-spine journey proof (needs codex+opencli)
```

Headless/CI environments: run e2e under `xvfb-run -a` with `ELECTRON_DISABLE_SANDBOX=1`.

## Packaging & release

```bash
pnpm package:mac      # dmg + zip, arm64 + x64  (run on macOS)
pnpm package:linux    # AppImage + deb, x64
```

Artifacts land in `apps/desktop/release/`. The vite build bundles all runtime deps into `out/`, so packages ship no `node_modules`.

**Cutting a release:** push a `v*` tag (e.g. `git tag v0.1.0 && git push origin v0.1.0`). The [Release workflow](.github/workflows/release.yml) builds macOS + Linux packages and attaches them to a draft GitHub Release. CI ([ci.yml](.github/workflows/ci.yml)) gates every push/PR with typecheck, unit tests, and a real-Electron e2e.

Prototype builds are **unsigned** — first-launch on macOS needs right-click → Open (or `xattr -d com.apple.quarantine`). Code signing + notarization are wired behind `CSC_*` env vars when certificates are available.

### Useful env vars

`RENDER_HOME_PORTAL=0` (disable home portal) · `RENDER_PORTAL_UX_MJS` / `RENDER_PORTAL_SPEC` / `RENDER_PORTAL_HTML` (portal overrides) · `RENDER_CDP_PORT` / `RENDER_NO_CDP` / `RENDER_DEBUG_CDP` (CDP endpoint) · `OPENCLI_BIN` / `OPENCLI_DAEMON_PORT` / `RENDER_OPENCLI_PROFILE` (app hand) · `RENDER_CODEX_EGRESS_PROXY` (brain egress) · `E2B_API_KEY` (remote sandbox)

## Roadmap

- **macOS** (now): the packaged desktop prototype — full agent spine, generated pages, HITL, saved pages.
- **Windows / Linux**: same Electron codebase; Linux packages already build in CI. Windows needs NSIS/MSIX + signing.
- **iOS / Android**: native thin clients — a WebView + the json-render renderer speaking `@render/protocol` to a **remote brain** (e2b or Render cloud). The protocol package is deliberately dependency-free so mobile reuses it as-is.
- **Render cloud**: hosted brain + credential vault, so every device syncs one agent and one login state.
- **Hardening backlog**: make the opencli bridge the default path and retire fallbacks, daemon serial-queue fix upstream, login-lifecycle e2e on a real cookie site, CDP action scoping (task-scoped origins + TTL).

Deep-dive design docs live in [`docs/`](docs/) — start with `render-architecture-canonical.html` and `render-delivery.html`.

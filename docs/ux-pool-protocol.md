# ux pool protocol — one ux server, many specs, hot-swap by route

Status: **contract defined, Render side implemented** (`apps/desktop/src/main/ux-server.ts`).
The serving side lives in the sibling `opencli-ux` checkout (`ux.mjs`) and still
needs to implement the `pool` command described here. Until it does, Render's
capability probe falls back to today's per-page `ux render --spec … --keep`
servers automatically — nothing breaks, pool mode just lights up when `ux.mjs`
gains it.

## Why

Every `render-page` used to mint its own `ux render` process and its own
localhost origin. With updatable pages (skeleton → refine, post-hoc revisions),
per-page processes get worse: a revision either restarts the server (URL churn,
tab re-point) or leaks a process per revision. Pool mode fixes both:

- **one long-lived process** serves every generated page (and reopened saved
  pages) for the whole app run;
- **stable URLs**: a page keeps its URL across revisions, so updating the open
  tab is just a reload;
- **hot-swap**: revising a page is one stdin op, not a process spawn.

## Contract

### Spawn

```
node ux.mjs pool --no-open
```

Environment: `OPENCLI_PROFILE` is set to the profile all pooled pages run under
(Render passes its bridge profile). `--no-open` means never open a system
browser.

### Announce (stdout, first line)

```json
{"pooled": true, "url": "http://127.0.0.1:<port>"}
```

Render treats the first parseable JSON line as the announce and requires
`pooled === true` — anything else (usage text, an older `served`/`rendered`
announce) marks the binary as not pool-capable and Render falls back to
per-page servers for the rest of the app run. Render allows 3s for the
announce, then kills the child and falls back.

### Ops (stdin, JSONL — one op per line, acks in order)

Render serializes ops: at most one is in flight, and each op gets EXACTLY ONE
ack line on stdout (also JSONL). An ack must arrive within 15s or Render
retires the pool.

Serve (or hot-swap) a spec at a route:

```json
{"op": "set", "route": "pg-3-m5xk2v", "spec": { "root": "…", "state": {}, "elements": {} }, "allow": "agg search,coingecko top"}
```

→ ack:

```json
{"op": "set", "route": "pg-3-m5xk2v", "ok": true, "url": "http://127.0.0.1:<port>/page/pg-3-m5xk2v"}
```

- `spec` is the parsed json-render spec object (not a file path, not a string).
- The URL shape is ux.mjs's choice, but it MUST be stable across `set` ops on
  the same route — that stability is what makes update-in-place a tab reload.
- A `set` on an existing route replaces its spec and allowlist atomically; new
  page loads serve the new spec. (Render reloads the tab after every revision,
  so live client-side spec refresh — poll/SSE — is optional polish, not
  required.)

Free a route:

```json
{"op": "delete", "route": "pg-3-m5xk2v"}
```

→ ack `{"op": "delete", "route": "pg-3-m5xk2v", "ok": true}`.

Failure ack (still exactly one line per op):

```json
{"op": "set", "route": "…", "ok": false, "error": "spec failed catalog validation"}
```

### Security invariants (unchanged from per-page mode)

- `allow` is the **server-owned, per-route** allowlist: `/ux/data` requests
  originating from route R may only run the `<site> <command>` pairs in R's own
  allowlist — never another route's. Writes stay default-rejected.
- Specs remain catalog-whitelisted json-render; the pool must run the same
  validation `ux render --spec` runs.
- `/ux/data` stays token-gated per page load exactly as today.

## Render-side behavior (already implemented)

- Backend picked lazily on the first served page, once per app run:
  probe pool → fall back to per-page. `RENDER_UX_POOL=0` skips the probe.
- Pool death (exit, ack timeout) demotes new pages to per-page servers; pages
  the dead pool was serving return `null` from their next `update()`, which
  makes the agent runtime re-deliver them fresh.
- `disposeUxHost()` (window teardown) kills the pool; the next page re-probes.

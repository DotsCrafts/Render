/**
 * AgentRuntime — the REAL spine wired into the desktop hands broker.
 *
 * Replaces the M1 agent-stub. It owns:
 *   • a real `AgentSession` (@render/agent-bridge) running `codex app-server`
 *     inside a SandboxProvider — normalized AgentEvents stream straight to the
 *     renderer over IPC.assistantEvent.
 *   • the app-hand seam: a `/opencli …` command is routed through the
 *     `OpencliRouter` (@render/opencli-router) and its real data is surfaced as a
 *     ux render (or ux login when a logged-in session is required).
 *   • the HITL resolution path: blocking ux confirm/form messages are tracked by
 *     id; `resolveUx(id,result)` maps the human's choice back to the codex reply
 *     and calls `AgentSession.resolvePending`.
 *
 * Trust boundary unchanged: the renderer only ever speaks the protocol channels;
 * codex / opencli / CDP stay behind this main-process module.
 */

import { AgentSession } from '@render/agent-bridge';
import type { OpencliRouterHandle } from '@render/opencli-router';
import type {
  AgentEvent,
  ApprovalPolicy,
  OpencliInvocation,
  SandboxMode,
  SandboxProvider,
  TabGroupInfo,
  UxBlockResult,
  UxKind,
  UxLoginResult,
  UxMessage,
  UxPageRef,
  UxResult,
} from '@render/protocol';
import { prepareCodexHome, type CodexHome } from './codex-home.js';
import { parseOpencliCommand } from './opencli-command.js';
import { opencliResultToUx } from './opencli-to-ux.js';
import { uxResultToCodexReply } from './ux-reply.js';
import {
  RENDER_AGENTS_MD,
  writeAgentsMd,
  installRenderOpen,
  parseRenderOpen,
  installRenderPage,
  parseRenderPage,
} from './agent-instructions.js';
import { answerToUxMessage } from './answer-to-ux.js';
import { detectOpencliAuthNeed } from './opencli-auth.js';
import { createConversationGroups, type ConversationGroups } from './conversation-groups.js';
import { serveUxSpec, type UxPage } from './ux-server.js';

export interface AgentRuntime {
  submit(text: string): Promise<{ turnId: string }>;
  steer(text: string): Promise<void>;
  cancel(): Promise<void>;
  resolveUx(id: string, result: UxResult): Promise<void>;
  /**
   * The CURRENT conversation's browser tab group — read by the opencli bridge at
   * tab-mint time so agent tabs join the active conversation's group.
   */
  activeGroup(): TabGroupInfo;
  /**
   * Start a FRESH conversation: tear down the current codex thread (the next
   * submit lazily starts a new one) and allocate the next tab group, so the
   * agent's subsequent tabs land in a new group. New group ⟺ new conversation.
   */
  newConversation(): Promise<TabGroupInfo>;
  dispose(): Promise<void>;
}

export interface AgentRuntimeDeps {
  /** push a normalized AgentEvent to the renderer (broker.emitAgent) */
  emit: (event: AgentEvent) => void;
  /** sandbox the BRAIN (codex app-server) runs inside */
  sandbox: SandboxProvider;
  /** the app hand — routes /opencli commands (public→sandbox, browser→CDP relay) */
  router: OpencliRouterHandle;
  /**
   * Open a URL in Render's OWN browser tab (human-hand) — the `render-open` tool.
   * Returns the minted tab's id when the TabManager provides one, so delivered
   * pages can be updated in place in the same tab later.
   */
  openTab?: (url: string) => string | void;
  /**
   * Re-point an existing tab at a URL (or reload it when the URL is unchanged) —
   * how a revised render-page lands in the tab it already owns. Returns false
   * when the tab is gone, so the caller opens a fresh one instead.
   */
  navigateTab?: (tabId: string, url: string) => boolean;
  /**
   * Register a conversation's tab group (label/color) with the TabManager when it
   * becomes active, so snapshots can render its chip even before the bridge mints
   * its first tab. Wired to `tabs.ensureGroup` by index.ts.
   */
  registerGroup?: (group: TabGroupInfo) => void;
  /**
   * The opencli profile the agent's cookie/browser commands route to. When the
   * bridge is on this is Render's own profile (`render`), so logged-in scraping
   * happens inside Render. Falls back to OPENCLI_PROFILE / 'default' when unset.
   */
  opencliProfile?: string;
  /**
   * The human-hand CDP relay endpoint. Injected into the sandbox as
   * OPENCLI_CDP_ENDPOINT so the AGENT's own opencli browser-adapter calls reach
   * the user's real logged-in Chromium. Lazy — the relay binds at window boot.
   */
  cdpEndpoint?: () => Promise<string>;
  now: () => number;
  approvalPolicy?: ApprovalPolicy;
  sandboxMode?: SandboxMode;
  effort?: 'low' | 'medium' | 'high';
  model?: string;
  /** echo raw codex JSONL frames to stderr (diagnostics only) */
  logRaw?: boolean;
  /**
   * Materialize a Render-managed hook-free CODEX_HOME (provider + credential set
   * in Render's settings). Returns null when no Render credential exists, so the
   * runtime falls back to copying the user's ~/.codex.
   */
  materializeCodexHome?: () => Promise<CodexHome | null>;
  /**
   * Persist a delivered Tier-2 page's spec (Delta 3) so the human can Save it and
   * reopen it later. Best-effort — returns the page id, or undefined when no store
   * is wired. The page is PURE given spec + allowlist, so re-serving reproduces it.
   */
  persistPage?: (input: {
    specJson: string;
    title: string;
    allow: string;
    convId?: string;
  }) => string | undefined;
  /**
   * Persist a REVISION of an already-persisted page as a new version of the SAME
   * store entry (Delta 5 addVersion), so Save captures the latest spec instead of
   * littering the store with one draft per revision. Best-effort.
   */
  updatePage?: (id: string, input: { specJson: string; title?: string; allow?: string }) => void;
}

/** A delivered Tier-2 page: its serve handle plus everything needed to revise it. */
interface DeliveredPage {
  /** abs spec path inside the sandbox — the AGENT-facing identity of the page */
  file: string;
  title: string;
  allow: string;
  page: UxPage;
  /** the tab the page lives in — the HUMAN-facing surface to update in place */
  tabId?: string;
  /** pages-store id, so revisions persist as new versions of the same entry */
  storeId?: string;
}

interface PendingHitl {
  requestId: number | string;
  kind: UxKind;
}

export function createAgentRuntime(deps: AgentRuntimeDeps): AgentRuntime {
  // ux id → codex requestId, so resolveUx can route the human's reply back.
  const pendingHitl = new Map<string, PendingHitl>();
  // ux id → { site, loginUrl } for the needs-login → open-real-tab round-trip.
  const pendingLogin = new Map<string, { site: string; loginUrl?: string }>();
  // sites we've already surfaced a login card for this turn, so a retry storm
  // of AUTH_REQUIRED commands doesn't spam duplicate login surfaces.
  const loginPrompted = new Set<string>();
  // ux ids of block-decision cards, so resolveUx routes a choice/steer back into
  // the conversation (steerTurn if live, else a fresh turn) instead of to codex.
  const pendingBlock = new Set<string>();
  let session: AgentSession | null = null;
  let codexHome: CodexHome | null = null;
  let startPromise: Promise<void> | null = null;
  let turnSeq = 0;
  let uxSeq = 0;
  // Per-conversation tab groups: conv-1 is the degenerate single-group case.
  // Each time a group becomes active we register it with the TabManager so its
  // label/color are known to snapshots before the bridge mints a tab into it.
  const conversations: ConversationGroups = createConversationGroups((group) => {
    deps.registerGroup?.(group);
  });

  let pageSeq = 0;
  /**
   * Delivered pages keyed by the tab they live in (synthetic `page-N` key when no
   * tab id was available). A `render-page` re-run whose SPEC FILE matches an entry
   * revises that page IN PLACE — same page identity, same tab — instead of minting
   * a new tab + server. Cleared (not disposed) per conversation: the pages stay
   * open for the human, but a new conversation's `app.json` is a new page.
   */
  const pageByTab = new Map<string, DeliveredPage>();
  /** every page served this app-session — lifecycle only, disposed at shutdown. */
  const pages: UxPage[] = [];

  /**
   * Revise an already-delivered page: re-serve the new spec through its UxPage
   * (pooled backend hot-swaps at the same URL; per-page fallback re-serves at a
   * new one), land it in the page's existing tab, persist a new version, drop an
   * "Updated" card. Returns false when the page's server is gone — the caller
   * then falls back to a fresh delivery.
   */
  const revisePage = async (
    key: string,
    rec: DeliveredPage,
    inv: { file: string; title?: string; allow?: string },
    specJson: string,
  ): Promise<boolean> => {
    const url = await rec.page.update({
      specJson,
      ...(inv.allow !== undefined ? { allow: inv.allow } : {}),
    });
    if (!url) {
      // server died / revision unservable — retire the record so the fresh
      // delivery below re-registers this spec file as a new page.
      pageByTab.delete(key);
      rec.page.dispose();
      return false;
    }
    if (inv.title?.trim()) rec.title = inv.title.trim();
    if (inv.allow !== undefined) rec.allow = inv.allow;
    // Land the revision in the page's own tab: unchanged URL → loadURL reloads it.
    // If the human closed that tab, open a fresh one and re-key the registry.
    const navigated = rec.tabId ? deps.navigateTab?.(rec.tabId, url) === true : false;
    if (!navigated) {
      const opened = deps.openTab?.(url);
      const tabId = typeof opened === 'string' ? opened : undefined;
      if (tabId && tabId !== key) {
        pageByTab.delete(key);
        rec.tabId = tabId;
        pageByTab.set(tabId, rec);
      }
    }
    try {
      if (rec.storeId) {
        deps.updatePage?.(rec.storeId, { specJson, title: rec.title, allow: rec.allow });
      } else {
        const pid = deps.persistPage?.({ specJson, title: rec.title, allow: rec.allow });
        if (pid) rec.storeId = pid;
      }
    } catch (err) {
      console.warn('[agent-runtime] persisting page revision failed:', errText(err));
    }
    deps.emit({
      kind: 'ux',
      message: {
        id: `ux-page-${++uxSeq}`,
        kind: 'render',
        blocking: false,
        ts: deps.now(),
        ...(rec.storeId ? { page: { id: rec.storeId, title: rec.title } } : {}),
        spec: {
          title: `Updated app: ${rec.title}`,
          body: 'The open page was revised in place.',
          items: [{ title: rec.title, url }],
        },
      },
    });
    return true;
  };

  /**
   * Deliveries are SERIALIZED: a rapid skeleton→refine pair must not race — the
   * second run has to see the first run's pageByTab entry, or it would mint a
   * second page/tab for the same spec file instead of revising the first.
   */
  let deliverChain: Promise<void> = Promise.resolve();
  const enqueueDeliverPage = (inv: { file: string; title?: string; allow?: string }): void => {
    deliverChain = deliverChain.then(
      () => deliverPage(inv),
      () => deliverPage(inv), // never let one failed delivery poison the chain
    );
  };

  /**
   * Read the json-render spec the agent wrote (inside the sandbox), serve it via
   * the opencli-ux kernel, and open the served URL in a tab — then drop a
   * reference card. A re-run with a spec file that already backs a delivered page
   * UPDATES that page/tab in place (skeleton-then-refine, post-hoc revisions).
   * No isolated partition / artifact bridge: the page is a real localhost app
   * whose only backend reach is the ux server's /ux/data.
   */
  const deliverPage = async (inv: { file: string; title?: string; allow?: string }): Promise<void> => {
    let specJson: string;
    try {
      const res = await deps.sandbox.exec('cat', [inv.file], { cwd: deps.sandbox.workdir() });
      if (res.exitCode !== 0 || !res.stdout.trim()) {
        deps.emit({ kind: 'error', message: `render-page: could not read ${inv.file}` });
        return;
      }
      specJson = res.stdout;
    } catch (err) {
      deps.emit({ kind: 'error', message: `render-page: ${errText(err)}` });
      return;
    }
    try {
      JSON.parse(specJson);
    } catch (err) {
      deps.emit({ kind: 'error', message: `render-page: spec is not valid JSON — ${errText(err)}` });
      return;
    }

    // Same spec file as an already-delivered page → revise it in place.
    const existing = [...pageByTab.entries()].find(([, p]) => p.file === inv.file);
    if (existing && (await revisePage(existing[0], existing[1], inv, specJson))) return;

    const title = inv.title?.trim() || 'App';
    const page = serveUxSpec({
      specJson,
      allow: inv.allow ?? '',
      idTag: `${++pageSeq}-${deps.now()}`,
      ...(deps.opencliProfile ? { profile: deps.opencliProfile } : {}),
    });
    pages.push(page);
    const url = await page.whenReady();
    if (!url) {
      deps.emit({ kind: 'error', message: `render-page: ux server failed to start for "${title}"` });
      return;
    }
    const opened = deps.openTab?.(url);
    const tabId = typeof opened === 'string' ? opened : undefined;
    // Delta 3: persist the spec so the human can Save + reopen it. The page is
    // pure given spec + allowlist, so re-serving reproduces it (data refetched
    // live). Best-effort — a persistence failure must not break the open.
    let pageRef: UxPageRef | undefined;
    try {
      const pid = deps.persistPage?.({ specJson, title, allow: inv.allow ?? '' });
      if (pid) pageRef = { id: pid, title };
    } catch (err) {
      console.warn('[agent-runtime] persistPage failed:', errText(err));
    }
    pageByTab.set(tabId ?? `page-${pageSeq}`, {
      file: inv.file,
      title,
      allow: inv.allow ?? '',
      page,
      ...(tabId ? { tabId } : {}),
      ...(pageRef ? { storeId: pageRef.id } : {}),
    });
    deps.emit({
      kind: 'ux',
      message: {
        id: `ux-page-${++uxSeq}`,
        kind: 'render',
        blocking: false,
        ts: deps.now(),
        ...(pageRef ? { page: pageRef } : {}),
        spec: {
          title: `Opened app: ${title}`,
          body: 'An interactive page is open in its own tab.',
          items: [{ title, url }],
        },
      },
    });
  };

  const buildSession = (env?: Record<string, string>): AgentSession => {
    const s = new AgentSession({
      sandbox: deps.sandbox,
      // we start()/dispose() the sandbox ourselves so we can seed AGENTS.md
      // before codex boots.
      externalSandbox: true,
      // browsing agent UX: let opencli reads flow (they stream into the panel),
      // and only surface a ux confirm when a command needs to escalate out of the
      // sandbox. HITL is preserved for the risky cases, not every read.
      approvalPolicy: deps.approvalPolicy ?? 'on-failure',
      sandboxMode: deps.sandboxMode ?? 'workspace-write',
      // the agent's hand (opencli) needs the network + the localhost CDP relay;
      // codex's workspace-write sandbox denies network unless we opt in.
      extraArgs: ['-c', 'sandbox_workspace_write.network_access=true'],
      effort: deps.effort ?? 'low',
      ...(deps.model ? { model: deps.model } : {}),
      ...(deps.logRaw ? { logRaw: true } : {}),
      ...(env ? { env } : {}),
    });
    // accumulate streamed agentMessage text per item so the final answer can be
    // converted into a structured ux render card (see answer-to-ux.ts).
    const answerText = new Map<string, string>();
    s.onAgentEvent((event) => {
      if (event.kind === 'ux' && event.message.blocking) {
        const requestId = event.message.origin?.requestId;
        if (requestId !== undefined) {
          pendingHitl.set(event.message.id, { requestId, kind: event.message.kind });
        }
      }

      // The agent's prose answer must NOT show as raw feed text — it becomes a
      // json-render card. Suppress agentMessage deltas; on completion, emit a
      // ux render (parsed structured spec, or prose fallback as the card body).
      if (event.kind === 'delta') {
        if (event.itemId) {
          answerText.set(event.itemId, (answerText.get(event.itemId) ?? '') + event.text);
        }
        return;
      }
      if (event.kind === 'item' && event.item.type === 'userMessage') {
        return; // we already echoed the user's message optimistically in submit()
      }
      // `render-open <url>` → open the page in Render's OWN browser tab (not a
      // system browser). The shim only prints a sentinel; the real open is here.
      if (
        event.kind === 'item' &&
        event.phase === 'completed' &&
        event.item.type === 'commandExecution'
      ) {
        const url = parseRenderOpen(event.item.command);
        if (url && deps.openTab) {
          deps.openTab(url);
          deps.emit({
            kind: 'ux',
            message: {
              id: `ux-open-${++uxSeq}`,
              kind: 'render',
              blocking: false,
              ts: deps.now(),
              spec: { title: 'Opened in your browser', body: url, items: [{ title: url, url }] },
            },
          });
          return; // don't also show the raw shim command row
        }
        // `render-page <spec> --title … --allow …` → deliver a Tier-2 page: read
        // the json-render spec the agent wrote, serve it via the opencli-ux kernel,
        // open the URL in a tab, drop a reference card. The shim printed a sentinel
        // into the command's output (we read THAT, so shell quoting is collapsed).
        const pageInv = parseRenderPage(collectItemOutput(event.item));
        if (pageInv) {
          enqueueDeliverPage(pageInv);
          return; // don't also show the raw shim command row
        }
        // The agent ran opencli directly and it failed because the site needs a
        // logged-in session. opencli signals this (exit 77 / AUTH_REQUIRED) but
        // the agent just narrates it and falls back to a public source — so the
        // `login` HITL surface (which lives only on the router path) never fires.
        // Surface it here from the agent's own command stream: one card per site.
        const authNeed = detectOpencliAuthNeed(event.item);
        if (authNeed && !loginPrompted.has(authNeed.site)) {
          loginPrompted.add(authNeed.site);
          const id = `ux-login-${++uxSeq}`;
          pendingLogin.set(id, { site: authNeed.site, loginUrl: authNeed.loginUrl });
          deps.emit({
            kind: 'ux',
            message: {
              id,
              kind: 'login',
              blocking: false, // don't freeze the agent; offer login alongside its fallback
              ts: deps.now(),
              spec: {
                site: authNeed.site,
                reason: `opencli needs a logged-in ${authNeed.site} session — log in here and I can pull the full ${authNeed.site} data.`,
                ...(authNeed.loginUrl ? { loginUrl: authNeed.loginUrl } : {}),
              },
            },
          });
          // fall through: still forward the command row so the stream stays truthful
        }
      }
      if (event.kind === 'item' && event.item.type === 'agentMessage') {
        if (event.phase === 'completed') {
          const id = typeof event.item.id === 'string' ? event.item.id : undefined;
          const text =
            (typeof event.item.text === 'string' && event.item.text) ||
            (id ? (answerText.get(id) ?? '') : '');
          if (id) answerText.delete(id);
          if (text.trim()) {
            const message = answerToUxMessage(text, `ux-ans-${++uxSeq}`, deps.now());
            // a ```block answer is a decision card — track it so resolveUx steers
            // the conversation rather than routing the reply back to codex.
            if (message.kind === 'block') pendingBlock.add(message.id);
            deps.emit({ kind: 'ux', message });
          }
        }
        return; // never forward the raw agentMessage item to the feed
      }

      deps.emit(event);
    });
    return s;
  };

  const ensureStarted = (): Promise<void> => {
    if (!startPromise) {
      startPromise = (async () => {
        // Render owns the approval UX, so run codex against a hook-free home —
        // approvals then arrive over the protocol as our ux confirm/form. Prefer a
        // Render-managed home (provider/auth set in Render's settings); fall back
        // to copying the user's ~/.codex when no Render credential exists.
        codexHome = (await deps.materializeCodexHome?.()) ?? (await prepareCodexHome());
        const env: Record<string, string> = {};
        if (codexHome) env.CODEX_HOME = codexHome.path;
        // opencli's default profile (~/.opencli/browser-profiles.json) is often a
        // DISCONNECTED context, which makes browser/search commands fail with
        // "profile not connected". Pin a connected profile so the agent's opencli
        // browser commands work without it having to recover each time.
        //
        // When the opencli /ext bridge is active (RENDER_OPENCLI_BRIDGE=1), Render
        // is itself connected as a distinct, named profile (default `render`), so
        // we target THAT — the agent's opencli browser/cookie commands are then
        // served by Render's OWN Chromium via the bridge, while the unqualified
        // default profile keeps routing to the user's system Chrome (untouched).
        // An explicit OPENCLI_PROFILE always wins.
        env.OPENCLI_PROFILE =
          process.env.OPENCLI_PROFILE ??
          (process.env.RENDER_OPENCLI_BRIDGE === '1'
            ? (process.env.RENDER_OPENCLI_PROFILE?.trim() || 'render')
            : 'default');
        // Wire the human-hand relay so the agent's opencli browser-adapter calls
        // drive the user's REAL logged-in Chromium (Plane-2 stays in the browser).
        if (deps.cdpEndpoint) {
          try {
            env.OPENCLI_CDP_ENDPOINT = await deps.cdpEndpoint();
          } catch {
            /* relay not up yet — public/API adapters still work headless */
          }
        }
        // Start the sandbox ourselves, then seed AGENTS.md (makes opencli the
        // agent's mandated hand) + install the `render-open` tool before boot.
        await deps.sandbox.start({ env });
        await writeAgentsMd(deps.sandbox, RENDER_AGENTS_MD, env);
        // both the render-open and render-page shims live in the same .render-bin;
        // install both (same dir) and prepend it to PATH once.
        const binDir = await installRenderOpen(deps.sandbox, env);
        await installRenderPage(deps.sandbox, env);
        if (binDir) env.PATH = `${binDir}:${process.env.PATH ?? ''}`;
        session = buildSession(env);
        await session.start();
      })().catch((err) => {
        startPromise = null; // allow a retry after a failed boot
        throw err;
      });
    }
    return startPromise;
  };

  const runOpencli = async (inv: OpencliInvocation): Promise<{ turnId: string }> => {
    const turnId = `oc-${++turnSeq}`;
    deps.emit({ kind: 'turn_started', turnId });
    try {
      const result = await deps.router.invoke(inv);
      const message = opencliResultToUx(result, inv, `ux-oc-${++uxSeq}`, deps.now());
      if (message.kind === 'login') {
        const loginUrl = (message.spec as { loginUrl?: string }).loginUrl;
        pendingLogin.set(message.id, { site: inv.site, loginUrl });
      }
      deps.emit({ kind: 'ux', message });
      deps.emit({ kind: 'turn_completed', status: result.ok ? 'completed' : 'failed' });
    } catch (err) {
      deps.emit({ kind: 'error', message: errText(err) });
      deps.emit({ kind: 'turn_completed', status: 'failed' });
    }
    return { turnId };
  };

  const submit = async (text: string): Promise<{ turnId: string }> => {
    // Optimistic echo: show the user's own message in the stream immediately,
    // before the sandbox/codex boot (otherwise the first turn shows nothing for
    // seconds). codex's own userMessage item is suppressed below to avoid a dup.
    deps.emit({ kind: 'item', phase: 'completed', item: { type: 'userMessage', text } });
    const opencli = parseOpencliCommand(text);
    if (opencli) return runOpencli(opencli);
    await ensureStarted();
    return session!.submitTurn(text);
  };

  const steer = async (text: string): Promise<void> => {
    if (!session) return;
    await session.steer(text);
  };

  const cancel = async (): Promise<void> => {
    if (!session) return;
    await session.cancel();
  };

  const resolveUx = async (id: string, result: UxResult): Promise<void> => {
    const login = pendingLogin.get(id);
    if (login) {
      pendingLogin.delete(id);
      resolveLogin(login.site, login.loginUrl, result as UxLoginResult);
      return;
    }
    // Block-decision card: a picked option or a free-text steer both feed back
    // into the conversation — steer the live turn, else start a fresh turn.
    if (pendingBlock.has(id)) {
      pendingBlock.delete(id);
      const r = result as UxBlockResult;
      if (r.action === 'ux_cancel') return;
      const text = (r.action === 'ux_instruct' ? r.instruction : r.choice)?.trim();
      if (!text) return;
      if (session?.activeTurnId) await session.steer(text);
      else await submit(text);
      return;
    }
    const hitl = pendingHitl.get(id);
    if (!hitl || !session) return; // unknown / already resolved
    pendingHitl.delete(id);
    session.resolvePending(hitl.requestId, uxResultToCodexReply(hitl.kind, result));
  };

  const resolveLogin = (site: string, loginUrl: string | undefined, result: UxLoginResult): void => {
    // allow a fresh login card if this site's session lapses again later
    loginPrompted.delete(site);
    if (result.action !== 'login_done') return;
    // REAL login: open the site's login page in Render's OWN browser tab and let
    // the human log in there. Because that tab and the opencli bridge's views
    // share the `persist:render` session, the cookie the user sets is visible to
    // the agent's opencli (routed to the `render` profile) — so a retry succeeds.
    // We never call router.login (cookie adapter → system Chrome) and never claim
    // "signed in": we only confirm the tab is open and ask the agent to retry.
    const url = loginUrl ?? `https://${site}.com`;
    if (deps.openTab) deps.openTab(url);
    deps.emit({
      kind: 'ux',
      message: loginOpenedUx(site, url, !!deps.openTab, `ux-oc-${++uxSeq}`, deps.now()),
    });
  };

  const activeGroup = (): TabGroupInfo => conversations.current();

  const newConversation = async (): Promise<TabGroupInfo> => {
    // Tear down the current codex thread so the NEXT submit lazily starts a fresh
    // one (ensureStarted re-runs once startPromise is cleared). Per-turn HITL /
    // login state belongs to the old conversation, so clear it too.
    if (session) {
      const old = session;
      session = null;
      startPromise = null;
      await old.dispose();
    }
    if (codexHome) {
      await codexHome.cleanup();
      codexHome = null;
    }
    pendingHitl.clear();
    pendingLogin.clear();
    loginPrompted.clear();
    pendingBlock.clear();
    // Page identity is conversation-scoped: drop the update-in-place registry (the
    // pages themselves stay open in their tabs) so the new conversation's spec
    // files mint fresh pages instead of overwriting the old conversation's.
    pageByTab.clear();
    // Allocate the next group; subsequent agent tabs (minted by the bridge) join
    // it. We don't open an initial tab — the active group is set for the next
    // agent action, matching the bridge's lazy mint-on-demand model.
    return conversations.next();
  };

  const dispose = async (): Promise<void> => {
    pendingHitl.clear();
    pendingLogin.clear();
    loginPrompted.clear();
    pendingBlock.clear();
    pageByTab.clear();
    pages.forEach((p) => p.dispose());
    if (session) await session.dispose();
    if (codexHome) await codexHome.cleanup();
  };

  return {
    submit,
    steer,
    cancel,
    resolveUx,
    activeGroup,
    newConversation,
    dispose,
  };
}

function loginOpenedUx(site: string, url: string, opened: boolean, id: string, ts: number): UxMessage {
  return {
    id,
    kind: 'render',
    blocking: false,
    ts,
    spec: opened
      ? {
          title: `Opened ${site} login in Render`,
          body: `Log in on the tab I just opened — your session stays inside Render. When you're done, ask me to retry and I'll use it.`,
          items: [{ title: url, url }],
        }
      : {
          title: `Log in to ${site} in Render`,
          body: `Open this page in a Render tab, log in, then ask me to retry.`,
          items: [{ title: url, url }],
        },
  };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Join a completed command item's output streams (for sentinel scanning). */
function collectItemOutput(item: { aggregatedOutput?: unknown; stdout?: unknown; stderr?: unknown }): string {
  return [item.aggregatedOutput, item.stdout, item.stderr]
    .filter((p): p is string => typeof p === 'string')
    .join('\n');
}

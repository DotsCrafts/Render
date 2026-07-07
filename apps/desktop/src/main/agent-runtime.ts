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
  seedPortalExample,
} from './agent-instructions.js';
import { answerToUxMessage } from './answer-to-ux.js';
import { detectOpencliAuthNeed } from './opencli-auth.js';
import { validatePageSpec } from './spec-guard.js';
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
   * open a URL in Render's OWN browser tab (human-hand) — the `render-open`
   * tool. Returns the tabId when the host provides one, which lets the runtime
   * tie a generated page's server to its tab lifetime.
   */
  openTab?: (url: string) => string | void;
  /** subscribe to tab teardown — pairs with openTab for page-server disposal */
  onTabClose?: (cb: (tabId: string) => void) => () => void;
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
  // Conversation generation — bumped by newConversation so a submit that was
  // mid-boot when the user reset can detect it and re-enter on the fresh thread
  // instead of dereferencing a torn-down session.
  let conversationGen = 0;
  // Boot turns Stop already reported as cancelled — each in-flight
  // startCodexTurn checks (and consumes) ITS OWN id after the boot settles, so
  // a Stop aimed at message 1 can't be erased by message 2 minting a new turn.
  const cancelledBootTurns = new Set<string>();
  // /opencli router turns: live ones (id → command text) are cancellable — we
  // stop reporting them; a cancelled id makes the late-settling invoke drop its
  // stale result instead of corrupting a later turn.
  const liveOcTurns = new Map<string, string>();
  const cancelledOcTurns = new Set<string>();
  // Synthetic "booting" turns emitted by startCodexTurn so the panel shows
  // working state immediately. A SET, not a slot: a second message typed during
  // the multi-second boot mints another boot turn, and every outstanding one
  // must be retired when codex's real turn_started arrives — an orphaned boot
  // id would leave the renderer's open-turn set (and its working dot) stuck
  // for the rest of the session.
  const pendingBootTurns = new Set<string>();
  // consecutive render-page failures — stop auto-steering the agent after a few
  // so a hopeless spec can't ping-pong forever.
  let pageFailStreak = 0;
  // Per-conversation tab groups: conv-1 is the degenerate single-group case.
  // Each time a group becomes active we register it with the TabManager so its
  // label/color are known to snapshots before the bridge mints a tab into it.
  const conversations: ConversationGroups = createConversationGroups((group) => {
    deps.registerGroup?.(group);
  });

  let pageSeq = 0;
  const pages: UxPage[] = [];
  // delivered page ↔ tab: closing the tab kills the page's server, so a day of
  // browsing doesn't accumulate zombie node processes (each an opencli-capable
  // localhost server). Pages without a known tab still die in dispose().
  const pageByTab = new Map<string, UxPage>();
  const offTabClose = deps.onTabClose?.((tabId) => {
    const page = pageByTab.get(tabId);
    if (!page) return;
    pageByTab.delete(tabId);
    page.dispose();
  });

  /**
   * Read the json-render spec the agent wrote (inside the sandbox), serve it via
   * the opencli-ux kernel (`ux render`), and open the served URL in a tab — then
   * drop a reference card. No isolated partition / artifact bridge: the page is a
   * real localhost app whose only backend reach is the ux server's /ux/data.
   */
  /**
   * A render-page failure must reach BOTH sides: the human (error row in the
   * feed) and the AGENT — the shim exits 0 unconditionally, so without a steer
   * the agent believes the page shipped and ends its turn. Steer the live turn
   * when one is open, else start a corrective follow-up turn; give up after a
   * few consecutive failures so a hopeless spec can't ping-pong forever.
   */
  const failPage = async (reason: string): Promise<void> => {
    deps.emit({ kind: 'error', message: `render-page: ${reason}` });
    pageFailStreak += 1;
    if (!session || pageFailStreak > 3) return;
    const guidance = `render-page FAILED (the page was NOT delivered): ${reason}\nFix the spec file (or the --allow list) and run render-page again.`;
    try {
      if (session.activeTurnId) await session.steer(guidance);
      else await session.submitTurn(guidance);
    } catch (err) {
      console.warn('[agent-runtime] failPage steer failed:', errText(err));
    }
  };

  const deliverPage = async (inv: { file: string; title?: string; allow?: string }): Promise<void> => {
    let specJson: string;
    try {
      const res = await deps.sandbox.exec('cat', [inv.file], { cwd: deps.sandbox.workdir() });
      if (res.exitCode !== 0 || !res.stdout.trim()) {
        await failPage(`could not read ${inv.file}`);
        return;
      }
      specJson = res.stdout;
    } catch (err) {
      await failPage(errText(err));
      return;
    }
    // Deliver-time validation: structural integrity, forbidden terminal actions
    // (ux_submit would destroy a kept page), and ux_data-vs-allowlist mismatches
    // all fail HERE, agent-actionably — not as a blank tab or a dead widget.
    const guard = validatePageSpec(specJson, inv.allow ?? '');
    if (!guard.ok) {
      await failPage(`spec rejected —\n- ${guard.errors.join('\n- ')}`);
      return;
    }

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
      const tail = page.stderrTail().trim();
      await failPage(
        `ux server failed to start for "${title}"${tail ? ` — ${tail.slice(-300)}` : ''}`,
      );
      return;
    }
    pageFailStreak = 0;
    const tabId = deps.openTab?.(url);
    if (typeof tabId === 'string') pageByTab.set(tabId, page);
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
    // converted into a structured ux render card (see answer-to-ux.ts). While
    // streaming, a throttled DRAFT card with the SAME stable id as the final
    // card is emitted (the feed replaces same-id surfaces in place), so long
    // answers fill in live instead of popping whole at the very end.
    const answerText = new Map<string, string>();
    const draftEmittedAt = new Map<string, number>();
    // reasoning arrives as one event per token fragment — batch fragments and
    // forward at most ~2 events/sec (each event carries the text SINCE the last
    // flush; the feed concatenates), so narration cannot flood the bounded
    // event windows and evict real cards.
    let reasonBuf: { itemId: string | undefined; text: string; lastFlush: number } = {
      itemId: undefined,
      text: '',
      lastFlush: 0,
    };
    const flushReasoning = (): void => {
      if (reasonBuf.text) {
        deps.emit({
          kind: 'reasoning',
          ...(reasonBuf.itemId ? { itemId: reasonBuf.itemId } : {}),
          text: reasonBuf.text,
        });
      }
      reasonBuf = { itemId: reasonBuf.itemId, text: '', lastFlush: deps.now() };
    };
    const emitDraft = (itemId: string): void => {
      const now = deps.now();
      if (now - (draftEmittedAt.get(itemId) ?? 0) < 700) return;
      const body = draftAnswerBody(answerText.get(itemId) ?? '');
      if (!body) return;
      draftEmittedAt.set(itemId, now);
      deps.emit({
        kind: 'ux',
        message: {
          id: `ux-ans-${itemId}`,
          kind: 'render',
          blocking: false,
          ts: now,
          spec: { body },
        },
      });
    };

    s.onAgentEvent((event) => {
      // codex process died. newConversation/dispose null `session` BEFORE
      // tearing down, so if this session is still current the exit was NOT
      // deliberate — surface it, close open turns, and reset so the next
      // submit boots a fresh thread instead of wedging the panel forever.
      if (event.kind === 'sandbox' && event.status === 'closed') {
        deps.emit(event); // the lane's lifecycle row stays truthful either way
        if (s !== session) return;
        session = null;
        startPromise = null;
        pendingBootTurns.clear();
        pendingHitl.clear();
        pendingBlock.clear();
        const home = codexHome;
        codexHome = null;
        deps.emit({
          kind: 'error',
          message: 'agent process exited — your next message starts a fresh session',
        });
        deps.emit({ kind: 'turn_completed', status: 'failed' });
        void s.dispose().catch((err) => console.warn('[agent-runtime] crash dispose:', errText(err)));
        if (home) void home.cleanup().catch(() => {});
        return;
      }

      if (event.kind === 'reasoning') {
        if (reasonBuf.itemId !== event.itemId && reasonBuf.text) flushReasoning();
        reasonBuf = {
          itemId: event.itemId,
          text: reasonBuf.itemId === event.itemId ? reasonBuf.text + event.text : event.text,
          lastFlush: reasonBuf.lastFlush,
        };
        if (deps.now() - reasonBuf.lastFlush >= 400) flushReasoning();
        return;
      }
      // any non-delta event: flush buffered narration first so ordering holds
      if (event.kind !== 'delta') flushReasoning();

      if (event.kind === 'ux' && event.message.blocking) {
        const requestId = event.message.origin?.requestId;
        if (requestId !== undefined) {
          pendingHitl.set(event.message.id, { requestId, kind: event.message.kind });
        }
      }

      // The agent's prose answer must NOT show as raw feed text — it becomes a
      // json-render card. agentMessage deltas accumulate into the draft card;
      // on completion, the final card (same id) replaces it in place.
      if (event.kind === 'delta') {
        if (event.itemId) {
          answerText.set(event.itemId, (answerText.get(event.itemId) ?? '') + event.text);
          emitDraft(event.itemId);
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
          void deliverPage(pageInv);
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
          if (id) {
            answerText.delete(id);
            draftEmittedAt.delete(id);
          }
          if (text.trim()) {
            // same id as the streamed draft so the final card replaces it in place
            const cardId = id ? `ux-ans-${id}` : `ux-ans-${++uxSeq}`;
            const message = answerToUxMessage(text, cardId, deps.now());
            // a ```block answer is a decision card — track it so resolveUx steers
            // the conversation rather than routing the reply back to codex.
            if (message.kind === 'block') pendingBlock.add(message.id);
            deps.emit({ kind: 'ux', message });
          }
        }
        return; // never forward the raw agentMessage item to the feed
      }

      // codex's real turn is live — retire EVERY outstanding synthetic boot
      // turn (each emitted by startCodexTurn so the panel showed working state
      // during the boot). Real first, then the closes: the busy set never dips.
      if (event.kind === 'turn_started' && pendingBootTurns.size > 0) {
        const boots = [...pendingBootTurns];
        pendingBootTurns.clear();
        deps.emit(event);
        for (const boot of boots) {
          deps.emit({ kind: 'turn_completed', status: 'completed', turnId: boot });
        }
        return;
      }

      deps.emit(event);
    });
    return s;
  };

  const ensureStarted = (): Promise<void> => {
    if (!startPromise) {
      const genAtStart = conversationGen;
      startPromise = (async () => {
        // Render owns the approval UX, so run codex against a hook-free home —
        // approvals then arrive over the protocol as our ux confirm/form. Prefer a
        // Render-managed home (provider/auth set in Render's settings); fall back
        // to copying the user's ~/.codex when no Render credential exists.
        codexHome = (await deps.materializeCodexHome?.()) ?? (await prepareCodexHome());
        const env: Record<string, string> = {};
        if (codexHome) env.CODEX_HOME = codexHome.path;
        // Route the agent's opencli browser/cookie commands to Render's own
        // bridge profile (injected by index.ts when the /ext bridge is up —
        // undefined when the bridge is disabled). An explicit OPENCLI_PROFILE
        // env always wins; with neither, we deliberately leave the variable
        // UNSET so opencli falls through to its defaultContextId / single-
        // connected-profile resolution instead of a literal (usually
        // disconnected) "default" context.
        const profile = process.env.OPENCLI_PROFILE ?? deps.opencliProfile;
        if (profile) env.OPENCLI_PROFILE = profile;
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
        // agent's mandated hand), the render-open/render-page shims, and the
        // canonical page-spec example — the three seeds are independent files,
        // so they install in parallel.
        await deps.sandbox.start({ env });
        const [, binDir] = await Promise.all([
          writeAgentsMd(deps.sandbox, RENDER_AGENTS_MD, env),
          installRenderOpen(deps.sandbox, env),
          installRenderPage(deps.sandbox, env),
          seedPortalExample(deps.sandbox, env),
        ]);
        if (binDir) env.PATH = `${binDir}:${process.env.PATH ?? ''}`;
        const built = buildSession(env);
        session = built;
        await built.start();
        // the user reset the conversation while we were booting — this thread
        // belongs to the OLD conversation; tear it down and let submit re-enter.
        if (genAtStart !== conversationGen) {
          if (session === built) session = null;
          await built.dispose();
          const home = codexHome;
          codexHome = null;
          if (home) await home.cleanup().catch(() => {});
          throw new Error('conversation was reset during boot');
        }
      })().catch((err) => {
        startPromise = null; // allow a retry after a failed boot
        throw err;
      });
    }
    return startPromise;
  };

  const runOpencli = async (inv: OpencliInvocation): Promise<{ turnId: string }> => {
    const turnId = `oc-${++turnSeq}`;
    // a live "running…" row appears immediately; the completed event with the
    // same item id upgrades it in place (see EventFeed's started/completed pairing).
    const command = `opencli ${inv.site} ${inv.command}`;
    liveOcTurns.set(turnId, command);
    deps.emit({ kind: 'turn_started', turnId });
    deps.emit({ kind: 'item', phase: 'started', item: { type: 'commandExecution', id: turnId, command } });
    try {
      const result = await deps.router.invoke(inv);
      // Stop was pressed while this ran — the turn is already reported
      // cancelled; drop the stale result instead of corrupting a later turn.
      if (cancelledOcTurns.delete(turnId)) return { turnId };
      liveOcTurns.delete(turnId);
      deps.emit({
        kind: 'item',
        phase: 'completed',
        item: { type: 'commandExecution', id: turnId, command, exitCode: result.ok ? 0 : 1 },
      });
      const message = opencliResultToUx(result, inv, `ux-oc-${++uxSeq}`, deps.now());
      if (message.kind === 'login') {
        const loginUrl = (message.spec as { loginUrl?: string }).loginUrl;
        pendingLogin.set(message.id, { site: inv.site, loginUrl });
      }
      deps.emit({ kind: 'ux', message });
      deps.emit({ kind: 'turn_completed', status: result.ok ? 'completed' : 'failed', turnId });
    } catch (err) {
      if (cancelledOcTurns.delete(turnId)) return { turnId };
      liveOcTurns.delete(turnId);
      // close the "running…" row too, or it spins forever
      deps.emit({
        kind: 'item',
        phase: 'completed',
        item: { type: 'commandExecution', id: turnId, command, exitCode: 1 },
      });
      deps.emit({ kind: 'error', message: errText(err) });
      deps.emit({ kind: 'turn_completed', status: 'failed', turnId });
    }
    return { turnId };
  };

  /**
   * Kick a codex turn (no echo, no /opencli parsing — submit/steer own those).
   * Synthetic boot turn: the first submit pays a multi-second sandbox+codex
   * boot — flip the panel to "working" NOW (codex's real turn_started retires
   * it, see buildSession). Any failure on this path must close the turn and
   * surface an error, or the journey dies at step 1 with zero feedback.
   */
  const startCodexTurn = async (text: string): Promise<{ turnId: string }> => {
    const bootTurnId = `boot-${++turnSeq}`;
    pendingBootTurns.add(bootTurnId);
    deps.emit({ kind: 'turn_started', turnId: bootTurnId });
    try {
      // A conversation reset mid-boot fails the OLD boot (ensureStarted's gen
      // check) — the user's message must ride the FRESH thread instead of being
      // dropped with an error, so re-enter once. Awaiting the old startPromise
      // first keeps boots serialized (never two sandbox.start races).
      for (let attempt = 0; ; attempt++) {
        const genBefore = conversationGen;
        try {
          await ensureStarted();
        } catch (err) {
          if (attempt === 0 && errText(err).includes('reset during boot')) continue;
          throw err;
        }
        if (genBefore === conversationGen) break;
        if (attempt > 0) throw new Error('conversation kept resetting during boot');
      }
      // Stop already reported this boot turn cancelled — honor it quietly.
      // (A conversation RESET is different: the boot indicator was retired but
      // the user's message still rides the fresh thread.)
      if (cancelledBootTurns.delete(bootTurnId)) return { turnId: bootTurnId };
      return await session!.submitTurn(text);
    } catch (err) {
      if (cancelledBootTurns.delete(bootTurnId)) return { turnId: bootTurnId };
      pendingBootTurns.delete(bootTurnId);
      deps.emit({ kind: 'error', message: `agent: ${errText(err)}` });
      // harmless if the reset path already closed this id — the renderer
      // ignores completions for unknown turn ids.
      deps.emit({ kind: 'turn_completed', status: 'failed', turnId: bootTurnId });
      return { turnId: bootTurnId };
    }
  };

  const submit = async (text: string): Promise<{ turnId: string }> => {
    // Optimistic echo: show the user's own message in the stream immediately,
    // before the sandbox/codex boot (otherwise the first turn shows nothing for
    // seconds). codex's own userMessage item is suppressed below to avoid a dup.
    deps.emit({ kind: 'item', phase: 'completed', item: { type: 'userMessage', text } });
    const opencli = parseOpencliCommand(text);
    if (opencli) return runOpencli(opencli);
    return startCodexTurn(text);
  };

  /**
   * Mid-run input. The renderer routes it here on its (event-derived, possibly
   * stale) busy flag — branch on the AUTHORITATIVE session state: steer the
   * live turn, and when there is none (or the steer loses the completion race /
   * codex rejects it) the text becomes a fresh turn. The user's words are never
   * silently dropped.
   */
  const steer = async (text: string): Promise<void> => {
    deps.emit({ kind: 'item', phase: 'completed', item: { type: 'userMessage', text } });
    // a /opencli command is a direct router invocation whoever types it —
    // steering it into codex as prose would just confuse the model.
    const opencli = parseOpencliCommand(text);
    if (opencli) {
      await runOpencli(opencli);
      return;
    }
    if (session?.activeTurnId) {
      try {
        await session.steer(text);
        return;
      } catch (err) {
        console.warn('[agent-runtime] steer fell back to a fresh turn:', errText(err));
      }
    }
    await startCodexTurn(text);
  };

  const cancel = async (): Promise<void> => {
    // Stop during the boot window: report each pending boot turn cancelled NOW
    // (immediate feedback) and mark it so its in-flight startCodexTurn ends
    // quietly instead of submitting.
    for (const id of [...pendingBootTurns]) {
      pendingBootTurns.delete(id);
      cancelledBootTurns.add(id);
      deps.emit({ kind: 'turn_completed', status: 'cancelled', turnId: id });
    }
    // /opencli router turns: the underlying command is bounded by the router's
    // own deadline; report the cancel immediately — close the "running…" row
    // AND the turn — and drop the late result when the invoke finally settles.
    for (const [id, command] of [...liveOcTurns]) {
      liveOcTurns.delete(id);
      cancelledOcTurns.add(id);
      deps.emit({
        kind: 'item',
        phase: 'completed',
        item: { type: 'commandExecution', id, command, exitCode: 130 },
      });
      deps.emit({ kind: 'turn_completed', status: 'cancelled', turnId: id });
    }
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
    // The steer can still lose the race with turn completion (or codex rejects
    // a steer into a review turn) — fall back to a fresh turn so the human's
    // choice is NEVER silently dropped.
    if (pendingBlock.has(id)) {
      pendingBlock.delete(id);
      const r = result as UxBlockResult;
      if (r.action === 'ux_cancel') return;
      const text = (r.action === 'ux_instruct' ? r.instruction : r.choice)?.trim();
      if (!text) return;
      if (session?.activeTurnId) {
        try {
          await session.steer(text);
        } catch {
          await submit(text);
        }
      } else await submit(text);
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
    //
    // No fabricated URLs: a slug like `xhs` is not a domain, and auto-opening a
    // guessed https://<slug>.com deep-links the user to a 404 (or worse, a
    // squatter). Without a real loginUrl, show the navigate-yourself card.
    const url = loginUrl && /^https?:\/\//i.test(loginUrl) ? loginUrl : undefined;
    if (url && deps.openTab) deps.openTab(url);
    deps.emit({
      kind: 'ux',
      message: loginOpenedUx(site, url, `ux-oc-${++uxSeq}`, deps.now()),
    });
  };

  const activeGroup = (): TabGroupInfo => conversations.current();

  const newConversation = async (): Promise<TabGroupInfo> => {
    // Tear down the current codex thread so the NEXT submit lazily starts a fresh
    // one. Bump the generation FIRST: a submit that is mid-boot detects the reset
    // and re-enters instead of driving a torn-down session, and an in-flight
    // ensureStarted disposes the thread it just built (it belongs to the old
    // conversation). Null `session` before disposing so the crash handler knows
    // this teardown is deliberate. Per-turn HITL/login state goes with it.
    conversationGen += 1;
    // retire any outstanding synthetic boot turns — their submits will fail the
    // gen check and re-enter, but the renderer's open-turn set must not be left
    // holding ids that will never complete.
    for (const boot of [...pendingBootTurns]) {
      pendingBootTurns.delete(boot);
      deps.emit({ kind: 'turn_completed', status: 'cancelled', turnId: boot });
    }
    pageFailStreak = 0;
    if (session) {
      const old = session;
      session = null;
      startPromise = null;
      await old.dispose();
      if (codexHome) {
        await codexHome.cleanup();
        codexHome = null;
      }
    }
    pendingHitl.clear();
    pendingLogin.clear();
    loginPrompted.clear();
    pendingBlock.clear();
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
    pendingBootTurns.clear();
    cancelledBootTurns.clear();
    offTabClose?.();
    pageByTab.clear();
    pages.forEach((p) => p.dispose());
    // null before disposing — the crash handler treats a still-current session's
    // exit as an unexpected death and would emit a spurious error card.
    const old = session;
    session = null;
    if (old) await old.dispose();
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

function loginOpenedUx(site: string, url: string | undefined, id: string, ts: number): UxMessage {
  return {
    id,
    kind: 'render',
    blocking: false,
    ts,
    spec: url
      ? {
          title: `Opened ${site} login in Render`,
          body: `Log in on the tab I just opened — your session stays inside Render. When you're done, send "继续" (or anything) and I'll retry with it.`,
          items: [{ title: url, url }],
        }
      : {
          title: `Log in to ${site} in Render`,
          body: `I don't know this site's login URL — open ${site} in a new tab, log in there, then send "继续" and I'll retry with your session.`,
        },
  };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Streaming-draft body: prose only. Complete fenced blocks are removed and an
 * unterminated trailing fence (a spec still being typed) is cut off — streaming
 * half-written spec JSON is exactly why answer deltas used to be suppressed.
 */
function draftAnswerBody(text: string): string {
  let t = text.replace(/```[a-z]*\n[\s\S]*?```/gi, '');
  const lastFence = t.lastIndexOf('```');
  if (lastFence >= 0) t = t.slice(0, lastFence);
  return t.trim().slice(0, 2000);
}

/** Join a completed command item's output streams (for sentinel scanning). */
function collectItemOutput(item: { aggregatedOutput?: unknown; stdout?: unknown; stderr?: unknown }): string {
  return [item.aggregatedOutput, item.stdout, item.stderr]
    .filter((p): p is string => typeof p === 'string')
    .join('\n');
}

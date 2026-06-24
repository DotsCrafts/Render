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
  Artifact,
  OpencliInvocation,
  SandboxMode,
  SandboxProvider,
  TabGroupInfo,
  UxKind,
  UxLoginResult,
  UxMessage,
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
  installRenderArtifact,
  parseRenderArtifact,
} from './agent-instructions.js';
import { answerToUxMessage } from './answer-to-ux.js';
import { detectOpencliAuthNeed } from './opencli-auth.js';
import { createConversationGroups, type ConversationGroups } from './conversation-groups.js';
import { createArtifactCapability, type ArtifactCapability } from './artifact-capability.js';

export interface AgentRuntime {
  submit(text: string): Promise<{ turnId: string }>;
  steer(text: string): Promise<void>;
  cancel(): Promise<void>;
  resolveUx(id: string, result: UxResult): Promise<void>;
  /**
   * Authorize a Tier-2 artifact's opencli read: enforce its declared allowlist +
   * (once per artifact) the human consent prompt. Called by the IPC handler that
   * serves `window.renderArtifact.opencli`. Returns whether the call may proceed.
   */
  authorizeArtifactOpencli(
    artifactId: string,
    site: string,
    command: string,
  ): Promise<{ ok: boolean; error?: string }>;
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
  /** open a URL in Render's OWN browser tab (human-hand) — the `render-open` tool */
  openTab?: (url: string) => void;
  /**
   * Open a Tier-2 artifact as an isolated, ephemeral tab (the `render-artifact`
   * tool). Wired to TabManager.createArtifact in the active conversation group.
   * Returns the tab id so the panel's reference card can activate it.
   */
  openArtifact?: (artifact: Artifact, groupId: string) => string;
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
  let session: AgentSession | null = null;
  let codexHome: CodexHome | null = null;
  let startPromise: Promise<void> | null = null;
  let turnSeq = 0;
  let uxSeq = 0;
  // Tier-2 capability gate: allowlist + per-artifact consent for opencli reads.
  const capability: ArtifactCapability = createArtifactCapability({
    emit: (message) => deps.emit({ kind: 'ux', message }),
    now: deps.now,
    nextUxId: () => `ux-cap-${++uxSeq}`,
  });
  // Per-conversation tab groups: conv-1 is the degenerate single-group case.
  // Each time a group becomes active we register it with the TabManager so its
  // label/color are known to snapshots before the bridge mints a tab into it.
  const conversations: ConversationGroups = createConversationGroups((group) => {
    deps.registerGroup?.(group);
  });

  let artifactSeq = 0;

  /**
   * Read the html the agent wrote (inside the sandbox), open it as an isolated
   * ephemeral artifact tab in the current conversation group, register its
   * opencli allowlist, then emit the kind:'artifact' event + a reference card.
   */
  const deliverArtifact = async (inv: {
    file: string;
    title?: string;
    opencli?: string[];
  }): Promise<void> => {
    let content: string;
    try {
      const res = await deps.sandbox.exec('cat', [inv.file], { cwd: deps.sandbox.workdir() });
      if (res.exitCode !== 0 || !res.stdout.trim()) {
        deps.emit({ kind: 'error', message: `render-artifact: could not read ${inv.file}` });
        return;
      }
      content = res.stdout;
    } catch (err) {
      deps.emit({ kind: 'error', message: `render-artifact: ${errText(err)}` });
      return;
    }

    const id = `art-${++artifactSeq}`;
    const title = inv.title?.trim() || 'App';
    const artifact: Artifact = {
      id,
      title,
      format: 'html',
      content,
      ...(inv.opencli && inv.opencli.length ? { opencli: inv.opencli } : {}),
    };

    // emit the artifact event (parallel to ux), register its capability allowlist,
    // then open the isolated tab in the active conversation's group.
    deps.emit({ kind: 'artifact', artifact });
    capability.register(artifact);
    const group = conversations.current();
    const tabId = deps.openArtifact?.(artifact, group.id);

    // reference card in the panel: a Tier-1 render card linking the artifact tab.
    deps.emit({
      kind: 'ux',
      message: {
        id: `ux-art-${++uxSeq}`,
        kind: 'render',
        blocking: false,
        ts: deps.now(),
        spec: {
          title: `Opened app: ${title}`,
          body: inv.opencli?.length
            ? `An interactive app is open in its own tab. It may ask to query: ${[
                ...new Set(inv.opencli.map((c) => c.split(' ')[0])),
              ].join(', ')}.`
            : 'An interactive app is open in its own tab.',
          items: [{ title, fields: { tab: tabId ?? 'opening…' } }],
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
        // `render-artifact <file> --title … [--opencli …]` → deliver a Tier-2
        // artifact: read the html the agent wrote, open an ISOLATED ephemeral tab,
        // register its opencli allowlist, and drop a reference card in the panel.
        // The shim printed a sentinel into the command's output (we read THAT, so
        // shell quoting is already collapsed).
        const artifactInv = parseRenderArtifact(collectItemOutput(event.item));
        if (artifactInv && deps.openArtifact) {
          void deliverArtifact(artifactInv);
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
            deps.emit({ kind: 'ux', message: answerToUxMessage(text, `ux-ans-${++uxSeq}`, deps.now()) });
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
        // both the render-open and render-artifact shims live in the same
        // .render-bin; install both (same dir) and prepend it to PATH once.
        const binDir = await installRenderOpen(deps.sandbox, env);
        await installRenderArtifact(deps.sandbox, env);
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
    // a Tier-2 artifact opencli-capability consent confirm? resolve it here.
    if (capability.resolveConsent(id, result)) return;
    const login = pendingLogin.get(id);
    if (login) {
      pendingLogin.delete(id);
      resolveLogin(login.site, login.loginUrl, result as UxLoginResult);
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

  const authorizeArtifactOpencli = (
    artifactId: string,
    site: string,
    command: string,
  ): Promise<{ ok: boolean; error?: string }> =>
    // Prototype mode (default): an artifact calls opencli as freely as the agent
    // itself — no allowlist, no consent. The gate (allowlist + per-artifact
    // consent) stays wired and flips back on with RENDER_ARTIFACT_GATE=1.
    process.env.RENDER_ARTIFACT_GATE === '1'
      ? capability.authorize(artifactId, site, command)
      : Promise.resolve({ ok: true });

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
    // Tier-2 artifacts are conversation-scoped (阅后即焚): drop their capability
    // grants. Their tabs are torn down by the TabManager when the user closes
    // them; we only revoke the consent state here.
    capability.forgetAll();
    // Allocate the next group; subsequent agent tabs (minted by the bridge) join
    // it. We don't open an initial tab — the active group is set for the next
    // agent action, matching the bridge's lazy mint-on-demand model.
    return conversations.next();
  };

  const dispose = async (): Promise<void> => {
    pendingHitl.clear();
    pendingLogin.clear();
    loginPrompted.clear();
    capability.forgetAll();
    if (session) await session.dispose();
    if (codexHome) await codexHome.cleanup();
  };

  return {
    submit,
    steer,
    cancel,
    resolveUx,
    authorizeArtifactOpencli,
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

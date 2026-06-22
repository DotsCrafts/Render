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
} from './agent-instructions.js';
import { answerToUxMessage } from './answer-to-ux.js';
import { detectOpencliAuthNeed } from './opencli-auth.js';

export interface AgentRuntime {
  submit(text: string): Promise<{ turnId: string }>;
  steer(text: string): Promise<void>;
  cancel(): Promise<void>;
  resolveUx(id: string, result: UxResult): Promise<void>;
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
}

interface PendingHitl {
  requestId: number | string;
  kind: UxKind;
}

export function createAgentRuntime(deps: AgentRuntimeDeps): AgentRuntime {
  // ux id → codex requestId, so resolveUx can route the human's reply back.
  const pendingHitl = new Map<string, PendingHitl>();
  // ux id → opencli site, for the needs-login → login round-trip.
  const pendingLogin = new Map<string, string>();
  // sites we've already surfaced a login card for this turn, so a retry storm
  // of AUTH_REQUIRED commands doesn't spam duplicate login surfaces.
  const loginPrompted = new Set<string>();
  let session: AgentSession | null = null;
  let codexHome: CodexHome | null = null;
  let startPromise: Promise<void> | null = null;
  let turnSeq = 0;
  let uxSeq = 0;

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
        // The agent ran opencli directly and it failed because the site needs a
        // logged-in session. opencli signals this (exit 77 / AUTH_REQUIRED) but
        // the agent just narrates it and falls back to a public source — so the
        // `login` HITL surface (which lives only on the router path) never fires.
        // Surface it here from the agent's own command stream: one card per site.
        const authNeed = detectOpencliAuthNeed(event.item);
        if (authNeed && !loginPrompted.has(authNeed.site)) {
          loginPrompted.add(authNeed.site);
          const id = `ux-login-${++uxSeq}`;
          pendingLogin.set(id, authNeed.site);
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
        // approvals then arrive over the protocol as our ux confirm/form.
        codexHome = await prepareCodexHome();
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
        const binDir = await installRenderOpen(deps.sandbox, env);
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
      if (message.kind === 'login') pendingLogin.set(message.id, inv.site);
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
    const site = pendingLogin.get(id);
    if (site) {
      pendingLogin.delete(id);
      await resolveLogin(site, result as UxLoginResult);
      return;
    }
    const hitl = pendingHitl.get(id);
    if (!hitl || !session) return; // unknown / already resolved
    pendingHitl.delete(id);
    session.resolvePending(hitl.requestId, uxResultToCodexReply(hitl.kind, result));
  };

  const resolveLogin = async (site: string, result: UxLoginResult): Promise<void> => {
    // allow a fresh login card if this site's session lapses again later
    loginPrompted.delete(site);
    if (result.action !== 'login_done') return;
    try {
      const { loggedIn, account } = await deps.router.login(site);
      deps.emit({
        kind: 'ux',
        message: loginResultUx(site, loggedIn, account, `ux-oc-${++uxSeq}`, deps.now()),
      });
    } catch (err) {
      deps.emit({ kind: 'error', message: errText(err) });
    }
  };

  const dispose = async (): Promise<void> => {
    pendingHitl.clear();
    pendingLogin.clear();
    loginPrompted.clear();
    if (session) await session.dispose();
    if (codexHome) await codexHome.cleanup();
  };

  return { submit, steer, cancel, resolveUx, dispose };
}

function loginResultUx(
  site: string,
  loggedIn: boolean,
  account: string | undefined,
  id: string,
  ts: number,
): UxMessage {
  return {
    id,
    kind: 'render',
    blocking: false,
    ts,
    spec: {
      title: loggedIn ? `Signed in to ${site}` : `${site} login not completed`,
      body: loggedIn
        ? `Session ready${account ? ` for ${account}` : ''} — re-run the command to use it.`
        : 'No active session was detected after the login attempt.',
    },
  };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

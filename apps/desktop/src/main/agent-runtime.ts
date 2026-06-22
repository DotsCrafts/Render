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
  let session: AgentSession | null = null;
  let codexHome: CodexHome | null = null;
  let startPromise: Promise<void> | null = null;
  let turnSeq = 0;
  let uxSeq = 0;

  const buildSession = (env?: Record<string, string>): AgentSession => {
    const s = new AgentSession({
      sandbox: deps.sandbox,
      approvalPolicy: deps.approvalPolicy ?? 'on-request',
      sandboxMode: deps.sandboxMode ?? 'workspace-write',
      effort: deps.effort ?? 'low',
      ...(deps.model ? { model: deps.model } : {}),
      ...(deps.logRaw ? { logRaw: true } : {}),
      ...(env ? { env } : {}),
    });
    s.onAgentEvent((event) => {
      if (event.kind === 'ux' && event.message.blocking) {
        const requestId = event.message.origin?.requestId;
        if (requestId !== undefined) {
          pendingHitl.set(event.message.id, { requestId, kind: event.message.kind });
        }
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
        session = buildSession(codexHome ? { CODEX_HOME: codexHome.path } : undefined);
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

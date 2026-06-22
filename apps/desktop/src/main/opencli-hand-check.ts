/**
 * Headless verification: does the agent now autonomously reach for opencli?
 * Mirrors the runtime wiring (AGENTS.md + network + CDP endpoint env), submits a
 * natural-language WEB query (no /opencli prefix), and reports whether codex ran
 * an `opencli` command and got real data back. Run: npx tsx src/main/opencli-hand-check.ts
 */
import { AgentSession } from '@render/agent-bridge';
import { selectSandbox } from '@render/sandbox';
import type { AgentEvent, CodexItem } from '@render/protocol';
import { RENDER_AGENTS_MD, writeAgentsMd } from './agent-instructions.js';

const TIMEOUT_MS = Number(process.env.CHECK_TIMEOUT_MS ?? 150_000);
const PROMPT =
  process.argv.slice(2).join(' ') ||
  "What are a couple of well-reviewed pour-over coffee gear picks? Use opencli to search the web, then summarize.";

async function main(): Promise<void> {
  const sandbox = selectSandbox({ prefer: process.env.E2B_API_KEY ? undefined : 'local-seatbelt' });
  const env: Record<string, string> = { OPENCLI_CDP_ENDPOINT: 'ws://127.0.0.1:0' };
  await sandbox.start({ env });
  const wrote = await writeAgentsMd(sandbox, RENDER_AGENTS_MD, env);
  console.error(`[check] AGENTS.md written: ${wrote} · workdir=${sandbox.workdir()}`);

  const session = new AgentSession({
    sandbox,
    externalSandbox: true,
    approvalPolicy: 'never', // headless: let the agent run opencli without a human gate
    sandboxMode: 'workspace-write',
    extraArgs: ['-c', 'sandbox_workspace_write.network_access=true'],
    hookFreeCodexHome: true,
    effort: 'low',
    env,
  });

  const commands: string[] = [];
  let agentText = '';
  session.onAgentEvent((e: AgentEvent) => {
    if (e.kind === 'item' && (e.item as CodexItem).type === 'commandExecution') {
      const cmd = String((e.item as CodexItem).command ?? '');
      if (e.phase === 'started') console.error(`[cmd] ${cmd}`);
      if (e.phase === 'completed') {
        commands.push(cmd);
        const out = String((e.item as CodexItem).stdout ?? '').slice(0, 200).replace(/\n/g, ' ');
        console.error(`[cmd done exit=${(e.item as CodexItem).exitCode}] ${out}`);
      }
    }
    if (e.kind === 'delta') process.stderr.write(e.text);
  });

  await session.start();
  console.error(`\n[check] prompt: ${PROMPT}\n`);
  const turn = await session.submitTurn(PROMPT);
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, TIMEOUT_MS);
    session.onAgentEvent((e) => {
      if (e.kind === 'turn_completed') { clearTimeout(t); resolve(); }
      if (e.kind === 'item' && e.phase === 'completed' && (e.item as CodexItem).type === 'agentMessage') {
        agentText = String((e.item as CodexItem).text ?? agentText);
      }
    });
  });

  const opencliCmds = commands.filter((c) => /(^|\s|\/)opencli(\s|$)/.test(c));
  const verdict = {
    turnId: turn.turnId,
    totalCommands: commands.length,
    opencliCommands: opencliCmds,
    usedOpencli: opencliCmds.length > 0,
    agentTextPreview: agentText.slice(0, 280),
  };
  console.error('\n==== VERDICT ====');
  console.log(JSON.stringify(verdict, null, 2));
  await session.dispose();
  process.exit(verdict.usedOpencli ? 0 : 2);
}

main().catch((err) => {
  console.error('check failed:', err);
  process.exit(1);
});

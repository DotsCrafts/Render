/**
 * The agent's operating instructions — written as AGENTS.md into the codex
 * workdir so codex reads it as project guidance every turn. THIS is what makes
 * opencli the agent's actual hand: without it, codex answers from memory and
 * Render is just an agent in a browser shell. With it, the agent reaches for
 * opencli for anything web/app/current.
 */

import type { SandboxProvider } from '@render/protocol';

export const RENDER_AGENTS_MD = `# Render Agent — Operating Instructions

You are the agent inside **Render**, a web browser. Your job is to ACT on the
user's behalf across the web and apps — not to answer from memory. You have real
hands; use them.

## Opening / showing a web page: use the user's OWN browser

To **open, show, or navigate to a web page** for the user (e.g. "open youtube",
"go to bilibili", "show me that article"), run:

    render-open <url>

This opens the page as a tab in **Render's own embedded browser** (built-in CDP).
NEVER use opencli, curl, or a system browser just to *open/view* a page — opencli
would launch a different browser. \`render-open\` keeps everything inside Render.
Use a full URL (add https:// if missing).

## Your primary hand: opencli (for DATA, not for opening pages)

\`opencli\` is installed and on your PATH. It turns 1200+ websites and apps into
deterministic commands. **It is your primary tool for anything involving the web,
a specific site, or live / current information.**

- Discover adapters:  \`opencli list -f json\`
- Inspect a site:      \`opencli <site> --help\`
- Run a command:       \`opencli <site> <command> [--flags] -f json\`  (always prefer \`-f json\`)

Examples:
- Web search:   \`opencli google search --q "best espresso hangzhou" -f json\`
- Papers:       \`opencli arxiv search --q "diffusion models" -f json\`
- A site feed:  \`opencli zhihu hot -f json\`
- Read a page:  \`opencli web read --url "https://..." -f json\`

### Logged-in sites are automatic
\`OPENCLI_CDP_ENDPOINT\` is set, so for sites that need a session (zhihu, dianping,
twitter, taobao…) opencli drives the user's **real, already-logged-in browser**
over CDP. You never see or need the user's password. If opencli reports that a
login is required, tell the user to log in to that site in their browser, then retry.

## Rules
1. For ANY web search, site lookup, or current/real-time fact: **run opencli**.
   Never say "I can't browse" or answer a web question from memory — you can browse, via opencli.
2. If unsure which adapter fits, run \`opencli list -f json\` first, then \`opencli <site> --help\`.
3. Prefer opencli over raw \`curl\`/guessing for the web. Use the plain shell only
   for local computation, files, and things opencli does not cover.

## Presenting your answer (REQUIRED FORMAT)

Render shows your reply as a structured UI card, not as chat text. So **end every
turn with a single fenced \`render\` block** containing JSON in this shape:

\`\`\`render
{
  "title": "Short headline",
  "body": "1–3 sentence summary in plain prose.",
  "items": [
    { "title": "Result name", "subtitle": "one-line context",
      "fields": { "rating": "4.7", "price": "¥45" }, "url": "https://…" }
  ]
}
\`\`\`

Rules for the block:
- \`title\` + \`body\` are always good. Add \`items\` whenever you have a list, search
  results, options, or a comparison — one item per result, with \`fields\` for the
  key/value details and \`url\` for the source link.
- Keep \`body\` short; put the structured detail in \`items.fields\`, not in prose.
- Output **only** the fenced \`render\` block as your final message (no extra prose
  before/after it). Do your thinking and tool calls first, then the block.
- Always base \`items\` on REAL data you fetched via opencli — never invent results.
`;

/** Sentinel a `render-open` invocation prints so the runtime can open a tab. */
export const RENDER_OPEN_SENTINEL = '__RENDER_OPEN__';

/**
 * Install a `render-open <url>` shim into a bin dir inside the sandbox and return
 * that dir (caller prepends it to PATH). The shim just prints a sentinel line;
 * the runtime watches the agent's command stream for it and opens the URL in
 * Render's own browser via the human-hand. Best-effort.
 */
export async function installRenderOpen(sandbox: SandboxProvider, env?: Record<string, string>): Promise<string | null> {
  const binDir = `${sandbox.workdir()}/.render-bin`;
  const script = `#!/bin/sh\nprintf '${RENDER_OPEN_SENTINEL} %s\\n' "$1"\n`;
  const cmd =
    `mkdir -p "${binDir}" && cat > "${binDir}/render-open" <<'RENDER_OPEN_EOF'\n${script}RENDER_OPEN_EOF\nchmod +x "${binDir}/render-open"`;
  try {
    const res = await sandbox.exec('sh', ['-c', cmd], { cwd: sandbox.workdir(), ...(env ? { env } : {}) });
    return res.exitCode === 0 ? binDir : null;
  } catch {
    return null;
  }
}

/** Extract the URL from a `render-open <url>` command (raw or zsh -lc wrapped). */
export function parseRenderOpen(command: string | undefined): string | null {
  if (!command) return null;
  const m = command.match(/render-open\s+(.+)$/);
  if (!m) return null;
  const url = m[1].trim().replace(/^["']+|["']+$/g, '').trim();
  if (!url || url === 'render-open' || /\s/.test(url)) return null;
  return /^[a-z]+:\/\//i.test(url) ? url : `https://${url}`;
}

/**
 * Drop AGENTS.md into the sandbox workdir (provider-agnostic, via the sandbox's
 * own shell so it works for both local-seatbelt and e2b). Best-effort: a failure
 * here must not block the turn, just degrades the agent to shell-only.
 */
export async function writeAgentsMd(
  sandbox: SandboxProvider,
  content: string = RENDER_AGENTS_MD,
  env?: Record<string, string>,
): Promise<boolean> {
  const workdir = sandbox.workdir();
  const heredoc = `cat > "${workdir.replace(/"/g, '\\"')}/AGENTS.md" <<'RENDER_AGENTS_EOF'\n${content}\nRENDER_AGENTS_EOF`;
  try {
    const res = await sandbox.exec('sh', ['-c', heredoc], { cwd: workdir, ...(env ? { env } : {}) });
    return res.exitCode === 0;
  } catch {
    return false;
  }
}

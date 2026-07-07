/**
 * Wrap a Node child process into the protocol `SandboxProcess` seam, so the
 * agent-bridge can drive the BRAIN identically whether it runs locally or in a
 * remote sandbox.
 *
 * Spawn failures (e.g. ENOENT for a missing codex binary) emit 'error' on the
 * ChildProcess and NEVER 'exit' — and an unlistened 'error' event throws,
 * which in the Electron main process means an uncaughtException crash dialog.
 * We therefore always listen for 'error' and fold it into the same exit
 * callback path (as exit code null, reason logged), so consumers like
 * CodexClient reject their pending requests instead of hanging forever.
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { SandboxProcess } from '@render/protocol';

export function wrapNodeProcess(child: ChildProcessWithoutNullStreams): SandboxProcess {
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  // 'error' (spawn failure, e.g. ENOENT for `codex` when a packaged app is
  // launched from Finder with the minimal system PATH) and 'exit' can BOTH
  // fire for the same child — `finished` dedupes so each exit callback runs
  // exactly once. Callbacks registered after the child already finished are
  // invoked immediately so no consumer can miss the terminal signal.
  const exitCbs: Array<(code: number | null) => void> = [];
  let finished = false;
  let finalCode: number | null = null;

  const finish = (code: number | null): void => {
    if (finished) return;
    finished = true;
    finalCode = code;
    for (const cb of exitCbs) cb(code);
  };

  child.on('error', (err) => {
    // The protocol's onExit only carries a code, so the reason (ENOENT etc.)
    // is surfaced here; the null code tells consumers "no real exit status".
    console.warn(`[render/sandbox] child process failed: ${err.message}`);
    finish(null);
  });
  child.on('exit', (code) => finish(code));

  return {
    get pid() {
      return child.pid ?? -1;
    },
    write(data: string) {
      child.stdin.write(data);
    },
    onStdout(cb: (chunk: string) => void) {
      child.stdout.on('data', cb);
    },
    onStderr(cb: (chunk: string) => void) {
      child.stderr.on('data', cb);
    },
    onExit(cb: (code: number | null) => void) {
      if (finished) {
        cb(finalCode);
        return;
      }
      exitCbs.push(cb);
    },
    kill() {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    },
  };
}

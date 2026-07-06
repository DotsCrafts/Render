/**
 * Wrap a Node child process into the protocol `SandboxProcess` seam, so the
 * agent-bridge can drive the BRAIN identically whether it runs locally or in a
 * remote sandbox.
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { SandboxProcess } from '@render/protocol';

export function wrapNodeProcess(child: ChildProcessWithoutNullStreams): SandboxProcess {
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  // spawn-time ENOENT (binary not on PATH — e.g. `codex` when a packaged app
  // is launched from Finder with the minimal system PATH) surfaces as an async
  // 'error' event; unhandled it would crash the host process and 'exit' would
  // never fire. Report it through the seam as a failed exit instead.
  const exitCbs: Array<(code: number | null) => void> = [];
  let exitFired = false;
  const fireExit = (code: number | null) => {
    if (exitFired) return;
    exitFired = true;
    for (const cb of exitCbs) cb(code);
  };
  child.on('exit', (code) => fireExit(code));
  child.on('error', (err) => {
    console.warn('[sandbox] child process error:', String(err));
    fireExit(-1);
  });
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

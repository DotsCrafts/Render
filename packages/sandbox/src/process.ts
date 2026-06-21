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
      child.on('exit', (code) => cb(code));
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

import http from 'node:http';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

const DEFAULT_DAEMON_PORT = 19825;
const OPENCLI_APP_NODE = '/Applications/OpenCLIApp.app/Contents/Resources/node_modules/node/bin/node';
const OPENCLI_APP_MAIN =
  '/Applications/OpenCLIApp.app/Contents/Resources/node_modules/@jackwener/opencli/dist/src/main.js';

export interface EnsureOpencliDaemonOptions {
  bin?: string;
  port?: number;
  timeoutMs?: number;
}

/**
 * Best-effort warmup for OpenCLIApp's node daemon.
 *
 * The managed `/usr/local/bin/opencli` shim starts the daemon lazily when a CLI
 * command runs. Render's bridge is a websocket client of that daemon, so a cold
 * app boot can otherwise race forever against ECONNREFUSED until the user runs a
 * manual `opencli doctor`. This helper performs that one bounded warmup itself.
 */
export async function ensureOpencliDaemon(
  opts: EnsureOpencliDaemonOptions = {},
): Promise<boolean> {
  const port = opts.port ?? Number(process.env.OPENCLI_DAEMON_PORT || DEFAULT_DAEMON_PORT);
  if (await isDaemonReachable(port)) return true;

  const command = resolveOpencliCommand(opts.bin);
  const timeoutMs = opts.timeoutMs ?? 15_000;
  void execFileAsync(command.bin, [...command.prefixArgs, 'doctor'], timeoutMs).catch(() => {
    // `doctor` is allowed to exit non-zero while Render's profile is not
    // connected yet. We only need it to kick OpenCLIApp's managed daemon awake.
  });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isDaemonReachable(port)) return true;
    await delay(300);
  }
  return false;
}

function isDaemonReachable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/ping',
        method: 'GET',
        timeout: 800,
      },
      (res) => {
        res.resume();
        resolve(true);
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

function resolveOpencliCommand(bin?: string): { bin: string; prefixArgs: string[] } {
  if (bin) return { bin, prefixArgs: [] };
  const envBin = process.env.OPENCLI_BIN?.trim();
  if (envBin) return { bin: envBin, prefixArgs: [] };
  if (existsSync(OPENCLI_APP_NODE) && existsSync(OPENCLI_APP_MAIN)) {
    return { bin: OPENCLI_APP_NODE, prefixArgs: [OPENCLI_APP_MAIN] };
  }
  return { bin: 'opencli', prefixArgs: [] };
}

function execFileAsync(bin: string, argv: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(bin, argv, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

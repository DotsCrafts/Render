/**
 * Codex provider + auth manager (Phase A).
 *
 * Render owns codex's model-provider config and credentials as a first-class
 * setting, instead of silently copying the user's ~/.codex. It materializes a
 * per-session, hook-free CODEX_HOME from Render-managed state:
 *   - config.toml  : model_provider + [model_providers.<name>] base_url/wire_api
 *   - auth.json    : OAuth token blob OR { OPENAI_API_KEY }
 *
 * Two auth modes (OAuth-first per product decision):
 *   - OAuth : drive `codex login` (it runs a localhost:1455 PKCE callback and,
 *             on success, writes auth.json with OpenAI OAuth tokens). We suppress
 *             its system-browser auto-open and hand the auth URL back so the
 *             caller opens it in a Render tab — "everything in Render".
 *   - API key : `codex login --with-api-key` (key piped on stdin) → auth.json.
 *
 * Secrets (the auth.json blob) are encrypted at rest via Electron safeStorage and
 * never written to the repo or logged. Provider config is plaintext JSON.
 */

import { app, safeStorage } from 'electron';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME_PREFIX = 'render-codex-home-';

/**
 * Remove stale materialized CODEX_HOMEs from prior runs. Each holds the model
 * credential in PLAINTEXT (codex needs to read it), so a hard kill that skips
 * cleanup() would otherwise leave keys on disk. Best-effort, called at startup
 * before any new home is materialized.
 */
function sweepStaleHomes(): void {
  try {
    const dir = tmpdir();
    for (const name of readdirSync(dir)) {
      if (name.startsWith(HOME_PREFIX)) {
        try {
          rmSync(join(dir, name), { recursive: true, force: true });
        } catch {
          /* in use / gone — skip */
        }
      }
    }
  } catch {
    /* tmpdir unreadable — skip */
  }
}
import { stripHookSections } from '@render/agent-bridge';
import type {
  CodexProviderConfig as ProviderConfig,
  CodexProviderStatus as ProviderStatus,
} from '@render/protocol';
import { createCodexEgressProxy, type CodexEgressProxy } from './codex-egress-proxy.js';

export type { ProviderConfig, ProviderStatus };

/** codex's built-in OpenAI provider base URL (upstream when no custom base_url). */
const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
/** placeholder key codex carries to the loopback proxy (proxy injects the real one). */
const PROXY_PLACEHOLDER_KEY = 'sk-render-egress-proxy-placeholder';

const DEFAULT_PROVIDER: ProviderConfig = {
  name: 'OpenAI',
  baseUrl: '',
  wireApi: 'responses',
  authMode: 'oauth',
};

// ── persistence ──────────────────────────────────────────────────────────────

function configDir(): string {
  const dir = join(app.getPath('userData'), 'codex');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}
const providerPath = (): string => join(configDir(), 'provider.json');
const secretPath = (): string => join(configDir(), 'auth.enc'); // safeStorage-encrypted auth.json blob

function readProvider(): ProviderConfig {
  try {
    const raw = JSON.parse(readFileSync(providerPath(), 'utf8')) as Partial<ProviderConfig>;
    return { ...DEFAULT_PROVIDER, ...raw };
  } catch {
    return { ...DEFAULT_PROVIDER };
  }
}

function writeProvider(p: ProviderConfig): void {
  writeFileSync(providerPath(), `${JSON.stringify(p, null, 2)}\n`);
}

/** Read the decrypted auth.json blob (the secret), or null if none/undecryptable. */
function readSecret(): string | null {
  try {
    if (!existsSync(secretPath())) return null;
    const enc = readFileSync(secretPath());
    if (!safeStorage.isEncryptionAvailable()) return null;
    return safeStorage.decryptString(enc);
  } catch {
    return null;
  }
}

function writeSecret(authJson: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS secure storage unavailable — cannot persist codex credentials');
  }
  writeFileSync(secretPath(), safeStorage.encryptString(authJson));
}

// ── config.toml generation ─────────────────────────────────────────────────────

/**
 * Drop `model_provider = …` + every `[model_providers.*]` section. Render OWNS
 * the provider now, so when we inherit the user's ~/.codex/config.toml we must
 * strip their old provider/base_url — otherwise an empty base_url in Render's
 * settings would silently fall back to whatever ~/.codex had (e.g. a stale
 * proxy endpoint), making the settings panel a lie.
 */
function stripProviderConfig(toml: string): string {
  const out: string[] = [];
  let inProvider = false;
  for (const line of toml.split('\n')) {
    if (/^\s*\[/.test(line)) inProvider = /^\s*\[model_providers/.test(line);
    if (inProvider) continue;
    if (/^\s*model_provider\s*=/.test(line)) continue;
    out.push(line);
  }
  return out.join('\n');
}

function configToml(p: ProviderConfig): string {
  // No custom base_url → let codex use its built-in OpenAI provider defaults.
  if (!p.baseUrl || p.baseUrl.trim() === '') return '';
  const name = p.name.trim() || 'OpenAI';
  return [
    `model_provider = "${name}"`,
    `[model_providers.${name}]`,
    `name = "${name}"`,
    `base_url = "${p.baseUrl.trim()}"`,
    `wire_api = "${p.wireApi}"`,
    '',
  ].join('\n');
}

/** Point codex at the loopback egress proxy instead of the real upstream. */
function proxyConfigToml(wireApi: string, proxyUrl: string): string {
  return [
    'model_provider = "render-proxy"',
    '[model_providers.render-proxy]',
    'name = "render-proxy"',
    `base_url = "${proxyUrl}"`,
    `wire_api = "${wireApi}"`,
    '',
  ].join('\n');
}

// ── public API ──────────────────────────────────────────────────────────────

export interface CodexProvider {
  getStatus(): ProviderStatus;
  setProvider(p: ProviderConfig): void;
  /** Store an API key (drives `codex login --with-api-key` to produce auth.json). */
  loginWithApiKey(apiKey: string): Promise<void>;
  /**
   * Drive `codex login` OAuth. `onAuthUrl` is called with the OpenAI auth URL —
   * the caller MUST open it in a Render tab (NOT system browser). Resolves once
   * codex's localhost callback completes and auth.json is written.
   */
  loginWithOAuth(onAuthUrl: (url: string) => void): Promise<void>;
  /** Sign out — drop the stored credential blob. */
  logout(): void;
  /**
   * Materialize a per-session hook-free CODEX_HOME from Render-managed config +
   * the stored credential. Returns null when no Render credential exists (caller
   * falls back to the legacy copy-from-~/.codex path).
   */
  materializeCodexHome(): Promise<{ path: string; cleanup: () => Promise<void> } | null>;
  /** Tear down the egress proxy (if any). Call on app shutdown. */
  dispose(): Promise<void>;
}

export function createCodexProvider(): CodexProvider {
  sweepStaleHomes(); // clear plaintext-key leftovers from prior runs

  // Loopback egress proxy (lazy): in API-key mode codex talks to this instead of
  // the real upstream, so the real key never lands in CODEX_HOME / the brain.
  // Set RENDER_CODEX_EGRESS_PROXY=0 to fall back to the in-CODEX_HOME key.
  const proxyEnabled = process.env.RENDER_CODEX_EGRESS_PROXY !== '0';
  let proxy: CodexEgressProxy | null = null;
  const ensureProxy = async (): Promise<CodexEgressProxy> => {
    if (!proxy) proxy = await createCodexEgressProxy();
    return proxy;
  };

  const getStatus = (): ProviderStatus => {
    const provider = readProvider();
    const secret = readSecret();
    if (!secret) return { provider, authed: false, authKind: null, hint: '' };
    try {
      const blob = JSON.parse(secret) as { OPENAI_API_KEY?: string; tokens?: unknown };
      if (blob.tokens) return { provider, authed: true, authKind: 'oauth', hint: 'ChatGPT' };
      if (blob.OPENAI_API_KEY) {
        const k = blob.OPENAI_API_KEY;
        const hint = k.length > 10 ? `${k.slice(0, 5)}…${k.slice(-4)}` : '••••';
        return { provider, authed: true, authKind: 'apikey', hint };
      }
    } catch {
      /* corrupt blob → treat as unauthed */
    }
    return { provider, authed: false, authKind: null, hint: '' };
  };

  const setProvider = (p: ProviderConfig): void => writeProvider(p);
  const logout = (): void => {
    try {
      if (existsSync(secretPath())) rm(secretPath(), { force: true });
    } catch {
      /* best effort */
    }
  };

  /** Run `codex login [...]` against a scratch home; capture auth.json on success. */
  const runCodexLogin = (args: string[], hooks: {
    stdin?: string;
    onLine?: (line: string) => void;
  }): Promise<string> =>
    new Promise((resolve, reject) => {
      void mkdtemp(join(tmpdir(), 'render-codex-login-')).then((scratch) => {
        const env: Record<string, string> = {
          ...(process.env as Record<string, string>),
          CODEX_HOME: scratch,
          // Suppress codex's system-browser auto-open — we route the URL into a
          // Render tab ourselves. A no-op BROWSER keeps Plane-2 inside Render.
          BROWSER: '/usr/bin/true',
        };
        const child = spawn('codex', ['login', ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
        let buf = '';
        const onChunk = (d: Buffer): void => {
          buf += d.toString();
          let nl: number;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            hooks.onLine?.(line);
          }
        };
        child.stdout.on('data', onChunk);
        child.stderr.on('data', onChunk);
        if (hooks.stdin !== undefined) {
          child.stdin.write(hooks.stdin);
          child.stdin.end();
        }
        child.on('error', reject);
        child.on('close', async (code) => {
          if (code !== 0) {
            await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
            reject(new Error(`codex login exited ${code}`));
            return;
          }
          try {
            const authJson = await readFile(join(scratch, 'auth.json'), 'utf8');
            writeSecret(authJson);
            resolve(authJson);
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          } finally {
            await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
          }
        });
      }, reject);
    });

  const loginWithApiKey = async (apiKey: string): Promise<void> => {
    const key = apiKey.trim();
    if (!key) throw new Error('empty API key');
    await runCodexLogin(['--with-api-key'], { stdin: key });
  };

  const loginWithOAuth = async (onAuthUrl: (url: string) => void): Promise<void> => {
    let urlSent = false;
    await runCodexLogin([], {
      onLine: (line) => {
        // codex prints: "navigate to this URL to authenticate:" then the URL line.
        const m = line.match(/https:\/\/auth\.openai\.com\/oauth\/authorize\?\S+/);
        if (m && !urlSent) {
          urlSent = true;
          onAuthUrl(m[0]);
        }
      },
    });
  };

  const materializeCodexHome = async (): Promise<{ path: string; cleanup: () => Promise<void> } | null> => {
    const secret = readSecret();
    if (!secret) return null; // no Render credential → caller uses legacy path
    const provider = readProvider();
    const path = await mkdtemp(join(tmpdir(), HOME_PREFIX));

    // The stored auth blob decides the mode: { OPENAI_API_KEY } vs { tokens }.
    let realKey = '';
    try {
      const blob = JSON.parse(secret) as { OPENAI_API_KEY?: string };
      if (typeof blob.OPENAI_API_KEY === 'string') realKey = blob.OPENAI_API_KEY;
    } catch {
      /* not JSON → treat as opaque, written verbatim below */
    }

    let providerToml: string;
    let authJson: string;
    if (realKey && proxyEnabled) {
      // API-KEY MODE → route codex through the loopback egress proxy. The real
      // key stays in main-process memory; codex's CODEX_HOME gets a placeholder
      // and a base_url pointing at 127.0.0.1, so the brain never sees the key.
      const upstream = provider.baseUrl?.trim() || OPENAI_DEFAULT_BASE_URL;
      const p = await ensureProxy();
      p.setTarget({ upstream, bearer: realKey });
      providerToml = proxyConfigToml(provider.wireApi, p.url);
      authJson = JSON.stringify({ OPENAI_API_KEY: PROXY_PLACEHOLDER_KEY });
    } else {
      // OAuth (codex refreshes its own tokens) or proxy disabled → codex's own auth.
      providerToml = configToml(provider);
      authJson = secret;
    }

    // 0600: even the placeholder/auth blob is owner-only.
    await writeFile(join(path, 'auth.json'), authJson, { mode: 0o600 });
    // Inherit the user's non-hook, non-provider settings (Render owns the provider).
    let base = '';
    try {
      const raw = await readFile(join(homedir(), '.codex', 'config.toml'), 'utf8');
      base = stripProviderConfig(stripHookSections(raw));
    } catch {
      /* none — fine */
    }
    const merged = providerToml ? `${providerToml}\n${base}` : base;
    if (merged.trim()) await writeFile(join(path, 'config.toml'), merged);
    return {
      path,
      cleanup: () => rm(path, { recursive: true, force: true }).catch(() => undefined),
    };
  };

  const dispose = async (): Promise<void> => {
    if (proxy) {
      await proxy.dispose();
      proxy = null;
    }
  };

  return { getStatus, setProvider, loginWithApiKey, loginWithOAuth, logout, materializeCodexHome, dispose };
}

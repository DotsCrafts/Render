/**
 * Codex provider/auth settings (Phase A) — OAuth-first.
 *
 * Untrusted display: talks only to the main process over window.render.codex*.
 * "Sign in with ChatGPT" drives `codex login` in main; the auth page opens in a
 * Render tab (not the system browser). API key + base-url cover custom/proxy
 * providers (e.g. your api.ai.ifunk.cn). Credentials live in main's safeStorage.
 */
import { useEffect, useState, type ReactElement } from 'react';
import type { CodexProviderStatus, CodexWireApi } from '@render/protocol';

export function CodexSettings({ onClose }: { onClose: () => void }): ReactElement {
  const [status, setStatus] = useState<CodexProviderStatus | null>(null);
  const [name, setName] = useState('OpenAI');
  const [baseUrl, setBaseUrl] = useState('');
  const [wireApi, setWireApi] = useState<CodexWireApi>('responses');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const apply = (s: CodexProviderStatus): void => {
    setStatus(s);
    setName(s.provider.name);
    setBaseUrl(s.provider.baseUrl ?? '');
    setWireApi(s.provider.wireApi);
  };

  useEffect(() => {
    void window.render.codexStatus().then(apply);
  }, []);

  const run = async (label: string, fn: () => Promise<CodexProviderStatus>): Promise<void> => {
    setErr(null);
    setBusy(label);
    try {
      apply(await fn());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const authMode = status?.provider.authMode ?? 'oauth';

  return (
    <div className="cx-overlay" onClick={onClose}>
      <div className="cx-panel" onClick={(e) => e.stopPropagation()}>
        <div className="cx-head">
          <h3>Codex 设置</h3>
          <button className="cx-x" onClick={onClose} aria-label="close">×</button>
        </div>

        <div className="cx-status">
          {status?.authed ? (
            <span className="cx-ok">● 已登录 · {status.authKind === 'oauth' ? 'ChatGPT' : 'API Key'} · {status.hint}</span>
          ) : (
            <span className="cx-off">○ 未登录</span>
          )}
        </div>

        {err ? <div className="cx-err">{err}</div> : null}

        {/* ── Auth (OAuth-first) ── */}
        <div className="cx-section">
          <button
            className="cx-primary"
            disabled={!!busy}
            onClick={() => void run('oauth', () => window.render.codexLoginOAuth())}
          >
            {busy === 'oauth' ? '已在 Render 标签打开登录页 — 完成后自动返回…' : 'Sign in with ChatGPT'}
          </button>
          <p className="cx-hint">OAuth 登录页会在 Render 自己的标签里打开,登录态留本机,不进沙箱。</p>

          <div className="cx-or">或用 API Key</div>
          <div className="cx-row">
            <input
              type="password"
              placeholder="sk-…(自定义 base_url 的密钥)"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
            <button
              disabled={!!busy || !apiKey.trim()}
              onClick={() => void run('apikey', () => window.render.codexLoginApiKey(apiKey).then((s) => { setApiKey(''); return s; }))}
            >
              {busy === 'apikey' ? '保存中…' : '保存 Key'}
            </button>
          </div>
        </div>

        {/* ── Provider (base_url) ── */}
        <div className="cx-section">
          <label className="cx-label">Provider</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="OpenAI" />
          <label className="cx-label">Base URL <span className="cx-dim">(留空 = OpenAI 默认)</span></label>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.ai.ifunk.cn" />
          <label className="cx-label">wire_api</label>
          <select value={wireApi} onChange={(e) => setWireApi(e.target.value as CodexWireApi)}>
            <option value="responses">responses</option>
            <option value="chat">chat</option>
          </select>
          <button
            className="cx-save"
            disabled={!!busy}
            onClick={() => void run('provider', () => window.render.codexSetProvider({ name, baseUrl, wireApi, authMode }))}
          >
            {busy === 'provider' ? '保存中…' : '保存 Provider'}
          </button>
        </div>

        {status?.authed ? (
          <button className="cx-logout" disabled={!!busy} onClick={() => void run('logout', () => window.render.codexLogout())}>
            退出登录
          </button>
        ) : null}
      </div>
    </div>
  );
}

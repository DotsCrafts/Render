/**
 * wait-download — mirrors the extension's `handleWaitDownload` result shape
 * (decoded from `background.js` lines 196-273). The extension watches
 * `chrome.downloads`; Electron has no `chrome.downloads`, so we drive it over
 * the CDP Browser/Page download domain on the lease's own target:
 *
 *   • `Browser.setDownloadBehavior { behavior:'allowAndName', eventsEnabled:true,
 *      downloadPath }` — route downloads to a known dir AND emit progress events.
 *   • `Page.downloadWillBegin { guid, url, suggestedFilename }` — a download
 *      started; we match it against the caller's substring pattern.
 *   • `Page.downloadProgress { guid, totalBytes, receivedBytes, state }` —
 *      resolves when state hits `completed` (or `canceled`).
 *
 * The result object matches the extension's `downloadResult` field-for-field so
 * opencli's `waitForDownload` consumer reads it unchanged. NOT page-scoped (the
 * extension's handler carries no `page`).
 *
 * The download host (set behavior + final on-disk path resolution) is injected
 * so this stays Electron-free and unit-testable.
 */

import type { CdpTarget } from './types.js';

/** The extension's `downloadResult` wire shape (field-for-field). */
export interface DownloadResult {
  downloaded: boolean;
  id: number;
  filename: string;
  url: string;
  finalUrl: string;
  mime: string;
  totalBytes: number;
  state: string;
  danger: string;
  error: string;
  elapsedMs: number;
}

export interface WaitDownloadDeps {
  /** Directory CDP routes downloads into; the host ensures it exists. */
  downloadPath: string;
  /** Resolve the final on-disk path for a completed download's guid+filename
   *  (Electron `will-download`/`item.getSavePath()` or `<downloadPath>/<name>`). */
  resolveSavePath?: (guid: string, suggestedFilename: string) => string;
  /** Best-effort byte size of the finished file at `path` (for totalBytes when
   *  CDP omits it). */
  fileSize?: (path: string) => number;
}

interface DownloadWillBegin {
  guid: string;
  url?: string;
  suggestedFilename?: string;
}
interface DownloadProgress {
  guid: string;
  totalBytes?: number;
  receivedBytes?: number;
  state?: string; // 'inProgress' | 'completed' | 'canceled'
}

const substringMatch = (haystack: string, pattern: string): boolean =>
  pattern === '' || haystack.toLowerCase().includes(pattern.toLowerCase());

const timeoutResult = (elapsedMs: number, error: string): DownloadResult => ({
  downloaded: false,
  id: 0,
  filename: '',
  url: '',
  finalUrl: '',
  mime: '',
  totalBytes: 0,
  state: 'interrupted',
  danger: '',
  error,
  elapsedMs,
});

/**
 * Wait for a download matching `pattern` (substring over filename|url) to finish,
 * bounded by `timeoutMs`. Returns the extension's `downloadResult` shape.
 */
export async function waitForDownload(
  target: CdpTarget,
  deps: WaitDownloadDeps,
  pattern = '',
  timeoutMs = 30_000,
): Promise<DownloadResult> {
  const startedAt = Date.now();
  const resolveSavePath =
    deps.resolveSavePath ?? ((_g, name) => `${deps.downloadPath}/${name}`);

  // Route + name downloads, and turn on the progress events we await on.
  await target.send('Browser.setDownloadBehavior', {
    behavior: 'allowAndName',
    downloadPath: deps.downloadPath,
    eventsEnabled: true,
  });
  await target.send('Page.enable', {}).catch(() => {});

  return new Promise<DownloadResult>((resolve) => {
    let settled = false;
    // guid → the begin info, so a progress event can recover url/filename.
    const begun = new Map<string, DownloadWillBegin>();
    let matchedGuid: string | null = null;

    const finish = (result: DownloadResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      offBegin();
      offProgress();
      resolve(result);
    };

    const onBegin = (params: unknown): void => {
      const p = params as DownloadWillBegin;
      const name = p.suggestedFilename ?? '';
      const url = p.url ?? '';
      begun.set(p.guid, p);
      // Lock onto the first download that matches the pattern.
      if (matchedGuid === null && (substringMatch(name, pattern) || substringMatch(url, pattern))) {
        matchedGuid = p.guid;
      }
    };

    const onProgress = (params: unknown): void => {
      const p = params as DownloadProgress;
      if (matchedGuid === null || p.guid !== matchedGuid) return;
      if (p.state === 'completed' || p.state === 'canceled') {
        const begin = begun.get(p.guid);
        const filename = begin?.suggestedFilename ?? '';
        const savePath = resolveSavePath(p.guid, filename);
        const total =
          typeof p.totalBytes === 'number' && p.totalBytes > 0
            ? p.totalBytes
            : (deps.fileSize?.(savePath) ?? 0);
        finish({
          downloaded: p.state === 'completed',
          id: 0,
          filename: savePath,
          url: begin?.url ?? '',
          finalUrl: begin?.url ?? '',
          mime: '',
          totalBytes: total,
          state: p.state === 'completed' ? 'complete' : 'interrupted',
          danger: '',
          error: p.state === 'completed' ? '' : 'download canceled',
          elapsedMs: Date.now() - startedAt,
        });
      }
    };

    const offBegin = target.on('Page.downloadWillBegin', onBegin);
    const offProgress = target.on('Page.downloadProgress', onProgress);
    const timer = setTimeout(
      () => finish(timeoutResult(Date.now() - startedAt, `wait-download timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
}

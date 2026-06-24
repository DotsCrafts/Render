/**
 * Artifact-preload — the ONLY bridge for a Tier-2 artifact page.
 *
 * Loaded exclusively into isolated `artifact:<id>` tabs (never normal browsing
 * tabs, never the chrome renderer). It exposes a SINGLE narrow capability:
 *
 *     window.renderArtifact.opencli(site, command, args) → { ok, data?, error? }
 *
 * The artifact id is baked in from the preload's process args (set by the
 * TabManager at mint time) so a page can't spoof which artifact it is — the main
 * handler keys allowlist + consent off this trusted id, not anything the page
 * sends. Everything else (the user's session, the agent, codex, CDP) stays
 * unreachable: the page has no network (CSP) and no other bridge.
 */

import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC,
  type ArtifactOpencliResult,
  type RenderArtifactApi,
} from '@render/protocol';

const ARTIFACT_ID =
  process.argv.find((a) => a.startsWith('--render-artifact-id='))?.slice('--render-artifact-id='.length) ?? '';

const api: RenderArtifactApi = {
  artifactId: ARTIFACT_ID,
  opencli: (site, command, args) =>
    ipcRenderer.invoke(IPC.artifactOpencli, {
      artifactId: ARTIFACT_ID,
      site,
      command,
      ...(args ? { args } : {}),
    }) as Promise<ArtifactOpencliResult>,
};

contextBridge.exposeInMainWorld('renderArtifact', api);

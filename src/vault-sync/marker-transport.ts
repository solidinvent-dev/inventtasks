/**
 * Transport wrapper that scans every server response for workspace marker
 * files (_workspace.md / _workspace-state.md) and registers their directories
 * as detected task-workspace roots BEFORE the engine filters the batch. This
 * is what keeps a task workspace out of vault sync even when it was uploaded
 * by an older/misconfigured device, or when THIS device's data.json does not
 * list that root (per-device settings can differ). Pure — no Obsidian imports.
 */

import type { SyncTransport } from "../sync/engine";

export class MarkerScanTransport implements SyncTransport {
  constructor(
    private readonly inner: SyncTransport,
    private readonly registerRoots: (paths: Iterable<string>) => void,
  ) {}

  async changes(since: number): ReturnType<SyncTransport["changes"]> {
    const res = await this.inner.changes(since);
    this.registerRoots(res.files.map((f) => f.path));
    return res;
  }

  async snapshot(): ReturnType<SyncTransport["snapshot"]> {
    const lines = await this.inner.snapshot();
    this.registerRoots(lines.filter((l) => l.type === "file").map((l) => (l as { path: string }).path));
    return lines;
  }

  push: SyncTransport["push"] = (req) => this.inner.push(req);
  uploadBlob: SyncTransport["uploadBlob"] = (h, d) => this.inner.uploadBlob(h, d);
  downloadBlob: SyncTransport["downloadBlob"] = (h) => this.inner.downloadBlob(h);
  stashVersion: SyncTransport["stashVersion"] = (req) => this.inner.stashVersion(req);
}

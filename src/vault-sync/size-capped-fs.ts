/**
 * SyncFs wrapper enforcing the Vault Sync maxFileMB limit on files the server
 * has NOT seen yet. Files already in the manifest keep syncing even if they
 * grow past the limit — hiding them would read as a local delete and
 * tombstone them remotely. Pure (no Obsidian imports), unit-testable.
 */

import type { FsEntry, SyncFs } from "../sync/engine";

export class SizeCappedFs implements SyncFs {
  /** Files skipped by the cap during the last full list(). */
  skippedLarge = 0;

  constructor(
    private readonly inner: SyncFs,
    /** Live limit in bytes; 0 = no limit. */
    private readonly maxBytes: () => number,
    private readonly inManifest: (path: string) => boolean,
  ) {}

  private skip(path: string, size: number): boolean {
    const max = this.maxBytes();
    return max > 0 && size > max && !this.inManifest(path);
  }

  async list(): Promise<FsEntry[]> {
    const entries = await this.inner.list();
    const kept: FsEntry[] = [];
    let skipped = 0;
    for (const e of entries) {
      if (this.skip(e.path, e.size)) skipped++;
      else kept.push(e);
    }
    this.skippedLarge = skipped;
    return kept;
  }

  async stat(path: string): Promise<{ mtime: number; size: number } | null> {
    const st = await this.inner.stat(path);
    return st && this.skip(path, st.size) ? null : st;
  }

  readBinary(path: string): Promise<ArrayBuffer> { return this.inner.readBinary(path); }
  writeBinary(path: string, data: ArrayBuffer): Promise<void> { return this.inner.writeBinary(path, data); }
  remove(path: string): Promise<void> { return this.inner.remove(path); }
}

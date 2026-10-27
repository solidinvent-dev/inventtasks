/**
 * VaultSyncFs — SyncFs over the Obsidian vault, scoped to one workspace root.
 * Paths in/out are RELATIVE to that root.
 *
 * Listing strategy: vault.getFiles() covers every indexed file with in-memory
 * stats (fast), but Obsidian does not index dot-paths — and the plugin keeps
 * view configs in `.views/`. So we additionally walk folders via the adapter,
 * stat-ing only dot-files/dot-dirs (cheap: folder counts are small).
 *
 * Writes prefer the vault API (fires events synchronously → WorkspaceIndex
 * re-scans incrementally); hidden paths fall back to the adapter, which the
 * index reads directly during scans anyway.
 *
 * Empty folders sync as zero-byte `.inventtasks-folder` markers (see
 * shared/protocol.ts): list() synthesizes one per leaf-empty folder (mtime 0,
 * size 0 — stable, so scans never read them as dirty), writes materialize the
 * FOLDER only (the marker never exists on disk), and removing a marker deletes
 * the folder only while it is still empty. A folder gaining content simply
 * stops synthesizing its marker — the engine tombstones it on the next scan.
 */

import { App, TFile, TFolder, normalizePath } from "obsidian";
import { FOLDER_MARKER_NAME, folderOfMarkerPath, isFolderMarkerPath } from "../../shared/protocol";
import type { FsEntry, SyncFs } from "./engine";

/**
 * Optional walk exclusions over VAULT-ABSOLUTE paths. When set they replace
 * the built-in whole-vault exclusions (configDir/.trash/.git), so the walker
 * can descend into normally-hidden trees (Vault Sync's .obsidian toggles)
 * while still pruning excluded subtrees during the walk instead of filtering
 * afterwards. Omitted → original behavior (task sync unchanged).
 */
export interface WalkExclusions {
  /** Exact per-file exclusion (also filters the indexed listing). */
  file(absPath: string): boolean;
  /** Prune: return true only when NOTHING under this directory can be included. */
  dir(absPath: string): boolean;
}

export class VaultSyncFs implements SyncFs {
  private readonly app: App;
  /** Normalized root; "/" = whole vault. */
  private readonly root: string;
  private readonly configDir: string;
  private readonly exclusions?: WalkExclusions;

  constructor(app: App, root: string, exclusions?: WalkExclusions) {
    this.app = app;
    const r = (root || "").trim();
    this.root = !r || r === "/" ? "/" : normalizePath(r);
    this.configDir = (app.vault as any).configDir || ".obsidian";
    this.exclusions = exclusions;
  }

  private abs(rel: string): string {
    return this.root === "/" ? rel : `${this.root}/${rel}`;
  }

  private relOf(abs: string): string | null {
    if (this.root === "/") return abs;
    const prefix = `${this.root}/`;
    return abs.startsWith(prefix) ? abs.slice(prefix.length) : null;
  }

  /** Top-level dirs that must never sync when the root is the whole vault. */
  private isExcludedDir(absPath: string): boolean {
    if (this.exclusions) return this.exclusions.dir(absPath);
    if (this.root !== "/") return false;
    return absPath === this.configDir || absPath === ".trash" || absPath === ".git";
  }

  private isExcludedFile(absPath: string): boolean {
    return this.exclusions?.file(absPath) ?? false;
  }

  async list(): Promise<FsEntry[]> {
    const out = new Map<string, FsEntry>();
    const prefix = this.root === "/" ? "" : `${this.root}/`;
    for (const f of this.app.vault.getFiles()) {
      if (prefix && !f.path.startsWith(prefix)) continue;
      if (this.isExcludedFile(f.path)) continue;
      const rel = prefix ? f.path.slice(prefix.length) : f.path;
      out.set(rel, { path: rel, mtime: f.stat.mtime, size: f.stat.size });
    }
    try {
      await this.walkForHidden(this.root === "/" ? "/" : this.root, out);
    } catch {
      // Adapter walk is an enhancement for dot-paths; the indexed listing stands.
    }
    this.addFolderMarkers(out);
    return [...out.values()];
  }

  /** Synthesize a marker entry per leaf-empty folder under the root (skipping
   *  hidden/dot folders — those are config-ish and never shown in Obsidian). */
  private addFolderMarkers(out: Map<string, FsEntry>): void {
    const loaded = (this.app.vault as any).getAllLoadedFiles?.() as unknown[] | undefined;
    if (!loaded) return;
    for (const af of loaded) {
      if (!(af instanceof TFolder) || af.children.length > 0) continue;
      const abs = af.path;
      if (!abs || abs === "/" || this.isHiddenPath(abs)) continue;
      const rel = this.relOf(abs);
      if (rel === null || rel === "") continue;
      const marker = `${rel}/${FOLDER_MARKER_NAME}`;
      if (this.isExcludedDir(abs) || this.isExcludedFile(this.abs(marker))) continue;
      if (!out.has(marker)) out.set(marker, { path: marker, mtime: 0, size: 0 });
    }
  }

  /** The vault-absolute folder a marker path stands for, or null off-root. */
  private markerFolderAbs(rel: string): string | null {
    const folderRel = folderOfMarkerPath(rel);
    return folderRel ? this.abs(folderRel) : null;
  }

  /** Visit every folder; collect dot-files; fully walk dot-folders. */
  private async walkForHidden(dir: string, out: Map<string, FsEntry>): Promise<void> {
    const listing = await this.app.vault.adapter.list(dir);
    for (const file of listing.files) {
      const base = file.split("/").pop() || "";
      if (!base.startsWith(".")) continue;
      await this.statInto(file, out);
    }
    for (const folder of listing.folders) {
      if (this.isExcludedDir(folder)) continue;
      const base = folder.split("/").pop() || "";
      if (base.startsWith(".")) await this.walkAll(folder, out);
      else await this.walkForHidden(folder, out);
    }
  }

  /** Everything under a dot-folder is invisible to vault.getFiles(). */
  private async walkAll(dir: string, out: Map<string, FsEntry>): Promise<void> {
    const listing = await this.app.vault.adapter.list(dir);
    for (const file of listing.files) await this.statInto(file, out);
    for (const folder of listing.folders) {
      if (!this.isExcludedDir(folder)) await this.walkAll(folder, out);
    }
  }

  private async statInto(absFile: string, out: Map<string, FsEntry>): Promise<void> {
    if (this.isExcludedFile(absFile)) return;
    const rel = this.relOf(absFile);
    if (rel === null || out.has(rel)) return;
    const st = await this.app.vault.adapter.stat(absFile);
    if (st && st.type === "file") out.set(rel, { path: rel, mtime: st.mtime, size: st.size });
  }

  async stat(rel: string): Promise<{ mtime: number; size: number } | null> {
    if (isFolderMarkerPath(rel)) {
      const abs = this.markerFolderAbs(rel);
      const af = abs ? this.app.vault.getAbstractFileByPath(abs) : null;
      // A marker "exists" exactly while its folder is still leaf-empty.
      return af instanceof TFolder && af.children.length === 0 ? { mtime: 0, size: 0 } : null;
    }
    try {
      const st = await this.app.vault.adapter.stat(this.abs(rel));
      return st && st.type === "file" ? { mtime: st.mtime, size: st.size } : null;
    } catch {
      return null;
    }
  }

  async readBinary(rel: string): Promise<ArrayBuffer> {
    if (isFolderMarkerPath(rel)) return new ArrayBuffer(0);
    return this.app.vault.adapter.readBinary(this.abs(rel));
  }

  async writeBinary(rel: string, data: ArrayBuffer): Promise<void> {
    if (isFolderMarkerPath(rel)) {
      // Applying a marker materializes the FOLDER; the file itself never
      // touches disk (list() keeps synthesizing it while the folder is empty).
      const folderAbs = this.markerFolderAbs(rel);
      if (folderAbs && !(await this.app.vault.adapter.exists(folderAbs))) {
        try {
          await this.app.vault.createFolder(folderAbs); // fires events → UI/index update
        } catch {
          await this.app.vault.adapter.mkdir(folderAbs);
        }
      }
      return;
    }
    const abs = this.abs(rel);
    const slash = abs.lastIndexOf("/");
    if (slash > 0) {
      const parent = abs.slice(0, slash);
      if (!(await this.app.vault.adapter.exists(parent))) {
        await this.app.vault.adapter.mkdir(parent); // recursive + event-quiet; vault reconciles
      }
    }
    const existing = this.app.vault.getAbstractFileByPath(abs);
    if (existing instanceof TFile) {
      await (this.app.vault as any).modifyBinary(existing, data);
      return;
    }
    if (this.isHiddenPath(abs)) {
      await this.app.vault.adapter.writeBinary(abs, data);
      return;
    }
    try {
      await (this.app.vault as any).createBinary(abs, data);
    } catch {
      // Race (created meanwhile) or API refusal — the adapter always works.
      await this.app.vault.adapter.writeBinary(abs, data);
    }
  }

  async remove(rel: string): Promise<void> {
    if (isFolderMarkerPath(rel)) {
      // A marker tombstone means either "folder deleted elsewhere" (folder is
      // still empty here → delete it too) or "folder gained content" (its
      // marker got cleaned up → the folder must stay).
      const folderAbs = this.markerFolderAbs(rel);
      const af = folderAbs ? this.app.vault.getAbstractFileByPath(folderAbs) : null;
      if (af instanceof TFolder && af.children.length === 0) {
        await this.app.vault.trash(af, false);
        await this.pruneEmptyAncestors(folderAbs!);
      }
      return;
    }
    const abs = this.abs(rel);
    const existing = this.app.vault.getAbstractFileByPath(abs);
    if (existing instanceof TFile) {
      // Vault trash (.trash/) — restorable, and .trash never syncs.
      await this.app.vault.trash(existing, false);
    } else if (await this.app.vault.adapter.exists(abs)) {
      await this.app.vault.adapter.remove(abs);
    }
    // Obsidian leaves the now-empty parent folder on disk. A folder that held
    // the file we just deleted never had a marker (markers exist only for
    // EMPTY folders), so an emptied parent is residue from a move/rename and
    // must go — otherwise marker synthesis would re-adopt it and push a phantom
    // empty folder back to the server. If the server actually wants the folder
    // kept empty, its marker's writeBinary re-creates it.
    await this.pruneEmptyAncestors(abs);
  }

  /** Trash empty ancestor folders of `abs`, upward, stopping at the workspace
   *  root, the first non-empty folder, or any hidden/excluded folder. */
  private async pruneEmptyAncestors(abs: string): Promise<void> {
    const boundary = this.root === "/" ? "" : this.root;
    let dir = abs.includes("/") ? abs.slice(0, abs.lastIndexOf("/")) : "";
    while (dir && dir !== boundary) {
      if (this.isHiddenPath(dir) || this.isExcludedDir(dir)) return;
      const af = this.app.vault.getAbstractFileByPath(dir);
      if (!(af instanceof TFolder) || af.children.length > 0) return;
      await this.app.vault.trash(af, false);
      dir = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
    }
  }

  private isHiddenPath(abs: string): boolean {
    return abs.split("/").some((seg) => seg.startsWith("."));
  }
}

/**
 * SyncEngine — the pure sync cycle for ONE workspace:
 *
 *   pull (changes since cursor) → apply to disk → push local diff → save state
 *
 * Local-first: the vault stays the source of truth; this engine only ferries
 * bytes. It is deliberately free of Obsidian imports — `SyncFs` and
 * `SyncTransport` abstract the vault and the server, so the whole conflict /
 * bootstrap / guard logic is unit-testable and reusable by the web app.
 *
 * The manifest (see types.ts) is the base of a 3-way diff:
 *   dirty(path)        = disk differs from manifest (hash, mtime+size as fast path)
 *   remote-changed     = server entry.rev > manifest.rev
 *   echo of own write  = disk equals manifest → never re-pushed
 *
 * Conflict policy (single user, multiple devices): per-file last-writer-wins
 * by mtime, hash as the deterministic tie-break. The losing content is always
 * stashed into the server's version history first — nothing is ever lost.
 * `_workspace-state.md` is special: remote content is applied and the plugin's
 * own merge machinery re-merges and re-pushes (never LWW — see workspace-state.ts).
 */

import {
  DEFAULT_INLINE_MAX_BYTES, WORKSPACE_STATE_FILE,
  type ChangeEntry, type ChangesResponse, type PushItem, type PushItemResult,
  type PushRequest, type PushResponse, type SnapshotLine, type StashVersionRequest,
} from "../../shared/protocol";
import { emptySummary, type SyncRunSummary, type SyncManifestEntry, type SyncStateFile } from "./types";
import { b64decode, b64encode, sha256Hex } from "./util";

// ---------------------------------------------------------------------------
// Abstractions
// ---------------------------------------------------------------------------

export interface FsEntry { path: string; mtime: number; size: number }

/** Vault subtree IO, paths relative to the workspace root. */
export interface SyncFs {
  list(): Promise<FsEntry[]>;
  stat(path: string): Promise<{ mtime: number; size: number } | null>;
  readBinary(path: string): Promise<ArrayBuffer>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  /** Should prefer trash over hard delete where the platform allows. */
  remove(path: string): Promise<void>;
}

export interface SyncTransport {
  changes(since: number): Promise<ChangesResponse>;
  push(req: PushRequest): Promise<PushResponse>;
  snapshot(): Promise<SnapshotLine[]>;
  uploadBlob(hash: string, data: ArrayBuffer): Promise<void>;
  downloadBlob(hash: string): Promise<ArrayBuffer>;
  stashVersion(req: StashVersionRequest): Promise<void>;
}

export interface SyncEngineOptions {
  fs: SyncFs;
  transport: SyncTransport;
  state: SyncStateFile;
  saveState: () => Promise<void>;
  /** Live settings reads (the user can toggle while the engine exists). */
  conflictCopies: () => boolean;
  /** Paths handled by app-level merge instead of LWW (workspace state file). */
  isMergeFile?: (path: string) => boolean;
  /** Paths to ignore entirely (configDir/.trash when root is the whole vault). */
  exclude?: (path: string) => boolean;
  /**
   * Mass-delete guard: called before applying a remote change set that would
   * delete a large share of local files. Three-way decision:
   *  - "apply":         delete locally too (accept the remote deletions),
   *  - "restoreServer": UNDO the deletion — keep the local files and re-push
   *                     them to the server as new revisions (other devices
   *                     then pull them back),
   *  - "cancel":        block the run (cursor NOT advanced; re-prompts later).
   * Omitted callback → "cancel" (headless safety).
   */
  confirmMassDeletion?: (deletions: number, total: number, paths?: string[]) => Promise<MassDeleteChoice>;
  /**
   * First-connect guard: called on the very first sync of a device when BOTH
   * this device and the server workspace already hold files, so the user can
   * choose how to start. Omit (web / headless) → defaults to "merge".
   */
  confirmBootstrap?: (info: { localFiles: number; serverFiles: number }) => Promise<BootstrapChoice>;
  /**
   * First-connect guard for the EMPTY-device case: the server already holds
   * files and this never-synced device has none, so the only sensible action
   * is a full download — but it should still be confirmed, not silent.
   * "cancel" cancels the run (managers turn sync off, like a bootstrap
   * cancel). Omit (web / headless) → "pull".
   */
  confirmFirstPull?: (info: { serverFiles: number }) => Promise<"pull" | "cancel">;
  inlineMaxBytes?: number;
  log?: (msg: string) => void;
}

/** How a first connection with data on both sides should be reconciled. */
export type BootstrapChoice = "merge" | "overwriteServer" | "overwriteLocal" | "cancel";

/** Outcome of the mass-delete guard (see SyncEngineOptions.confirmMassDeletion). */
export type MassDeleteChoice = "apply" | "restoreServer" | "cancel";

export interface SyncRunOptions {
  /** Restrict local-change detection to these paths (event-driven quick sync). */
  dirtyPaths?: string[];
  /** Pull/apply only — used right after a watch ping. */
  pullOnly?: boolean;
}

export class SyncError extends Error {
  /**
   * HTTP status when the failure came from the server. It is what separates a
   * file the server will never accept (413, 400) from a run that should simply
   * be retried later (network, 5xx, 429).
   */
  constructor(message: string, readonly status?: number) { super(message); }
}

/**
 * True when the server's answer condemns one specific file rather than the
 * run: too large for the deployment (or for a proxy in front of it), or
 * content the server refuses to validate. Retrying such a file is pointless —
 * it fails identically every cycle, and while it does, nothing behind it in
 * the queue reaches the server either.
 */
function isPermanentFileRejection(e: unknown): e is SyncError {
  return e instanceof SyncError && (e.status === 413 || e.status === 400);
}

// Tuned against server limits (server: 500 items / 4 MB inline per response).
const PUSH_MAX_ITEMS = 400;
const PUSH_MAX_INLINE_BYTES = 3 * 1024 * 1024;
const MASS_DELETE_MIN_FILES = 20;
const MASS_DELETE_MIN_DELETIONS = 10;
const MASS_DELETE_FRACTION = 0.25;

interface LocalChange {
  path: string;
  kind: "upsert" | "delete";
  baseRev: number;
  mtime: number;
  /** Content hash + size captured during detection, so the push can skip a
   *  second read+hash of the same file. Only trusted when the file is still
   *  unchanged at push time (same mtime+size). */
  hash?: string;
  size?: number;
}

/**
 * Files that carry no user content and therefore must not make a device look
 * "non-empty" when deciding how a first connection is reconciled.
 */
function isBookkeepingOnly(path: string): boolean {
  const name = path.split("/").pop() ?? path;
  return name === WORKSPACE_STATE_FILE;
}

export class SyncEngine {
  private readonly fs: SyncFs;
  private readonly transport: SyncTransport;
  private readonly state: SyncStateFile;
  private readonly saveState: () => Promise<void>;
  private readonly opts: SyncEngineOptions;
  private readonly inlineMax: number;

  constructor(opts: SyncEngineOptions) {
    this.opts = opts;
    this.fs = opts.fs;
    this.transport = opts.transport;
    this.state = opts.state;
    this.saveState = opts.saveState;
    this.inlineMax = opts.inlineMaxBytes ?? DEFAULT_INLINE_MAX_BYTES;
  }

  /** One full cycle. Callers must serialise runs (see SyncManager). */
  async run(runOpts?: SyncRunOptions): Promise<SyncRunSummary> {
    const sum = emptySummary();

    // ---- First-connect bootstrap guard ----
    // Full runs always evaluate it. Event-driven (dirtyPaths) and pull-only
    // runs normally skip it, but NOT on a virgin (never-synced) client: they
    // run the same pull loop, so without the guard a stray vault event firing
    // before the initial full sync could start applying server data before
    // the user made the first-connect decision.
    const virgin = this.state.cursor === 0 && Object.keys(this.state.manifest).length === 0;
    if ((!runOpts?.pullOnly && !runOpts?.dirtyPaths) || virgin) {
      const choice = await this.bootstrapDecision();
      if (choice === "cancel") { sum.cancelled = true; return sum; }
      if (choice === "overwriteServer") { await this.overwriteServer(sum); return sum; }
      if (choice === "overwriteLocal") { await this.overwriteLocal(sum); return sum; }
      // "none" (nothing to disambiguate) | "merge" → fall through to the normal cycle
    }

    // ---- PULL (loop while truncated) ----
    for (;;) {
      const res = await this.transport.changes(this.state.cursor);
      if (res.resync) {
        await this.resyncFromSnapshot(sum);
        if (sum.blocked) return sum;
        break;
      }
      // Foreign / reset server: the highest revision we think we know (cursor or
      // any manifest entry) is beyond the server's head, so this client state
      // belongs to a DIFFERENT (or wiped) workspace — e.g. the plugin was
      // re-pointed at a freshly created server workspace, or the server data was
      // reset. Drop the stale manifest+cursor and re-pull from zero, so local
      // files re-upload as a clean bootstrap instead of silently no-op'ing (the
      // manifest would otherwise mark everything "already synced").
      let knownRev = this.state.cursor;
      for (const m of Object.values(this.state.manifest)) if (m.rev > knownRev) knownRev = m.rev;
      if (knownRev > 0 && res.rev < knownRev) {
        this.state.cursor = 0;
        this.state.manifest = {};
        await this.saveState();
        continue;
      }
      const entries = res.files.filter((f) => !this.opts.exclude?.(f.path));
      if (entries.length > 0) {
        if (!(await this.applyRemote(entries, sum))) {
          sum.blocked = "mass-delete";
          return sum; // cursor untouched — nothing was applied
        }
      }
      this.state.cursor = res.truncated && res.files.length > 0
        ? Math.max(...res.files.map((f) => f.rev))
        : Math.max(this.state.cursor, res.rev);
      await this.saveState();
      if (!res.truncated) break;
    }

    // ---- PUSH ----
    if (!runOpts?.pullOnly) {
      const changes = await this.detectLocalChanges(runOpts?.dirtyPaths);
      if (changes.length > 0) {
        await this.pushLocal(changes, sum, true);
      }
      await this.saveState();
    }
    return sum;
  }

  /** Pending = what a push would send right now (settings status line). */
  async pendingCount(): Promise<number> {
    return (await this.detectLocalChanges()).length;
  }

  /**
   * Live fast path for the WebSocket: apply server-sent change entries directly,
   * skipping the GET /changes round-trip. Valid only when `since` lines up with
   * our cursor (contiguous) — otherwise returns "gap" and the caller pulls
   * normally. Never pushes; local edits ride their own trigger. Callers must
   * serialise this with run() (same single-flight as a pull).
   */
  async applyLiveChanges(since: number, rev: number, files: ChangeEntry[]): Promise<"applied" | "applied-needs-push" | "gap" | "blocked"> {
    if (since !== this.state.cursor) return "gap";
    // Never fast-path a virgin client: the first-connect decision (bootstrap /
    // first-pull confirmation) belongs to a full run.
    if (this.state.cursor === 0 && Object.keys(this.state.manifest).length === 0) return "gap";
    const sum = emptySummary();
    const entries = files.filter((f) => !this.opts.exclude?.(f.path));
    if (entries.length > 0 && !(await this.applyRemote(entries, sum))) return "blocked";
    this.state.cursor = rev;
    await this.saveState();
    // The user chose to UNDO a deletion carried by this frame — this method
    // never pushes, so the caller must schedule a run that does.
    return this.restoreQueue.size > 0 ? "applied-needs-push" : "applied";
  }

  // -------------------------------------------------------------------------
  // First-connect bootstrap (data on both sides)
  // -------------------------------------------------------------------------

  /**
   * Decide how a never-synced device should start. Returns "none" when there is
   * nothing to disambiguate (already synced, or one side is empty) — the caller
   * then runs the normal merge cycle. Also resolves a stale/foreign client
   * state first, so re-pointing at a fresh workspace is treated as a clean
   * first connect.
   */
  private async bootstrapDecision(): Promise<"none" | BootstrapChoice> {
    const probe = await this.transport.changes(this.state.cursor);
    if (!probe.resync) {
      let knownRev = this.state.cursor;
      for (const m of Object.values(this.state.manifest)) if (m.rev > knownRev) knownRev = m.rev;
      if (knownRev > 0 && probe.rev < knownRev) {
        this.state.cursor = 0;
        this.state.manifest = {};
        await this.saveState();
      }
    }
    // Only a fresh, never-synced device bootstraps.
    if (this.state.cursor !== 0 || Object.keys(this.state.manifest).length > 0) return "none";
    if (probe.rev === 0) return "none"; // empty server → plain upload, no prompt
    const localFiles = (await this.fs.list()).filter((f) => !this.opts.exclude?.(f.path));
    // `_workspace-state.md` is pure bookkeeping (view state, notification
    // stamps) and the plugin rewrites it into the root as soon as the
    // workspace is saved — before the first sync run ever gets to look. Left
    // in the tally it made `localCount` permanently >= 1, so a brand-new device
    // joining an existing workspace never reached the first-pull confirmation
    // below and was offered the four-way bootstrap instead, "overwrite server
    // with this device" included. Counting only real content restores the
    // intended guard for the device that has nothing of its own to lose.
    const localCount = localFiles.filter((f) => !isBookkeepingOnly(f.path)).length;
    if (localCount === 0) {
      // Empty device, server has data: the only sane outcome is a download —
      // but it must be confirmed, never silent (web/headless omit the callback).
      if (!this.opts.confirmFirstPull) return "none";
      const serverCount = (await this.collectServerFiles()).map.size;
      if (serverCount === 0) return "none"; // only tombstones on the server
      return (await this.opts.confirmFirstPull({ serverFiles: serverCount })) === "pull" ? "none" : "cancel";
    }
    if (!this.opts.confirmBootstrap) return "merge"; // web / headless: safe default
    const serverCount = (await this.collectServerFiles()).map.size;
    return this.opts.confirmBootstrap({ localFiles: localCount, serverFiles: serverCount });
  }

  /** Snapshot of the server's live files, keyed by path (handles truncation). */
  private async collectServerFiles(): Promise<{ map: Map<string, ChangeEntry>; head: number }> {
    const map = new Map<string, ChangeEntry>();
    let since = 0;
    let head = 0;
    for (;;) {
      const res = await this.transport.changes(since);
      head = res.rev;
      for (const f of res.files) {
        if (this.opts.exclude?.(f.path)) continue;
        if (f.deleted) map.delete(f.path);
        else map.set(f.path, f);
      }
      if (!res.truncated || res.files.length === 0) break;
      since = Math.max(...res.files.map((f) => f.rev));
    }
    return { map, head };
  }

  /** Force-write a server entry to disk + manifest (no conflict resolution). */
  private async writeRemote(entry: ChangeEntry, sum: SyncRunSummary): Promise<void> {
    const data = entry.content !== undefined
      ? b64decode(entry.content)
      : await this.transport.downloadBlob(this.requireBlobHash(entry));
    if ((await sha256Hex(data)) !== entry.hash) throw new SyncError(`integrity check failed for ${entry.path}`);
    await this.fs.writeBinary(entry.path, data);
    const after = await this.fs.stat(entry.path);
    this.state.manifest[entry.path] = {
      hash: entry.hash,
      mtime: after?.mtime ?? entry.mtime,
      size: after?.size ?? entry.size,
      rev: entry.rev,
    };
    sum.pulled++;
  }

  /**
   * "Overwrite server with this device": force-push every local file and delete
   * server-only files. The server copies each overwritten/deleted row into its
   * version history first, so the previous server content stays recoverable.
   */
  private async overwriteServer(sum: SyncRunSummary): Promise<void> {
    const { map: server } = await this.collectServerFiles();
    const local = (await this.fs.list()).filter((f) => !this.opts.exclude?.(f.path));
    const localPaths = new Set(local.map((f) => f.path));
    const changes: LocalChange[] = [];
    for (const f of local) {
      const remote = server.get(f.path);
      changes.push({ path: f.path, kind: "upsert", baseRev: remote?.rev ?? 0, mtime: f.mtime });
    }
    for (const [path, remote] of server) {
      if (!localPaths.has(path)) changes.push({ path, kind: "delete", baseRev: remote.rev, mtime: Date.now() });
    }
    if (changes.length > 0) await this.pushLocal(changes, sum, true);
    await this.saveState();
  }

  /**
   * "Overwrite this device from server": pull every server file and drop
   * local-only files. Anything discarded or overwritten on disk is stashed into
   * the server's version history first, so nothing is lost.
   */
  private async overwriteLocal(sum: SyncRunSummary): Promise<void> {
    const { map: server, head } = await this.collectServerFiles();
    const local = (await this.fs.list()).filter((f) => !this.opts.exclude?.(f.path));
    for (const f of local) {
      const remote = server.get(f.path);
      const localHash = await this.hashOf(f.path);
      if (remote && remote.hash === localHash) continue; // identical — nothing to keep
      await this.stashLocal(f.path, "overwrite-local (discarded local)");
    }
    for (const entry of server.values()) await this.writeRemote(entry, sum);
    for (const f of local) {
      if (!server.has(f.path)) {
        await this.fs.remove(f.path);
        delete this.state.manifest[f.path];
        sum.deletedLocal++;
      }
    }
    this.state.cursor = head;
    await this.saveState();
  }

  // -------------------------------------------------------------------------
  // Remote → local
  // -------------------------------------------------------------------------

  /**
   * Paths queued for a forced re-push after the user chose to UNDO a mass
   * deletion ("restoreServer"): their manifest entries are force-dirtied and
   * the paths are merged into the next push's detection set, so the undo
   * ships even from an event-driven (dirtyPaths) run.
   */
  private restoreQueue = new Set<string>();

  /** True when a chosen undo still needs a push leg (see applyLiveChanges). */
  get hasPendingRestore(): boolean {
    return this.restoreQueue.size > 0;
  }

  private async applyRemote(entries: ChangeEntry[], sum: SyncRunSummary): Promise<boolean> {
    const manifest = this.state.manifest;
    const total = Object.keys(manifest).length;
    const deletedPaths = entries.filter((e) => e.deleted && manifest[e.path]).map((e) => e.path);
    const deletions = deletedPaths.length;
    let choice: MassDeleteChoice = "apply";
    if (
      total >= MASS_DELETE_MIN_FILES &&
      deletions >= Math.max(MASS_DELETE_MIN_DELETIONS, Math.ceil(total * MASS_DELETE_FRACTION))
    ) {
      choice = (await this.opts.confirmMassDeletion?.(deletions, total, deletedPaths)) ?? "cancel";
      if (choice === "cancel") return false;
    }
    const ordered = [...entries].sort((a, b) => a.rev - b.rev);
    for (const entry of ordered) {
      if (choice === "restoreServer" && entry.deleted && manifest[entry.path]) {
        // UNDO: keep the local file and force-push it against the tombstone's
        // rev. The full placeholder (mtime 0 / size -1) is required — a clean
        // file matches the manifest's mtime+size and the full-scan fast path
        // would otherwise skip it (same shape the conflict-winner path uses).
        manifest[entry.path] = { hash: "", mtime: 0, size: -1, rev: entry.rev };
        this.restoreQueue.add(entry.path);
        continue;
      }
      await this.applyEntry(entry, sum);
    }
    return true;
  }

  private async applyEntry(entry: ChangeEntry, sum: SyncRunSummary): Promise<void> {
    const manifest = this.state.manifest;
    const m = manifest[entry.path];
    const disk = await this.fs.stat(entry.path);

    if (entry.deleted) {
      // Never synced here (bootstrap union / pruned history) → deletion does not apply.
      if (!m) return;
      if (!disk) {
        delete manifest[entry.path];
        return;
      }
      if (!(await this.isLocallyDirty(entry.path, m, disk))) {
        await this.fs.remove(entry.path);
        delete manifest[entry.path];
        sum.deletedLocal++;
        return;
      }
      // Remote delete vs local edit.
      sum.conflicts++;
      if (disk.mtime > entry.mtime) {
        // Local edit wins: align baseRev with the tombstone so the next push overwrites it.
        m.rev = entry.rev;
        m.hash = ""; // force-dirty
        return;
      }
      await this.stashLocal(entry.path, "conflict-loser (remote delete)");
      await this.writeConflictCopy(entry.path);
      await this.fs.remove(entry.path);
      delete manifest[entry.path];
      sum.deletedLocal++;
      return;
    }

    // Upsert. Content we already adopted at this hash → just track the new rev.
    if (m && m.hash === entry.hash) {
      m.rev = entry.rev;
      return;
    }

    if (disk) {
      const diskHash = await this.hashOf(entry.path);
      if (diskHash === entry.hash) {
        // Converged independently (double transport: e.g. our sync + Obsidian Sync).
        manifest[entry.path] = { hash: entry.hash, mtime: disk.mtime, size: disk.size, rev: entry.rev };
        return;
      }
      const dirty = !m || diskHash !== m.hash;
      if (dirty) {
        if (this.opts.isMergeFile?.(entry.path)) {
          // Merge file: remote lands on disk, the app merges in memory and the
          // merged result is re-pushed by a later cycle. Stash local first.
          await this.stashLocal(entry.path, "pre-merge");
        } else {
          const localWins =
            disk.mtime > entry.mtime || (disk.mtime === entry.mtime && diskHash > entry.hash);
          sum.conflicts++;
          if (localWins) {
            // Keep local; force-push against the remote rev on the push leg.
            manifest[entry.path] = { hash: "", mtime: 0, size: -1, rev: entry.rev };
            return;
          }
          await this.stashLocal(entry.path, "conflict-loser");
          await this.writeConflictCopy(entry.path);
        }
      }
    }

    const data = entry.content !== undefined
      ? b64decode(entry.content)
      : await this.transport.downloadBlob(this.requireBlobHash(entry));
    if ((await sha256Hex(data)) !== entry.hash) {
      throw new SyncError(`integrity check failed for ${entry.path}`);
    }
    await this.fs.writeBinary(entry.path, data);
    const after = await this.fs.stat(entry.path);
    manifest[entry.path] = {
      hash: entry.hash,
      mtime: after?.mtime ?? entry.mtime,
      size: after?.size ?? entry.size,
      rev: entry.rev,
    };
    sum.pulled++;
  }

  private requireBlobHash(entry: ChangeEntry): string {
    if (!entry.blobHash) throw new SyncError(`server entry for ${entry.path} has neither content nor blobHash`);
    return entry.blobHash;
  }

  // -------------------------------------------------------------------------
  // Resync (cursor predates pruned tombstones) — snapshot-based reconcile
  // -------------------------------------------------------------------------

  private async resyncFromSnapshot(sum: SyncRunSummary): Promise<void> {
    const lines = await this.transport.snapshot();
    const header = lines[0];
    if (!header || header.type !== "header") throw new SyncError("snapshot: missing header");
    const last = lines[lines.length - 1];
    if (!last || last.type !== "end") throw new SyncError("snapshot: stream truncated (no end marker)");

    const server = new Map<string, ChangeEntry>();
    for (const line of lines) {
      if (line.type === "file" && !this.opts.exclude?.(line.path)) server.set(line.path, line);
    }

    // Newly-excluded tracked paths must not read as "deleted remotely" below
    // (the server rightly has no entry for them) — that would delete them
    // from THIS disk. Stop tracking them instead. Runs AFTER the snapshot
    // fetch so exclusions derived from it (marker scan) are already known.
    this.dropExcludedManifestEntries();

    // Paths we synced before that the server no longer has = deleted remotely
    // while we were too far behind to see the tombstones.
    const vanished = Object.keys(this.state.manifest).filter((p) => !server.has(p));
    const total = Object.keys(this.state.manifest).length;
    let choice: MassDeleteChoice = "apply";
    if (
      total >= MASS_DELETE_MIN_FILES &&
      vanished.length >= Math.max(MASS_DELETE_MIN_DELETIONS, Math.ceil(total * MASS_DELETE_FRACTION))
    ) {
      choice = (await this.opts.confirmMassDeletion?.(vanished.length, total, vanished)) ?? "cancel";
      if (choice === "cancel") {
        sum.blocked = "mass-delete";
        return;
      }
    }

    for (const entry of server.values()) await this.applyEntry(entry, sum);

    for (const path of vanished) {
      const m = this.state.manifest[path];
      const disk = await this.fs.stat(path);
      if (!disk) {
        delete this.state.manifest[path];
        continue;
      }
      if (choice === "restoreServer") {
        // UNDO: keep the local file; dropping the manifest entry makes it read
        // as brand-new, so the push leg re-creates it over the (possibly
        // pruned) tombstone.
        delete this.state.manifest[path];
        this.restoreQueue.add(path);
        continue;
      }
      if (await this.isLocallyDirty(path, m, disk)) {
        // Local changes since last sync → treat as new content, re-push.
        delete this.state.manifest[path];
      } else {
        await this.fs.remove(path);
        delete this.state.manifest[path];
        sum.deletedLocal++;
      }
    }

    this.state.cursor = header.rev;
    await this.saveState();
  }

  // -------------------------------------------------------------------------
  // Local → remote
  // -------------------------------------------------------------------------

  /**
   * A tracked path that BECAME excluded (its folder turned into a task
   * workspace, a new ignore pattern, a toggle flipped) must be dropped from
   * the manifest silently. Leaving it would read as "file vanished from disk"
   * on the next full scan and push a tombstone — deleting it on the server
   * and every other device even though the file still exists here.
   */
  private dropExcludedManifestEntries(): void {
    if (!this.opts.exclude) return;
    for (const path of Object.keys(this.state.manifest)) {
      if (this.opts.exclude(path)) delete this.state.manifest[path];
    }
  }

  private async detectLocalChanges(dirtyPaths?: string[]): Promise<LocalChange[]> {
    const manifest = this.state.manifest;
    const changes: LocalChange[] = [];

    // A chosen undo-deletion must ship even from an event-driven quick sync:
    // merge the queued paths into the restricted detection set.
    if (dirtyPaths && this.restoreQueue.size > 0) {
      dirtyPaths = [...dirtyPaths, ...this.restoreQueue];
    }
    this.restoreQueue.clear();

    if (dirtyPaths && dirtyPaths.length > 0) {
      for (const path of new Set(dirtyPaths)) {
        if (this.opts.exclude?.(path)) {
          // Tracked path that BECAME excluded — stop tracking, never tombstone.
          delete manifest[path];
          continue;
        }
        const m = manifest[path];
        const disk = await this.fs.stat(path);
        if (!disk) {
          if (m) changes.push({ path, kind: "delete", baseRev: m.rev, mtime: Date.now() });
          continue;
        }
        if (!m) {
          changes.push({ path, kind: "upsert", baseRev: 0, mtime: disk.mtime });
        } else if (m.hash === "") {
          // Forced-dirty placeholder (won a conflict): hash unknown, push reads it.
          changes.push({ path, kind: "upsert", baseRev: m.rev, mtime: disk.mtime });
        } else if (disk.mtime !== m.mtime || disk.size !== m.size) {
          const hash = await this.hashOf(path);
          if (hash === m.hash) { m.mtime = disk.mtime; m.size = disk.size; continue; }
          changes.push({ path, kind: "upsert", baseRev: m.rev, mtime: disk.mtime, hash, size: disk.size });
        }
      }
      return changes;
    }

    const diskFiles = (await this.fs.list()).filter((f) => !this.opts.exclude?.(f.path));
    const seen = new Set<string>();
    for (const f of diskFiles) {
      seen.add(f.path);
      const m = manifest[f.path];
      if (!m) {
        changes.push({ path: f.path, kind: "upsert", baseRev: 0, mtime: f.mtime });
        continue;
      }
      if (f.mtime === m.mtime && f.size === m.size) continue; // clean fast path
      const hash = await this.hashOf(f.path);
      if (hash === m.hash) {
        // Touched but identical (e.g. editor re-save): silently re-baseline.
        m.mtime = f.mtime;
        m.size = f.size;
        continue;
      }
      changes.push({ path: f.path, kind: "upsert", baseRev: m.rev, mtime: f.mtime, hash, size: f.size });
    }
    for (const path of Object.keys(manifest)) {
      if (seen.has(path)) continue;
      // Checked HERE (not before fs.list()) because listing can register new
      // exclusions on the fly (marker files discovered during the walk).
      if (this.opts.exclude?.(path)) {
        delete manifest[path];
        continue;
      }
      changes.push({ path, kind: "delete", baseRev: manifest[path].rev, mtime: Date.now() });
    }
    return changes;
  }

  private async pushLocal(changes: LocalChange[], sum: SyncRunSummary, allowRetry: boolean): Promise<void> {
    type Prepared = { item: PushItem; data?: ArrayBuffer };
    const prepared: Prepared[] = [];

    for (const ch of changes) {
      if (ch.kind === "delete") {
        prepared.push({ item: { path: ch.path, baseRev: ch.baseRev, hash: "", size: 0, mtime: ch.mtime, deleted: true } });
        continue;
      }
      const disk = await this.fs.stat(ch.path);
      if (!disk) continue; // vanished between detect and push — the delete will surface next cycle
      const data = await this.fs.readBinary(ch.path);
      // Reuse the hash captured at detection when the file hasn't changed since
      // (same mtime+size) — avoids a second SHA over the same bytes. Any change
      // in the window invalidates it and we re-hash, so the advertised hash
      // always matches the content we send.
      const hash = (ch.hash && ch.size === data.byteLength && ch.mtime === disk.mtime)
        ? ch.hash
        : await sha256Hex(data);
      const prior = this.state.rejected?.[ch.path];
      if (prior) {
        if (prior.hash === hash) {
          // Unchanged since the server refused it. Re-uploading would fail the
          // same way and, for the large files this usually hits, burn the
          // bandwidth again on every cycle.
          sum.rejected.push({ path: ch.path, reason: prior.reason });
          continue;
        }
        delete this.state.rejected![ch.path]; // edited since — the user's retry
      }
      const base: PushItem = { path: ch.path, baseRev: ch.baseRev, hash, size: data.byteLength, mtime: disk.mtime };
      if (data.byteLength > this.inlineMax) {
        try {
          await this.transport.uploadBlob(hash, data);
        } catch (e) {
          if (!isPermanentFileRejection(e)) throw e;
          this.noteRejected(ch.path, hash, e.message, sum);
          continue;
        }
        prepared.push({ item: { ...base, blobHash: hash }, data });
      } else {
        prepared.push({ item: { ...base, content: b64encode(data) }, data });
      }
    }

    const retries: LocalChange[] = [];
    for (const batch of this.batches(prepared)) {
      const res = await this.transport.push({ device: this.state.deviceId, items: batch.map((p) => p.item) });
      for (let i = 0; i < batch.length; i++) {
        const { item, data } = batch[i];
        const result = res.results[i];
        if (!result) throw new SyncError(`push: missing result for ${item.path}`);
        if (result.status === "ok") {
          if (item.deleted) delete this.state.manifest[item.path];
          else {
            const disk = await this.fs.stat(item.path);
            this.state.manifest[item.path] = {
              hash: item.hash,
              mtime: disk?.mtime ?? item.mtime,
              size: item.size,
              rev: result.rev ?? this.state.cursor,
            };
          }
          if (item.deleted) sum.deletedRemote++; else sum.pushed++;
          continue;
        }
        if (result.status === "conflict" && result.current) {
          const retry = await this.resolvePushConflict(item, data, result, sum);
          if (retry) retries.push(retry);
          continue;
        }
        // A per-item "error" condemns this file, not the run. Record it and
        // let the rest of the batch through, so one file the server will never
        // accept cannot wedge the whole workspace.
        this.noteRejected(item.path, item.hash, result.message || result.status, sum);
      }
    }

    if (retries.length > 0) {
      if (!allowRetry) throw new SyncError(`push: conflicts persisted after retry (${retries[0].path})`);
      await this.pushLocal(retries, sum, false);
    }
  }

  /** Remember a file the server refused, and report it in this run's summary. */
  private noteRejected(path: string, hash: string, reason: string, sum: SyncRunSummary): void {
    (this.state.rejected ||= {})[path] = { hash, reason };
    sum.rejected.push({ path, reason });
  }

  /** Returns a retry change when the local side wins; otherwise adopts the server state. */
  private async resolvePushConflict(
    item: PushItem,
    data: ArrayBuffer | undefined,
    result: PushItemResult,
    sum: SyncRunSummary,
  ): Promise<LocalChange | null> {
    const current = result.current!;
    sum.conflicts++;
    const localWins =
      item.mtime > current.mtime || (item.mtime === current.mtime && item.hash > current.hash);

    if (localWins) {
      return {
        path: item.path,
        kind: item.deleted ? "delete" : "upsert",
        baseRev: current.rev,
        mtime: item.mtime,
      };
    }

    // Server wins. Preserve our content in its history, then adopt.
    if (!item.deleted && data) {
      await this.stashData(item.path, data, item.mtime, "conflict-loser");
      await this.writeConflictCopy(item.path, data);
    }
    if (current.deleted) {
      const disk = await this.fs.stat(item.path);
      if (disk) await this.fs.remove(item.path);
      delete this.state.manifest[item.path];
      sum.deletedLocal++;
      return null;
    }
    const remote = current.content !== undefined
      ? b64decode(current.content)
      : await this.transport.downloadBlob(this.requireBlobHash(current));
    await this.fs.writeBinary(item.path, remote);
    const after = await this.fs.stat(item.path);
    this.state.manifest[item.path] = {
      hash: current.hash,
      mtime: after?.mtime ?? current.mtime,
      size: after?.size ?? current.size,
      rev: current.rev,
    };
    sum.pulled++;
    return null;
  }

  private *batches<T extends { item: PushItem }>(prepared: T[]): Generator<T[]> {
    let batch: T[] = [];
    let inlineBytes = 0;
    for (const p of prepared) {
      const cost = p.item.content ? p.item.size : 0;
      if (batch.length > 0 && (batch.length >= PUSH_MAX_ITEMS || inlineBytes + cost > PUSH_MAX_INLINE_BYTES)) {
        yield batch;
        batch = [];
        inlineBytes = 0;
      }
      batch.push(p);
      inlineBytes += cost;
    }
    if (batch.length > 0) yield batch;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private async isLocallyDirty(
    path: string,
    m: SyncManifestEntry,
    disk: { mtime: number; size: number },
  ): Promise<boolean> {
    if (m.hash === "") return true; // placeholder: forced dirty after a won conflict
    if (disk.mtime === m.mtime && disk.size === m.size) return false;
    return (await this.hashOf(path)) !== m.hash;
  }

  private async hashOf(path: string): Promise<string> {
    return sha256Hex(await this.fs.readBinary(path));
  }

  /** Best effort: stash failures must never block the sync itself. */
  private async stashLocal(path: string, note: string): Promise<void> {
    try {
      const disk = await this.fs.stat(path);
      if (!disk) return;
      await this.stashData(path, await this.fs.readBinary(path), disk.mtime, note);
    } catch (e) {
      this.opts.log?.(`stash failed for ${path}: ${e instanceof Error ? e.message : e}`);
    }
  }

  private async stashData(path: string, data: ArrayBuffer, mtime: number, note: string): Promise<void> {
    try {
      const hash = await sha256Hex(data);
      const req: StashVersionRequest = {
        device: this.state.deviceId, path, hash, size: data.byteLength, mtime, note,
      };
      if (data.byteLength > this.inlineMax) {
        await this.transport.uploadBlob(hash, data);
        req.blobHash = hash;
      } else {
        req.content = b64encode(data);
      }
      await this.transport.stashVersion(req);
    } catch (e) {
      this.opts.log?.(`stash failed for ${path}: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Optional local copy of the losing side: "<name> (conflict <device> <ts>).<ext>". */
  private async writeConflictCopy(path: string, data?: ArrayBuffer): Promise<void> {
    if (!this.opts.conflictCopies()) return;
    try {
      const bytes = data ?? await this.fs.readBinary(path);
      const dot = path.lastIndexOf(".");
      const slash = path.lastIndexOf("/");
      const stem = dot > slash ? path.slice(0, dot) : path;
      const ext = dot > slash ? path.slice(dot) : "";
      const ts = new Date().toISOString().slice(0, 16).replace("T", " ").replace(":", "");
      await this.fs.writeBinary(`${stem} (conflict ${this.state.deviceName} ${ts})${ext}`, bytes);
    } catch (e) {
      this.opts.log?.(`conflict copy failed for ${path}: ${e instanceof Error ? e.message : e}`);
    }
  }
}

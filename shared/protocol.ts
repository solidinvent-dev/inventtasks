/**
 * shared/protocol.ts — sync protocol contract shared by the plugin (src/sync/),
 * the sync server (server/) and the web app (webapp/).
 *
 * This is the ONLY code shared with the server. The server is content-agnostic:
 * it moves bytes + metadata and never parses task YAML (SYNC_SPECIFICATION.md §0.3),
 * so nothing here may import from src/.
 *
 * Wire format notes:
 *  - file content travels as base64 (uniform for text and binary),
 *  - `hash` is the SHA-256 hex of the raw file bytes,
 *  - `mtime` is the client-observed modification time in ms since epoch,
 *  - `rev` is the server's per-workspace monotonic revision counter; a client
 *    cursor is simply the highest rev it has fully processed.
 */

export const SYNC_PROTOCOL_VERSION = 1;

export const SERVER_NAME = "inventtasks-sync-server";

/** Inline-content ceiling. Files larger than this travel via the blob endpoints. */
export const DEFAULT_INLINE_MAX_BYTES = 1024 * 1024;

// ---------------------------------------------------------------------------
// Validation helpers (used by both ends; the server enforces, clients pre-check)
// ---------------------------------------------------------------------------

export const SHA256_HEX_RE = /^[a-f0-9]{64}$/;

export const WORKSPACE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export function isValidWorkspaceId(id: string): boolean {
  return WORKSPACE_ID_RE.test(id);
}

/**
 * A sync path is the path of a file relative to the workspace root, using `/`
 * separators, with no traversal and no absolute/drive forms. The server never
 * maps these onto its own filesystem (content lives in SQLite / hash-named
 * blobs) — these rules protect the CLIENTS that write pulled paths into a vault.
 */
/**
 * Empty-folder convention: sync is file-based, so an empty directory is
 * represented by a zero-byte marker file with this reserved name. Clients
 * treat the marker as "this folder exists": the plugin synthesizes one for
 * every leaf-empty folder when listing and materializes the FOLDER (not the
 * file) when applying; the web vault browser hides it from the file list and
 * renders its parent as an (empty) folder. The name is dot-prefixed so an
 * older client that writes it as a real file keeps it invisible in Obsidian.
 */
export const FOLDER_MARKER_NAME = ".inventtasks-folder";

/**
 * Per-workspace bookkeeping file (view state, notification stamps). It syncs
 * like any other file, but it carries no user content, so the sync layer must
 * not treat a root holding only this file as a device with something to lose.
 */
export const WORKSPACE_STATE_FILE = "_workspace-state.md";

export function isFolderMarkerPath(path: string): boolean {
  return path === FOLDER_MARKER_NAME || path.endsWith(`/${FOLDER_MARKER_NAME}`);
}

/** The directory a marker path stands for ("" for a root-level marker). */
export function folderOfMarkerPath(path: string): string {
  return path === FOLDER_MARKER_NAME ? "" : path.slice(0, -(FOLDER_MARKER_NAME.length + 1));
}

export function isValidSyncPath(path: string): boolean {
  if (typeof path !== "string" || path.length === 0 || path.length > 1024) return false;
  if (path.startsWith("/") || path.includes("\\")) return false;
  if (/^[a-zA-Z]:/.test(path)) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(path)) return false;
  const segments = path.split("/");
  return segments.every((s) => s.length > 0 && s !== "." && s !== "..");
}

// ---------------------------------------------------------------------------
// Info / health
// ---------------------------------------------------------------------------

export interface ServerInfo {
  name: typeof SERVER_NAME;
  serverVersion: string;
  protocolVersion: number;
  /** Optional capability flags (older servers omit this). */
  features?: { vaultSync: boolean };
}

/**
 * What a server-side workspace holds. "tasks" = an InventTasks workspace
 * subtree (the original sync scope); "vault" = a whole Obsidian vault synced
 * by the independent Vault Sync module. The sync data path is identical for
 * both — the kind only drives account UI (dashboard sections, vault browser)
 * and creation-time gating (ENABLE_VAULT_SYNC).
 */
export type WorkspaceKind = "tasks" | "vault";

// ---------------------------------------------------------------------------
// Changes (pull)
// ---------------------------------------------------------------------------

/** One file's state on the server. */
export interface ChangeEntry {
  path: string;
  rev: number;
  hash: string;          // "" for tombstones
  size: number;
  mtime: number;
  deleted: boolean;
  device?: string;       // device that produced this revision
  /** Present when the content is small enough to ship inline (base64). */
  content?: string;
  /** Present for blob-backed files: fetch via GET blobs/:hash. Equals `hash`. */
  blobHash?: string;
}

export interface ChangesResponse {
  /** Current server head revision for the workspace. */
  rev: number;
  /** Echo of the `since` cursor the client sent. */
  since: number;
  files: ChangeEntry[];
  /**
   * True when limits cut the list short — the client must call again with
   * `since` = the highest rev it received in `files`.
   */
  truncated?: boolean;
  /**
   * True when `since` predates pruned tombstones: the delta journal can no
   * longer prove which files were deleted. The client must run a full
   * snapshot-based reconcile instead of applying `files` (which will be empty).
   */
  resync?: boolean;
}

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

export interface PushItem {
  path: string;
  /**
   * The rev the client believes the server currently has for this path
   * (from its manifest). 0 = "the server has never seen this path".
   * A mismatch yields status "conflict" — the CLIENT resolves (LWW by mtime)
   * and either re-pushes with the returned current rev or adopts the server's
   * version locally (stashing its loser via POST versions).
   */
  baseRev: number;
  hash: string;          // sha256 of content; "" when deleted
  size: number;          // byte size; 0 when deleted
  mtime: number;
  deleted?: boolean;
  /** Inline content (base64). Exactly one of content/blobHash unless deleted. */
  content?: string;
  /** Reference to a blob previously uploaded with PUT blobs/:hash. */
  blobHash?: string;
}

export interface PushRequest {
  device: string;
  items: PushItem[];
}

export type PushItemStatus = "ok" | "conflict" | "error";

export interface PushItemResult {
  path: string;
  status: PushItemStatus;
  /** New (or, for idempotent no-ops, current) rev when status is "ok". */
  rev?: number;
  /** The server's current state when status is "conflict". */
  current?: ChangeEntry;
  message?: string;
}

export interface PushResponse {
  /** Server head after the batch. */
  rev: number;
  results: PushItemResult[];
}

// ---------------------------------------------------------------------------
// Version history
// ---------------------------------------------------------------------------

export interface VersionEntry {
  id: number;
  path: string;
  /** Rev this content held when it was live; 0 for stashed conflict losers. */
  rev: number;
  hash: string;
  size: number;
  mtime: number;
  deleted: boolean;
  device?: string;
  createdAt: string;     // ISO, server clock
  note?: string;         // e.g. "conflict-loser"
}

export interface VersionListResponse {
  path: string;
  versions: VersionEntry[];
}

/**
 * Body of POST restore-deleted — server-side mass UNDO: every file whose
 * tombstone was written at/after `since` is re-created (as a NEW revision)
 * from its most recent live version in history. Append-only: history is never
 * rewritten, so the restore itself is reversible. Recovery net for the
 * "wrong device wiped the workspace" scenario.
 */
export interface RestoreDeletedRequest {
  device: string;
  /** ISO timestamp; tombstones with updated_at >= since are restored. */
  since: string;
  /** Optional selection: restore ONLY these paths (subset of the window).
   *  Omitted = every tombstone in the window (legacy behavior). */
  paths?: string[];
}

/** One current tombstone, as listed by GET deleted (the restore preview). */
export interface DeletedFileEntry {
  path: string;
  /** ISO timestamp of the tombstone — when the deletion reached the server. */
  deletedAt: string;
  /** Device that pushed the deletion ("" when unknown). */
  device: string;
  /** Size of the version a restore would bring back (0 when not restorable). */
  size: number;
  /** False when the content aged out of history/blob retention. */
  restorable: boolean;
}

export interface ListDeletedResponse {
  files: DeletedFileEntry[];
}

export interface RestoreDeletedResponse {
  /** Server head after the restore batch. */
  rev: number;
  restored: number;
  /** Tombstones whose content is no longer in history (retention) — not restorable. */
  skipped: number;
}

/** Body of POST versions — stash content into history WITHOUT changing head. */
export interface StashVersionRequest {
  device: string;
  path: string;
  hash: string;
  size: number;
  mtime: number;
  note?: string;
  content?: string;      // base64; or blobHash for large files
  blobHash?: string;
}

// ---------------------------------------------------------------------------
// Snapshot (bootstrap) — NDJSON stream
// ---------------------------------------------------------------------------

export interface SnapshotHeaderLine {
  type: "header";
  rev: number;
  files: number;
  protocolVersion: number;
}

export interface SnapshotFileLine extends ChangeEntry {
  type: "file";
}

/** Lets clients detect a stream cut short by network failure. */
export interface SnapshotEndLine {
  type: "end";
  files: number;
}

export type SnapshotLine = SnapshotHeaderLine | SnapshotFileLine | SnapshotEndLine;

// ---------------------------------------------------------------------------
// Watch (WebSocket)
// ---------------------------------------------------------------------------

/** First client→server frame; the socket is closed unless it arrives in time. */
export interface WatchAuthMessage {
  type: "auth";
  token: string;
}

export interface WatchHelloMessage {
  type: "hello";
  rev: number;
  protocolVersion: number;
}

/**
 * Broadcast after a committed push when the delta is too big to inline (or as
 * a generic fallback). The client does a follow-up GET /changes.
 */
export interface WatchRevMessage {
  type: "rev";
  rev: number;
}

/**
 * Broadcast after a committed push that carries its delta inline — the client
 * applies it directly, skipping the GET /changes round-trip (live fast path).
 * `since` is the workspace head BEFORE this push; a client whose cursor equals
 * `since` can apply `files` contiguously and set its cursor to `rev`. A client
 * with a different cursor (gap / behind) ignores `files` and pulls normally.
 * Large or blob-heavy pushes fall back to WatchRevMessage instead.
 */
export interface WatchChangesMessage {
  type: "changes";
  rev: number;
  since: number;
  files: ChangeEntry[];
}

export type WatchServerMessage = WatchHelloMessage | WatchRevMessage | WatchChangesMessage;

/** Max inline bytes a `changes` watch frame will carry; bigger pushes use `rev`. */
export const WATCH_INLINE_MAX_BYTES = 512 * 1024;

/** WebSocket close codes used by the watch endpoint. */
export const WS_CLOSE_UNAUTHORIZED = 4401;
export const WS_CLOSE_AUTH_TIMEOUT = 4408;
export const WS_CLOSE_BAD_WORKSPACE = 4404;

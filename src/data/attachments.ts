// Attachments — file storage tied to a task by ID rather than file path.
// Physical layout under the workspace root:
//
//   <workspaceRoot>/_attachments/<TASK_ID>/main/<filename>          ← module
//   <workspaceRoot>/_attachments/<TASK_ID>/cf-<fieldId>/<filename>  ← cf
//
// Why keyed by ID instead of file path: a task can be moved between
// lists, folders, or spaces freely — but its TSK-xxxxx ID is stable, so
// the path to its attachments doesn't have to change when the task moves.
//
// Frontmatter stores `path` RELATIVE to `<workspaceRoot>/_attachments/<TASK_ID>/`
// so on read we just join. Names get a "-1", "-2", ... suffix when a
// collision is detected at upload time.

import { TFile, TFolder, normalizePath } from "obsidian";
import type { TaskAttachment } from "../types";
import type { WorkspaceIndex } from "./workspace-index";
import { appendActivity } from "./activity";

const ATTACHMENTS_FOLDER = "_attachments";
const MAIN_BUCKET = "main";
const CF_BUCKET_PREFIX = "cf-";

// -------- Path helpers --------

function attachmentsRoot(idx: WorkspaceIndex): string {
  const root = (idx.rootPath || "").trim();
  if (!root || root === "/") return ATTACHMENTS_FOLDER;
  return normalizePath(`${root}/${ATTACHMENTS_FOLDER}`);
}

function taskAttachmentsDir(idx: WorkspaceIndex, taskId: string): string {
  return normalizePath(`${attachmentsRoot(idx)}/${taskId}`);
}

function bucketPath(idx: WorkspaceIndex, taskId: string, bucket: string): string {
  return normalizePath(`${taskAttachmentsDir(idx, taskId)}/${bucket}`);
}

function relativeFor(bucket: string, filename: string): string {
  return `${bucket}/${filename}`;
}

// Keep attachment names portable across the desktop platforms supported by
// Obsidian. Browser File objects normally expose a basename already, but drag
// sources and programmatic callers can still supply separators/control chars.
function safeFilename(value: string): string {
  const cleaned = String(value || "")
    .trim()
    // eslint-disable-next-line no-control-regex -- control characters are exactly what a filename must not contain
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/[. ]+$/g, "")
    .trim();
  if (!cleaned || cleaned === "." || cleaned === "..") {
    throw new Error("Attachment filename cannot be empty.");
  }
  return cleaned;
}

// Absolute vault path for a stored attachment record.
export function resolveAttachmentVaultPath(idx: WorkspaceIndex, taskId: string, att: TaskAttachment): string {
  return normalizePath(`${taskAttachmentsDir(idx, taskId)}/${att.path}`);
}

// Resolves a stored `cover_image` value to a usable <img>/background URL.
// External URLs (http/data/app/blob) are used as-is; anything else is treated
// as a vault path and resolved to a displayable resource URL.
export function resolveCoverUrl(idx: WorkspaceIndex, value: string | undefined): string {
  if (!value) return "";
  if (value.startsWith("color:")) return "";
  if (/^(https?:|data:|app:|blob:)/i.test(value)) return value;
  try { return (idx.app.vault.adapter as any).getResourcePath(value) || value; } catch { return value; }
}

export function coverColorValue(value: string | undefined): string | undefined {
  const match = String(value || "").match(/^color:(#[0-9a-f]{6})$/i);
  return match?.[1];
}

// Covers can be backed either by an image (vault path / URL) or by a plain
// color. Keeping the styling in one helper prevents Board cards and the Item
// modal from interpreting the stored value differently.
export function applyCoverBackground(el: HTMLElement, idx: WorkspaceIndex, value: string | undefined): void {
  const color = coverColorValue(value);
  el.style.backgroundColor = color || "";
  el.style.backgroundImage = color ? "none" : `url("${resolveCoverUrl(idx, value)}")`;
}

// -------- Vault primitives (idempotent helpers) --------

async function ensureFolder(idx: WorkspaceIndex, path: string): Promise<void> {
  const af = idx.app.vault.getAbstractFileByPath(path);
  if (af instanceof TFolder) return;
  if (af) throw new Error(`Path exists but is not a folder: ${path}`);
  await idx.app.vault.createFolder(path).catch((e: any) => {
    // Race: another writer created it between check and create — fine.
    if (!/already exists/i.test(String(e?.message ?? e))) throw e;
  });
}

async function ensureBucket(idx: WorkspaceIndex, taskId: string, bucket: string): Promise<string> {
  const root = attachmentsRoot(idx);
  // Walk down the chain so intermediate folders are guaranteed to exist.
  await ensureFolder(idx, root);
  await ensureFolder(idx, taskAttachmentsDir(idx, taskId));
  const bucketDir = bucketPath(idx, taskId, bucket);
  await ensureFolder(idx, bucketDir);
  return bucketDir;
}

// Suffix collisions deterministically: "foo.pdf" → "foo-1.pdf", "foo-2.pdf", …
function uniqueName(existingNames: Set<string>, desired: string): string {
  if (!existingNames.has(desired)) return desired;
  const dot = desired.lastIndexOf(".");
  const base = dot > 0 ? desired.slice(0, dot) : desired;
  const ext = dot > 0 ? desired.slice(dot) : "";
  for (let n = 1; n < 10000; n++) {
    const cand = `${base}-${n}${ext}`;
    if (!existingNames.has(cand)) return cand;
  }
  // Pathological fallback — timestamp suffix.
  return `${base}-${Date.now()}${ext}`;
}

function existingNamesInBucket(idx: WorkspaceIndex, bucketDir: string): Set<string> {
  const folder = idx.app.vault.getAbstractFileByPath(bucketDir);
  if (!(folder instanceof TFolder)) return new Set();
  return new Set(folder.children.map((c) => c.name));
}

// -------- Public API --------

// Upload a binary file into the given bucket. Returns the stored attachment
// metadata (caller writes it into frontmatter via updateTask).
export async function uploadAttachment(
  idx: WorkspaceIndex,
  taskId: string,
  bucket: string,
  file: File,
): Promise<TaskAttachment> {
  const bucketDir = await ensureBucket(idx, taskId, bucket);
  const existing = existingNamesInBucket(idx, bucketDir);
  const name = uniqueName(existing, safeFilename(file.name));
  const fullPath = normalizePath(`${bucketDir}/${name}`);
  const buf = await file.arrayBuffer();
  await idx.app.vault.createBinary(fullPath, buf);
  return {
    name,
    path: relativeFor(bucket, name),
    size: file.size,
    mime: file.type || undefined,
    uploaded: new Date().toISOString(),
  };
}

async function renameAttachmentFile(
  idx: WorkspaceIndex,
  taskId: string,
  bucket: string,
  att: TaskAttachment,
  desiredName: string,
): Promise<TaskAttachment> {
  const currentPath = resolveAttachmentVaultPath(idx, taskId, att);
  const file = idx.app.vault.getAbstractFileByPath(currentPath);
  if (!(file instanceof TFile)) throw new Error(`Attachment file not found: ${att.name}`);

  const bucketDir = bucketPath(idx, taskId, bucket);
  const existing = existingNamesInBucket(idx, bucketDir);
  existing.delete(file.name);
  const name = uniqueName(existing, safeFilename(desiredName));
  if (name === file.name) return { ...att, name, path: relativeFor(bucket, name) };

  await idx.app.vault.rename(file, normalizePath(`${bucketDir}/${name}`));
  return { ...att, name, path: relativeFor(bucket, name) };
}

// Delete a single attachment file from disk + return success/failure (the
// caller is responsible for removing the record from frontmatter).
export async function deleteAttachmentFile(
  idx: WorkspaceIndex,
  taskId: string,
  att: TaskAttachment,
): Promise<void> {
  const path = resolveAttachmentVaultPath(idx, taskId, att);
  const f = idx.app.vault.getAbstractFileByPath(path);
  if (f instanceof TFile) {
    await idx.app.fileManager.trashFile(f);
  }
}

// Trash the entire <task_id> attachment dir — used when a task itself is
// deleted. Silently no-ops if the dir doesn't exist.
export async function deleteAllAttachmentsForTask(idx: WorkspaceIndex, taskId: string): Promise<void> {
  const dir = taskAttachmentsDir(idx, taskId);
  const f = idx.app.vault.getAbstractFileByPath(dir);
  if (f instanceof TFolder) {
    await idx.app.fileManager.trashFile(f);
  }
}

// Deep-copy every attachment bucket belonging to a task. Metadata paths are
// relative to the task directory, so the cloned TaskData can keep them
// unchanged while the physical files live under the new task ID.
export async function copyAllAttachmentsForTask(
  idx: WorkspaceIndex,
  sourceTaskId: string,
  targetTaskId: string,
): Promise<void> {
  const adapter: any = idx.app.vault.adapter;
  const sourceDir = taskAttachmentsDir(idx, sourceTaskId);
  if (!adapter?.exists || !(await adapter.exists(sourceDir))) return;

  const targetDir = taskAttachmentsDir(idx, targetTaskId);
  await ensureFolder(idx, attachmentsRoot(idx));
  await ensureFolder(idx, targetDir);

  const copyDir = async (from: string, to: string): Promise<void> => {
    const listing = await adapter.list(from);
    for (const folder of listing.folders || []) {
      const name = String(folder).split("/").pop();
      const next = normalizePath(`${to}/${name}`);
      await ensureFolder(idx, next);
      await copyDir(folder, next);
    }
    for (const file of listing.files || []) {
      const name = String(file).split("/").pop();
      const bytes = await adapter.readBinary(file);
      await adapter.writeBinary(normalizePath(`${to}/${name}`), bytes);
    }
  };
  await copyDir(sourceDir, targetDir);
}

// -------- Frontmatter-side: main module helpers (TaskData.attachments) --------

export async function addMainAttachments(idx: WorkspaceIndex, taskId: string, files: FileList | File[]): Promise<void> {
  const list = Array.from(files);
  if (list.length === 0) return;
  // Upload all files (parallel-safe because uniqueName is computed each call
  // against the live folder listing; sequential is simpler and avoids races).
  const uploaded: TaskAttachment[] = [];
  for (const f of list) {
    const att = await uploadAttachment(idx, taskId, MAIN_BUCKET, f);
    uploaded.push(att);
  }
  await idx.updateTask(taskId, (d) => {
    const next = [...(d.attachments ?? []), ...uploaded];
    let activity = d.activity;
    for (const a of uploaded) {
      activity = appendActivity(activity, { kind: "attachment_added", text: a.name });
    }
    return { data: { ...d, attachments: next, activity } };
  });
}

export async function removeMainAttachment(idx: WorkspaceIndex, taskId: string, attPath: string): Promise<void> {
  const tf = idx.tasksById.get(taskId);
  if (!tf) return;
  const att = (tf.data.attachments ?? []).find((a) => a.path === attPath);
  if (!att) return;
  await deleteAttachmentFile(idx, taskId, att);
  const oldCoverPath = resolveAttachmentVaultPath(idx, taskId, att);
  await idx.updateTask(taskId, (d) => {
    const next = ((d.attachments ?? []) as TaskAttachment[]).filter((a) => a.path !== attPath);
    return {
      data: {
        ...d,
        attachments: next.length ? next : undefined,
        // Never leave a broken cover reference when its backing attachment is
        // explicitly removed. Removing only the cover itself still keeps the
        // attachment, which is the non-destructive behavior promised by UI.
        cover_image: d.cover_image === oldCoverPath ? undefined : d.cover_image,
        activity: appendActivity(d.activity, { kind: "attachment_removed", text: att.name }),
      },
    };
  });
}

export async function renameMainAttachment(
  idx: WorkspaceIndex,
  taskId: string,
  attPath: string,
  desiredName: string,
): Promise<void> {
  const tf = idx.tasksById.get(taskId);
  if (!tf) return;
  const att = (tf.data.attachments ?? []).find((a) => a.path === attPath);
  if (!att) return;
  const oldCoverPath = resolveAttachmentVaultPath(idx, taskId, att);
  const renamed = await renameAttachmentFile(idx, taskId, MAIN_BUCKET, att, desiredName);
  const newCoverPath = resolveAttachmentVaultPath(idx, taskId, renamed);
  await idx.updateTask(taskId, (d) => ({
    data: {
      ...d,
      attachments: (d.attachments ?? []).map((a: TaskAttachment) => a.path === attPath ? renamed : a),
      cover_image: d.cover_image === oldCoverPath ? newCoverPath : d.cover_image,
      activity: appendActivity(d.activity, { kind: "attachment_renamed", from: att.name, to: renamed.name }),
    },
  }));
}

// -------- Frontmatter-side: custom-field attachment helpers --------

function cfBucket(fieldId: string): string {
  return `${CF_BUCKET_PREFIX}${fieldId}`;
}

export async function addCfAttachments(
  idx: WorkspaceIndex,
  taskId: string,
  fieldId: string,
  files: FileList | File[],
): Promise<void> {
  const list = Array.from(files);
  if (list.length === 0) return;
  const uploaded: TaskAttachment[] = [];
  for (const f of list) {
    const att = await uploadAttachment(idx, taskId, cfBucket(fieldId), f);
    uploaded.push(att);
  }
  await idx.updateTask(taskId, (d) => {
    const cf = { ...(d.custom_fields ?? {}) };
    const current: TaskAttachment[] = Array.isArray(cf[fieldId]) ? cf[fieldId] : [];
    cf[fieldId] = [...current, ...uploaded];
    let activity = d.activity;
    for (const a of uploaded) {
      activity = appendActivity(activity, { kind: "attachment_added", text: `${fieldId}: ${a.name}` });
    }
    return { data: { ...d, custom_fields: cf, activity } };
  });
}

export async function removeCfAttachment(
  idx: WorkspaceIndex,
  taskId: string,
  fieldId: string,
  attPath: string,
): Promise<void> {
  const tf = idx.tasksById.get(taskId);
  if (!tf) return;
  const list: TaskAttachment[] = Array.isArray(tf.data.custom_fields?.[fieldId])
    ? (tf.data.custom_fields![fieldId] as TaskAttachment[])
    : [];
  const att = list.find((a) => a.path === attPath);
  if (!att) return;
  await deleteAttachmentFile(idx, taskId, att);
  await idx.updateTask(taskId, (d) => {
    const cf = { ...(d.custom_fields ?? {}) };
    const next = list.filter((a) => a.path !== attPath);
    if (next.length === 0) delete cf[fieldId];
    else cf[fieldId] = next;
    return {
      data: {
        ...d,
        custom_fields: cf,
        activity: appendActivity(d.activity, { kind: "attachment_removed", text: `${fieldId}: ${att.name}` }),
      },
    };
  });
}

export async function renameCfAttachment(
  idx: WorkspaceIndex,
  taskId: string,
  fieldId: string,
  attPath: string,
  desiredName: string,
): Promise<void> {
  const tf = idx.tasksById.get(taskId);
  if (!tf) return;
  const list: TaskAttachment[] = Array.isArray(tf.data.custom_fields?.[fieldId])
    ? (tf.data.custom_fields![fieldId] as TaskAttachment[])
    : [];
  const att = list.find((a) => a.path === attPath);
  if (!att) return;
  const renamed = await renameAttachmentFile(idx, taskId, cfBucket(fieldId), att, desiredName);
  await idx.updateTask(taskId, (d) => {
    const cf = { ...(d.custom_fields ?? {}) };
    const current: TaskAttachment[] = Array.isArray(cf[fieldId]) ? cf[fieldId] : [];
    cf[fieldId] = current.map((a) => a.path === attPath ? renamed : a);
    return {
      data: {
        ...d,
        custom_fields: cf,
        activity: appendActivity(d.activity, {
          kind: "attachment_renamed",
          id: fieldId,
          from: att.name,
          to: renamed.name,
        }),
      },
    };
  });
}

// -------- Display helpers --------

export function humanFileSize(bytes: number | undefined): string {
  if (bytes === undefined || bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function openAttachmentInDefaultApp(idx: WorkspaceIndex, taskId: string, att: TaskAttachment): void {
  const path = resolveAttachmentVaultPath(idx, taskId, att);
  // `openWithDefaultApp` is on the App prototype in current Obsidian
  // versions but not in the typed surface — cast to any.
  (idx.app as any).openWithDefaultApp?.(path);
}

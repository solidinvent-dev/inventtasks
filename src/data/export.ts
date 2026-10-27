// Export — two flavours:
//   • Backup (re-importable): a lossless InventTasks JSON capturing the whole
//     subtree (configs + tasks + saved views). Round-trips via import.ts.
//   • Readable (for humans): CSV / Markdown / HTML / pretty JSON, a flat table
//     of the scope's tasks (or a view's filtered+columned tasks).
//
// Scope: workspace / space / folder / list / single task, plus "current view"
// and "saved view" (handled by the caller passing the tasks + columns).

import { Notice, Component, MarkdownRenderer, normalizePath, arrayBufferToBase64, type TAbstractFile } from "obsidian";
import { t } from "../i18n";
import type InventTasksPlugin from "../main";
import {
  TaskData, TaskFile, SpaceNode, FolderNode, ListNode, ViewConfig,
  SpaceConfig, FolderConfig, ListConfig, WorkspaceConfig, CustomFieldDef, ContextLocation,
  PriorityDef, StatusDef,
} from "../types";
import { csvCellValue, csvEscape } from "../views/table-view";
import { fieldLabelFrom } from "../i18n";
import { effectiveCustomFieldValue } from "./custom-fields";
import { resolveAttachmentVaultPath, resolveCoverUrl } from "./attachments";
import { getBlocks, getWaitingOn, getRelated } from "./relationships";
import { parentTaskIds } from "../types";
import { scalarText } from "../utils/text";

export type ExportScope = "workspace" | "space" | "folder" | "list" | "task" | "view";
export type ReadableFormat = "csv" | "xlsx" | "markdown" | "html" | "json";

// ---------- Backup (re-importable) bundle ----------

export interface BackupTask { data: TaskData; body: string; }
export interface BackupRawFile {
  path: string;
  kind: "workspace" | "workspace-state" | "doc" | "template" | "attachment" | "cover" | "other";
  encoding: "utf8" | "base64";
  data: string;
}
// `srcPath` = the node's original vault path; used on import to remap
// path-based references (e.g. tasks' additional_lists) to the new locations.
export interface BackupList { srcPath: string; config: ListConfig; tasks: BackupTask[]; views: ViewConfig[]; }
export interface BackupFolder { srcPath: string; config: FolderConfig; lists: BackupList[]; views: ViewConfig[]; }
export interface BackupSpace { srcPath: string; config: SpaceConfig; folders: BackupFolder[]; lists: BackupList[]; views: ViewConfig[]; }

export interface BackupBundle {
  format: "inventtasks-backup";
  version: 1;
  exportedAt: string;
  scope: ExportScope;
  scopeName: string;
  workspaceConfig?: WorkspaceConfig;
  globalViews?: ViewConfig[];           // workspace scope: global task locations
  spaces?: BackupSpace[];               // workspace scope
  space?: BackupSpace;                  // space scope
  folder?: BackupFolder;                // folder scope
  list?: BackupList;                    // list scope
  task?: BackupTask;                    // task scope
  task_subtasks?: BackupTask[];         // task scope: descendant tasks (templates)
  rawFiles?: BackupRawFile[];           // docs/templates/attachments/state/raw config not represented structurally
}

/**
 * Lookup context the readable exports use to resolve names and labels. Built
 * by buildScopeContext for scope exports; a view export passes its own view
 * context, which carries these members too.
 */
export interface ReadableExportContext {
  statuses: StatusDef[];
  priorities: PriorityDef[];
  customFields?: CustomFieldDef[];
  fieldLabels?: Record<string, string>;
  subtaskStats?: Map<string, { total: number; done: number }>;
  taskTitles?: Map<string, string>;
}

const GLOBAL_VIEW_LOCS = new Set(["everything", "today", "favorites", "recents", "archived"]);

function viewsForKey(plugin: InventTasksPlugin, key: string): ViewConfig[] {
  return plugin.index.viewsForLocationKey(key).map((v) => {
    const c: ViewConfig = { ...v };
    delete c.__path; // internal source-path marker — never persisted
    return c;
  });
}

function bkList(plugin: InventTasksPlugin, list: ListNode): BackupList {
  return {
    srcPath: list.path,
    config: list.config,
    tasks: list.taskFiles.map((tf) => ({ data: tf.data, body: tf.body })),
    views: viewsForKey(plugin, `list:${list.path}`),
  };
}
function bkFolder(plugin: InventTasksPlugin, folder: FolderNode): BackupFolder {
  return {
    srcPath: folder.path,
    config: folder.config,
    lists: folder.lists.map((l) => bkList(plugin, l)),
    views: viewsForKey(plugin, `folder:${folder.path}`),
  };
}
function bkSpace(plugin: InventTasksPlugin, space: SpaceNode): BackupSpace {
  return {
    srcPath: space.path,
    config: space.config,
    folders: space.folders.map((f) => bkFolder(plugin, f)),
    lists: space.lists.map((l) => bkList(plugin, l)),
    views: viewsForKey(plugin, `space:${space.path}`),
  };
}

// Direct + nested descendant tasks of `id` (for task templates).
function collectDescendants(plugin: InventTasksPlugin, id: string): TaskFile[] {
  const out: TaskFile[] = [];
  const seen = new Set<string>([id]);
  const stack = [id];
  while (stack.length) {
    const pid = stack.pop()!;
    plugin.index.tasksById.forEach((tf) => {
      if (!seen.has(tf.data.id) && parentTaskIds(tf.data).includes(pid)) {
        seen.add(tf.data.id); out.push(tf); stack.push(tf.data.id);
      }
    });
  }
  return out;
}

export async function buildBackup(plugin: InventTasksPlugin, scope: ExportScope, ref: { path?: string; taskId?: string }, opts?: { includeSubtasks?: boolean }): Promise<BackupBundle> {
  const base = {
    format: "inventtasks-backup" as const,
    version: 1 as const,
    exportedAt: new Date().toISOString(),
    scope,
  };
  if (scope === "workspace") {
    const globalViews = plugin.index.views
      .filter((v) => GLOBAL_VIEW_LOCS.has(v.location || ""))
      .map((v) => { const c: ViewConfig = { ...v }; delete c.__path; return c; });
    const bundle: BackupBundle = {
      ...base,
      scopeName: plugin.index.workspace?.name || "Workspace",
      workspaceConfig: plugin.index.workspace || undefined,
      globalViews,
      spaces: plugin.index.spaces.map((s) => bkSpace(plugin, s)),
    };
    bundle.rawFiles = await collectRawFiles(plugin, scope, ref, bundle);
    return bundle;
  }
  if (scope === "space") {
    const s = plugin.index.findSpace(ref.path!);
    if (!s) throw new Error(t("err.spaceNotFound"));
    const bundle: BackupBundle = { ...base, scopeName: s.config.name, space: bkSpace(plugin, s) };
    bundle.rawFiles = await collectRawFiles(plugin, scope, ref, bundle);
    return bundle;
  }
  if (scope === "folder") {
    const f = plugin.index.findFolder(ref.path!);
    if (!f) throw new Error(t("err.folderNotFound"));
    const bundle: BackupBundle = { ...base, scopeName: f.config.name, folder: bkFolder(plugin, f) };
    bundle.rawFiles = await collectRawFiles(plugin, scope, ref, bundle);
    return bundle;
  }
  if (scope === "list") {
    const l = plugin.index.findList(ref.path!);
    if (!l) throw new Error(t("err.listNotFound"));
    const bundle: BackupBundle = { ...base, scopeName: l.config.name, list: bkList(plugin, l) };
    bundle.rawFiles = await collectRawFiles(plugin, scope, ref, bundle);
    return bundle;
  }
  if (scope === "task") {
    const tf = plugin.index.tasksById.get(ref.taskId!);
    if (!tf) throw new Error(t("err.taskNotFoundExport"));
    const bundle: BackupBundle = { ...base, scopeName: tf.data.title || t("gantt.task"), task: { data: tf.data, body: tf.body } };
    if (opts?.includeSubtasks) {
      const subs = collectDescendants(plugin, tf.data.id);
      if (subs.length) bundle.task_subtasks = subs.map((s) => ({ data: s.data, body: s.body }));
    }
    bundle.rawFiles = await collectRawFiles(plugin, scope, ref, bundle);
    return bundle;
  }
  throw new Error(t("err.unsupportedBackupScope", { scope }));
}

function workspaceRoot(plugin: InventTasksPlugin): string {
  const root = (plugin.index.rootPath || "").trim();
  return !root || root === "/" ? "" : normalizePath(root).replace(/\/+$/, "");
}

function joinRoot(root: string, child: string): string {
  return root ? normalizePath(`${root}/${child}`) : child;
}

function pathInScope(path: string, scopeRoots: string[]): boolean {
  const p = normalizePath(path);
  return scopeRoots.some((root) => p === root || p.startsWith(`${root}/`));
}

function taskIdsInBundle(bundle: BackupBundle): Set<string> {
  const ids = new Set<string>();
  const addList = (bl: BackupList) => bl.tasks.forEach((t) => t.data.id && ids.add(t.data.id));
  const addFolder = (bf: BackupFolder) => bf.lists.forEach(addList);
  const addSpace = (bs: BackupSpace) => { bs.folders.forEach(addFolder); bs.lists.forEach(addList); };
  bundle.spaces?.forEach(addSpace);
  if (bundle.space) addSpace(bundle.space);
  if (bundle.folder) addFolder(bundle.folder);
  if (bundle.list) addList(bundle.list);
  if (bundle.task?.data.id) ids.add(bundle.task.data.id);
  bundle.task_subtasks?.forEach((t) => t.data.id && ids.add(t.data.id));
  return ids;
}

function tasksInBundle(bundle: BackupBundle): BackupTask[] {
  const out: BackupTask[] = [];
  const addList = (bl: BackupList) => out.push(...bl.tasks);
  const addFolder = (bf: BackupFolder) => bf.lists.forEach(addList);
  const addSpace = (bs: BackupSpace) => { bs.folders.forEach(addFolder); bs.lists.forEach(addList); };
  bundle.spaces?.forEach(addSpace);
  if (bundle.space) addSpace(bundle.space);
  if (bundle.folder) addFolder(bundle.folder);
  if (bundle.list) addList(bundle.list);
  if (bundle.task) out.push(bundle.task);
  if (bundle.task_subtasks) out.push(...bundle.task_subtasks);
  return out;
}

async function listFilesRecursive(plugin: InventTasksPlugin, dir: string): Promise<string[]> {
  const adapter = plugin.app.vault.adapter;
  try {
    if (!(await adapter.exists(dir))) return [];
    const listing = await adapter.list(dir);
    const files = [...(listing.files || [])];
    for (const folder of listing.folders || []) files.push(...await listFilesRecursive(plugin, folder));
    return files;
  } catch {
    return [];
  }
}

function localCoverPath(value: string | undefined): string | undefined {
  if (!value || /^(https?:|data:|app:|blob:)/i.test(value)) return undefined;
  return normalizePath(value);
}

async function collectRawFiles(
  plugin: InventTasksPlugin,
  scope: ExportScope,
  ref: { path?: string; taskId?: string },
  bundle: BackupBundle,
): Promise<BackupRawFile[]> {
  const root = workspaceRoot(plugin);
  const paths = new Map<string, BackupRawFile["kind"]>();
  const add = (path: string | undefined, kind: BackupRawFile["kind"]) => {
    if (!path) return;
    paths.set(normalizePath(path), kind);
  };
  const addTree = async (dir: string, kind: BackupRawFile["kind"]) => {
    for (const file of await listFilesRecursive(plugin, dir)) add(file, kind);
  };

  const scopeRoots = (() => {
    if (scope === "workspace") return [root || "/"];
    if (scope === "space" || scope === "folder" || scope === "list") return [normalizePath(ref.path || "")];
    const task = plugin.index.tasksById.get(ref.taskId || "");
    return task?.listPath ? [task.listPath] : [];
  })().filter(Boolean);

  if (scope === "workspace") {
    add(joinRoot(root, "_workspace.md"), "workspace");
    add(joinRoot(root, "_workspace-state.md"), "workspace-state");
    await addTree(joinRoot(root, "_templates"), "template");
  }

  await addTree(joinRoot(root, "_attachments"), "attachment");
  for (const docsDir of [joinRoot(root, "_docs"), ...scopeRoots.map((p) => normalizePath(`${p}/_docs`))]) {
    await addTree(docsDir, "doc");
  }

  const taskIds = taskIdsInBundle(bundle);
  for (const task of tasksInBundle(bundle)) {
    if (task.data.cover_image) add(localCoverPath(task.data.cover_image), "cover");
    for (const docId of task.data.documents || []) {
      for (const doc of plugin.index.docs || []) {
        if (doc.doc_id === docId) add(doc.__path, "doc");
      }
      for (const page of plugin.index.docPages || []) {
        if (page.doc_id === docId) add(page.__path, "doc");
      }
    }
  }

  const out: BackupRawFile[] = [];
  for (const [path, kind] of paths) {
    if (kind === "attachment") {
      const m = path.match(/(?:^|\/)_attachments\/([^/]+)\//);
      if (m && !taskIds.has(m[1])) continue;
    } else if (scope !== "workspace" && !pathInScope(path, scopeRoots) && kind !== "cover" && kind !== "doc") {
      continue;
    }
    const raw = await readBackupRawFile(plugin, path, kind);
    if (raw) out.push(raw);
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

async function readBackupRawFile(plugin: InventTasksPlugin, path: string, kind: BackupRawFile["kind"]): Promise<BackupRawFile | null> {
  const adapter = plugin.app.vault.adapter;
  try {
    if (!(await adapter.exists(path))) return null;
    if (/\.md$|\.json$|\.txt$|\.csv$|\.html$/i.test(path)) {
      return { path, kind, encoding: "utf8", data: await adapter.read(path) };
    }
    if (adapter.readBinary) {
      const data = await adapter.readBinary(path);
      return { path, kind, encoding: "base64", data: arrayBufferToBase64(data) };
    }
    return { path, kind, encoding: "utf8", data: await adapter.read(path) };
  } catch {
    return null;
  }
}

// ---------- Readable exports ----------

// All lists in a scope subtree (home lists only — tasks live in their home list).
export function listsInScope(plugin: InventTasksPlugin, scope: ExportScope, ref: { path?: string; taskId?: string }): ListNode[] {
  const out: ListNode[] = [];
  const addSpace = (s: SpaceNode) => { out.push(...s.lists); for (const f of s.folders) out.push(...f.lists); };
  if (scope === "workspace") { for (const s of plugin.index.spaces) addSpace(s); return out; }
  if (scope === "space") { const s = plugin.index.findSpace(ref.path!); if (s) addSpace(s); return out; }
  if (scope === "folder") { const f = plugin.index.findFolder(ref.path!); if (f) out.push(...f.lists); return out; }
  if (scope === "list") { const l = plugin.index.findList(ref.path!); if (l) out.push(l); return out; }
  if (scope === "task") { const lp = plugin.index.tasksById.get(ref.taskId!)?.listPath; const l = lp ? plugin.index.findList(lp) : undefined; if (l) out.push(l); return out; }
  return out;
}

export function gatherScopeTasks(plugin: InventTasksPlugin, scope: ExportScope, ref: { path?: string; taskId?: string }): TaskFile[] {
  if (scope === "task") {
    const tf = plugin.index.tasksById.get(ref.taskId!);
    return tf ? [tf] : [];
  }
  // Human-readable scope exports mirror the normal UI. Archived/system items
  // remain in lossless backup bundles, but do not leak into ordinary exports.
  return listsInScope(plugin, scope, ref)
    .flatMap((l) => l.taskFiles)
    .filter((task) => !plugin.index.isSystemTask(task) && !task.data.archived);
}

// Builds the lookup context csvCellValue needs (statuses + priorities + custom
// fields). Statuses/CFs are UNIONed across the scope's lists so names resolve
// even when sub-lists override the workflow.
export function buildScopeContext(plugin: InventTasksPlugin, lists: ListNode[], loc: ContextLocation): ReadableExportContext {
  const statusMap = new Map<string, StatusDef>();
  const cfMap = new Map<string, CustomFieldDef>();
  for (const l of lists) {
    for (const s of plugin.index.resolveStatusSet(l.path).statuses) if (!statusMap.has(s.id)) statusMap.set(s.id, s);
    for (const cf of plugin.index.resolveCustomFields(l.path)) if (!cfMap.has(cf.id)) cfMap.set(cf.id, cf);
  }
  // Fallback to workspace/location-level resolution for an empty scope.
  if (statusMap.size === 0) for (const s of plugin.index.resolveStatusSet().statuses) statusMap.set(s.id, s);
  if (cfMap.size === 0) for (const cf of plugin.index.resolveCustomFieldsForLocation(loc)) cfMap.set(cf.id, cf);
  const renderStats = plugin.index.buildRenderStats();
  return {
    statuses: Array.from(statusMap.values()),
    priorities: plugin.index.resolvePrioritiesForLocation(loc),
    customFields: Array.from(cfMap.values()),
    fieldLabels: plugin.index.resolveFieldLabelsForLocation(loc),
    subtaskStats: renderStats.subtasks,
    taskTitles: new Map(Array.from(plugin.index.tasksById.values()).map((task) => [task.data.id, task.data.title || task.data.id])),
  };
}

// Default readable columns for a scope export: a comprehensive built-in set plus
// every custom field present in the context.
export function defaultReadableColumns(ctx: ReadableExportContext): string[] {
  const builtin = [
    "custom_id", "title", "type", "status", "priority", "start_date", "due_date",
    "tags", "context", "time_estimate", "time_tracked", "sprint_points",
    "list", "folder", "space", "created_at", "updated_at",
  ];
  const cfs = ctx.customFields?.map((c) => `custom_field:${c.id}`) || [];
  return [...builtin, ...cfs];
}

function colLabel(col: string, ctx: ReadableExportContext): string {
  if (col.startsWith("custom_field:")) {
    const id = col.slice(13);
    return ctx.customFields?.find((c) => c.id === id)?.name || id;
  }
  return fieldLabelFrom(ctx?.fieldLabels, col) || col;
}

export function tasksToCsv(tasks: TaskFile[], cols: string[], plugin: InventTasksPlugin, ctx: ReadableExportContext): string {
  const header = cols.map((c) => csvEscape(colLabel(c, ctx))).join(",");
  const rows = tasks.map((t) => cols.map((c) => csvEscape(csvCellValue(t, c, plugin, ctx))).join(","));
  return "﻿" + [header, ...rows].join("\r\n"); // BOM so Excel reads UTF-8
}

// ---------- Native XLSX (minimal OOXML package, no runtime dependency) ----------

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function concatBytes(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

function zipStored(files: Array<{ name: string; data: string }>): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const now = new Date();
  const dosTime = ((now.getHours() & 31) << 11) | ((now.getMinutes() & 63) << 5) | ((now.getSeconds() / 2) & 31);
  const dosDate = (((Math.max(1980, now.getFullYear()) - 1980) & 127) << 9) | (((now.getMonth() + 1) & 15) << 5) | (now.getDate() & 31);

  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = encoder.encode(file.data);
    const checksum = crc32(data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // UTF-8 names
    lv.setUint16(8, 0, true);      // STORE — valid ZIP, no fake compression
    lv.setUint16(10, dosTime, true); lv.setUint16(12, dosDate, true);
    lv.setUint32(14, checksum, true);
    lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true); lv.setUint16(28, 0, true);
    local.set(name, 30);
    locals.push(local, data);

    const dir = new Uint8Array(46 + name.length);
    const dv = new DataView(dir.buffer);
    dv.setUint32(0, 0x02014b50, true);
    dv.setUint16(4, 20, true); dv.setUint16(6, 20, true);
    dv.setUint16(8, 0x0800, true); dv.setUint16(10, 0, true);
    dv.setUint16(12, dosTime, true); dv.setUint16(14, dosDate, true);
    dv.setUint32(16, checksum, true);
    dv.setUint32(20, data.length, true); dv.setUint32(24, data.length, true);
    dv.setUint16(28, name.length, true);
    dv.setUint16(30, 0, true); dv.setUint16(32, 0, true);
    dv.setUint16(34, 0, true); dv.setUint16(36, 0, true);
    dv.setUint32(38, 0, true); dv.setUint32(42, offset, true);
    dir.set(name, 46);
    central.push(dir);
    offset += local.length + data.length;
  }

  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true); ev.setUint16(6, 0, true);
  ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true); ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);
  return concatBytes([...locals, ...central, end]);
}

function xmlEsc(value: unknown): string {
  return Array.from(scalarText(value))
    .filter((char) => {
      const code = char.codePointAt(0)!;
      return code === 9 || code === 10 || code === 13 || (code >= 0x20 && code <= 0xd7ff)
        || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff);
    })
    .join("")
    .replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char]!));
}

function xlsxColumnName(index: number): string {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

type XlsxValue = { value: string | number | boolean; style?: number };

function excelDate(value: string): number | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!match) return null;
  const utc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4] || 0), Number(match[5] || 0), Number(match[6] || 0));
  return Number.isFinite(utc) ? utc / 86_400_000 + 25569 : null;
}

function xlsxCellValue(task: TaskFile, col: string, plugin: InventTasksPlugin, ctx: ReadableExportContext): XlsxValue {
  const data = task.data as unknown as Record<string, unknown>;
  if (["time_estimate", "time_tracked", "sprint_points"].includes(col) && typeof data[col] === "number") {
    return { value: data[col] };
  }
  if (["start_date", "due_date", "created_at", "updated_at"].includes(col) && typeof data[col] === "string") {
    const serial = excelDate(data[col]);
    if (serial !== null) return { value: serial, style: data[col].includes("T") || data[col].includes(" ") ? 3 : 2 };
  }
  if (col.startsWith("custom_field:")) {
    const id = col.slice(13);
    const field = ctx.customFields?.find((candidate: CustomFieldDef) => candidate.id === id);
    if (field) {
      const raw: unknown = effectiveCustomFieldValue(task, field, { subtaskStats: ctx.subtaskStats });
      if (["number", "money", "rating"].includes(field.type) && typeof raw === "number") return { value: raw, style: field.type === "money" ? 6 : undefined };
      if (["progress_manual", "progress_auto"].includes(field.type) && Number.isFinite(Number(raw))) return { value: Number(raw) / 100, style: 5 };
      if (field.type === "checkbox" && typeof raw === "boolean") return { value: raw };
      if (field.type === "time" && typeof raw === "string" && /^\d{2}:\d{2}/.test(raw)) {
        const [hours, minutes, seconds = 0] = raw.split(":").map(Number);
        return { value: (hours * 3600 + minutes * 60 + seconds) / 86_400, style: 4 };
      }
      if ((field.type === "date" || field.type === "datetime") && typeof raw === "string") {
        const serial = excelDate(raw);
        if (serial !== null) return { value: serial, style: field.type === "datetime" ? 3 : 2 };
      }
    }
  }
  return { value: csvCellValue(task, col, plugin, ctx) };
}

function xlsxCell(ref: string, entry: XlsxValue, header = false): string {
  const style = header ? 1 : entry.style;
  const styleAttr = style !== undefined ? ` s="${style}"` : "";
  if (typeof entry.value === "number") return `<c r="${ref}"${styleAttr}><v>${Number.isFinite(entry.value) ? entry.value : 0}</v></c>`;
  if (typeof entry.value === "boolean") return `<c r="${ref}" t="b"${styleAttr}><v>${entry.value ? 1 : 0}</v></c>`;
  return `<c r="${ref}" t="inlineStr"${styleAttr}><is><t xml:space="preserve">${xmlEsc(entry.value)}</t></is></c>`;
}

export function tasksToXlsx(tasks: TaskFile[], cols: string[], plugin: InventTasksPlugin, ctx: ReadableExportContext): Uint8Array<ArrayBuffer> {
  const rows: string[] = [];
  rows.push(`<row r="1">${cols.map((col, index) => xlsxCell(`${xlsxColumnName(index)}1`, { value: colLabel(col, ctx) }, true)).join("")}</row>`);
  tasks.forEach((task, taskIndex) => {
    const row = taskIndex + 2;
    rows.push(`<row r="${row}">${cols.map((col, index) => xlsxCell(`${xlsxColumnName(index)}${row}`, xlsxCellValue(task, col, plugin, ctx))).join("")}</row>`);
  });
  const lastCol = xlsxColumnName(Math.max(0, cols.length - 1));
  const lastRow = Math.max(1, tasks.length + 1);
  const widths = cols.map((col, index) => {
    const values = [colLabel(col, ctx), ...tasks.map((task) => csvCellValue(task, col, plugin, ctx))];
    const width = Math.min(60, Math.max(10, ...values.map((value) => Array.from(value).length + 2)));
    return `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`;
  }).join("");
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${lastCol}${lastRow}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${widths}</cols><sheetData>${rows.join("")}</sheetData><autoFilter ref="A1:${lastCol}${lastRow}"/></worksheet>`;
  const files = [
    { name: "[Content_Types].xml", data: `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>` },
    { name: "_rels/.rels", data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: "xl/workbook.xml", data: `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Items" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: "xl/styles.xml", data: `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="5"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd hh:mm"/><numFmt numFmtId="166" formatCode="hh:mm"/><numFmt numFmtId="167" formatCode="0%"/><numFmt numFmtId="168" formatCode="0.00"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE8EEF7"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="7"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="1" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="167" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="168" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>` },
    { name: "xl/worksheets/sheet1.xml", data: sheet },
  ];
  return zipStored(files);
}

export function tasksToReadableJson(tasks: TaskFile[], cols: string[], plugin: InventTasksPlugin, ctx: ReadableExportContext, scopeName: string): string {
  const rows = tasks.map((t) => {
    const o: Record<string, string> = {};
    for (const c of cols) o[colLabel(c, ctx)] = csvCellValue(t, c, plugin, ctx);
    return o;
  });
  return JSON.stringify({ scope: scopeName, exportedAt: new Date().toISOString(), count: rows.length, tasks: rows }, null, 2);
}

function mdCell(s: string): string {
  return s.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

export function tasksToMarkdown(scopeName: string, tasks: TaskFile[], cols: string[], plugin: InventTasksPlugin, ctx: ReadableExportContext): string {
  const lines: string[] = [];
  lines.push(`# ${scopeName}`, "", `_Exported ${new Date().toLocaleString()} — ${tasks.length} task(s)._`, "");
  if (tasks.length === 0) { lines.push("_No tasks._"); return lines.join("\n"); }
  lines.push("| " + cols.map((c) => mdCell(colLabel(c, ctx))).join(" | ") + " |");
  lines.push("| " + cols.map(() => "---").join(" | ") + " |");
  for (const t of tasks) {
    lines.push("| " + cols.map((c) => mdCell(csvCellValue(t, c, plugin, ctx))).join(" | ") + " |");
  }
  return lines.join("\n") + "\n";
}

function htmlEsc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}

function sanitizeHtmlFragment(html: string): string {
  // Parsed into an inert document: nothing in it runs or loads.
  const root = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html").body;
  const blocked = new Set(["script", "style", "iframe", "object", "embed", "link", "meta", "base", "form", "input", "textarea", "select", "button", "svg", "math"]);
  const urlAttrs = new Set(["href", "src", "xlink:href"]);
  const isSafeUrl = (value: string) => {
    const v = value.trim().toLowerCase();
    return !v || v.startsWith("#") || v.startsWith("/") || v.startsWith("./") || v.startsWith("../")
      || /^(https?:|mailto:|app:|obsidian:)/.test(v)
      || /^data:image\/(png|jpe?g|gif|webp|bmp|avif);/i.test(value.trim());
  };
  for (const el of Array.from(root.querySelectorAll("*"))) {
    const tag = el.tagName.toLowerCase();
    if (blocked.has(tag)) {
      el.remove();
      continue;
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) {
        el.removeAttribute(attr.name);
      } else if (urlAttrs.has(name) && !isSafeUrl(attr.value)) {
        el.removeAttribute(attr.name);
      } else if (name === "style") {
        el.removeAttribute(attr.name);
      }
    }
  }
  return root.innerHTML;
}

// Shared HTML chrome. `printButton` controls the toolbar (the print/PDF button
// + tip) — omitted when the user didn't ask to print.
function htmlDoc(title: string, meta: string, inner: string, printButton: boolean): string {
  const toolbar = printButton
    ? `<div class="toolbar"><button onclick="window.print()">Print / Save as PDF</button><span class="tip">Tip: in the print dialog choose “Save as PDF”.</span></div>`
    : "";
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${htmlEsc(title)} — InventTasks export</title>
<style>
  body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; margin: 24px; color: #1a1a1a; line-height: 1.5; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .meta { color: #666; font-size: 12px; margin-bottom: 16px; }
  .toolbar { margin-bottom: 16px; }
  .toolbar button { font: inherit; padding: 6px 12px; border: 1px solid #ccc; border-radius: 6px; background: #f6f6f6; cursor: pointer; }
  .tip { color: #888; font-size: 12px; margin-left: 8px; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  th, td { border: 1px solid #ddd; padding: 6px 8px; text-align: left; vertical-align: top; }
  th { background: #f3f3f3; }
  tr:nth-child(even) td { background: #fafafa; }
  .it-note-fields { margin: 12px 0 18px; }
  .it-note-fields .f { display: flex; gap: 8px; padding: 3px 0; border-bottom: 1px solid #eee; }
  .it-note-fields .fl { flex: 0 0 160px; color: #666; font-weight: 600; }
  .it-note-fields .fv { flex: 1 1 auto; }
  .it-note-cover { max-width: 100%; border-radius: 8px; margin: 8px 0 16px; }
  .it-note-body { margin-top: 8px; }
  .it-note-body img { max-width: 100%; height: auto; }
  .it-note-body h2 { font-size: 16px; }
  .it-note-att { display: flex; flex-wrap: wrap; gap: 10px; }
  .it-note-att img { max-height: 220px; border-radius: 6px; border: 1px solid #eee; }
  @media print { .toolbar { display: none; } body { margin: 0; } }
</style></head>
<body>
  <h1>${htmlEsc(title)}</h1>
  <div class="meta">${meta}</div>
  ${toolbar}
  ${inner}
</body></html>`;
}

export function tasksToHtml(scopeName: string, tasks: TaskFile[], cols: string[], plugin: InventTasksPlugin, ctx: ReadableExportContext, opts?: { printButton?: boolean }): string {
  const head = cols.map((c) => `<th>${htmlEsc(colLabel(c, ctx))}</th>`).join("");
  const body = tasks.map((t) =>
    "<tr>" + cols.map((c) => `<td>${htmlEsc(csvCellValue(t, c, plugin, ctx))}</td>`).join("") + "</tr>"
  ).join("\n");
  const inner = `<table><thead><tr>${head}</tr></thead><tbody>\n${body}\n</tbody></table>`;
  return htmlDoc(scopeName, `Exported ${htmlEsc(new Date().toLocaleString())} — ${tasks.length} task(s)`, inner, !!opts?.printButton);
}

// ---------- Single-task "note" export (document, not a table) ----------

// The fields shown in a task note, one under another. Empty values are skipped.
function noteFields(ctx: ReadableExportContext): string[] {
  const builtin = [
    "type", "status", "priority", "start_date", "due_date",
    "time_estimate", "time_tracked", "sprint_points", "tags", "context",
    "list", "folder", "space", "created_at", "updated_at",
  ];
  const cfs = ctx.customFields?.map((c) => `custom_field:${c.id}`) || [];
  return [...builtin, ...cfs];
}

const IMG_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;

// Removes only a leading `# <title>` heading (the auto-generated one) so the
// note body / Description isn't duplicated under the H1 — everything else is
// kept verbatim.
function stripLeadingTitle(body: string, title: string): string {
  const lines = (body || "").replace(/^\s+/, "").split(/\r?\n/);
  if (lines.length && lines[0].trim() === `# ${title}`.trim()) lines.shift();
  return lines.join("\n").trim();
}

// Direct child tasks of `id` (subtasks).
function childTasks(plugin: InventTasksPlugin, id: string): TaskFile[] {
  const out: TaskFile[] = [];
  plugin.index.tasksById.forEach((tf) => { if (parentTaskIds(tf.data).includes(id)) out.push(tf); });
  return out;
}
function statusNameOf(plugin: InventTasksPlugin, tf: TaskFile): string {
  return plugin.index.resolveStatusSet(tf.listPath).statuses.find((s) => s.id === tf.data.status)?.name || tf.data.status || "";
}
function titlesOf(plugin: InventTasksPlugin, ids: string[]): string[] {
  return ids.map((id) => plugin.index.tasksById.get(id)?.data.title || id);
}

export function taskToMarkdownNote(plugin: InventTasksPlugin, tf: TaskFile, ctx: ReadableExportContext): string {
  const d = tf.data;
  const out: string[] = [];
  out.push(`# ${d.title || t("common.untitled")}`, "");
  if (d.cover_image) out.push(`![cover](${d.cover_image})`, "");

  // Fields — each on its own line (a list keeps them one-under-another).
  const fieldLines: string[] = [];
  for (const f of noteFields(ctx)) {
    const v = csvCellValue(tf, f, plugin, ctx);
    if (v && v.trim()) fieldLines.push(`- **${colLabel(f, ctx)}:** ${v.replace(/\r?\n/g, " ")}`);
  }
  if (fieldLines.length) out.push("## Details", ...fieldLines, "");

  // Description (the markdown body) — always present as its own section.
  const desc = stripLeadingTitle(tf.body, d.title || "");
  out.push("## Description", "", desc || "_(empty)_", "");

  // Subtasks
  const kids = childTasks(plugin, d.id);
  if (kids.length) {
    out.push("## Subtasks");
    for (const k of kids) out.push(`- [${statusNameOf(plugin, k)}] ${k.data.title || t("common.untitled")}`);
    out.push("");
  }

  // Relationships
  const blocks = titlesOf(plugin, getBlocks(tf));
  const waiting = titlesOf(plugin, getWaitingOn(tf, plugin.index));
  const related = titlesOf(plugin, getRelated(tf, plugin.index));
  if (blocks.length || waiting.length || related.length) {
    out.push("## Relationships");
    if (blocks.length) out.push(`- **Blocks:** ${blocks.join(", ")}`);
    if (waiting.length) out.push(`- **Waiting on:** ${waiting.join(", ")}`);
    if (related.length) out.push(`- **Related:** ${related.join(", ")}`);
    out.push("");
  }

  if (d.checklist?.length) {
    out.push("## Checklist");
    for (const it of d.checklist) out.push(`- [${it.done ? "x" : " "}] ${it.text}`);
    out.push("");
  }

  if (d.attachments?.length) {
    out.push("## Attachments");
    for (const a of d.attachments) {
      const vp = resolveAttachmentVaultPath(plugin.index, d.id, a);
      out.push(IMG_RE.test(a.name || vp) ? `![${a.name}](${vp})` : `- [${a.name}](${vp})`);
    }
    out.push("");
  }

  return out.join("\n").trim() + "\n";
}

function resourceUrl(plugin: InventTasksPlugin, vaultPath: string): string | null {
  try { return plugin.app.vault.adapter.getResourcePath(vaultPath) || null; } catch { return null; }
}

export async function taskToHtmlNote(plugin: InventTasksPlugin, tf: TaskFile, ctx: ReadableExportContext, opts: { printButton: boolean }): Promise<string> {
  const d = tf.data;

  // Render the Description (markdown body) to HTML so formatting + images show.
  let bodyHtml = "";
  const bodyMd = stripLeadingTitle(tf.body, d.title || "");
  if (bodyMd) {
    const tmp = createDiv();
    const comp = new Component();
    try {
      await MarkdownRenderer.render(plugin.app, bodyMd, tmp, tf.filePath || "", comp);
      bodyHtml = sanitizeHtmlFragment(tmp.innerHTML);
    } catch { bodyHtml = ""; }
    comp.unload();
  }

  const fieldRows = noteFields(ctx).map((f) => {
    const v = csvCellValue(tf, f, plugin, ctx);
    return v && v.trim() ? `<div class="f"><span class="fl">${htmlEsc(colLabel(f, ctx))}</span><span class="fv">${htmlEsc(v)}</span></div>` : "";
  }).join("");

  let coverHtml = "";
  if (d.cover_image) {
    const src = resolveCoverUrl(plugin.index, d.cover_image);
    if (src) coverHtml = `<img class="it-note-cover" src="${htmlEsc(src)}">`;
  }

  const section = (title: string, inner: string) => inner ? `<h2>${htmlEsc(title)}</h2>${inner}` : "";

  // Subtasks
  const kids = childTasks(plugin, d.id);
  const subtasksHtml = section(t("task.subtasks.title"), kids.length
    ? `<ul>${kids.map((k) => `<li>[${htmlEsc(statusNameOf(plugin, k))}] ${htmlEsc(k.data.title || t("common.untitled"))}</li>`).join("")}</ul>` : "");

  // Relationships
  const blocks = titlesOf(plugin, getBlocks(tf));
  const waiting = titlesOf(plugin, getWaitingOn(tf, plugin.index));
  const related = titlesOf(plugin, getRelated(tf, plugin.index));
  const relRows = [
    blocks.length ? `<div class="f"><span class="fl">${htmlEsc(t("task.relationships.blocks"))}</span><span class="fv">${htmlEsc(blocks.join(", "))}</span></div>` : "",
    waiting.length ? `<div class="f"><span class="fl">${htmlEsc(t("task.relationships.waitingOn"))}</span><span class="fv">${htmlEsc(waiting.join(", "))}</span></div>` : "",
    related.length ? `<div class="f"><span class="fl">${htmlEsc(t("task.relationships.related"))}</span><span class="fv">${htmlEsc(related.join(", "))}</span></div>` : "",
  ].join("");
  const relHtml = section(t("task.relationships.title"), relRows ? `<div class="it-note-fields">${relRows}</div>` : "");

  const checklistHtml = section(t("task.checklist.title"), d.checklist?.length
    ? `<ul style="list-style:none;padding-left:0">${d.checklist.map((it) => `<li>${it.done ? "☑" : "☐"} ${htmlEsc(it.text)}</li>`).join("")}</ul>` : "");

  let attHtml = "";
  if (d.attachments?.length) {
    const parts = d.attachments.map((a) => {
      const vp = resolveAttachmentVaultPath(plugin.index, d.id, a);
      const url = resourceUrl(plugin, vp);
      if (url && IMG_RE.test(a.name || vp)) return `<img src="${htmlEsc(url)}" alt="${htmlEsc(a.name)}">`;
      return `<div>📎 ${htmlEsc(a.name)}</div>`;
    }).join("");
    attHtml = section(t("task.attachments.title"), `<div class="it-note-att">${parts}</div>`);
  }

  const descHtml = `<h2>${htmlEsc(t("task.description.title"))}</h2><div class="it-note-body">${bodyHtml || `<em>${htmlEsc(t("task.description.empty"))}</em>`}</div>`;
  const inner = `${coverHtml}<div class="it-note-fields">${fieldRows}</div>${descHtml}${subtasksHtml}${relHtml}${checklistHtml}${attHtml}`;
  return htmlDoc(d.title || t("gantt.task"), t("export.htmlSubtitle", { date: new Date().toLocaleString() }), inner, opts.printButton);
}

// ---------- File output ----------

export function safeFilenameBase(name: string): string {
  return (name || "export").replace(/[^a-zA-Z0-9_\- ]+/g, "-").replace(/\s+/g, "-").replace(/^-+|-+$/g, "") || "export";
}

export function downloadFile(filename: string, content: BlobPart, mime: string) {
  const blob = new Blob([content], { type: typeof content === "string" ? mime + ";charset=utf-8;" : mime });
  const url = URL.createObjectURL(blob);
  const a = createEl("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

// Opens the system print dialog with the given HTML (for "Save as PDF"). Uses a
// hidden iframe so only this content prints, not the Obsidian window.
export function printHtml(html: string) {
  const iframe = createEl("iframe");
  iframe.addClass("it-print-frame");
  document.body.appendChild(iframe);
  const doc = iframe.contentWindow?.document;
  if (!doc) { iframe.remove(); return; }
  doc.open();
  doc.write(html);
  doc.close();
  const win = iframe.contentWindow;
  const go = () => {
    try { win.focus(); win.print(); } catch { /* ignore */ }
    window.setTimeout(() => iframe.remove(), 1000);
  };
  // Give the iframe a tick to lay out before printing.
  window.setTimeout(go, 150);
}

// ---------- Image handling for note exports (embed vs folder) ----------

export type ImageMode = "embed" | "folder";

function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(typeof r.result === "string" ? r.result : "");
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

function extFromMime(mime: string, src: string): string {
  const map: Record<string, string> = {
    "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp",
    "image/svg+xml": "svg", "image/bmp": "bmp", "image/avif": "avif",
  };
  if (map[mime]) return map[mime];
  const m = src.split("?")[0].match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : "png";
}

// Replaces every <img src> with a base64 data-URI so the HTML is self-contained
// and renders anywhere (not just inside Obsidian where app:// resolves).
async function inlineHtmlImages(html: string): Promise<string> {
  const srcs = new Set<string>();
  const re = /<img\b[^>]*?\ssrc="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) srcs.add(m[1]);
  const map = new Map<string, string>();
  for (const s of srcs) {
    if (s.startsWith("data:")) continue;
    try { const resp = await fetch(s); map.set(s, await blobToDataUri(await resp.blob())); } catch { /* keep original */ }
  }
  return html.replace(/(<img\b[^>]*?\ssrc=")([^"]+)(")/g, (full: string, a: string, s: string, b: string) => (map.has(s) ? a + map.get(s) + b : full));
}

async function ensureExportFolder(plugin: InventTasksPlugin, baseName: string): Promise<string> {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const folder = normalizePath(`_exports/${safeFilenameBase(baseName)}-${stamp}`);
  await plugin.index.ensureFolder(folder);
  return folder;
}

// Writes the HTML + an images/ subfolder (copied image files, relative srcs)
// into a new vault folder. Returns the folder path.
async function exportHtmlFolder(plugin: InventTasksPlugin, html: string, baseName: string): Promise<string> {
  const folder = await ensureExportFolder(plugin, baseName);
  const imagesDir = `${folder}/images`;
  await plugin.index.ensureFolder(imagesDir);
  const srcs = new Set<string>();
  const re = /<img\b[^>]*?\ssrc="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) srcs.add(m[1]);
  const map = new Map<string, string>();
  let i = 0;
  for (const s of srcs) {
    if (s.startsWith("data:")) continue;
    try {
      const blob = await (await fetch(s)).blob();
      const name = `img-${++i}.${extFromMime(blob.type, s)}`;
      await plugin.app.vault.adapter.writeBinary(`${imagesDir}/${name}`, await blob.arrayBuffer());
      map.set(s, `images/${name}`);
    } catch { /* keep original src */ }
  }
  const out = html.replace(/(<img\b[^>]*?\ssrc=")([^"]+)(")/g, (full: string, a: string, s: string, b: string) => (map.has(s) ? a + map.get(s) + b : full));
  await plugin.app.vault.adapter.write(`${folder}/${safeFilenameBase(baseName)}.html`, out);
  return folder;
}

// Writes the Markdown + an images/ subfolder, rewriting vault image embeds
// (`![[...]]` and `![](vault/path)`) to relative `images/...` links.
async function exportMarkdownFolder(plugin: InventTasksPlugin, tf: TaskFile, md: string, baseName: string): Promise<string> {
  const app = plugin.app;
  const folder = await ensureExportFolder(plugin, baseName);
  const imagesDir = `${folder}/images`;
  await plugin.index.ensureFolder(imagesDir);
  let i = 0;
  const copied = new Map<string, string>(); // vault path → relative
  const copyVaultFile = async (file: { path: string; name: string }): Promise<string | null> => {
    if (copied.has(file.path)) return copied.get(file.path)!;
    try {
      const buf = await app.vault.adapter.readBinary(file.path);
      const safe = `${++i}-${file.name}`.replace(/[^a-zA-Z0-9_.-]/g, "_");
      await app.vault.adapter.writeBinary(`${imagesDir}/${safe}`, buf);
      const rel = `images/${safe}`;
      copied.set(file.path, rel);
      return rel;
    } catch { return null; }
  };

  let out = md;
  // Wiki embeds: ![[name|...]]
  const wiki = [...md.matchAll(/!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)];
  for (const w of wiki) {
    const file = app.metadataCache.getFirstLinkpathDest(w[1].trim(), tf.filePath || "");
    if (file) { const rel = await copyVaultFile(file); if (rel) out = out.split(w[0]).join(`![](${rel})`); }
  }
  // Standard embeds: ![alt](target) — only local vault targets.
  const std = [...out.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)];
  for (const s of std) {
    const target = s[2].trim();
    if (/^(https?:|data:|app:|images\/)/i.test(target)) continue;
    const af: (TAbstractFile & { extension?: string }) | null = app.vault.getAbstractFileByPath(normalizePath(target));
    if (af && af.extension) { const rel = await copyVaultFile(af); if (rel) out = out.split(s[0]).join(`![${s[1]}](${rel})`); }
  }
  await app.vault.adapter.write(`${folder}/${safeFilenameBase(baseName)}.md`, out);
  return folder;
}

const MIME: Record<ReadableFormat | "json-backup", string> = {
  csv: "text/csv",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  markdown: "text/markdown",
  html: "text/html",
  json: "application/json",
  "json-backup": "application/json",
};
const EXT: Record<ReadableFormat | "json-backup", string> = {
  csv: "csv", xlsx: "xlsx", markdown: "md", html: "html", json: "json", "json-backup": "inventtasks.json",
};

// High-level: build a readable export for a set of tasks + columns and download
// it (and optionally open the print dialog for HTML).
export async function exportReadable(opts: {
  plugin: InventTasksPlugin;
  format: ReadableFormat;
  scopeName: string;
  tasks: TaskFile[];
  cols: string[];
  ctx: ReadableExportContext;
  openPrint?: boolean;
  // When set (single-task export), Markdown/HTML render as a full note
  // document (body + fields + media) instead of a one-row table.
  noteTask?: TaskFile;
  // Image handling for note exports: "embed" → self-contained file (HTML uses
  // data-URI); "folder" → write a vault folder with the doc + images/.
  imageMode?: ImageMode;
}) {
  const { plugin, format, scopeName, tasks, cols, ctx } = opts;
  const printButton = !!opts.openPrint;

  // Single-task note (Markdown/HTML) with image handling.
  if (opts.noteTask && (format === "markdown" || format === "html")) {
    if (format === "html") {
      const html = await taskToHtmlNote(plugin, opts.noteTask, ctx, { printButton });
      if (opts.imageMode === "folder") {
        const folder = await exportHtmlFolder(plugin, html, scopeName);
        if (opts.openPrint) printHtml(html);          // print uses app:// (resolves in Obsidian)
        new Notice(t("notice.exportedFolder", { folder }));
        return;
      }
      const inlined = await inlineHtmlImages(html);     // embed → self-contained
      downloadFile(`${safeFilenameBase(scopeName)}.html`, inlined, MIME.html);
      if (opts.openPrint) printHtml(inlined);
      new Notice(t("notice.exportedHtml", { name: safeFilenameBase(scopeName) }));
      return;
    }
    // markdown note
    const md = taskToMarkdownNote(plugin, opts.noteTask, ctx);
    if (opts.imageMode === "folder") {
      const folder = await exportMarkdownFolder(plugin, opts.noteTask, md, scopeName);
      new Notice(t("notice.exportedFolder", { folder }));
      return;
    }
    downloadFile(`${safeFilenameBase(scopeName)}.md`, md, MIME.markdown);
    new Notice(t("notice.exportedMd", { name: safeFilenameBase(scopeName) }));
    return;
  }

  let content: BlobPart = "";
  if (format === "csv") content = tasksToCsv(tasks, cols, plugin, ctx);
  else if (format === "xlsx") content = tasksToXlsx(tasks, cols, plugin, ctx);
  else if (format === "markdown") content = tasksToMarkdown(scopeName, tasks, cols, plugin, ctx);
  else if (format === "html") content = tasksToHtml(scopeName, tasks, cols, plugin, ctx, { printButton });
  else content = tasksToReadableJson(tasks, cols, plugin, ctx, scopeName);
  const filename = `${safeFilenameBase(scopeName)}.${EXT[format]}`;
  downloadFile(filename, content, MIME[format]);
  if (format === "html" && opts.openPrint) printHtml(content as string);
  new Notice(t("notice.exportedFile", { count: tasks.length, filename }));
}

export async function exportBackup(plugin: InventTasksPlugin, scope: ExportScope, ref: { path?: string; taskId?: string }) {
  const bundle = await buildBackup(plugin, scope, ref);
  const filename = `${safeFilenameBase(bundle.scopeName)}.${EXT["json-backup"]}`;
  downloadFile(filename, JSON.stringify(bundle, null, 2), MIME["json-backup"]);
  const n = gatherScopeTasks(plugin, scope, ref).length;
  new Notice(t("notice.backupExported", { filename, count: n }));
}

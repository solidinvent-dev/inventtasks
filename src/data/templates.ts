// Templates — reusable Space / Folder / List / Task blueprints.
//
// A template is just a captured backup bundle (see export.ts) plus metadata,
// stored as JSON under `<root>/_templates/`. Creating "from template" =
// instantiating the bundle via importBackup (collision-safe, id-remapped),
// renaming the top-level item to the user's chosen name.

import { Notice, normalizePath, TFile } from "obsidian";
import type InventTasksPlugin from "../main";
import { t } from "../i18n";
import { ExportScope, BackupBundle, buildBackup } from "./export";
import { importBackup, ImportDestination, ImportResult } from "./import";
import { slugify } from "../utils/slug";

export type TemplateLevel = "space" | "folder" | "list" | "task";

export interface TemplateFile {
  format: "inventtasks-template";
  version: 1;
  template_id: string;
  name: string;
  description?: string;
  icon?: string;
  level: TemplateLevel;
  createdAt: string;
  bundle: BackupBundle;
  __path?: string;   // internal: source file path (for delete)
}

// In-memory cache, populated at startup and refreshed on save/delete. The
// create modals read it synchronously.
let cache: TemplateFile[] = [];

function templatesDir(plugin: InventTasksPlugin): string {
  const root = plugin.index.rootPath;
  return root && root !== "/" ? `${root}/_templates` : "_templates";
}

export async function loadTemplates(plugin: InventTasksPlugin): Promise<void> {
  cache = [];
  const dir = templatesDir(plugin);
  const adapter: any = plugin.app.vault.adapter;
  try {
    if (!(await adapter.exists(dir))) return;
    const listing = await adapter.list(dir);
    for (const f of listing.files as string[]) {
      if (!f.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(await adapter.read(f));
        if (parsed?.format === "inventtasks-template" && parsed.bundle) {
          parsed.__path = f;
          cache.push(parsed as TemplateFile);
        }
      } catch { /* skip unreadable / malformed template */ }
    }
    cache.sort((a, b) => a.name.localeCompare(b.name));
  } catch { /* dir missing — no templates */ }
}

export function getTemplates(level?: TemplateLevel): TemplateFile[] {
  return level ? cache.filter((t) => t.level === level) : cache.slice();
}

// Captures a full bundle for a scope (used by the Save-as-template modal, which
// then lets the user prune it before writing via saveTemplateBundle).
export async function buildTemplateBundle(plugin: InventTasksPlugin, scope: ExportScope, ref: { path?: string; taskId?: string }): Promise<BackupBundle> {
  return buildBackup(plugin, scope, ref, { includeSubtasks: scope === "task" });
}

export interface TemplateStats { spaces: number; folders: number; lists: number; tasks: number; views: number; }

// Counts what a template's bundle contains (for previews).
export function templateStats(tpl: TemplateFile): TemplateStats {
  const b = tpl.bundle;
  const s: TemplateStats = { spaces: 0, folders: 0, lists: 0, tasks: 0, views: 0 };
  const cntList = (bl: any) => { s.lists++; s.tasks += bl.tasks?.length || 0; s.views += bl.views?.length || 0; };
  const cntFolder = (bf: any) => { s.folders++; s.views += bf.views?.length || 0; (bf.lists || []).forEach(cntList); };
  const cntSpace = (bs: any) => { s.spaces++; s.views += bs.views?.length || 0; (bs.folders || []).forEach(cntFolder); (bs.lists || []).forEach(cntList); };
  if (b.spaces) b.spaces.forEach(cntSpace);
  if (b.space) cntSpace(b.space);
  if (b.folder) cntFolder(b.folder);
  if (b.list) cntList(b.list);
  if (b.task) { s.tasks += 1 + (b.task_subtasks?.length || 0); }
  s.views += b.globalViews?.length || 0;
  return s;
}

export function templateSummaryText(tpl: TemplateFile): string {
  const s = templateStats(tpl);
  const parts: string[] = [];
  const add = (n: number, one: string) => { if (n) parts.push(`${n} ${one}${n > 1 ? "s" : ""}`); };
  add(s.spaces, "space"); add(s.folders, "folder"); add(s.lists, "list"); add(s.tasks, "task"); add(s.views, "view");
  return parts.join(" · ") || "empty";
}

// Rewrites a template's metadata (name / description / icon) in place.
export async function updateTemplate(
  plugin: InventTasksPlugin,
  tpl: TemplateFile,
  patch: { name?: string; description?: string; icon?: string },
): Promise<void> {
  if (!tpl.__path) return;
  const next: any = { ...tpl, ...patch };
  if (patch.name !== undefined) next.name = patch.name.trim() || tpl.name;
  if (patch.description !== undefined) next.description = patch.description.trim() || undefined;
  delete next.__path;
  await plugin.app.vault.adapter.write(tpl.__path, JSON.stringify(next, null, 2));
  await loadTemplates(plugin);
}

export async function deleteTemplate(plugin: InventTasksPlugin, tpl: TemplateFile): Promise<void> {
  if (!tpl.__path) return;
  const f = plugin.app.vault.getAbstractFileByPath(tpl.__path);
  if (f instanceof TFile) await plugin.app.fileManager.trashFile(f);
  await loadTemplates(plugin);
}

// Imports an (already pruned) bundle. Clones first so the source is untouched.
export async function instantiateBundle(
  plugin: InventTasksPlugin,
  bundle: BackupBundle,
  dest: ImportDestination,
  topName?: string,
): Promise<ImportResult> {
  return importBackup(plugin, JSON.parse(JSON.stringify(bundle)) as BackupBundle, dest, { topName });
}

// Writes a template from an already-built (and possibly pruned) bundle.
export async function saveTemplateBundle(
  plugin: InventTasksPlugin,
  level: TemplateLevel,
  bundle: BackupBundle,
  meta: { name: string; description?: string; icon?: string },
): Promise<void> {
  const id = `TPL-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const tpl: TemplateFile = {
    format: "inventtasks-template",
    version: 1,
    template_id: id,
    name: (meta.name || "Template").trim() || "Template",
    description: meta.description?.trim() || undefined,
    icon: meta.icon || undefined,
    level,
    createdAt: new Date().toISOString(),
    bundle,
  };
  const dir = templatesDir(plugin);
  await plugin.index.ensureFolder(dir);
  const file = normalizePath(`${dir}/${slugify(tpl.name) || "template"}-${id.toLowerCase()}.json`);
  await plugin.app.vault.adapter.write(file, JSON.stringify(tpl, null, 2));
  await loadTemplates(plugin);
  new Notice(t("notice.templateSaved", { name: tpl.name }));
}

// ---------- Element selection + pruning ----------

// Per-section config keys (a Space/Folder/List ConfigurableSet) — exposed
// individually so the user can keep e.g. statuses but drop label styles.
export const CONFIG_SECTION_DEFS: Array<{ key: string; label: string }> = [
  { key: "status_set", label: "Statuses" },
  { key: "priorities", label: "Priorities" },
  { key: "task_types", label: "Item types" },
  { key: "tags_palette", label: "Tags palette" },
  { key: "context_labels", label: "Context labels" },
  { key: "custom_fields", label: "Custom fields" },
  { key: "view_defaults", label: "View defaults" },
  { key: "features", label: "Features" },
  { key: "empty_positions", label: "Empty positions" },
  { key: "chip_styles", label: "Label styles" },
  { key: "task_behavior", label: "Item behavior" },
  { key: "notifications_enabled", label: "Notification rules" },
  { key: "calendar_sync", label: "Calendar sync rules" },
];
const CONFIG_SET_KEYS = CONFIG_SECTION_DEFS.map((d) => d.key);

// Individual task fields/sections — what to keep on every captured task.
export const TASK_FIELD_DEFS: Array<{ key: string; label: string }> = [
  { key: "description", label: "Description" },
  { key: "status", label: "Status" },
  { key: "priority", label: "Priority" },
  { key: "dates", label: "Dates (start/due)" },
  { key: "tags", label: "Tags" },
  { key: "context", label: "Context" },
  { key: "time", label: "Time est/tracked" },
  { key: "sprint_points", label: "Sprint points" },
  { key: "custom_fields", label: "Custom fields" },
  { key: "checklist", label: "Checklist" },
  { key: "relationships", label: "Relationships" },
  { key: "documents", label: "Documents" },
  { key: "cover", label: "Cover image" },
  { key: "attachments", label: "Attachments" },
  { key: "activity", label: "Activity log" },
  { key: "comments", label: "Comments" },
  { key: "recurring", label: "Recurring" },
];

// What to keep when saving / applying a template. `excluded` holds structural
// node keys the user unchecked: `s:|f:|l:<srcPath>` for containers, `t:<id>`
// for tasks. `configSections` / `taskFields` are the included keys.
export interface ElementSelection {
  excluded: Set<string>;
  configSections: Set<string>;   // included container config sections
  views: boolean;                // saved views
  taskFields: Set<string>;       // included per-task fields/sections
  subtasks: boolean;             // task template: include descendant tasks
}

export function defaultSelection(): ElementSelection {
  return {
    excluded: new Set(),
    configSections: new Set(CONFIG_SET_KEYS),
    views: true,
    taskFields: new Set(TASK_FIELD_DEFS.map((d) => d.key)),
    subtasks: true,
  };
}

function stripConfig(cfg: any, sel: ElementSelection) {
  for (const k of CONFIG_SET_KEYS) if (!sel.configSections.has(k)) delete cfg[k];
  if (!sel.configSections.has("notifications_enabled")) {
    delete cfg.notify_system;
    delete cfg.notify_ntfy;
  }
  if (!sel.configSections.has("calendar_sync")) {
    delete cfg.calendar_sync_status_policy;
    delete cfg.calendar_sync_rules;
  }
}

// Returns a new bundle filtered by the selection.
export function pruneBundle(bundle: BackupBundle, sel: ElementSelection): BackupBundle {
  const b: any = JSON.parse(JSON.stringify(bundle));
  const has = (k: string) => sel.taskFields.has(k);
  const taskKept = (t: any) => !sel.excluded.has(`t:${t.data.id}`);
  const pruneTask = (t: any) => {
    const d = t.data;
    if (!has("description")) t.body = "";
    if (!has("status")) { delete d.status; delete d.status_group; }
    if (!has("priority")) d.priority = null;
    if (!has("dates")) { d.start_date = null; d.due_date = null; }
    if (!has("tags")) d.tags = [];
    if (!has("context")) d.context = [];
    if (!has("time")) { delete d.time_estimate; delete d.time_tracked; }
    if (!has("sprint_points")) delete d.sprint_points;
    if (!has("custom_fields")) delete d.custom_fields;
    if (!has("checklist")) delete d.checklist;
    if (!has("relationships")) delete d.relationships;
    if (!has("documents")) delete d.documents;
    if (!has("cover")) delete d.cover_image;
    if (!has("attachments")) delete d.attachments;
    if (!has("activity")) delete d.activity;
    if (!has("comments")) delete d.comments;
    if (!has("recurring")) delete d.recurring;
    return t;
  };
  const pruneList = (bl: any) => {
    bl.tasks = (bl.tasks || []).filter(taskKept).map(pruneTask);
    if (!sel.views) bl.views = [];
    stripConfig(bl.config, sel);
    return bl;
  };
  const pruneFolder = (bf: any) => {
    bf.lists = (bf.lists || []).filter((l: any) => !sel.excluded.has(`l:${l.srcPath}`)).map(pruneList);
    if (!sel.views) bf.views = [];
    stripConfig(bf.config, sel);
    return bf;
  };
  const pruneSpace = (bs: any) => {
    bs.folders = (bs.folders || []).filter((f: any) => !sel.excluded.has(`f:${f.srcPath}`)).map(pruneFolder);
    bs.lists = (bs.lists || []).filter((l: any) => !sel.excluded.has(`l:${l.srcPath}`)).map(pruneList);
    if (!sel.views) bs.views = [];
    stripConfig(bs.config, sel);
    return bs;
  };
  if (b.spaces) b.spaces = b.spaces.filter((s: any) => !sel.excluded.has(`s:${s.srcPath}`)).map(pruneSpace);
  if (b.space) b.space = pruneSpace(b.space);
  if (b.folder) b.folder = pruneFolder(b.folder);
  if (b.list) b.list = pruneList(b.list);
  if (b.task) {
    pruneTask(b.task);
    if (!sel.subtasks) delete b.task_subtasks;
    else b.task_subtasks = (b.task_subtasks || []).filter(taskKept).map(pruneTask);
  }
  if (!sel.views) b.globalViews = [];
  if (Array.isArray(b.rawFiles)) {
    const keptTaskIds = new Set<string>();
    const addTaskIds = (tasks: any[]) => tasks.forEach((t) => t?.data?.id && keptTaskIds.add(t.data.id));
    const walkList = (bl: any) => addTaskIds(bl.tasks || []);
    const walkFolder = (bf: any) => (bf.lists || []).forEach(walkList);
    const walkSpace = (bs: any) => { (bs.folders || []).forEach(walkFolder); (bs.lists || []).forEach(walkList); };
    (b.spaces || []).forEach(walkSpace);
    if (b.space) walkSpace(b.space);
    if (b.folder) walkFolder(b.folder);
    if (b.list) walkList(b.list);
    if (b.task) addTaskIds([b.task]);
    addTaskIds(b.task_subtasks || []);
    b.rawFiles = b.rawFiles.filter((f: any) => {
      if (f.kind === "attachment" && !sel.taskFields.has("attachments")) return false;
      if (f.kind === "doc" && !sel.taskFields.has("documents")) return false;
      const m = String(f.path || "").match(/(?:^|\/)_attachments\/([^/]+)\//);
      return !m || keptTaskIds.has(m[1]);
    });
  }
  return b as BackupBundle;
}

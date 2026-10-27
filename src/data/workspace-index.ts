import { App, TFile, TFolder, EventRef, Notice, normalizePath } from "obsidian";
import {
  SpaceConfig, FolderConfig, ListConfig, WorkspaceConfig,
  SpaceNode, FolderNode, ListNode, TaskFile, ViewConfig,
  StatusDef, ResolvedStatusSet, CustomFieldDef, PriorityDef,
  ViewDefaults, ViewType, ContextLocation, TaskType, SidebarOrder,
  ChipKind, ChipStyles, ResolvedChipStyles, parentTaskIds, normalizeParentTask,
  DocMeta, DocPage, FavLocation,
} from "../types";
import {
  parseTaskFile, parseSpaceConfig, parseFolderConfig, parseListConfig,
  parseWorkspaceConfig, parseViewConfig, parseDocMeta, parseDocPage,
  serializeTask, joinFrontmatter, splitFrontmatter
} from "./parsers";
import { t } from "../i18n";
import { absoluteLocationKey, portableLocationKey } from "../view-state";
import { limit, freeLimit, licenseConsistent } from "./license";
import { canAttachSubtask, isDescendantOf } from "./subtasks";
import { sidebarOrderResolvesFully } from "./sidebar-order";
import {
  WORKSPACE_FILE, SPACE_FILE, FOLDER_FILE, LIST_FILE, VIEWS_DIR, DOCS_DIR,
  DOC_ACCENT, DOC_ICON,
  DEFAULT_STATUS_SET, DEFAULT_PRIORITIES, DEFAULT_TASK_TYPES, DEFAULT_CONTEXT_LABELS,
  DEFAULT_CHIP_STYLES, defaultResolvedChipStyles,
  defaultVisibleFor, CHIP_KINDS, DEFAULT_MODAL_DISPLAY_FEATURES,
} from "../constants";
import { nowIso, todayKey, dayKey } from "../utils/dates";
import { safeFileName, slugify } from "../utils/slug";
import { appendActivity } from "./activity";
import { copyAllAttachmentsForTask, deleteAllAttachmentsForTask } from "./attachments";
import { rescheduleOnClose } from "./recurring";
import { MAX_TASK_TITLE_LENGTH, parseNonNegativeInteger, validateTaskTitle } from "./task-values";

type Listener = () => void;

interface DuplicateTaskIdIssue {
  id: string;
  duplicatePath: string;
  keptPath: string;
}

const SYSTEM_SPACE_NAME = "System";
const SYSTEM_REMINDERS_NAME = "Reminders";
const SYSTEM_SHORT_NOTES_NAME = "Short notes";
export type SystemListKind = "reminders" | "short_notes";

const SYSTEM_LIST_FEATURES: Record<string, boolean> = {
  time_tracking: false,
  time_estimate: false,
  sprint_points: false,
  dependencies: false,
  custom_task_types: false,
  recurring_tasks: false,
  incomplete_warning: false,
  dependency_warning: false,
  nested_subtasks: false,
  multiple_lists: false,
};

// One entry in the Trash view — either a soft-deleted task (path = file) or a
// soft-deleted container (path = folder).
export interface TrashedItem {
  kind: "task" | "space" | "folder" | "list";
  name: string;
  id?: string;        // tasks only
  trashedAt?: string;
  from?: string;      // original parent path (list dir for tasks; parent dir for containers)
  path: string;       // task: file path; container: folder path
}

// Every container marker file (`_workspace.md`, `_space.md`, `_folder.md`,
// `_list.md`) is created with a leading `# <name>` heading. That heading is the
// only human-readable title when the file is opened directly in Obsidian, so a
// rename has to carry it along — otherwise the marker keeps advertising the old
// name forever. Nothing parses it (the name is read from frontmatter), so this
// is presentation only, and it is deliberately conservative: the heading is
// rewritten only while it still matches the previous name, leaving a body the
// user has edited untouched.
export function retitleBody(body: string, oldName: string | undefined, newName: string | undefined): string {
  if (!oldName || !newName || oldName === newName) return body;
  const m = body.match(/^[ \t]*#[ \t]+(.+?)[ \t]*$/m);
  if (!m || m.index === undefined || m[1] !== oldName) return body;
  return body.slice(0, m.index) + `# ${newName}` + body.slice(m.index + m[0].length);
}

export class WorkspaceIndex {
  /** Session-only secret resolver injected by the plugin. Keeping it here lets
   * every shared view renderer obey the same lock state without persisting it. */
  secretFieldPlaintext?: (value: unknown) => string | null;
  app: App;
  rootPath: string;

  workspace: WorkspaceConfig | null = null;
  workspaceFilePath: string | null = null;
  spaces: SpaceNode[] = [];
  views: ViewConfig[] = [];
  docs: DocMeta[] = [];
  docPages: DocPage[] = [];
  tasksById = new Map<string, TaskFile>();
  // Soft-deleted IDs remain reserved until their trash entries are purged.
  // Otherwise a newly created item can reuse an ID and make the old item
  // impossible to restore safely.
  private trashedTaskIds = new Set<string>();
  private trashIdCache = new Map<string, { mtime: number; size: number; id?: string }>();

  private listeners = new Set<Listener>();
  private vaultRefs: EventRef[] = [];
  private reloadTimer: number | null = null;
  private suppressEvents = 0;
  private scanInFlight: Promise<void> | null = null;
  private scanQueued = false;
  private scanIssues = { duplicateIds: [] as string[], missingIds: [] as string[], corruptedYaml: [] as string[] };
  private duplicateTaskIdIssues: DuplicateTaskIdIssue[] = [];
  // Set while seeding fixed sample content so it is never budget-checked.
  bulk = false;
  /** Bumped on every emit — cheap change token for render-level caches. */
  generation = 0;
  // Additional-list tallies, rebuilt when `generation` moves on.
  private additionalListCounts: { gen: number; map: Map<string, number> } | null = null;
  // Parse cache for task files keyed by path: a re-scan only re-reads and
  // re-parses files whose mtime/size changed, so an external edit to ONE file
  // costs O(1) parses instead of O(all tasks). Entries also replay their
  // diagnostics (yaml error / missing id) so scan issue reporting stays
  // identical on cache hits.
  private taskParseCache = new Map<string, {
    mtime: number;
    size: number;
    data: any;
    body: string;
    yamlError?: string;
  }>();
  // O(1) path → node lookups, rebuilt after every scan. findList/findFolder/
  // findSpace are called per task row (status sets, chips, system checks…),
  // which made every render O(tasks × tree) before.
  private listByPath = new Map<string, ListNode>();
  private folderByPath = new Map<string, FolderNode>();
  private spaceByPath = new Map<string, SpaceNode>();
  // UI controls save independently. Two quick changes to the same Item can
  // therefore overlap: both used to read the same old Markdown and the later
  // write silently erased the earlier one. Chain writes per Item while still
  // allowing unrelated Items to save in parallel.
  private taskWriteChains = new Map<string, Promise<void>>();

  constructor(app: App, rootPath: string) {
    this.app = app;
    this.rootPath = rootPath;
  }

  // ---------- Lifecycle ----------

  async load() {
    await this.scan();
    await this.migrateFavoritesIfNeeded();
    await this.migrateSidebarOrderIfNeeded();
    this.attachVaultEvents();
  }

  unload() {
    for (const r of this.vaultRefs) this.app.vault.offref(r);
    this.vaultRefs = [];
    this.listeners.clear();
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    this.generation++;
    for (const fn of this.listeners) {
      try { fn(); } catch (e) { console.error("InventTasks listener error", e); }
    }
  }

  private async withTaskWriteLock<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.taskWriteChains.get(id) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(action);
    const tail = current.then(() => undefined, () => undefined);
    this.taskWriteChains.set(id, tail);
    try {
      return await current;
    } finally {
      if (this.taskWriteChains.get(id) === tail) this.taskWriteChains.delete(id);
    }
  }

  // ---------- Scanning the vault ----------

  async setRoot(newRoot: string) {
    this.rootPath = newRoot;
    await this.scan();
    this.emit();
  }

  // Full re-scan of the current root + notify subscribers. Used after a bulk
  // file write (e.g. import) so the in-memory tree reflects the new files.
  async rescan() {
    await this.scan();
    this.emit();
  }

  async scan() {
    if (this.scanInFlight) {
      this.scanQueued = true;
      return this.scanInFlight;
    }
    this.scanInFlight = this.scanLoop();
    try {
      await this.scanInFlight;
    } finally {
      this.scanInFlight = null;
    }
  }

  private async scanLoop() {
    do {
      this.scanQueued = false;
      await this.scanOnce();
    } while (this.scanQueued);
  }

  private async scanOnce() {
    this.spaces = [];
    this.tasksById.clear();
    this.views = [];
    this.docs = [];
    this.docPages = [];
    this.workspace = null;
    this.workspaceFilePath = null;
    this.trashedTaskIds.clear();
    this.scanIssues = { duplicateIds: [], missingIds: [], corruptedYaml: [] };
    this.duplicateTaskIdIssues = [];
    this.scanSeenTaskPaths.clear();

    const root = this.getRootFolder();
    if (!root) return;

    // Workspace config
    const wsFile = root.children.find(
      (c) => c instanceof TFile && c.name === WORKSPACE_FILE
    ) as TFile | undefined;
    if (wsFile) {
      const raw = await this.app.vault.cachedRead(wsFile);
      this.recordYamlIssue(wsFile.path, raw);
      this.workspace = parseWorkspaceConfig(raw).config;
      this.workspaceFilePath = wsFile.path;
    }

    // Walk for spaces/folders/lists
    await this.walkForSpaces(root);

    // Load views (search whole subtree)
    await this.scanViews(root);

    // Load docs (containers + pages)
    await this.scanDocs(root);

    this.rebuildLookups();
    await this.scanTrashedTaskIds();
    this.pruneTaskParseCache();
    this.reportScanIssues();
  }

  private async scanTrashedTaskIds(): Promise<void> {
    this.trashedTaskIds.clear();
    const trash = this.app.vault.getAbstractFileByPath(this.trashDir());
    if (!(trash instanceof TFolder)) {
      this.trashIdCache.clear();
      return;
    }
    const seen = new Set<string>();

    const walk = async (folder: TFolder): Promise<void> => {
      for (const child of folder.children) {
        if (child instanceof TFolder) {
          await walk(child);
          continue;
        }
        if (!(child instanceof TFile) || child.extension !== "md" || child.name.startsWith("_")) continue;
        seen.add(child.path);
        try {
          let entry = this.trashIdCache.get(child.path);
          if (!entry || entry.mtime !== child.stat.mtime || entry.size !== child.stat.size) {
            const { fm } = splitFrontmatter(await this.app.vault.cachedRead(child));
            entry = {
              mtime: child.stat.mtime,
              size: child.stat.size,
              id: typeof fm.id === "string" && fm.id ? fm.id : undefined,
            };
            this.trashIdCache.set(child.path, entry);
          }
          if (entry.id) this.trashedTaskIds.add(entry.id);
        } catch (e) {
          // A damaged trash entry must not prevent the active workspace from
          // loading. It will remain visible to the Trash diagnostics/actions.
        }
      }
    };
    await walk(trash);
    for (const path of this.trashIdCache.keys()) {
      if (!seen.has(path)) this.trashIdCache.delete(path);
    }
  }

  private rebuildLookups() {
    this.listByPath.clear();
    this.folderByPath.clear();
    this.spaceByPath.clear();
    for (const s of this.spaces) {
      this.spaceByPath.set(s.path, s);
      for (const l of s.lists) this.listByPath.set(l.path, l);
      for (const f of s.folders) {
        this.folderByPath.set(f.path, f);
        for (const l of f.lists) this.listByPath.set(l.path, l);
      }
    }
  }

  // Drop cache entries for files that vanished (deleted / moved out of the
  // workspace root) so the cache can't grow without bound across rescans.
  private scanSeenTaskPaths = new Set<string>();
  private pruneTaskParseCache() {
    if (!this.taskParseCache.size) return;
    for (const path of this.taskParseCache.keys()) {
      if (!this.scanSeenTaskPaths.has(path)) this.taskParseCache.delete(path);
    }
  }

  private recordYamlIssue(path: string, raw: string) {
    const parsed = splitFrontmatter(raw);
    if (parsed.yamlError) this.scanIssues.corruptedYaml.push(`${path}: ${parsed.yamlError}`);
  }

  private reportScanIssues() {
    if (this.scanIssues.duplicateIds.length) {
      new Notice(t("notice.duplicateTaskIds", {
        count: this.scanIssues.duplicateIds.length,
        example: this.scanIssues.duplicateIds[0],
      }));
    }
    if (this.scanIssues.missingIds.length) {
      new Notice(t("notice.missingTaskIds", { count: this.scanIssues.missingIds.length }));
    }
    if (this.scanIssues.corruptedYaml.length) {
      new Notice(t("notice.corruptedYaml", {
        count: this.scanIssues.corruptedYaml.length,
        example: this.scanIssues.corruptedYaml[0],
      }));
    }
  }

  getRootFolder(): TFolder | null {
    const p = this.rootPath || "/";
    if (p === "/" || p === "") return this.app.vault.getRoot();
    const af = this.app.vault.getAbstractFileByPath(p);
    if (af instanceof TFolder) return af;
    return null;
  }

  private async walkForSpaces(folder: TFolder) {
    for (const c of folder.children) {
      if (c instanceof TFolder) {
        const spaceFile = c.children.find(
          (x) => x instanceof TFile && x.name === SPACE_FILE
        ) as TFile | undefined;
        if (spaceFile) {
          const raw = await this.app.vault.cachedRead(spaceFile);
          this.recordYamlIssue(spaceFile.path, raw);
          const cfg = parseSpaceConfig(raw).config;
          const node: SpaceNode = {
            config: cfg,
            configPath: spaceFile.path,
            path: c.path,
            folders: [],
            lists: [],
          };
          await this.walkForFolders(c, node);
          this.spaces.push(node);
        }
      }
    }
  }

  private async walkForFolders(folder: TFolder, space: SpaceNode) {
    for (const c of folder.children) {
      if (!(c instanceof TFolder)) continue;
      const folderFile = c.children.find((x) => x instanceof TFile && x.name === FOLDER_FILE) as TFile | undefined;
      const listFile = c.children.find((x) => x instanceof TFile && x.name === LIST_FILE) as TFile | undefined;

      if (folderFile) {
        const raw = await this.app.vault.cachedRead(folderFile);
        this.recordYamlIssue(folderFile.path, raw);
        const cfg = parseFolderConfig(raw).config;
        const folderNode: FolderNode = {
          config: cfg,
          configPath: folderFile.path,
          path: c.path,
          spacePath: space.path,
          lists: [],
        };
        // collect lists inside this folder
        for (const sub of c.children) {
          if (sub instanceof TFolder) {
            const lf = sub.children.find((x) => x instanceof TFile && x.name === LIST_FILE) as TFile | undefined;
            if (lf) {
              const listNode = await this.loadListNode(lf, sub, space.path, c.path);
              folderNode.lists.push(listNode);
            }
          }
        }
        space.folders.push(folderNode);
      } else if (listFile) {
        // list directly under space
        const listNode = await this.loadListNode(listFile, c, space.path, undefined);
        space.lists.push(listNode);
      }
    }
  }

  private async loadListNode(listFile: TFile, folder: TFolder, spacePath: string, folderPath: string | undefined): Promise<ListNode> {
    const raw = await this.app.vault.cachedRead(listFile);
    this.recordYamlIssue(listFile.path, raw);
    const cfg = parseListConfig(raw).config;
    const node: ListNode = {
      config: cfg,
      configPath: listFile.path,
      path: folder.path,
      spacePath,
      folderPath,
      taskFiles: [],
    };
    await this.loadTasksFromFolder(folder, node);
    return node;
  }

  private async loadTasksFromFolder(folder: TFolder, list: ListNode) {
    for (const c of folder.children) {
      if (c instanceof TFile && c.extension === "md" && !c.name.startsWith("_") && c.parent?.name !== VIEWS_DIR) {
        this.scanSeenTaskPaths.add(c.path);
        // Re-parse only files whose mtime/size changed since the last scan —
        // a re-scan after an external single-file edit then costs one parse,
        // not one per task in the workspace.
        let entry = this.taskParseCache.get(c.path);
        if (!entry || entry.mtime !== c.stat.mtime || entry.size !== c.stat.size) {
          const raw = await this.app.vault.cachedRead(c);
          const split = splitFrontmatter(raw);
          const parsed = parseTaskFile(raw);
          entry = {
            mtime: c.stat.mtime,
            size: c.stat.size,
            data: parsed.data,
            body: parsed.body,
            yamlError: split.yamlError || undefined,
          };
          this.taskParseCache.set(c.path, entry);
        }
        if (entry.yamlError) this.scanIssues.corruptedYaml.push(`${c.path}: ${entry.yamlError}`);
        if (!entry.data.id) {
          this.scanIssues.missingIds.push(c.path);
          continue;
        }
        if (this.tasksById.has(entry.data.id)) {
          const prev = this.tasksById.get(entry.data.id)!;
          this.scanIssues.duplicateIds.push(`${entry.data.id}: ${c.path} ← ${prev.filePath}`);
          this.duplicateTaskIdIssues.push({ id: entry.data.id, duplicatePath: c.path, keptPath: prev.filePath });
          continue;
        }
        const tf: TaskFile = {
          data: entry.data,
          body: entry.body,
          filePath: c.path,
          spacePath: list.spacePath,
          folderPath: list.folderPath,
          listPath: list.path,
        };
        list.taskFiles.push(tf);
        this.tasksById.set(entry.data.id, tf);
      }
    }
  }

  private async scanViews(folder: TFolder) {
    for (const c of folder.children) {
      if (c instanceof TFolder) {
        // Don't descend into trash or attachment stores — a trashed container
        // would otherwise leak its saved views back into the bars.
        if (c.name === "_trash" || c.name === "_attachments" || c.name === DOCS_DIR) continue;
        if (c.name === VIEWS_DIR) {
          for (const v of c.children) {
            if (v instanceof TFile && v.extension === "md") {
              const raw = await this.app.vault.cachedRead(v);
              this.recordYamlIssue(v.path, raw);
              const cfg = parseViewConfig(raw).config;
              if (cfg.view_id) {
                cfg.__path = v.path; // remember source file for deletion
                // Stored keys are root-relative (portable) — rebase to this
                // device's absolute paths for all runtime comparisons.
                if (cfg.location) cfg.location = absoluteLocationKey(cfg.location, this.rootPath);
                this.views.push(cfg);
              }
            }
          }
        } else {
          await this.scanViews(c);
        }
      }
    }
  }

  // Walk the tree for `_docs/` dirs; route each entry to docs (containers) or
  // docPages (pages) by which id its frontmatter carries.
  private async scanDocs(folder: TFolder) {
    for (const c of folder.children) {
      if (!(c instanceof TFolder)) continue;
      if (c.name === "_trash" || c.name === "_attachments") continue;
      if (c.name === DOCS_DIR) {
        for (const f of c.children) {
          if (!(f instanceof TFile) || f.extension !== "md") continue;
          const raw = await this.app.vault.cachedRead(f);
          const parsed = splitFrontmatter(raw);
          if (parsed.yamlError) this.scanIssues.corruptedYaml.push(`${f.path}: ${parsed.yamlError}`);
          const { fm } = parsed;
          if (fm?.page_id) {
            const { page, body } = parseDocPage(raw);
            if (!page.page_id || !page.doc_id) continue;
            page.__path = f.path;
            page.__body = body;
            this.docPages.push(page);
          } else if (fm?.doc_id) {
            const { meta } = parseDocMeta(raw);
            if (!meta.doc_id) continue;
            meta.__path = f.path;
            // Stored keys are root-relative (portable) — rebase to this
            // device's absolute paths for all runtime comparisons.
            if (meta.location) meta.location = absoluteLocationKey(meta.location, this.rootPath);
            this.docs.push(meta);
          }
        }
      } else {
        await this.scanDocs(c);
      }
    }
  }

  // ---------- Vault events ----------

  private attachVaultEvents() {
    // Idempotent: load() can run again when the first workspace is created
    // from the zero-workspaces state (boot skipped it) — never double-attach.
    if (this.vaultRefs.length > 0) return;
    const v = this.app.vault;
    const debounced = () => {
      if (this.suppressEvents > 0) return;
      if (this.reloadTimer !== null) window.clearTimeout(this.reloadTimer);
      this.reloadTimer = window.setTimeout(async () => {
        await this.scan();
        this.emit();
      }, 350);
    };
    const shouldReact = (path: string) => {
      // Only markdown matters to the index (tasks + space/folder/list/workspace
      // config + views + docs are all .md). Ignoring everything else avoids
      // needless re-scans on attachment writes and prevents a calendar-sync ↔
      // re-scan feedback loop from the generated _tasks-calendar.ics file.
      if (!path.endsWith(".md")) return false;
      const root = this.rootPath || "/";
      return root === "/" || root === "" || path.startsWith(root + "/");
    };
    this.vaultRefs.push(v.on("create", (f) => { if (shouldReact(f.path)) debounced(); }));
    this.vaultRefs.push(v.on("delete", (f) => { if (shouldReact(f.path)) debounced(); }));
    this.vaultRefs.push(v.on("modify", (f) => { if (shouldReact(f.path)) debounced(); }));
    this.vaultRefs.push(v.on("rename", (f) => { if (shouldReact(f.path)) debounced(); }));
  }

  // ---------- Status / field resolution ----------

  // Walks L → F → S → WS picking the first non-empty array (override semantics).
  private walkArr<T>(
    opts: { listPath?: string; folderPath?: string; spacePath?: string },
    pick: (cfg: any) => T[] | undefined,
    fallback: T[]
  ): T[] {
    let folderPath = opts.folderPath;
    let spacePath = opts.spacePath;
    if (opts.listPath) {
      const list = this.findList(opts.listPath);
      const v = pick(list?.config);
      if (v?.length) return v;
      folderPath = folderPath || list?.folderPath;
      spacePath = spacePath || list?.spacePath;
    }
    if (folderPath) {
      const f = this.findFolder(folderPath);
      const v = pick(f?.config);
      if (v?.length) return v;
      spacePath = spacePath || f?.spacePath;
    }
    if (spacePath) {
      const s = this.findSpace(spacePath);
      const v = pick(s?.config);
      if (v?.length) return v;
    }
    if (this.workspace) {
      const v = pick(this.workspace);
      if (v?.length) return v;
    }
    return fallback;
  }

  resolveStatusSet(listPath?: string): ResolvedStatusSet {
    if (listPath) {
      const list = this.findList(listPath);
      if (list?.config.status_set?.length) return { statuses: list.config.status_set, source: "list" };
      if (list?.folderPath) {
        const f = this.findFolder(list.folderPath);
        if (f?.config.status_set?.length) return { statuses: f.config.status_set, source: "folder" };
      }
      if (list?.spacePath) {
        const s = this.findSpace(list.spacePath);
        if (s?.config.status_set?.length) return { statuses: s.config.status_set, source: "space" };
      }
    }
    if (this.workspace?.status_set?.length) return { statuses: this.workspace.status_set, source: "default" };
    return { statuses: DEFAULT_STATUS_SET, source: "default" };
  }

  // Status set for a view scope. A single List resolves exactly like
  // resolveStatusSet. Multi-list scopes (Everything/Space/Folder and the
  // global virtual views) get the UNION of every in-scope List's EFFECTIVE
  // set — per-list inheritance still applies — so an Item whose home List
  // defines e.g. "backlog" never renders as "No status" above List level.
  // First definition of an id wins (tree order); `order` is re-stamped to the
  // merged sequence so cross-set order collisions can't scramble sorting.
  // A scope with no Lists falls back to the workspace/default chain.
  resolveStatusSetForLocation(loc: ContextLocation): ResolvedStatusSet {
    if (loc.kind === "list") return this.resolveStatusSet(loc.path);
    const listPaths: string[] = [];
    const pushSpace = (sp: SpaceNode) => {
      for (const l of sp.lists) listPaths.push(l.path);
      for (const f of sp.folders) for (const l of f.lists) listPaths.push(l.path);
    };
    if (loc.kind === "folder") {
      const f = this.findFolder(loc.path);
      for (const l of f?.lists ?? []) listPaths.push(l.path);
    } else if (loc.kind === "space") {
      const sp = this.findSpace(loc.path);
      if (sp) pushSpace(sp);
    } else {
      for (const sp of this.spaces) pushSpace(sp);
    }
    const merged: StatusDef[] = [];
    const seen = new Set<string>();
    for (const p of listPaths) {
      for (const s of this.resolveStatusSet(p).statuses) {
        if (seen.has(s.id)) continue;
        seen.add(s.id);
        merged.push({ ...s, order: merged.length });
      }
    }
    if (!merged.length) return this.resolveStatusSet(undefined);
    return { statuses: merged, source: "default" };
  }

  // Custom fields use override semantics (like other configurable arrays):
  // the narrowest level with a non-empty list wins. To "extend" parent fields,
  // copy parent's list and add — there's no implicit merge.
  resolveCustomFields(listPath?: string, _taskType?: string): CustomFieldDef[] {
    return this.walkArr({ listPath }, (cfg) => cfg?.custom_fields, []);
  }

  resolveCustomFieldsForLocation(loc: ContextLocation): CustomFieldDef[] {
    if (loc.kind === "list") return this.resolveCustomFields(loc.path);
    if (loc.kind === "folder") return this.walkArr({ folderPath: loc.path }, (cfg) => cfg?.custom_fields, []);
    if (loc.kind === "space") return this.walkArr({ spacePath: loc.path }, (cfg) => cfg?.custom_fields, []);
    return this.workspace?.custom_fields ?? [];
  }

  // Resolve a single boolean view-default toggle (cf_show_name /
  // cf_show_when_empty / etc) by walking the config chain from narrowest
  // to widest. `undefined` at every level → returns `fallback`. The first
  // explicit boolean wins, so an override at any level short-circuits.
  resolveViewDefaultBool(
    view: ViewType,
    key: "cf_show_name" | "cf_show_when_empty" | "cf_show_type_icon" | "show_unscheduled",
    loc: ContextLocation,
    fallback: boolean,
  ): boolean {
    return this.resolveViewDefaultValue<boolean>(view, key, loc, (v) => typeof v === "boolean", fallback);
  }

  // Same chain-walk as resolveViewDefaultBool, parameterised on the
  // validator so we can resolve string/enum view-default fields too
  // (e.g. `checkbox_action: "done" | "closed"`). First level that passes
  // the validator wins, fallback otherwise.
  resolveViewDefaultValue<T>(
    view: ViewType,
    key: string,
    loc: ContextLocation,
    isValid: (v: any) => boolean,
    fallback: T,
  ): T {
    return this.walkConfigChain(loc, (cfg) => cfg?.view_defaults?.[view]?.[key], isValid, fallback);
  }

  // Resolve a single field on `task_behavior` (or any other
  // ConfigurableSet sibling reachable by a one-liner `pick`). Same chain
  // walk as view-default resolvers — first level whose pick passes
  // `isValid` wins, otherwise return the fallback.
  resolveTaskBehaviorValue<T>(
    key: keyof import("../types").TaskBehavior,
    loc: ContextLocation,
    isValid: (v: any) => boolean,
    fallback: T,
  ): T {
    return this.walkConfigChain(loc, (cfg) => (cfg?.task_behavior as any)?.[key], isValid, fallback);
  }

  resolveNotificationsEnabledForLocation(loc: ContextLocation): boolean {
    return this.walkConfigChain(loc, (cfg) => cfg?.notifications_enabled, (v) => typeof v === "boolean", true);
  }

  resolveNotificationsEnabledForTask(task: TaskFile): boolean {
    if (!task.listPath) return this.workspace?.notifications_enabled ?? true;
    return this.resolveNotificationsEnabledForLocation({ kind: "list", path: task.listPath });
  }

  // Generic chain-walk resolver for any boolean field on the config set
  // (notify_system / notify_ntfy / notifications_enabled).
  // First explicit boolean from narrowest→widest wins.
  resolveConfigBoolForLocation(loc: ContextLocation, field: string, fallback = true): boolean {
    return this.walkConfigChain(loc, (cfg) => cfg?.[field], (v) => typeof v === "boolean", fallback);
  }

  resolveCalendarSyncStatusPolicyForLocation(loc: ContextLocation): import("../types").CalendarSyncStatusPolicy {
    return this.walkConfigChain(
      loc,
      (cfg) => cfg?.calendar_sync_status_policy,
      (v) => v === "sync_all" || v === "exclude_done_closed" || v === "exclude_closed",
      "exclude_done_closed",
    );
  }

  resolveCalendarSyncRulesForLocation(loc: ContextLocation): import("../types").CalendarSyncRule[] {
    const byId = new Map<string, import("../types").CalendarSyncRule>();
    // Calendar routing is additive: inherited rules and local rules all apply.
    // Walk widest → narrowest so a copied/local rule with the same id can refine
    // the inherited version without creating duplicate sends.
    for (const cfg of this.configChainForLocation(loc).reverse()) {
      const rules = cfg?.calendar_sync_rules;
      if (!Array.isArray(rules)) continue;
      for (const rule of rules) {
        if (!rule?.id) continue;
        byId.set(rule.id, rule);
      }
    }
    return [...byId.values()];
  }

  // Resolve the external notification channel toggles for a task's
  // location, applying space→folder→list inheritance.
  resolveExternalNotifyChannelsForTask(task: TaskFile): { system: boolean; ntfy: boolean } {
    const loc: ContextLocation = task.listPath ? { kind: "list", path: task.listPath } : { kind: "everything" };
    return {
      system: this.resolveConfigBoolForLocation(loc, "notify_system"),
      ntfy: this.resolveConfigBoolForLocation(loc, "notify_ntfy"),
    };
  }

  // Shared chain walker used by the value-resolvers above.
  private walkConfigChain<T>(
    loc: ContextLocation,
    pick: (cfg: any) => any,
    isValid: (v: any) => boolean,
    fallback: T,
  ): T {
    const chain = this.configChainForLocation(loc);
    for (const cfg of chain) {
      const v = pick(cfg);
      if (isValid(v)) return v as T;
    }
    return fallback;
  }

  private configChainForLocation(loc: ContextLocation): any[] {
    const chain: any[] = [];
    if (loc.kind === "list") {
      const list = this.findList(loc.path);
      if (list) {
        chain.push(list.config);
        if (list.folderPath) chain.push(this.findFolder(list.folderPath)?.config);
        if (list.spacePath) chain.push(this.findSpace(list.spacePath)?.config);
      }
    } else if (loc.kind === "folder") {
      const f = this.findFolder(loc.path);
      if (f) {
        chain.push(f.config);
        if (f.spacePath) chain.push(this.findSpace(f.spacePath)?.config);
      }
    } else if (loc.kind === "space") {
      const s = this.findSpace(loc.path);
      if (s) chain.push(s.config);
    }
    if (this.workspace) chain.push(this.workspace);
    return chain;
  }

  getPriorities(): PriorityDef[] {
    return this.workspace?.priorities && this.workspace.priorities.length
      ? this.workspace.priorities
      : DEFAULT_PRIORITIES;
  }

  resolvePriorities(opts: { listPath?: string; folderPath?: string; spacePath?: string } = {}): PriorityDef[] {
    return this.walkArr(opts, (cfg) => cfg?.priorities, DEFAULT_PRIORITIES);
  }

  resolvePrioritiesForLocation(loc: ContextLocation): PriorityDef[] {
    if (loc.kind === "list") return this.resolvePriorities({ listPath: loc.path });
    if (loc.kind === "folder") return this.resolvePriorities({ folderPath: loc.path });
    if (loc.kind === "space") return this.resolvePriorities({ spacePath: loc.path });
    return this.getPriorities();
  }

  resolveContextLabels(opts: { listPath?: string; folderPath?: string; spacePath?: string } = {}): import("../types").ContextLabelDef[] {
    return this.walkArr(opts, (cfg) => cfg?.context_labels, DEFAULT_CONTEXT_LABELS);
  }

  resolveContextLabelsForLocation(loc: ContextLocation): import("../types").ContextLabelDef[] {
    if (loc.kind === "list") return this.resolveContextLabels({ listPath: loc.path });
    if (loc.kind === "folder") return this.resolveContextLabels({ folderPath: loc.path });
    if (loc.kind === "space") return this.resolveContextLabels({ spacePath: loc.path });
    return this.resolveContextLabels();
  }

  // Where the "empty" bucket sits when grouping by `axis`. Looked up from the
  // same level that ultimately defines the palette. Defaults to 0.
  resolveEmptyPosition(axis: "status" | "priority" | "tags" | "context" | "type", loc: ContextLocation): number {
    const fromMap = (m?: Record<string, number>) => (m && typeof m[axis] === "number" ? m[axis] : undefined);
    const palettePick = (cfg: any): any[] | undefined => {
      switch (axis) {
        case "status": return cfg?.status_set;
        case "priority": return cfg?.priorities;
        case "tags": return cfg?.tags_palette;
        case "context": return cfg?.context_labels;
        case "type": return cfg?.task_types;
      }
    };

    // Build the resolve chain narrowest → widest.
    const chain: any[] = [];
    if (loc.kind === "list") {
      const list = this.findList(loc.path);
      if (list) {
        chain.push(list.config);
        if (list.folderPath) chain.push(this.findFolder(list.folderPath)?.config);
        if (list.spacePath) chain.push(this.findSpace(list.spacePath)?.config);
      }
    } else if (loc.kind === "folder") {
      const f = this.findFolder(loc.path);
      if (f) {
        chain.push(f.config);
        if (f.spacePath) chain.push(this.findSpace(f.spacePath)?.config);
      }
    } else if (loc.kind === "space") {
      const s = this.findSpace(loc.path);
      if (s) chain.push(s.config);
    }
    if (this.workspace) chain.push(this.workspace);

    for (const cfg of chain) {
      if (!cfg) continue;
      if (palettePick(cfg)?.length) {
        const v = fromMap(cfg.empty_positions);
        if (v !== undefined) return v;
      }
    }
    // No level defines this palette explicitly → fall back to WS's empty position (if any) then 0.
    const v = fromMap(this.workspace?.empty_positions);
    return v ?? 0;
  }

  // Resolve feature toggles per-key, walking WS → Space → Folder → List
  // (narrower wins). `undefined` in a level's features map = inherit.
  // Defaults: time_tracking / time_estimate / sprint_points are OFF —
  // they're niche features most users don't need on day one. Everything
  // else stays ON because it's part of the basic task experience.
  resolveFeatures(opts: { listPath?: string; folderPath?: string; spacePath?: string } = {}): Record<string, boolean> {
    const merged: Record<string, boolean> = {
      priorities: true, tags: true, context: true,
      time_tracking: false, time_estimate: false, sprint_points: false,
      dependencies: true, custom_task_types: true, recurring_tasks: true,
      incomplete_warning: true, dependency_warning: true, nested_subtasks: true,
      multiple_lists: true,
      due_dates: true, start_dates: true, checklists: true, attachments: true,
      comments: true, documents: true, description: true, cover_images: true,
      // Modal-display-only toggles (see constants.MODAL_DISPLAY_FEATURE_IDS).
      ...DEFAULT_MODAL_DISPLAY_FEATURES,
    };
    const apply = (src: Record<string, boolean> | undefined) => {
      if (!src) return;
      for (const k of Object.keys(src)) {
        const v = src[k];
        if (v === true || v === false) merged[k] = v;
      }
    };

    let folderPath = opts.folderPath;
    let spacePath = opts.spacePath;
    if (opts.listPath) {
      const list = this.findList(opts.listPath);
      folderPath = folderPath || list?.folderPath;
      spacePath = spacePath || list?.spacePath;
    }
    if (folderPath) {
      const f = this.findFolder(folderPath);
      spacePath = spacePath || f?.spacePath;
    }
    apply(this.workspace?.features);
    if (spacePath) apply(this.findSpace(spacePath)?.config.features);
    if (folderPath) apply(this.findFolder(folderPath)?.config.features);
    if (opts.listPath) apply(this.findList(opts.listPath)?.config.features);
    return merged;
  }

  resolveFeaturesForLocation(loc: ContextLocation): Record<string, boolean> {
    if (loc.kind === "list") return this.resolveFeatures({ listPath: loc.path });
    if (loc.kind === "folder") return this.resolveFeatures({ folderPath: loc.path });
    if (loc.kind === "space") return this.resolveFeatures({ spacePath: loc.path });
    return this.resolveFeatures();
  }

  // Resolve chip styling per chip kind, walking WS → Space → Folder → List.
  // Each property in `ChipStyleConfig` is tri-state: `undefined` at a level
  // means "inherit from parent"; `true`/`false` overrides. Returns a fully
  // resolved (no undefined) map ready to be consumed by chip renderers.
  resolveChipStyles(opts: { listPath?: string; folderPath?: string; spacePath?: string } = {}): ResolvedChipStyles {
    const merged = defaultResolvedChipStyles();
    const apply = (src: ChipStyles | undefined) => {
      if (!src) return;
      for (const k of CHIP_KINDS) {
        const cfg = src[k];
        if (!cfg) continue;
        if (cfg.border === true || cfg.border === false) merged[k].border = cfg.border;
        if (cfg.bold_border === true || cfg.bold_border === false) merged[k].bold_border = cfg.bold_border;
        if (cfg.background === true || cfg.background === false) merged[k].background = cfg.background;
      }
    };

    let folderPath = opts.folderPath;
    let spacePath = opts.spacePath;
    if (opts.listPath) {
      const list = this.findList(opts.listPath);
      folderPath = folderPath || list?.folderPath;
      spacePath = spacePath || list?.spacePath;
    }
    if (folderPath) {
      const f = this.findFolder(folderPath);
      spacePath = spacePath || f?.spacePath;
    }
    apply(this.workspace?.chip_styles);
    if (spacePath) apply(this.findSpace(spacePath)?.config.chip_styles);
    if (folderPath) apply(this.findFolder(folderPath)?.config.chip_styles);
    if (opts.listPath) apply(this.findList(opts.listPath)?.config.chip_styles);
    return merged;
  }

  resolveChipStylesForLocation(loc: ContextLocation): ResolvedChipStyles {
    if (loc.kind === "list") return this.resolveChipStyles({ listPath: loc.path });
    if (loc.kind === "folder") return this.resolveChipStyles({ folderPath: loc.path });
    if (loc.kind === "space") return this.resolveChipStyles({ spacePath: loc.path });
    return this.resolveChipStyles();
  }

  // Resolve custom DISPLAY names for built-in fields, walking WS→Space→Folder→
  // List (narrower wins per-key). Returns only keys that have a non-empty
  // override; callers fall back to the i18n default for everything else. The
  // markdown property / storage key is never affected — this is display-only.
  resolveFieldLabels(opts: { listPath?: string; folderPath?: string; spacePath?: string } = {}): Record<string, string> {
    const merged: Record<string, string> = {};
    const apply = (src: Record<string, string> | undefined) => {
      if (!src) return;
      for (const k of Object.keys(src)) {
        const v = src[k];
        if (typeof v === "string" && v.trim()) merged[k] = v.trim();
      }
    };

    let folderPath = opts.folderPath;
    let spacePath = opts.spacePath;
    if (opts.listPath) {
      const list = this.findList(opts.listPath);
      folderPath = folderPath || list?.folderPath;
      spacePath = spacePath || list?.spacePath;
    }
    if (folderPath) {
      const f = this.findFolder(folderPath);
      spacePath = spacePath || f?.spacePath;
    }
    apply(this.workspace?.field_labels);
    if (spacePath) apply(this.findSpace(spacePath)?.config.field_labels);
    if (folderPath) apply(this.findFolder(folderPath)?.config.field_labels);
    if (opts.listPath) apply(this.findList(opts.listPath)?.config.field_labels);
    return merged;
  }

  resolveFieldLabelsForLocation(loc: ContextLocation): Record<string, string> {
    if (loc.kind === "list") return this.resolveFieldLabels({ listPath: loc.path });
    if (loc.kind === "folder") return this.resolveFieldLabels({ folderPath: loc.path });
    if (loc.kind === "space") return this.resolveFieldLabels({ spacePath: loc.path });
    return this.resolveFieldLabels();
  }

  resolveViewDefaults(view: ViewType, opts: { listPath?: string; folderPath?: string; spacePath?: string } = {}): ViewDefaults {
    // Resolve every property of ViewDefaults independently — a lower level can
    // override `color_by` without also overriding `visible_fields`, and vice
    // versa. The walk is list → folder → space → workspace → built-in default.
    // For each property: the first level that defines it wins.
    let folderPath = opts.folderPath;
    let spacePath = opts.spacePath;
    const chain: any[] = [];
    if (opts.listPath) {
      const list = this.findList(opts.listPath);
      chain.push(list?.config);
      folderPath = folderPath || list?.folderPath;
      spacePath = spacePath || list?.spacePath;
    }
    if (folderPath) {
      const f = this.findFolder(folderPath);
      chain.push(f?.config);
      spacePath = spacePath || f?.spacePath;
    }
    if (spacePath) chain.push(this.findSpace(spacePath)?.config);
    chain.push(this.workspace);

    let visible_fields: string[] | undefined;
    let color_by: string | undefined;
    let date_field: string | undefined;
    let start_date_field: string | undefined;
    for (const cfg of chain) {
      const v = cfg?.view_defaults?.[view];
      if (!v) continue;
      if (visible_fields === undefined && Array.isArray(v.visible_fields) && v.visible_fields.length) {
        visible_fields = v.visible_fields;
      }
      if (color_by === undefined && typeof v.color_by === "string" && v.color_by.length) {
        color_by = v.color_by;
      }
      if (date_field === undefined && typeof v.date_field === "string" && v.date_field.length) {
        date_field = v.date_field;
      }
      if (start_date_field === undefined && typeof v.start_date_field === "string" && v.start_date_field.length) {
        start_date_field = v.start_date_field;
      }
    }
    return {
      visible_fields: visible_fields ?? defaultVisibleFor(view as any),
      color_by,
      date_field,
      start_date_field,
    };
  }

  resolveViewDefaultsForLocation(view: ViewType, loc: ContextLocation): ViewDefaults {
    if (loc.kind === "list") return this.resolveViewDefaults(view, { listPath: loc.path });
    if (loc.kind === "folder") return this.resolveViewDefaults(view, { folderPath: loc.path });
    if (loc.kind === "space") return this.resolveViewDefaults(view, { spacePath: loc.path });
    return this.resolveViewDefaults(view);
  }

  resolveTaskTypes(opts: { listPath?: string; folderPath?: string; spacePath?: string } = {}): TaskType[] {
    return this.walkArr(opts, (cfg) => cfg?.task_types, DEFAULT_TASK_TYPES);
  }

  resolveTaskTypesForLocation(loc: ContextLocation): TaskType[] {
    if (loc.kind === "list") return this.resolveTaskTypes({ listPath: loc.path });
    if (loc.kind === "folder") return this.resolveTaskTypes({ folderPath: loc.path });
    if (loc.kind === "space") return this.resolveTaskTypes({ spacePath: loc.path });
    return this.resolveTaskTypes();
  }

  resolveTagsPalette(opts: { listPath?: string; folderPath?: string; spacePath?: string } = {}): import("../types").TagDef[] {
    // Merge all levels (workspace lowest → list highest priority).
    // Same-name tag from a more specific level overrides the less specific one.
    type TagDef = import("../types").TagDef;
    const map = new Map<string, TagDef>();

    // Workspace (lowest priority)
    if (this.workspace?.tags_palette?.length) {
      for (const td of this.workspace.tags_palette) map.set(td.name, td);
    }

    // Resolve the hierarchy chain
    let spacePath = opts.spacePath;
    let folderPath = opts.folderPath;
    if (opts.listPath) {
      const list = this.findList(opts.listPath);
      folderPath = folderPath ?? list?.folderPath;
      spacePath = spacePath ?? list?.spacePath;
    }
    if (folderPath && !spacePath) {
      const f = this.findFolder(folderPath);
      spacePath = f?.spacePath;
    }

    if (spacePath) {
      const s = this.findSpace(spacePath);
      if (s?.config.tags_palette?.length) {
        for (const td of s.config.tags_palette) map.set(td.name, td);
      }
    }
    if (folderPath) {
      const f = this.findFolder(folderPath);
      if (f?.config.tags_palette?.length) {
        for (const td of f.config.tags_palette) map.set(td.name, td);
      }
    }
    if (opts.listPath) {
      const list = this.findList(opts.listPath);
      if (list?.config.tags_palette?.length) {
        for (const td of list.config.tags_palette) map.set(td.name, td);
      }
    }

    return Array.from(map.values());
  }

  resolveTagsPaletteForLocation(loc: ContextLocation): import("../types").TagDef[] {
    if (loc.kind === "list") return this.resolveTagsPalette({ listPath: loc.path });
    if (loc.kind === "folder") return this.resolveTagsPalette({ folderPath: loc.path });
    if (loc.kind === "space") return this.resolveTagsPalette({ spacePath: loc.path });
    return this.resolveTagsPalette();
  }

  // ---------- Lookups ----------
  // Map-first (rebuilt by every scan, O(1)); the linear walk stays as a
  // fallback for nodes touched by incremental mutations between scans.

  findSpace(path: string): SpaceNode | undefined {
    return this.spaceByPath.get(path) ?? this.spaces.find((s) => s.path === path);
  }

  findFolder(path: string): FolderNode | undefined {
    const hit = this.folderByPath.get(path);
    if (hit) return hit;
    for (const s of this.spaces) {
      const f = s.folders.find((x) => x.path === path);
      if (f) return f;
    }
    return undefined;
  }

  findList(path: string): ListNode | undefined {
    const hit = this.listByPath.get(path);
    if (hit) return hit;
    for (const s of this.spaces) {
      const l = s.lists.find((x) => x.path === path);
      if (l) return l;
      for (const fo of s.folders) {
        const lf = fo.lists.find((x) => x.path === path);
        if (lf) return lf;
      }
    }
    return undefined;
  }

  allLists(): ListNode[] {
    const out: ListNode[] = [];
    for (const s of this.spaces) {
      out.push(...s.lists);
      for (const f of s.folders) out.push(...f.lists);
    }
    return out;
  }

  allTasks(): TaskFile[] {
    return Array.from(this.tasksById.values());
  }

  isSystemList(listPath?: string): boolean {
    return !!listPath && !!this.findList(listPath)?.config.system_kind;
  }

  isSystemTask(task: TaskFile): boolean {
    return this.isSystemList(task.listPath);
  }

  systemList(kind: SystemListKind): ListNode | undefined {
    return this.allLists().find((l) => l.config.system_kind === kind);
  }

  systemTasks(kind: SystemListKind): TaskFile[] {
    return this.systemList(kind)?.taskFiles.slice() ?? [];
  }

  normalTasks(): TaskFile[] {
    return this.allTasks().filter((t) => !this.isSystemTask(t) && !t.data.archived);
  }

  archivedTasks(): TaskFile[] {
    return this.allTasks().filter((t) => !this.isSystemTask(t) && t.data.archived === true);
  }

  // Tasks that count toward the working-set budget: non-system and still open
  // (not in a done/closed status group). Completed work never counts, so the
  // budget tracks live workload, not history.
  private openBudgetCount(): number {
    let n = 0;
    for (const tf of this.normalTasks()) {
      const g = tf.data.status_group;
      if (g !== "done" && g !== "closed") n++;
    }
    return n;
  }

  // Build per-task counts the views need (subtask totals + relationship counts)
  // in a SINGLE pass over the index, instead of each row scanning allTasks()
  // (which was O(n²) — millions of iterations on a 1000-task vault). Callers
  // build this once per render (in tasksContext) and look up by task id.
  //
  //  - subtasks: total children + how many are done/closed (for progress_auto)
  //  - relationships: matches relationshipCount() = blocks + waiting_on + related,
  //    with `related` deduped across both directions (same as getRelated()).
  buildRenderStats(tasks: Iterable<TaskFile> = this.normalTasks()): {
    subtasks: Map<string, { total: number; done: number }>;
    relationships: Map<string, number>;
  } {
    const subtasks = new Map<string, { total: number; done: number }>();
    const inverseBlocks = new Map<string, number>(); // waiting_on count per id
    const relatedSets = new Map<string, Set<string>>();
    const relSet = (k: string) => {
      let s = relatedSets.get(k);
      if (!s) { s = new Set(); relatedSets.set(k, s); }
      return s;
    };

    const scoped = Array.from(tasks);
    const scopedIds = new Set(scoped.map((task) => task.data.id));
    for (const t of scoped) {
      const d = t.data;
      for (const pid of parentTaskIds(d)) {
        if (!scopedIds.has(pid)) continue;
        let e = subtasks.get(pid);
        if (!e) { e = { total: 0, done: 0 }; subtasks.set(pid, e); }
        e.total++;
        if (d.status_group === "done" || d.status_group === "closed") e.done++;
      }
      for (const b of d.relationships?.blocks ?? []) {
        if (!scopedIds.has(b)) continue;
        inverseBlocks.set(b, (inverseBlocks.get(b) ?? 0) + 1);
      }
      for (const r of d.relationships?.related ?? []) {
        if (!scopedIds.has(r)) continue;
        relSet(d.id).add(r);
        relSet(r).add(d.id);
      }
    }

    const relationships = new Map<string, number>();
    for (const t of scoped) {
      const id = t.data.id;
      const own = (t.data.relationships?.blocks ?? []).filter((otherId) => scopedIds.has(otherId)).length;
      const waiting = inverseBlocks.get(id) ?? 0;
      const rel = relatedSets.get(id)?.size ?? 0;
      relationships.set(id, own + waiting + rel);
    }
    return { subtasks, relationships };
  }

  tasksFor(loc: { kind: string; path?: string }): TaskFile[] {
    if (loc.kind === "everything") return this.normalTasks();
    if (loc.kind === "archived") return this.archivedTasks();
    if (loc.kind === "today") {
      const today = todayKey();
      return this.normalTasks().filter((t) => dayKey(t.data.due_date) === today);
    }
    if (loc.kind === "favorites") {
      const favs = this.getFavorites();
      const out: TaskFile[] = [];
      for (const p of favs) {
        const l = this.findList(p);
        if (l && !l.config.system_kind) out.push(...l.taskFiles.filter((task) => !task.data.archived));
      }
      return out;
    }
    if (loc.kind === "list" && loc.path) {
      const path = loc.path;
      const l = this.findList(path);
      if (l?.config.system_kind) return [];
      const home = l ? l.taskFiles.filter((task) => !task.data.archived) : [];
      // Multiple Lists: also surface tasks whose home is elsewhere but that list
      // this list in their additional_lists. (Their config/status stays home.)
      const extra = this.normalTasks().filter(
        (t) => t.listPath !== path && (t.data.additional_lists || []).includes(path),
      );
      return extra.length ? [...home, ...extra] : home;
    }
    if (loc.kind === "folder" && loc.path) {
      const f = this.findFolder(loc.path);
      if (!f) return [];
      return f.lists.filter((l) => !l.config.system_kind).flatMap((l) => l.taskFiles.filter((task) => !task.data.archived));
    }
    if (loc.kind === "space" && loc.path) {
      const s = this.findSpace(loc.path);
      if (!s) return [];
      if (s.config.hidden) return [];
      const r = [...s.lists.filter((l) => !l.config.system_kind).flatMap((l) => l.taskFiles.filter((task) => !task.data.archived))];
      for (const fo of s.folders) r.push(...fo.lists.filter((l) => !l.config.system_kind).flatMap((l) => l.taskFiles.filter((task) => !task.data.archived)));
      return r;
    }
    return [];
  }

  /**
   * How many Items a List actually shows: the ones living in it plus the ones
   * whose home is elsewhere but that name this List in `additional_lists`.
   *
   * The sidebar badge used to count only the folder's own files, so a List
   * populated entirely through Additional Lists advertised "0" while opening it
   * rendered its Items — the badge contradicted the view beside it.
   *
   * The additional-list tally is built once per index generation rather than
   * per row: the sidebar asks for every List on every render, and rescanning
   * all Items for each of them turns a redraw into O(lists × Items).
   */
  listItemCount(listPath: string): number {
    const list = this.findList(listPath);
    const home = list ? list.taskFiles.filter((task) => !task.data.archived).length : 0;
    if (!this.additionalListCounts || this.additionalListCounts.gen !== this.generation) {
      const map = new Map<string, number>();
      for (const task of this.normalTasks()) {
        for (const path of task.data.additional_lists ?? []) {
          if (path !== task.listPath) map.set(path, (map.get(path) ?? 0) + 1);
        }
      }
      this.additionalListCounts = { gen: this.generation, map };
    }
    return home + (this.additionalListCounts.map.get(listPath) ?? 0);
  }

  // ---------- Mutation helpers ----------

  withSuppression<T>(fn: () => Promise<T>): Promise<T> {
    this.suppressEvents++;
    return fn().finally(() => { this.suppressEvents--; });
  }

  async ensureFolder(path: string): Promise<TFolder> {
    const norm = normalizePath(path);
    const existing = this.app.vault.getAbstractFileByPath(norm);
    if (existing instanceof TFolder) return existing;
    try {
      await this.app.vault.createFolder(norm);
    } catch (e) {
      // Tolerate "already exists" races (the metadata cache can lag behind the
      // adapter, so getAbstractFileByPath returned null even though the folder
      // exists on disk). Re-check below before failing.
    }
    const created = this.app.vault.getAbstractFileByPath(norm);
    if (created instanceof TFolder) return created;
    // Fall back to the raw adapter: create if missing, and trust it exists.
    try {
      if (!(await this.app.vault.adapter.exists(norm))) {
        await this.app.vault.adapter.mkdir(norm);
      }
    } catch (e) { /* ignore */ }
    const after = this.app.vault.getAbstractFileByPath(norm);
    if (after instanceof TFolder) return after;
    throw new Error(t("err.couldNotCreateFolder", { path: norm }));
  }

  async writeFile(path: string, contents: string): Promise<TFile> {
    const norm = normalizePath(path);
    const existing = this.app.vault.getAbstractFileByPath(norm);
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, contents);
      return existing;
    }
    return await this.app.vault.create(norm, contents);
  }

  // ---------- Task CRUD ----------

  generateTaskId(): string {
    let n = 1;
    while (
      this.tasksById.has(`TSK-${n.toString().padStart(5, "0")}`)
      || this.trashedTaskIds.has(`TSK-${n.toString().padStart(5, "0")}`)
    ) n++;
    return `TSK-${n.toString().padStart(5, "0")}`;
  }

  diagnostics() {
    return {
      duplicateIds: [...this.scanIssues.duplicateIds],
      missingIds: [...this.scanIssues.missingIds],
      corruptedYaml: [...this.scanIssues.corruptedYaml],
      duplicateTaskIds: this.duplicateTaskIdIssues.map((issue) => ({ ...issue })),
    };
  }

  async repairDuplicateTaskIds(): Promise<number> {
    if (!this.duplicateTaskIdIssues.length) return 0;
    const used = new Set<string>(this.tasksById.keys());
    let fixed = 0;
    for (const issue of this.duplicateTaskIdIssues) {
      const file = this.app.vault.getAbstractFileByPath(issue.duplicatePath);
      if (!(file instanceof TFile)) continue;
      const parsed = parseTaskFile(await this.app.vault.read(file));
      if (parsed.data.id !== issue.id) continue;
      let nextId = this.generateTaskId();
      while (used.has(nextId)) {
        const n = Number(nextId.replace(/^TSK-/, "")) + 1;
        nextId = `TSK-${n.toString().padStart(5, "0")}`;
      }
      used.add(nextId);
      await this.app.vault.modify(file, serializeTask({ ...parsed.data, id: nextId, updated_at: nowIso() }, parsed.body));
      fixed++;
    }
    if (fixed) await this.scan();
    return fixed;
  }

  /**
   * Guard every parent assignment, not just the ones made at creation time.
   *
   * createTask refused a parent that would exceed the nesting limit, but the
   * update path did not — so linking an EXISTING Item as a subitem (the picker
   * in the Item modal does exactly that) walked straight past the rule and
   * produced the fourth level the limit exists to prevent. The check belongs
   * where every write passes, next to the other centrally applied rules.
   * Imports set `bulk` while they rebuild a whole tree and are left alone.
   */
  private assertParentsAllowed(id: string, listPath: string | undefined, next: string[], prev: string[]): void {
    if (this.bulk) return;
    const features = this.resolveFeatures({ listPath });
    for (const pid of next) {
      if (prev.includes(pid)) continue;            // an existing link is not re-litigated
      if (pid === id || isDescendantOf(pid, id, this.tasksById)) throw new Error(t("err.subtaskCycle"));
      if (!canAttachSubtask(pid, features, this.tasksById)) throw new Error(t("err.subtaskMaxDepth"));
    }
  }

  async createTask(input: {
    listPath: string;
    title: string;
    status?: string;
    priority?: 1 | 2 | 3 | 4 | null;
    due_date?: string;
    start_date?: string;
    custom_fields?: Record<string, any>;
    tags?: string[];
    context?: string[];
    parent_task?: string;
    type?: string;
    body?: string;
  }): Promise<TaskFile> {
    const checkedTitle = validateTaskTitle(input.title);
    if (!checkedTitle.valid) {
      throw new Error(checkedTitle.reason === "required"
        ? t("err.taskTitleRequired")
        : t("err.taskTitleTooLong", { max: String(MAX_TASK_TITLE_LENGTH) }));
    }
    const title = checkedTitle.value;
    const list = this.findList(input.listPath);
    if (!list) throw new Error(t("err.listNotFound"));
    if (!this.bulk && !list.config.system_kind && this.openBudgetCount() >= limit(2)) {
      throw new Error(t("lim.tasks", { n: freeLimit(2) }));
    }
    if (input.parent_task) {
      const features = this.resolveFeatures({ listPath: input.listPath });
      if (!canAttachSubtask(input.parent_task, features, this.tasksById)) {
        throw new Error(t("err.subtaskMaxDepth"));
      }
    }
    const id = this.generateTaskId();
    const statusSet = this.resolveStatusSet(input.listPath).statuses;
    const status = input.status ?? statusSet.find((s) => s.is_default)?.id ?? statusSet[0]?.id;
    const statusObj = statusSet.find((s) => s.id === status);
    const data: any = {
      id,
      type: input.type || list.config.default_task_type || "task",
      title,
      list: list.config.name,
      space: this.findSpace(list.spacePath)?.config.name,
      folder: list.folderPath ? this.findFolder(list.folderPath)?.config.name : undefined,
      parent_task: input.parent_task ?? null,
      status,
      status_group: statusObj?.group,
      priority: input.priority ?? null,
      due_date: input.due_date ?? null,
      start_date: input.start_date ?? null,
      created_at: nowIso(),
      updated_at: nowIso(),
      tags: input.tags ?? [],
      context: input.context ?? [],
    };
    // Seed date/datetime custom fields (e.g. a calendar placed by a custom
    // field creates the task on the clicked day).
    if (input.custom_fields && Object.keys(input.custom_fields).length) {
      data.custom_fields = { ...input.custom_fields };
    }
    // Seed activity with the "created" event (settings-aware). Description
    // and any other freeform content go into the body — we no longer
    // pre-bake `## Description` / `## Activity` headers; both are now
    // structured fields edited from the modal.
    const seeded = appendActivity(undefined, { kind: "created" });
    if (seeded.length > 0) data.activity = seeded;
    const fileName = `${id.toLowerCase()}-${slugify(title) || "untitled"}.md`;
    const filePath = `${list.path}/${safeFileName(fileName)}`;
    const body = input.body ?? `\n# ${title}\n`;
    const content = serializeTask(data as any, body);
    const tf: TaskFile = {
      data: data as any,
      body,
      filePath,
      spacePath: list.spacePath,
      folderPath: list.folderPath,
      listPath: list.path,
    };
    await this.withSuppression(async () => {
      await this.writeFile(filePath, content);
    });
    // Incremental insert into the live tree — no full vault rescan (matches
    // updateTask's optimistic model). Views read straight off these.
    list.taskFiles.push(tf);
    this.tasksById.set(id, tf);
    this.emit();
    return tf;
  }

  // Duplicate one or more tasks into a home List. User-authored fields and
  // body are retained, while identity/audit timestamps are always fresh.
  // Attachment metadata remains valid because its complete physical tree is
  // copied from _attachments/<old-id>/ to _attachments/<new-id>/.
  async copyTasks(ids: string[], targetListPath: string): Promise<TaskFile[]> {
    const targetList = this.findList(targetListPath);
    if (!targetList || targetList.config.system_kind) throw new Error(t("err.targetListNotFound", { path: targetListPath }));
    const sources = ids.map((id) => this.tasksById.get(id)).filter((task): task is TaskFile => !!task);
    if (!sources.length) return [];
    if (!this.bulk && this.openBudgetCount() + sources.length > limit(2)) {
      throw new Error(t("lim.tasks", { n: freeLimit(2) }));
    }

    const targetStatuses = this.resolveStatusSet(targetListPath).statuses;
    const targetSpace = this.findSpace(targetList.spacePath);
    const targetFolder = targetList.folderPath ? this.findFolder(targetList.folderPath) : undefined;
    const created: TaskFile[] = [];

    try {
      await this.withSuppression(async () => {
        for (const source of sources) {
          const id = this.generateTaskId();
          const now = nowIso();
          const data: any = JSON.parse(JSON.stringify(source.data));
          data.id = id;
          delete data.custom_id;
          data.created_at = now;
          data.updated_at = now;
          data.activity = appendActivity(undefined, { kind: "created" });
          if (!data.activity.length) delete data.activity;

          data.list = targetList.config.name;
          data.space = targetSpace?.config.name;
          if (targetFolder) data.folder = targetFolder.config.name;
          else delete data.folder;
          const currentStatus = targetStatuses.find((status) => status.id === data.status);
          const status = currentStatus ?? targetStatuses.find((candidate) => candidate.is_default) ?? targetStatuses[0];
          data.status = status?.id;
          data.status_group = status?.group;
          const additional = (Array.isArray(data.additional_lists) ? data.additional_lists : []).filter((path: string) => path !== targetListPath);
          if (additional.length) data.additional_lists = additional;
          else delete data.additional_lists;
          if (typeof data.cover_image === "string") {
            data.cover_image = data.cover_image.replace(`_attachments/${source.data.id}/`, `_attachments/${id}/`);
          }

          const fileName = `${id.toLowerCase()}-${slugify(data.title) || "untitled"}.md`;
          const filePath = normalizePath(`${targetList.path}/${safeFileName(fileName)}`);
          const body = source.body;
          await this.writeFile(filePath, serializeTask(data, body));
          const copy: TaskFile = {
            data,
            body,
            filePath,
            spacePath: targetList.spacePath,
            folderPath: targetList.folderPath,
            listPath: targetList.path,
          };
          created.push(copy);
          targetList.taskFiles.push(copy);
          // Reserve the ID immediately so the next copy in this batch cannot
          // generate it again before the final emit.
          this.tasksById.set(id, copy);
          await copyAllAttachmentsForTask(this, source.data.id, id);
        }
      });
    } catch (error) {
      await this.withSuppression(async () => {
        for (const copy of created) {
          const file = this.app.vault.getAbstractFileByPath(copy.filePath);
          if (file instanceof TFile) await this.app.vault.trash(file, true);
          try { await deleteAllAttachmentsForTask(this, copy.data.id); } catch { /* best-effort rollback */ }
          this.tasksById.delete(copy.data.id);
          const pos = targetList.taskFiles.indexOf(copy);
          if (pos >= 0) targetList.taskFiles.splice(pos, 1);
        }
      });
      throw error;
    }
    this.emit();
    return created;
  }

  // Recurring tasks advance instead of staying closed — and that must hold no
  // matter WHERE the status changed (task modal, list status chip, board drag,
  // table cell / bulk edit). Applied centrally on the only two write paths
  // (updateTask / bulkUpdateTasks): when a task transitions INTO done/closed
  // with an active recurring config, bump due_date to the next occurrence,
  // reset status to the list default and log the reschedule.
  private maybeRescheduleRecurring(draft: any, listPath: string | undefined, prevData: any): void {
    if (!draft.recurring?.enabled) return;
    const set = this.resolveStatusSet(listPath).statuses;
    const groupOf = (status: string | undefined | null, fallback?: string) =>
      set.find((s) => s.id === status)?.group ?? fallback;
    const newGroup = groupOf(draft.status, draft.status_group);
    if (newGroup !== "done" && newGroup !== "closed") return;
    const prevGroup = groupOf(prevData.status, prevData.status_group);
    if (prevGroup === "done" || prevGroup === "closed") return; // already closed — no double-advance

    const result = rescheduleOnClose({ due_date: draft.due_date, recurring: draft.recurring });
    if (!result) return; // no next occurrence — close normally
    draft.recurring = result.recurring;
    if (result.ended) {
      // Last occurrence: record that the series is over and let the close stand.
      // Advancing the date and resetting the status below would re-open the Item
      // on a date beyond the series the user configured.
      draft.activity = appendActivity(draft.activity, { kind: "recurring_disabled" });
      return;
    }
    draft.due_date = result.due_date;
    draft.activity = appendActivity(draft.activity, {
      kind: "recurring_rescheduled",
      from: prevData.due_date ?? null,
      to: result.due_date,
    });
    const defaultStatus = set.find((s) => s.is_default)?.id ?? set[0]?.id;
    if (defaultStatus) {
      draft.status = defaultStatus;
      draft.status_group = groupOf(defaultStatus, draft.status_group);
    }
  }

  async updateTask(id: string, mutator: (data: any, body: string) => { data: any; body?: string } | void) {
    return this.withTaskWriteLock(id, () => this.updateTaskUnlocked(id, mutator));
  }

  private async updateTaskUnlocked(id: string, mutator: (data: any, body: string) => { data: any; body?: string } | void) {
    const tf = this.tasksById.get(id);
    if (!tf) throw new Error(t("err.taskNotFound", { id }));
    const file = this.app.vault.getAbstractFileByPath(tf.filePath);
    if (!(file instanceof TFile)) throw new Error(t("err.taskNotFound", { id }));

    // Re-read the current file before applying a mutation. This prevents a
    // stale in-memory TaskFile from overwriting a newer edit that arrived via
    // Obsidian Sync or a direct markdown edit before the debounced rescan ran.
    const current = parseTaskFile(await this.app.vault.read(file));
    if (current.data.id && current.data.id !== id) {
      throw new Error(`Item id changed on disk (${id} -> ${current.data.id}). Refresh before saving.`);
    }

    const draftData = { ...current.data, id };
    let draftBody = current.body;
    const out = mutator(draftData, draftBody);
    if (out) {
      Object.assign(draftData, out.data);
      if (typeof out.body === "string") draftBody = out.body;
    }
    if (draftData.title !== current.data.title) {
      const checkedTitle = validateTaskTitle(draftData.title);
      if (!checkedTitle.valid) {
        throw new Error(checkedTitle.reason === "required"
          ? t("err.taskTitleRequired")
          : t("err.taskTitleTooLong", { max: String(MAX_TASK_TITLE_LENGTH) }));
      }
      draftData.title = checkedTitle.value;
      // Items are seeded with `# {title}` for the same reason container markers
      // are, so a rename has to carry the heading along here too — otherwise the
      // body keeps advertising the old title, and the Board's description
      // preview shows it back to the user.
      draftBody = retitleBody(draftBody, current.data.title, draftData.title);
    }
    for (const field of ["time_estimate", "time_tracked", "sprint_points"] as const) {
      if (Object.is(draftData[field], current.data[field])) continue;
      const checked = parseNonNegativeInteger(draftData[field]);
      if (!checked.valid) throw new Error(t("err.taskMetricInvalid"));
      draftData[field] = checked.value;
    }
    {
      const nextParents = parentTaskIds(draftData);
      const prevParents = parentTaskIds(current.data);
      if (nextParents.join("|") !== prevParents.join("|")) {
        this.assertParentsAllowed(id, tf.listPath, nextParents, prevParents);
      }
    }
    draftData.updated_at = nowIso();
    // Resolve status_group
    if (draftData.status && draftData.list) {
      const list = this.findList(tf.listPath || "");
      if (list) {
        const set = this.resolveStatusSet(tf.listPath).statuses;
        const so = set.find((s) => s.id === draftData.status);
        if (so) draftData.status_group = so.group;
      }
    }
    this.maybeRescheduleRecurring(draftData, tf.listPath, current.data);
    const content = serializeTask(draftData, draftBody);
    // Suppress the self-triggered vault 'modify' event: we apply the change
    // optimistically below and emit once, so the debounced watcher must not
    // run a second full rescan 350ms later (that caused the double flicker /
    // sluggishness on every edit). Matches the create/move mutators.
    await this.withSuppression(() => this.app.vault.modify(file, content));
    // Optimistic local update
    tf.data = draftData;
    tf.body = draftBody;
    this.emit();
  }

  // Apply a patch to many tasks at once — one suppressed file write each, then
  // a single emit. Used by Table bulk-edit so 50 selected rows don't trigger
  // 50 full re-renders.
  async bulkUpdateTasks(ids: string[], patch: (d: any) => any): Promise<void> {
    await this.withSuppression(async () => {
      for (const id of ids) {
        await this.withTaskWriteLock(id, async () => {
          const tf = this.tasksById.get(id);
          if (!tf) return;
          const file = this.app.vault.getAbstractFileByPath(tf.filePath);
          if (!(file instanceof TFile)) return;
          const current = parseTaskFile(await this.app.vault.read(file));
          if (current.data.id && current.data.id !== id) return;
          const patchData = patch(current.data) || {};
          const draft: any = { ...current.data, id, ...patchData, updated_at: nowIso() };
          let body = current.body;
          if (Object.prototype.hasOwnProperty.call(patchData, "title")) {
            const checkedTitle = validateTaskTitle(draft.title);
            if (!checkedTitle.valid) {
              throw new Error(checkedTitle.reason === "required"
                ? t("err.taskTitleRequired")
                : t("err.taskTitleTooLong", { max: String(MAX_TASK_TITLE_LENGTH) }));
            }
            draft.title = checkedTitle.value;
            body = retitleBody(body, current.data.title, draft.title);
          }
          if (Object.prototype.hasOwnProperty.call(patchData, "parent_task")) {
            this.assertParentsAllowed(id, tf.listPath, parentTaskIds(draft), parentTaskIds(current.data));
          }
          for (const field of ["time_estimate", "time_tracked", "sprint_points"] as const) {
            if (!Object.prototype.hasOwnProperty.call(patchData, field)) continue;
            const checked = parseNonNegativeInteger(draft[field]);
            if (!checked.valid) throw new Error(t("err.taskMetricInvalid"));
            draft[field] = checked.value;
          }
          // Bulk edits bypass the individual List/Table cell mutators, so keep
          // the same audit guarantees here for every core field supported by
          // ActivityKind. A caller that explicitly supplies `activity` remains
          // in full control and is not logged twice.
          if (!Object.prototype.hasOwnProperty.call(patchData, "activity")) {
            const auditedFields = [
              ["title", "title"],
              ["status", "status"],
              ["priority", "priority"],
              ["due_date", "due_date"],
              ["start_date", "start_date"],
            ] as const;
            for (const [field, kind] of auditedFields) {
              const from = current.data[field] ?? null;
              const to = draft[field] ?? null;
              if (!Object.is(from, to)) {
                draft.activity = appendActivity(draft.activity, { kind, from, to });
              }
            }
            const activityValue = (value: any): string | number | null => {
              if (value === null || value === undefined || value === "") return null;
              if (typeof value === "number" || typeof value === "string") return value;
              if (Array.isArray(value)) return value.map(String).join(", ") || null;
              if (typeof value === "boolean") return String(value);
              try { return JSON.stringify(value); } catch { return String(value); }
            };
            const oldTags = Array.isArray(current.data.tags) ? current.data.tags : [];
            const newTags = Array.isArray(draft.tags) ? draft.tags : [];
            if (JSON.stringify(oldTags) !== JSON.stringify(newTags)) {
              draft.activity = appendActivity(draft.activity, {
                kind: "tags",
                from: activityValue(oldTags),
                to: activityValue(newTags),
              });
            }
            const oldCustom = current.data.custom_fields || {};
            const newCustom = draft.custom_fields || {};
            for (const fieldId of new Set([...Object.keys(oldCustom), ...Object.keys(newCustom)])) {
              if (JSON.stringify(oldCustom[fieldId]) === JSON.stringify(newCustom[fieldId])) continue;
              draft.activity = appendActivity(draft.activity, {
                kind: "custom_field",
                id: fieldId,
                from: activityValue(oldCustom[fieldId]),
                to: activityValue(newCustom[fieldId]),
              });
            }
            const oldLists = new Set<string>((Array.isArray(current.data.additional_lists) ? current.data.additional_lists : []).map(String));
            const newLists = new Set<string>((Array.isArray(draft.additional_lists) ? draft.additional_lists : []).map(String));
            for (const listPath of newLists) {
              if (!oldLists.has(listPath)) draft.activity = appendActivity(draft.activity, { kind: "list_added", id: listPath });
            }
            for (const listPath of oldLists) {
              if (!newLists.has(listPath)) draft.activity = appendActivity(draft.activity, { kind: "list_removed", id: listPath });
            }
          }
          if (draft.status && tf.listPath) {
            const so = this.resolveStatusSet(tf.listPath).statuses.find((s) => s.id === draft.status);
            if (so) draft.status_group = so.group;
          }
          this.maybeRescheduleRecurring(draft, tf.listPath, current.data);
          await this.app.vault.modify(file, serializeTask(draft, body));
          tf.data = draft;
          tf.body = body;
        });
      }
    });
    this.emit();
  }

  // Archive is reversible and keeps the same file, id and relationships. The
  // false state is omitted from frontmatter so active tasks stay uncluttered.
  async setTasksArchived(ids: string[], archived: boolean): Promise<void> {
    const changed = ids.filter((id) => {
      const task = this.tasksById.get(id);
      return !!task && (task.data.archived === true) !== archived;
    });
    if (!changed.length) return;

    // Restoring puts tasks back into the open working set, so it has to pass
    // the same budget check as creating or copying them. Archiving needs no
    // gate — it only ever lowers the count. Without this, the ceiling is three
    // clicks away from meaningless: fill it, archive the lot, fill it again,
    // then restore. Checked for the whole batch up front, like copyTasks.
    if (!archived && !this.bulk) {
      const restoredOpen = changed.reduce((n, id) => {
        const g = this.tasksById.get(id)?.data.status_group;
        return n + (g !== "done" && g !== "closed" ? 1 : 0);
      }, 0);
      if (this.openBudgetCount() + restoredOpen > limit(2)) {
        throw new Error(t("lim.tasks", { n: freeLimit(2) }));
      }
    }

    await this.bulkUpdateTasks(changed, (data) => ({
      archived: archived ? true : undefined,
      activity: appendActivity(data.activity, { kind: archived ? "archived" : "unarchived" }),
    }));
  }

  // Merge selected tasks into one stable target. Per the product contract,
  // descriptions and checklists are combined; scalar properties (status,
  // dates, custom fields, etc.) remain authoritative on the chosen target.
  // Graph references are redirected before sources are soft-deleted so no
  // parent/relationship link is left pointing at a task moved to Trash.
  async mergeTasks(ids: string[], targetId: string): Promise<{ target: TaskFile; mergedIds: string[] }> {
    const uniqueIds = Array.from(new Set(ids));
    if (uniqueIds.length < 2) throw new Error(t("merge.needTwo"));
    if (!uniqueIds.includes(targetId)) throw new Error(t("merge.targetNotSelected"));
    const selected = uniqueIds.map((id) => this.tasksById.get(id));
    if (selected.some((task) => !task || task.data.archived || this.isSystemTask(task))) {
      throw new Error(t("merge.invalidSelection"));
    }
    const target = this.tasksById.get(targetId)!;
    const sources = selected.filter((task): task is TaskFile => !!task && task.data.id !== targetId);
    const selectedIds = new Set(uniqueIds);

    const redirected = (values: string[] | undefined, selfId: string): string[] => {
      const out: string[] = [];
      for (const value of values || []) {
        const next = selectedIds.has(value) ? targetId : value;
        if (next === selfId || out.includes(next)) continue;
        out.push(next);
      }
      return out;
    };
    const mergedRefs = (key: "blocks" | "related", current: any): string[] => redirected([
      ...(current.relationships?.[key] || []),
      ...sources.flatMap((source) => source.data.relationships?.[key] || []),
    ], targetId);

    await this.updateTask(targetId, (data, body) => {
      const usedChecklistIds = new Set<string>();
      const checklist: any[] = [];
      const addChecklist = (items: any[] | undefined, sourceId?: string) => {
        for (const original of items || []) {
          let id = String(original.id || "checklist-item");
          if (usedChecklistIds.has(id)) {
            const base = `${id}-merged-${String(sourceId || "item").toLowerCase()}`;
            id = base;
            let suffix = 2;
            while (usedChecklistIds.has(id)) id = `${base}-${suffix++}`;
          }
          usedChecklistIds.add(id);
          checklist.push({ ...original, id });
        }
      };
      addChecklist(Array.isArray(data.checklist) ? data.checklist : []);
      for (const source of sources) addChecklist(source.data.checklist, source.data.id);

      const bodyParts = [body.trimEnd()];
      for (const source of sources) {
        const sourceBody = source.body.trim();
        if (!sourceBody) continue;
        const sourceTitle = String(source.data.title || source.data.id).replace(/[\r\n]+/g, " ");
        bodyParts.push(`---\n\n## ${t("merge.bodyHeading", { title: sourceTitle, id: source.data.id })}\n\n${sourceBody}`);
      }

      let activity = data.activity;
      for (const source of sources) {
        activity = appendActivity(activity, { kind: "merged", id: source.data.id, text: source.data.title || source.data.id });
      }
      const parents = redirected([
        ...parentTaskIds(data),
        ...sources.flatMap((source) => parentTaskIds(source.data)),
      ], targetId);
      const blocks = mergedRefs("blocks", data);
      const related = mergedRefs("related", data);
      return {
        data: {
          ...data,
          parent_task: normalizeParentTask(parents),
          relationships: (blocks.length || related.length) ? { blocks, related } : undefined,
          checklist: checklist.length ? checklist : undefined,
          activity,
        },
        body: bodyParts.filter(Boolean).join("\n\n"),
      };
    });

    // Repoint references held by non-selected tasks. Do this before deleteTask;
    // its dangling-reference cleanup then becomes a no-op for merged IDs.
    for (const partner of Array.from(this.tasksById.values())) {
      if (selectedIds.has(partner.data.id)) continue;
      const oldParents = parentTaskIds(partner.data);
      const oldBlocks = partner.data.relationships?.blocks || [];
      const oldRelated = partner.data.relationships?.related || [];
      if (![...oldParents, ...oldBlocks, ...oldRelated].some((id) => selectedIds.has(id))) continue;
      await this.updateTask(partner.data.id, (data) => {
        const parents = redirected(parentTaskIds(data), partner.data.id);
        const blocks = redirected(data.relationships?.blocks, partner.data.id);
        const related = redirected(data.relationships?.related, partner.data.id);
        return { data: {
          ...data,
          parent_task: normalizeParentTask(parents),
          relationships: (blocks.length || related.length) ? { blocks, related } : undefined,
        } };
      });
    }

    for (const source of sources) await this.deleteTask(source.data.id);
    return { target: this.tasksById.get(targetId)!, mergedIds: sources.map((source) => source.data.id) };
  }

  async deleteTask(id: string) {
    const tf = this.tasksById.get(id);
    if (!tf) return;

    // Find every other task that references the deleted one in any stored
    // relationships bucket and rewrite them with the dangling id stripped.
    // We do this *before* trashing so a partial failure leaves the graph
    // consistent (file still exists, just with cleaned partners).
    // Only `blocks` and `related` are stored — `waiting_on` is derived from
    // inverse blocks, so it disappears automatically once `blocks` is cleaned.
    const refKeys: Array<"blocks" | "related"> = ["blocks", "related"];
    const writes: Array<{ tf: TaskFile; data: any }> = [];
    for (const partner of this.tasksById.values()) {
      if (partner.data.id === id) continue;
      const rels = partner.data.relationships;
      if (!rels) continue;
      let touched = false;
      const nextRels: any = { ...rels };
      for (const k of refKeys) {
        const arr = rels[k];
        if (Array.isArray(arr) && arr.includes(id)) {
          nextRels[k] = arr.filter((x: string) => x !== id);
          touched = true;
        }
      }
      if (touched) {
        writes.push({
          tf: partner,
          data: {
            ...partner.data,
            relationships: nextRels,
            updated_at: nowIso(),
          },
        });
      }
    }

    await this.withSuppression(async () => {
      for (const w of writes) {
        const f = this.app.vault.getAbstractFileByPath(w.tf.filePath);
        if (!(f instanceof TFile)) continue;
        await this.app.vault.modify(f, serializeTask(w.data, w.tf.body));
        w.tf.data = w.data;
      }
      // Soft-delete: move the file into the workspace _trash folder with
      // restore metadata (original list path + timestamp) so it can be
      // restored from the Trash view. Attachments stay until permanent purge.
      const file = this.app.vault.getAbstractFileByPath(tf.filePath);
      if (file instanceof TFile) {
        const fromDir = tf.listPath || file.parent?.path || "";
        const trashDir = this.trashDir();
        await this.ensureFolder(trashDir);
        const withMeta: any = { ...tf.data, _trashed_at: nowIso(), _trashed_from: fromDir };
        await this.app.vault.modify(file, serializeTask(withMeta, tf.body));
        await this.app.vault.rename(file, this.uniqueChildPath(trashDir, file.name));
      }
    });
    this.tasksById.delete(id);
    this.trashedTaskIds.add(id);
    // Incremental removal from the live list node — no full vault rescan.
    // Relationship partners were already patched in-memory above (same refs).
    const ln = tf.listPath ? this.findList(tf.listPath) : undefined;
    if (ln) {
      const i = ln.taskFiles.findIndex((x) => x.data.id === id);
      if (i >= 0) ln.taskFiles.splice(i, 1);
    }
    this.emit();
  }

  // ---------- Trash (soft-delete + restore) ----------

  // Folder under the workspace root that holds soft-deleted task files.
  // Not scanned as tasks (it has no _space.md and isn't inside any list).
  trashDir(): string {
    const r = this.rootPath || "/";
    return (r === "/" || r === "") ? "_trash" : `${r}/_trash`;
  }

  // A non-colliding `<dir>/<fileName>` path (appends -2, -3, … if taken).
  private uniqueChildPath(dir: string, fileName: string): string {
    const first = normalizePath(`${dir}/${fileName}`);
    if (!this.app.vault.getAbstractFileByPath(first)) return first;
    const stem = fileName.replace(/\.md$/i, "");
    let n = 2;
    while (this.app.vault.getAbstractFileByPath(normalizePath(`${dir}/${stem}-${n}.md`))) n++;
    return normalizePath(`${dir}/${stem}-${n}.md`);
  }

  // Same idea for a folder destination (no .md suffix handling).
  private uniqueChildDir(dir: string, name: string): string {
    const first = normalizePath(`${dir}/${name}`);
    if (!this.app.vault.getAbstractFileByPath(first)) return first;
    let n = 2;
    while (this.app.vault.getAbstractFileByPath(normalizePath(`${dir}/${name}-${n}`))) n++;
    return normalizePath(`${dir}/${name}-${n}`);
  }

  // Soft-delete a Space / Folder / List: stamp restore metadata onto its config
  // file (_space.md / _folder.md / _list.md) and move the whole folder (with all
  // its lists/tasks) into _trash. Restorable from the Trash view. _trash isn't
  // scanned, so everything inside disappears from views until restored.
  private async softTrashContainer(folderPath: string): Promise<void> {
    const folder = this.app.vault.getAbstractFileByPath(folderPath);
    if (!(folder instanceof TFolder)) return;
    const cfgFile = folder.children.find(
      (c) => c instanceof TFile && (c.name === SPACE_FILE || c.name === FOLDER_FILE || c.name === LIST_FILE)
    ) as TFile | undefined;
    const fromParent = folder.parent?.path ?? "";
    const trashDir = this.trashDir();
    await this.ensureFolder(trashDir);
    await this.withSuppression(async () => {
      if (cfgFile) {
        const raw = await this.app.vault.read(cfgFile);
        const { fm, body } = splitFrontmatter(raw);
        const next = { ...fm, _trashed_at: nowIso(), _trashed_from: fromParent };
        await this.app.vault.modify(cfgFile, joinFrontmatter(next, body));
      }
      await this.app.vault.rename(folder, this.uniqueChildDir(trashDir, folder.name));
    });
    await this.scan();
    this.emit();
  }

  /** Trashed items older than this are permanently deleted by the automatic
   *  sweep (mirrors the 30-day retention used for cleared notifications). */
  static TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

  /** Permanently delete trashed items past the retention window. Runs after
   *  load / workspace switch so the trash stays bounded without manual
   *  emptying. Items missing a `_trashed_at` stamp are never auto-purged. */
  async purgeExpiredTrash(now = Date.now()): Promise<number> {
    let purged = 0;
    try {
      const items = await this.listTrashedItems();
      for (const item of items) {
        const ts = item.trashedAt ? Date.parse(item.trashedAt) : NaN;
        if (!Number.isFinite(ts) || now - ts < WorkspaceIndex.TRASH_RETENTION_MS) continue;
        try {
          if (item.kind === "task") await this.purgeTask(item.path);
          else await this.purgeContainer(item.path);
          purged++;
        } catch (e) {
          console.warn("[InventTasks] Trash auto-purge failed for", item.path, e);
        }
      }
    } catch (e) {
      console.warn("[InventTasks] Trash auto-purge sweep failed", e);
    }
    return purged;
  }

  // Read the _trash folder and return one entry per trashed item — tasks
  // (direct .md files) AND containers (subfolders holding a _space/_folder/
  // _list.md). Sorted most-recently-trashed first. Frontmatter-only reads.
  async listTrashedItems(): Promise<TrashedItem[]> {
    const dir = this.app.vault.getAbstractFileByPath(this.trashDir());
    if (!(dir instanceof TFolder)) return [];
    const out: TrashedItem[] = [];
    for (const c of dir.children) {
      if (c instanceof TFile && c.extension === "md") {
        const { fm } = splitFrontmatter(await this.app.vault.read(c));
        out.push({
          kind: "task",
          name: fm.title ?? c.basename,
          id: typeof fm.id === "string" ? fm.id : undefined,
          trashedAt: typeof fm._trashed_at === "string" ? fm._trashed_at : undefined,
          from: typeof fm._trashed_from === "string" ? fm._trashed_from : undefined,
          path: c.path,
        });
      } else if (c instanceof TFolder) {
        const cfg = c.children.find(
          (x) => x instanceof TFile && (x.name === SPACE_FILE || x.name === FOLDER_FILE || x.name === LIST_FILE)
        ) as TFile | undefined;
        if (!cfg) continue;
        const { fm } = splitFrontmatter(await this.app.vault.read(cfg));
        const kind = cfg.name === SPACE_FILE ? "space" : cfg.name === FOLDER_FILE ? "folder" : "list";
        out.push({
          kind,
          name: fm.name ?? c.name,
          trashedAt: typeof fm._trashed_at === "string" ? fm._trashed_at : undefined,
          from: typeof fm._trashed_from === "string" ? fm._trashed_from : undefined,
          path: c.path,
        });
      }
    }
    out.sort((a, b) => String(b.trashedAt ?? "").localeCompare(String(a.trashedAt ?? "")));
    return out;
  }

  // Move a trashed file back to its original list, stripping trash metadata.
  // If that list was deleted, callers can pass a replacement list path.
  async restoreTask(filePath: string, targetListPath?: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) return;
    const raw = await this.app.vault.read(file);
    const { fm } = splitFrontmatter(raw);
    const fromDir = typeof fm._trashed_from === "string" ? fm._trashed_from : "";
    const restoreDir = targetListPath || fromDir;
    const target = restoreDir ? this.app.vault.getAbstractFileByPath(restoreDir) : null;
    if (!(target instanceof TFolder)) {
      throw new Error(t("err.restoreListGone"));
    }
    const targetList = this.findList(restoreDir);
    if (!targetList) throw new Error(t("err.restoreListGone"));

    // Re-parse to drop the _trashed_* metadata (parseTaskFile ignores unknown
    // keys), then write clean frontmatter with the target hierarchy and move.
    const parsed = parseTaskFile(raw);
    const data: any = { ...parsed.data };
    if (data.id && this.tasksById.has(data.id)) {
      throw new Error(t("err.restoreIdConflict", { id: data.id }));
    }
    const space = this.findSpace(targetList.spacePath);
    const folder = targetList.folderPath ? this.findFolder(targetList.folderPath) : undefined;
    const statusSet = this.resolveStatusSet(targetList.path).statuses;
    const status = data.status && statusSet.find((s) => s.id === data.status)
      ? data.status
      : (statusSet.find((s) => s.is_default)?.id ?? statusSet[0]?.id);
    const statusObj = statusSet.find((s) => s.id === status);
    data.space = space?.config.name;
    data.folder = folder?.config.name;
    if (!folder) delete data.folder;
    data.list = targetList.config.name;
    data.status = status;
    data.status_group = statusObj?.group;
    data.updated_at = nowIso();
    await this.withSuppression(async () => {
      await this.app.vault.modify(file, serializeTask(data, parsed.body));
      await this.app.vault.rename(file, this.uniqueChildPath(restoreDir, file.name));
    });
    await this.scan();
    this.emit();
  }

  // Permanently delete a trashed file (system trash) plus its attachments.
  async purgeTask(filePath: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) return;
    const raw = await this.app.vault.read(file);
    const { fm } = splitFrontmatter(raw);
    const id = typeof fm.id === "string" ? fm.id : "";
    if (id) await this.stripCustomRelationshipRefs(id);
    await this.withSuppression(async () => {
      if (id) { try { await deleteAllAttachmentsForTask(this, id); } catch (e) { /* swallow */ } }
      await this.app.vault.trash(file, true);
    });
    await this.scanTrashedTaskIds();
    this.emit();
  }

  /**
   * Drop a permanently deleted Item's id from every `relationship` custom field
   * that still points at it.
   *
   * Soft delete deliberately leaves these references alone: the Item is only in
   * the Trash, and keeping the id is what lets Restore bring the link back
   * intact. Once the Item is purged nothing can ever resolve that id again, so
   * leaving it behind strands a chip the user can never repair — the same
   * dangling-reference problem `deleteTask` already avoids for the built-in
   * `blocks` / `related` buckets.
   *
   * Only fields actually declared as `relationship` for the holding Item's List
   * are touched, so an array value of another type can never be edited by
   * coincidence.
   */
  private async stripCustomRelationshipRefs(id: string): Promise<void> {
    const writes: Array<{ tf: TaskFile; data: any }> = [];
    for (const tf of this.tasksById.values()) {
      const cf = tf.data.custom_fields;
      if (!cf) continue;
      const relFields = this.resolveCustomFields(tf.listPath).filter((f) => f.type === "relationship");
      if (relFields.length === 0) continue;
      let touched = false;
      const next: Record<string, any> = { ...cf };
      for (const field of relFields) {
        const arr = cf[field.id];
        if (!Array.isArray(arr) || !arr.includes(id)) continue;
        const kept = arr.filter((x: unknown) => x !== id);
        if (kept.length) next[field.id] = kept;
        else delete next[field.id];
        touched = true;
      }
      if (touched) writes.push({ tf, data: { ...tf.data, custom_fields: next, updated_at: nowIso() } });
    }
    if (writes.length === 0) return;
    await this.withSuppression(async () => {
      for (const w of writes) {
        const f = this.app.vault.getAbstractFileByPath(w.tf.filePath);
        if (!(f instanceof TFile)) continue;
        await this.app.vault.modify(f, serializeTask(w.data, w.tf.body));
        w.tf.data = w.data;
      }
    });
  }

  // Move a trashed container folder back to its original parent, stripping the
  // restore metadata from its config file. Throws if the parent is gone.
  async restoreContainer(folderPath: string): Promise<void> {
    const folder = this.app.vault.getAbstractFileByPath(folderPath);
    if (!(folder instanceof TFolder)) return;
    const cfg = folder.children.find(
      (x) => x instanceof TFile && (x.name === SPACE_FILE || x.name === FOLDER_FILE || x.name === LIST_FILE)
    ) as TFile | undefined;
    if (!cfg) throw new Error(t("err.trashedMissingConfig"));
    const raw = await this.app.vault.read(cfg);
    const { fm, body } = splitFrontmatter(raw);
    const fromParent = typeof fm._trashed_from === "string" ? fm._trashed_from : "";
    const target = (fromParent === "" || fromParent === "/")
      ? this.app.vault.getRoot()
      : this.app.vault.getAbstractFileByPath(fromParent);
    if (!(target instanceof TFolder)) {
      throw new Error(t("err.restoreParentGone"));
    }
    const clean: any = { ...fm };
    delete clean._trashed_at;
    delete clean._trashed_from;
    await this.withSuppression(async () => {
      await this.app.vault.modify(cfg, joinFrontmatter(clean, body));
      await this.app.vault.rename(folder, this.uniqueChildDir(target.path, folder.name));
    });
    await this.scan();
    this.emit();
  }

  // Permanently delete a trashed container (system trash) plus the attachments
  // of every task inside it. Best-effort attachment cleanup.
  async purgeContainer(folderPath: string): Promise<void> {
    const folder = this.app.vault.getAbstractFileByPath(folderPath);
    if (!(folder instanceof TFolder)) return;
    const ids = await this.collectTrashedTaskIds(folder);
    await this.withSuppression(async () => {
      for (const id of ids) { try { await deleteAllAttachmentsForTask(this, id); } catch (e) { /* swallow */ } }
      await this.app.vault.trash(folder, true);
    });
    await this.scanTrashedTaskIds();
    this.emit();
  }

  // Recursively collect task ids (from non-config .md files) inside a folder.
  private async collectTrashedTaskIds(folder: TFolder): Promise<string[]> {
    const ids: string[] = [];
    const walk = async (f: TFolder) => {
      for (const c of f.children) {
        if (c instanceof TFolder) await walk(c);
        else if (c instanceof TFile && c.extension === "md" && !c.name.startsWith("_")) {
          const { fm } = splitFrontmatter(await this.app.vault.read(c));
          if (typeof fm.id === "string") ids.push(fm.id);
        }
      }
    };
    await walk(folder);
    return ids;
  }

  // ---------- Relationships ----------
  //
  // Relationships are now single-source: see src/data/relationships.ts for
  // the helpers used by all consumers. `blocks` is stored on the blocker;
  // `waiting_on` is derived as the inverse view of `blocks`; `related` is
  // stored on whichever task the user added it from. All writes go through
  // `updateTask` directly via those helpers — no mirror, no batching.

  async openTaskInEditor(id: string) {
    const tf = this.tasksById.get(id);
    if (!tf) return;
    const file = this.app.vault.getAbstractFileByPath(tf.filePath);
    if (file instanceof TFile) {
      const leaf = this.app.workspace.getLeaf(true);
      await leaf.openFile(file);
    }
  }

  // ---------- Workspace/Space/List CRUD ----------

  async createWorkspaceConfig(name: string) {
    const root = this.rootPath || "/";
    const wsPath = root === "/" || root === "" ? WORKSPACE_FILE : `${root}/${WORKSPACE_FILE}`;
    // Workspace is the source — seed every configurable element with defaults.
    // Lower levels (Space/Folder/List) all inherit unless they override.
    const fm = {
      workspace_id: "WSP-0001",
      name,
      icon: "layout-dashboard",
      color: "#0091FF",
      date_format: "YYYY-MM-DD",
      time_format: "HH:mm",
      week_start: "monday",
      default_currency: "PLN",
      status_set: DEFAULT_STATUS_SET,
      priorities: DEFAULT_PRIORITIES,
      task_types: DEFAULT_TASK_TYPES,
      tags_palette: [],
      context_labels: DEFAULT_CONTEXT_LABELS,
      custom_fields: [],
      view_defaults: {},
      features: {
        priorities: true, tags: true, context: true,
        time_tracking: false, time_estimate: false, sprint_points: false,
        dependencies: true, custom_task_types: true, recurring_tasks: true,
        incomplete_warning: true, dependency_warning: true, nested_subtasks: true,
        multiple_lists: true,
        due_dates: true, start_dates: true, checklists: true, attachments: true,
        comments: true, documents: true, description: true, cover_images: true,
        ...DEFAULT_MODAL_DISPLAY_FEATURES,
      },
      empty_positions: {},
      chip_styles: DEFAULT_CHIP_STYLES,
      task_behavior: {
        subtasks_checkbox_action: "done",
      },
      field_labels: {},
      notifications_enabled: true,
    };
    const body = `\n# ${name}\n\nWelcome to InventTasks. This file holds your workspace-level configuration.\n`;
    const content = joinFrontmatter(fm, body);
    await this.writeFile(wsPath, content);
  }

  async createSpace(name: string, opts: { icon?: string; color?: string; statusSet?: StatusDef[]; description?: string } = {}): Promise<string> {
    // The hidden System space hosts Reminders and Short notes, but it is not a
    // user-created Space and must never consume the free-tier Space budget.
    // `spaces` deliberately includes it for lookup/config resolution; quota
    // decisions use the public, user-visible projection instead.
    if (!this.bulk && this.userSpaces.length >= limit(0)) throw new Error(t("lim.spaces", { n: freeLimit(0) }));
    const root = this.rootPath || "/";
    const dirName = safeFileName(`Space - ${name}`);
    const dirPath = root === "/" || root === "" ? dirName : `${root}/${dirName}`;
    await this.ensureFolder(dirPath);
    const filePath = `${dirPath}/${SPACE_FILE}`;
    // New space starts as fully-inherited from workspace (no overrides).
    // Caller can pass `statusSet` to immediately override the status workflow.
    const fm: any = {
      space_id: `SPC-${Math.floor(Math.random() * 10000).toString().padStart(4, "0")}`,
      name,
      icon: opts.icon ?? "🏷️",
      color: opts.color ?? "#0091FF",
    };
    if (opts.statusSet) fm.status_set = opts.statusSet;
    const body = `\n# ${name}\n\n${opts.description ?? ""}`;
    const content = joinFrontmatter(fm, body);
    await this.writeFile(filePath, content);
    return dirPath;
  }

  private systemSpacePath(): string {
    const root = this.rootPath || "/";
    const dirName = safeFileName(`Space - ${SYSTEM_SPACE_NAME}`);
    return root === "/" || root === "" ? dirName : `${root}/${dirName}`;
  }

  async ensureSystemLists(): Promise<boolean> {
    let changed = false;
    const spacePath = this.systemSpacePath();
    const spaceFile = `${spacePath}/${SPACE_FILE}`;
    if (!this.app.vault.getAbstractFileByPath(spaceFile)) {
      await this.ensureFolder(spacePath);
      await this.writeFile(spaceFile, joinFrontmatter({
        space_id: "SPC-SYSTEM",
        name: SYSTEM_SPACE_NAME,
        icon: "settings",
        color: "#64748B",
        hidden: true,
      }, `\n# ${SYSTEM_SPACE_NAME}\n\nSystem-managed lists for InventTasks.\n`));
      changed = true;
    }

    const ensureList = async (kind: SystemListKind, name: string, icon: string, color: string) => {
      const listPath = `${spacePath}/${safeFileName(`List - ${name}`)}`;
      const listFile = `${listPath}/${LIST_FILE}`;
      const existing = this.app.vault.getAbstractFileByPath(listFile);
      if (existing instanceof TFile) {
        const raw = await this.app.vault.read(existing);
        const { fm, body } = splitFrontmatter(raw);
        const inheritedFeatureKeys = new Set(["priorities", "tags", "context"]);
        const currentFeatures = typeof fm.features === "object" && fm.features ? { ...fm.features } : {};
        for (const key of inheritedFeatureKeys) delete currentFeatures[key];
        const next = {
          ...fm,
          name,
          icon,
          color,
          hidden: true,
          system_kind: kind,
          default_view: "list",
          default_task_type: kind === "reminders" ? "reminder" : "note",
          features: { ...currentFeatures, ...SYSTEM_LIST_FEATURES },
        };
        if (JSON.stringify(fm) !== JSON.stringify(next)) {
          await this.writeFile(listFile, joinFrontmatter(next, body || `\n# ${name}\n\nSystem-managed ${name} list.\n`));
          changed = true;
        }
        return;
      }
      await this.ensureFolder(listPath);
      await this.writeFile(listFile, joinFrontmatter({
        list_id: kind === "reminders" ? "LST-SYSTEM-REMINDERS" : "LST-SYSTEM-SHORT-NOTES",
        name,
        icon,
        color,
        hidden: true,
        system_kind: kind,
        default_view: "list",
        default_task_type: kind === "reminders" ? "reminder" : "note",
        features: SYSTEM_LIST_FEATURES,
      }, `\n# ${name}\n\nSystem-managed ${name} list.\n`));
      changed = true;
    };

    await ensureList("reminders", SYSTEM_REMINDERS_NAME, "alarm-clock", "#F59E0B");
    await ensureList("short_notes", SYSTEM_SHORT_NOTES_NAME, "sticky-note", "#14B8A6");
    return changed;
  }

  async createFolder(spacePath: string, name: string, opts: { icon?: string; color?: string } = {}): Promise<string> {
    const dirName = safeFileName(`Folder - ${name}`);
    const dirPath = `${spacePath}/${dirName}`;
    await this.ensureFolder(dirPath);
    const filePath = `${dirPath}/${FOLDER_FILE}`;
    const fm = {
      folder_id: `FLD-${Math.floor(Math.random() * 10000).toString().padStart(4, "0")}`,
      name,
      icon: opts.icon ?? "📁",
      color: opts.color ?? "#6647F0",
    };
    const body = `\n# ${name}\n`;
    await this.writeFile(filePath, joinFrontmatter(fm, body));
    return dirPath;
  }

  async createList(parentPath: string, name: string, opts: { icon?: string; color?: string; description?: string; statusSet?: StatusDef[]; defaultView?: string } = {}): Promise<string> {
    if (!this.bulk) {
      const used = this.allLists().reduce((n, l) => n + (l.config.system_kind ? 0 : 1), 0);
      if (used >= limit(1)) throw new Error(t("lim.lists", { n: freeLimit(1) }));
    }
    const dirName = safeFileName(`List - ${name}`);
    const dirPath = `${parentPath}/${dirName}`;
    await this.ensureFolder(dirPath);
    const filePath = `${dirPath}/${LIST_FILE}`;
    const fm: any = {
      list_id: `LST-${Math.floor(Math.random() * 10000).toString().padStart(4, "0")}`,
      name,
      icon: opts.icon ?? "📋",
      color: opts.color ?? "#2196F3",
      description: opts.description ?? "",
      default_view: opts.defaultView ?? "list",
      default_task_type: "task",
    };
    if (opts.statusSet) fm.status_set = opts.statusSet;
    const body = `\n# ${name}\n\n${opts.description ?? ""}\n`;
    await this.writeFile(filePath, joinFrontmatter(fm, body));
    return dirPath;
  }

  async updateSpaceConfig(spacePath: string, patch: Partial<SpaceConfig>) {
    const sp = this.findSpace(spacePath);
    if (!sp) return;
    const newCfg = { ...sp.config, ...patch };
    const file = this.app.vault.getAbstractFileByPath(sp.configPath);
    if (!(file instanceof TFile)) return;
    const raw = await this.app.vault.read(file);
    const split = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/);
    const body = split ? raw.slice(split[0].length) : raw;
    await this.app.vault.modify(file, joinFrontmatter(newCfg, retitleBody(body, sp.config.name, newCfg.name)));
  }

  async updateListConfig(listPath: string, patch: Partial<ListConfig>) {
    const l = this.findList(listPath);
    if (!l) return;
    const newCfg = { ...l.config, ...patch };
    const file = this.app.vault.getAbstractFileByPath(l.configPath);
    if (!(file instanceof TFile)) return;
    const raw = await this.app.vault.read(file);
    const split = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/);
    const body = split ? raw.slice(split[0].length) : raw;
    await this.app.vault.modify(file, joinFrontmatter(newCfg, retitleBody(body, l.config.name, newCfg.name)));
  }

  async updateFolderConfig(folderPath: string, patch: Partial<FolderConfig>) {
    const f = this.findFolder(folderPath);
    if (!f) return;
    const newCfg = { ...f.config, ...patch };
    const file = this.app.vault.getAbstractFileByPath(f.configPath);
    if (!(file instanceof TFile)) return;
    const raw = await this.app.vault.read(file);
    const split = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/);
    const body = split ? raw.slice(split[0].length) : raw;
    await this.app.vault.modify(file, joinFrontmatter(newCfg, retitleBody(body, f.config.name, newCfg.name)));
  }

  async updateWorkspaceConfig(patch: Partial<WorkspaceConfig>) {
    if (!this.workspaceFilePath || !this.workspace) {
      // Create it if missing
      await this.createWorkspaceConfig(patch.name || "My Workspace");
      await this.scan();
    }
    const oldName = this.workspace?.name ?? "";
    const newCfg = { ...this.workspace, ...patch };
    const file = this.app.vault.getAbstractFileByPath(this.workspaceFilePath!);
    if (!(file instanceof TFile)) return;
    const raw = await this.app.vault.read(file);
    const split = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/);
    const body = split ? raw.slice(split[0].length) : raw;
    await this.app.vault.modify(file, joinFrontmatter(newCfg, retitleBody(body, oldName, newCfg.name)));
  }

  // Merge a view_defaults patch (visible_fields / color_by / cf toggles / …)
  // into a chosen hierarchy level so it cascades to children (inheritance).
  // Used by the Fields customizer's "Set as default for List/Folder/Space/Workspace".
  async setScopeViewDefaults(
    level: "workspace" | "space" | "folder" | "list",
    path: string | undefined,
    view: ViewType,
    patch: Partial<ViewDefaults>,
  ): Promise<void> {
    const merge = (cfg: any) => {
      const vd: any = { ...(cfg?.view_defaults || {}) };
      vd[view] = { ...(vd[view] || {}), ...patch };
      return vd;
    };
    if (level === "workspace") {
      await this.updateWorkspaceConfig({ view_defaults: merge(this.workspace) } as any);
    } else if (level === "space" && path) {
      const s = this.findSpace(path); if (!s) return;
      await this.updateSpaceConfig(path, { view_defaults: merge(s.config) } as any);
    } else if (level === "folder" && path) {
      const f = this.findFolder(path); if (!f) return;
      await this.updateFolderConfig(path, { view_defaults: merge(f.config) } as any);
    } else if (level === "list" && path) {
      const l = this.findList(path); if (!l) return;
      await this.updateListConfig(path, { view_defaults: merge(l.config) } as any);
    }
    await this.scan();
    this.emit();
  }

  // Rename a tag across all tasks that reference it
  async renameTag(oldName: string, newName: string) {
    if (oldName === newName) return;
    const affected = this.allTasks().filter((t) => (t.data.tags || []).includes(oldName));
    for (const t of affected) {
      await this.updateTask(t.data.id, (d) => ({
        data: { ...d, tags: (d.tags || []).map((x: string) => (x === oldName ? newName : x)) },
      }));
    }
  }

  async removeTagFromAll(name: string) {
    const affected = this.allTasks().filter((t) => (t.data.tags || []).includes(name));
    for (const t of affected) {
      await this.updateTask(t.data.id, (d) => ({
        data: { ...d, tags: (d.tags || []).filter((x: string) => x !== name) },
      }));
    }
  }

  async deleteSpace(spacePath: string) {
    await this.softTrashContainer(spacePath);
  }

  async deleteList(listPath: string) {
    await this.softTrashContainer(listPath);
  }

  async deleteFolder(folderPath: string) {
    await this.softTrashContainer(folderPath);
  }

  // ---------- Move operations ----------

  async moveFolder(folderPath: string, targetSpacePath: string): Promise<void> {
    const folder = this.app.vault.getAbstractFileByPath(folderPath);
    if (!(folder instanceof TFolder)) throw new Error(t("err.folderNotFoundPath", { path: folderPath }));
    const newPath = normalizePath(`${targetSpacePath}/${folder.name}`);
    if (this.app.vault.getAbstractFileByPath(newPath)) {
      throw new Error(t("err.folderNameExists"));
    }
    await this.withSuppression(async () => {
      await this.app.vault.rename(folder, newPath);
    });
    await this.scan();
    this.emit();
  }

  async moveList(listPath: string, targetPath: string): Promise<void> {
    const folder = this.app.vault.getAbstractFileByPath(listPath);
    if (!(folder instanceof TFolder)) throw new Error(t("err.listNotFoundPath", { path: listPath }));
    const newPath = normalizePath(`${targetPath}/${folder.name}`);
    if (this.app.vault.getAbstractFileByPath(newPath)) {
      throw new Error(t("err.listNameExists"));
    }
    await this.withSuppression(async () => {
      await this.app.vault.rename(folder, newPath);
    });
    await this.scan();
    this.emit();
  }

  // ---------- Multiple Lists ----------

  // Add this task to another list (shows there in addition to its home list).
  async addTaskToList(taskId: string, listPath: string): Promise<void> {
    const tf = this.tasksById.get(taskId);
    if (!tf || tf.listPath === listPath) return; // home already covers it
    await this.updateTask(taskId, (d) => {
      const cur = Array.isArray(d.additional_lists) ? d.additional_lists : [];
      if (cur.includes(listPath)) return; // no-op
      return { data: { ...d, additional_lists: [...cur, listPath] } };
    });
  }

  // Stop showing this task in a given additional list (never affects home).
  async removeTaskFromList(taskId: string, listPath: string): Promise<void> {
    await this.updateTask(taskId, (d) => {
      const cur: string[] = Array.isArray(d.additional_lists) ? d.additional_lists : [];
      if (!cur.includes(listPath)) return;
      const next = cur.filter((p) => p !== listPath);
      return { data: { ...d, additional_lists: next.length ? next : undefined } };
    });
  }

  async moveTask(taskId: string, targetListPath: string): Promise<void> {
    const tf = this.tasksById.get(taskId);
    if (!tf) throw new Error(t("err.taskNotFound", { id: taskId }));
    const targetList = this.findList(targetListPath);
    if (!targetList) throw new Error(t("err.targetListNotFound", { path: targetListPath }));
    if (tf.listPath === targetListPath) return;

    const file = this.app.vault.getAbstractFileByPath(tf.filePath);
    if (!(file instanceof TFile)) throw new Error(t("err.taskFileNotFound", { path: tf.filePath }));

    // Determine the destination filename, handling collisions by appending a counter.
    const baseName = file.name; // includes .md
    let newPath = normalizePath(`${targetList.path}/${baseName}`);
    if (this.app.vault.getAbstractFileByPath(newPath)) {
      const stem = baseName.replace(/\.md$/i, "");
      let n = 2;
      while (this.app.vault.getAbstractFileByPath(normalizePath(`${targetList.path}/${stem}-${n}.md`))) n++;
      newPath = normalizePath(`${targetList.path}/${stem}-${n}.md`);
    }

    // Resolve the new status: try to keep the current status id if it exists
    // in the target list's status set; otherwise fall back to its default.
    const targetSet = this.resolveStatusSet(targetListPath).statuses;
    const currentStatusId = tf.data.status;
    let newStatus = currentStatusId && targetSet.find((s) => s.id === currentStatusId)
      ? currentStatusId
      : (targetSet.find((s) => s.is_default)?.id ?? targetSet[0]?.id);
    const newStatusObj = targetSet.find((s) => s.id === newStatus);

    const targetSpace = this.findSpace(targetList.spacePath);
    const targetFolder = targetList.folderPath ? this.findFolder(targetList.folderPath) : undefined;

    const draftData = {
      ...tf.data,
      list: targetList.config.name,
      space: targetSpace?.config.name,
      folder: targetFolder?.config.name ?? undefined,
      status: newStatus,
      status_group: newStatusObj?.group,
      updated_at: nowIso(),
    };
    // Drop `folder` cleanly when the target list lives directly under a space.
    if (!targetFolder) delete (draftData as any).folder;
    // If the new home was an additional list, it's now redundant — drop it.
    const addl = (tf.data.additional_lists || []).filter((p) => p !== targetListPath);
    (draftData as any).additional_lists = addl.length ? addl : undefined;

    const content = serializeTask(draftData as any, tf.body);

    await this.withSuppression(async () => {
      // Write the new content first, then move the file. Modifying after the
      // rename also works, but writing before keeps the moved file already in
      // its final state.
      await this.app.vault.modify(file, content);
      await this.app.vault.rename(file, newPath);
    });
    // Incremental move in the live tree — no full vault rescan. Detach from the
    // old list node, update the TaskFile's paths + data, attach to the target.
    const oldList = tf.listPath ? this.findList(tf.listPath) : undefined;
    if (oldList) {
      const i = oldList.taskFiles.findIndex((x) => x.data.id === taskId);
      if (i >= 0) oldList.taskFiles.splice(i, 1);
    }
    tf.data = draftData as any;
    tf.filePath = newPath;
    tf.listPath = targetList.path;
    tf.spacePath = targetList.spacePath;
    tf.folderPath = targetList.folderPath;
    targetList.taskFiles.push(tf);
    this.emit();
  }

  // ---------- Sidebar ordering ----------

  private sidebarOrderEntries(): Array<{ kind: "space" | "folder" | "list" | "doc"; id: string; path: string }> {
    const entries: Array<{ kind: "space" | "folder" | "list" | "doc"; id: string; path: string }> = [];
    for (const space of this.spaces) {
      entries.push({ kind: "space", id: space.config.space_id, path: space.path });
      for (const list of space.lists) entries.push({ kind: "list", id: list.config.list_id, path: list.path });
      for (const folder of space.folders) {
        entries.push({ kind: "folder", id: folder.config.folder_id, path: folder.path });
        for (const list of folder.lists) entries.push({ kind: "list", id: list.config.list_id, path: list.path });
      }
    }
    for (const doc of this.docs) {
      if (doc.__path) entries.push({ kind: "doc", id: doc.doc_id, path: doc.__path });
    }
    return entries;
  }

  private sidebarRefForPath(path: string): string {
    const entry = this.sidebarOrderEntries().find((candidate) => candidate.path === path);
    if (entry?.id) return `id:${entry.kind}:${entry.id}`;
    // Defensive fallback for old/malformed nodes without an id. Still portable
    // across different workspace roots, unlike the old absolute path format.
    return `path:${this.toFavRef(path)}`;
  }

  private sidebarPathForRef(ref: string, kinds?: Array<"space" | "folder" | "list" | "doc">): string | undefined {
    const entries = this.sidebarOrderEntries().filter((entry) => !kinds || kinds.includes(entry.kind));
    const idMatch = ref.match(/^id:(space|folder|list|doc):(.+)$/);
    if (idMatch) return entries.find((entry) => entry.kind === idMatch[1] && entry.id === idMatch[2])?.path;

    const rawPath = ref.startsWith("path:") ? ref.slice(5) : ref;
    // Current-device full path, then canonical root-relative path.
    const direct = entries.find((entry) => entry.path === rawPath);
    if (direct) return direct.path;
    const rebased = this.fromFavRef(rawPath);
    const portable = entries.find((entry) => entry.path === rebased || this.toFavRef(entry.path) === rawPath);
    if (portable) return portable.path;

    // Legacy order may have been synced from a device with another root prefix.
    // Resolve by the longest common path suffix (Space/Folder/List names); only
    // accept a unique best match so duplicate names are never guessed blindly.
    const wanted = rawPath.split("/").filter(Boolean);
    let best = 0;
    let matches: string[] = [];
    for (const entry of entries) {
      const parts = entry.path.split("/").filter(Boolean);
      let score = 0;
      while (score < wanted.length && score < parts.length && wanted[wanted.length - 1 - score] === parts[parts.length - 1 - score]) score++;
      if (score > best) { best = score; matches = [entry.path]; }
      else if (score === best && score > 0) matches.push(entry.path);
    }
    return best > 0 && matches.length === 1 ? matches[0] : undefined;
  }

  private runtimeSidebarOrder(stored: SidebarOrder | undefined): SidebarOrder {
    if (!stored) return {};
    const spaces = (stored.spaces || [])
      .map((ref) => this.sidebarPathForRef(ref, ["space"]))
      .filter((path): path is string => !!path);
    const children: Record<string, string[]> = {};
    for (const [parentRef, childRefs] of Object.entries(stored.children || {})) {
      const parentPath = this.sidebarPathForRef(parentRef, ["space", "folder"]);
      if (!parentPath) continue;
      const paths = childRefs.map((ref) => this.sidebarPathForRef(ref)).filter((path): path is string => !!path);
      if (paths.length) children[parentPath] = Array.from(new Set(paths));
    }
    return {
      spaces: Array.from(new Set(spaces)),
      children: Object.keys(children).length ? children : undefined,
    };
  }

  private storedSidebarOrder(runtime: SidebarOrder): SidebarOrder {
    const spaces = (runtime.spaces || []).map((path) => this.sidebarRefForPath(path));
    const children: Record<string, string[]> = {};
    for (const [parentPath, childPaths] of Object.entries(runtime.children || {})) {
      children[this.sidebarRefForPath(parentPath)] = childPaths.map((path) => this.sidebarRefForPath(path));
    }
    return {
      spaces: spaces.length ? spaces : undefined,
      children: Object.keys(children).length ? children : undefined,
    };
  }

  getSidebarOrder(): SidebarOrder {
    return this.runtimeSidebarOrder(this.workspace?.sidebar_order);
  }

  async updateSidebarOrder(order: SidebarOrder): Promise<void> {
    const stored = this.storedSidebarOrder(order);
    // Keep the in-memory workspace in the exact portable shape written to disk.
    if (this.workspace) {
      this.workspace.sidebar_order = stored;
    }
    // Persist to disk (vault event will trigger eventual rescan)
    if (this.workspaceFilePath && this.workspace) {
      const file = this.app.vault.getAbstractFileByPath(this.workspaceFilePath);
      if (file instanceof TFile) {
        const raw = await this.app.vault.read(file);
        const split = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/);
        const body = split ? raw.slice(split[0].length) : raw;
        await this.withSuppression(async () => {
          await this.app.vault.modify(file, joinFrontmatter({ ...this.workspace }, body));
        });
      }
    }
    // Emit immediately so sidebar re-renders with new order
    this.emit();
  }

  private async migrateSidebarOrderIfNeeded(): Promise<void> {
    if (!this.workspace?.sidebar_order) return;
    // Never migrate a partially resolvable order: the round trip below drops
    // whatever cannot be resolved at this instant, and persisting that turns a
    // Space that sync has not pulled yet into a permanently lost position.
    if (!sidebarOrderResolvesFully(this.workspace.sidebar_order, (ref, kinds) => this.sidebarPathForRef(ref, kinds))) return;
    const portable = this.storedSidebarOrder(this.runtimeSidebarOrder(this.workspace.sidebar_order));
    if (JSON.stringify(portable) === JSON.stringify(this.workspace.sidebar_order)) return;
    this.workspace.sidebar_order = portable;
    await this.persistWorkspace();
  }

  // ---------- Favorites ----------
  //
  // Three INDEPENDENT buckets, one per surface (left sidebar / bottom bar /
  // right panel). Each is separately ordered; an item may live in any subset of
  // them. The `favorites` key stores the left-sidebar bucket.

  private favField(loc: FavLocation): "favorites" | "favorites_bar" | "favorites_right" {
    return loc === "bar" ? "favorites_bar" : loc === "right" ? "favorites_right" : "favorites";
  }

  // ---- Favorite path portability ----
  // Lists/docs/views are favorited by PATH. A path like "Space - X/List - Y"
  // lives UNDER the workspace root, so storing the root-prefixed form
  // ("Tasks/Space - X/List - Y") makes the favorite device-specific: it won't
  // resolve on a device with a different root folder name, nor in the web app
  // (whose root is "/"). So favorites are stored RELATIVE to the workspace root
  // and re-prefixed for resolution. Tasks are stored by id (no "/" relation to
  // the tree) and pass through untouched.
  private favRootPrefix(): string {
    const r = this.rootPath;
    return r && r !== "/" ? r.replace(/\/+$/, "") + "/" : "";
  }
  /** Full/legacy path → stored (root-relative) ref. */
  private toFavRef(pathOrId: string): string {
    const p = this.favRootPrefix();
    return p && pathOrId.startsWith(p) ? pathOrId.slice(p.length) : pathOrId;
  }
  /** Stored ref → a path resolvable on THIS device. */
  private fromFavRef(ref: string): string {
    if (this.tasksById.has(ref)) return ref;        // task id
    const p = this.favRootPrefix();
    if (!p) return ref;
    return ref.startsWith(p) ? ref : p + ref;       // tolerate already-prefixed (legacy)
  }

  // Stored refs for a bucket, normalised to the root-relative form (legacy
  // root-prefixed entries are stripped on read, so resolution is uniform).
  private favRefs(loc: FavLocation): string[] {
    return (this.workspace?.[this.favField(loc)] ?? []).map((r) => this.toFavRef(r));
  }

  // A favorite ref resolves to a List, Doc, or saved View (all stored by PATH),
  // or a Task (stored by its stable id). Accepts either a stored ref or a full
  // path — both are normalised through fromFavRef.
  favoriteExists(ref: string): boolean {
    const full = this.fromFavRef(ref);
    return !!this.findList(full) || !!this.docByPath(full) || !!this.viewByPath(full)
      || this.tasksById.has(ref) || this.tasksById.has(full);
  }

  // Favorited paths for a bucket, in user order, re-prefixed to resolvable
  // paths and with stale entries pruned so callers never have to check.
  getFavorites(loc: FavLocation = "left"): string[] {
    return this.favRefs(loc).map((r) => this.fromFavRef(r)).filter((p) => this.favoriteExists(p));
  }

  // Membership: in a specific bucket when `loc` is given, else in ANY bucket.
  // `path` is a full path (or id); compared in the canonical relative form.
  isFavorite(path: string, loc?: FavLocation): boolean {
    const ref = this.toFavRef(path);
    if (loc) return this.favRefs(loc).includes(ref);
    return (["left", "bar", "right"] as FavLocation[]).some((l) => this.favRefs(l).includes(ref));
  }

  async addFavorite(path: string, loc: FavLocation): Promise<void> {
    if (!this.favoriteExists(path)) return;
    const ref = this.toFavRef(path);
    const refs = this.favRefs(loc);
    if (refs.includes(ref)) return;
    await this.writeFavRefs(loc, [...refs, ref]);
  }

  async removeFavorite(path: string, loc: FavLocation): Promise<void> {
    const ref = this.toFavRef(path);
    const refs = this.favRefs(loc);
    if (!refs.includes(ref)) return;
    await this.writeFavRefs(loc, refs.filter((r) => r !== ref));
  }

  async toggleFavorite(path: string, loc: FavLocation): Promise<void> {
    if (this.isFavorite(path, loc)) await this.removeFavorite(path, loc);
    else await this.addFavorite(path, loc);
  }

  // Move a favorite by `delta` positions within its bucket (negative = toward
  // the start: up in a panel / left on the bar). Operates on the pruned order.
  async moveFavorite(path: string, loc: FavLocation, delta: number): Promise<void> {
    const ordered = this.getFavorites(loc);
    const idx = ordered.indexOf(path);
    if (idx === -1) return;
    const target = Math.max(0, Math.min(ordered.length - 1, idx + delta));
    if (target === idx) return;
    const next = ordered.slice();
    next.splice(idx, 1);
    next.splice(target, 0, path);
    await this.writeFavRefs(loc, next.map((p) => this.toFavRef(p)));
  }

  // Drag-reorder within a bucket: drop `fromPath` before/after `toPath`.
  async reorderFavorites(fromPath: string, toPath: string, insertAfter: boolean, loc: FavLocation): Promise<void> {
    const ordered = this.getFavorites(loc);
    if (!ordered.includes(fromPath) || !ordered.includes(toPath) || fromPath === toPath) return;
    const without = ordered.filter((p) => p !== fromPath);
    const idx = without.indexOf(toPath);
    const insertAt = insertAfter ? idx + 1 : idx;
    without.splice(insertAt, 0, fromPath);
    await this.writeFavRefs(loc, without.map((p) => this.toFavRef(p)));
  }

  // Relocate a favorite from one surface to another (remove from `from`, append
  // to `to`). Single write so the two buckets update atomically.
  async moveFavoriteBetween(path: string, from: FavLocation, to: FavLocation): Promise<void> {
    if (from === to || !this.favoriteExists(path) || !this.workspace) return;
    const ref = this.toFavRef(path);
    const fromArr = this.favRefs(from).filter((r) => r !== ref);
    const toArr = this.favRefs(to).includes(ref) ? this.favRefs(to).slice() : [...this.favRefs(to), ref];
    this.workspace[this.favField(from)] = fromArr;
    this.workspace[this.favField(to)] = toArr;
    await this.persistWorkspace();
  }

  private async writeFavRefs(loc: FavLocation, refs: string[]): Promise<void> {
    if (this.workspace) this.workspace[this.favField(loc)] = refs;
    await this.persistWorkspace();
  }

  /**
   * One-time migration: rewrite any root-prefixed favorite entries to the
   * root-relative form and persist, so the synced _workspace.md becomes
   * portable (other devices / the web app can then resolve them). No-op once
   * everything is already relative. Called from load().
   */
  private async migrateFavoritesIfNeeded(): Promise<void> {
    if (!this.workspace) return;
    let changed = false;
    for (const loc of ["left", "bar", "right"] as FavLocation[]) {
      const field = this.favField(loc);
      const raw = this.workspace[field];
      if (!raw || raw.length === 0) continue;
      const rel = raw.map((r) => this.toFavRef(r));
      if (rel.some((r, i) => r !== raw[i])) {
        this.workspace[field] = rel;
        changed = true;
      }
    }
    if (changed) await this.persistWorkspace();
  }

  // Write the in-memory workspace config back to its markdown file + emit.
  private async persistWorkspace(): Promise<void> {
    if (this.workspaceFilePath && this.workspace) {
      const file = this.app.vault.getAbstractFileByPath(this.workspaceFilePath);
      if (file instanceof TFile) {
        const raw = await this.app.vault.read(file);
        const split = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/);
        const body = split ? raw.slice(split[0].length) : raw;
        await this.withSuppression(async () => {
          await this.app.vault.modify(file, joinFrontmatter({ ...this.workspace }, body));
        });
      }
    }
    this.emit();
  }

  // ---------- View configs ----------

  async saveView(view: ViewConfig, location: { listPath?: string; folderPath?: string; spacePath?: string; rootPath?: string }) {
    const base = location.listPath ?? location.folderPath ?? location.spacePath ?? this.rootPath;
    const root = (base === "/" || base === "") ? "" : base;
    const viewsDir = root ? `${root}/${VIEWS_DIR}` : VIEWS_DIR;
    await this.ensureFolder(viewsDir);
    const clean: any = { ...view };
    delete clean.__path; // never persist the internal source-path marker
    // Persist the location root-RELATIVE so the file resolves on every device.
    if (clean.location) clean.location = portableLocationKey(clean.location, this.rootPath);
    // Include the view_id in the filename so two views with the same name
    // don't overwrite each other.
    const fileName = `view-${slugify(view.name) || "view"}-${(view.view_id || "").toLowerCase()}.md`;
    const filePath = normalizePath(`${viewsDir}/${fileName}`);
    const body = `\n# ${view.name}\n\n${view.description ?? ""}\n`;
    await this.writeFile(filePath, joinFrontmatter(clean, body));
    await this.scan();
    // New view lands at the end of the Views-bar order.
    await this.appendToViewsBarOrder(view.location || "", "view", view.view_id);
  }

  // Saved views whose `location` field matches a locationKey (see view-state).
  viewsForLocationKey(key: string): ViewConfig[] {
    return this.views.filter((v) => v.location === key);
  }

  // A saved view by its source file path (the value stored when it's favorited).
  viewByPath(path: string): ViewConfig | undefined {
    return this.views.find((v) => v.__path === path);
  }

  // ---------- By-id lookups (deep links, stable across rename/move) ----------

  viewById(id: string): ViewConfig | undefined {
    return this.views.find((v) => v.view_id === id);
  }

  spaceById(id: string): SpaceNode | undefined {
    return this.spaces.find((s) => s.config.space_id === id);
  }

  folderById(id: string): FolderNode | undefined {
    for (const s of this.spaces) {
      const f = s.folders.find((x) => x.config.folder_id === id);
      if (f) return f;
    }
    return undefined;
  }

  listById(id: string): ListNode | undefined {
    for (const s of this.spaces) {
      const l = s.lists.find((x) => x.config.list_id === id);
      if (l) return l;
      for (const fo of s.folders) {
        const lf = fo.lists.find((x) => x.config.list_id === id);
        if (lf) return lf;
      }
    }
    return undefined;
  }

  async deleteView(viewId: string): Promise<void> {
    const v = this.views.find((x) => x.view_id === viewId);
    if (!v?.__path) return;
    const f = this.app.vault.getAbstractFileByPath(v.__path);
    if (f instanceof TFile) await this.app.vault.trash(f, true);
    await this.scan();
    this.emit();
  }

  // Write a patched copy of a saved view's frontmatter in place (no scan/emit
  // — callers batch a single scan). Filename stays the same; the display name
  // comes from frontmatter.
  private async writeViewFile(v: ViewConfig, patch: Partial<ViewConfig>): Promise<void> {
    if (!v.__path) return;
    const file = this.app.vault.getAbstractFileByPath(v.__path);
    if (!(file instanceof TFile)) return;
    const raw = await this.app.vault.read(file);
    const split = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/);
    const body = split ? raw.slice(split[0].length) : raw;
    const clean: any = { ...v, ...patch };
    delete clean.__path;
    // Always store the portable (root-relative) form — this also self-heals
    // legacy absolute keys on the next unrelated write (rename/order/pin).
    if (clean.location) clean.location = portableLocationKey(clean.location, this.rootPath);
    await this.writeFile(v.__path, joinFrontmatter(clean, body));
  }

  // Patch a saved view's frontmatter in place (rename / pin / clear-default).
  async updateView(viewId: string, patch: Partial<ViewConfig>): Promise<void> {
    const v = this.views.find((x) => x.view_id === viewId);
    if (!v) return;
    await this.writeViewFile(v, patch);
    await this.scan();
    this.emit();
  }

  // Mark exactly one Views-bar item (a view OR a doc) as the default for its
  // location, clearing the flag on every other view AND doc there — only one
  // default per location, regardless of kind. (Default opens on entry.)
  async setViewsBarDefault(key: string, kind: "view" | "doc", id: string): Promise<void> {
    for (const v of this.views) {
      if (v.location !== key) continue;
      const want = kind === "view" && v.view_id === id;
      if (!!v.default !== want) await this.writeViewFile(v, { default: want });
    }
    for (const d of this.docs) {
      if (d.location !== key) continue;
      const want = kind === "doc" && d.doc_id === id;
      if (!!d.default !== want) await this.writeDocRaw(d, { default: want });
    }
    await this.scan();
    this.emit();
  }

  // ---------- Docs ----------

  docsForLocationKey(key: string): DocMeta[] {
    return this.docs.filter((d) => d.location === key).sort((a, b) => a.name.localeCompare(b.name));
  }
  docById(id: string): DocMeta | undefined { return this.docs.find((d) => d.doc_id === id); }
  docByPath(path: string): DocMeta | undefined { return this.docs.find((d) => d.__path === path); }
  pagesForDoc(docId: string): DocPage[] { return this.docPages.filter((p) => p.doc_id === docId); }
  pageById(id: string): DocPage | undefined { return this.docPages.find((p) => p.page_id === id); }

  private docsDirFor(location: { listPath?: string; folderPath?: string; spacePath?: string; rootPath?: string }): string {
    const base = location.listPath ?? location.folderPath ?? location.spacePath ?? this.rootPath;
    const root = (base === "/" || base === "") ? "" : base;
    return root ? `${root}/${DOCS_DIR}` : DOCS_DIR;
  }

  private static rid(prefix: string): string {
    return `${prefix}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  }

  // Create a Doc container + one starter page; returns the new doc_id.
  async createDoc(
    name: string,
    location: { listPath?: string; folderPath?: string; spacePath?: string; rootPath?: string },
    locationKey: string,
    opts: { icon?: string; color?: string } = {},
  ): Promise<string> {
    // Docs share the working set with lists; if it is already past budget (or a
    // registered account no longer checks out), hold here as well.
    const within = this.allLists().reduce((n, l) => n + (l.config.system_kind ? 0 : 1), 0);
    if (!this.bulk && (within > limit(1) || !licenseConsistent())) throw new Error(t("lim.docs"));
    const dir = this.docsDirFor(location);
    await this.ensureFolder(dir);
    const now = nowIso();
    const docId = WorkspaceIndex.rid("DOC");
    const fm = { doc_id: docId, name, icon: opts.icon || DOC_ICON, color: opts.color || DOC_ACCENT, location: portableLocationKey(locationKey, this.rootPath), created_at: now, updated_at: now };
    const docPath = normalizePath(`${dir}/doc-${slugify(name) || "doc"}-${docId.toLowerCase()}.md`);
    await this.writeFile(docPath, joinFrontmatter(fm, `\n# ${name}\n`));
    // Starter page so the doc isn't empty on first open.
    const pageId = WorkspaceIndex.rid("PG");
    const untitled = t("common.untitled");
    const pfm = { page_id: pageId, doc_id: docId, parent_page: null, title: untitled, order: 0, created_at: now, updated_at: now };
    await this.writeFile(normalizePath(`${dir}/page-${pageId.toLowerCase()}.md`), joinFrontmatter(pfm, `\n# ${untitled}\n`));
    await this.scan();
    // New doc lands at the end of the Views-bar order at its location.
    await this.appendToViewsBarOrder(locationKey, "doc", docId);
    return docId;
  }

  // Patch a Doc container's frontmatter in place (no scan — callers batch one).
  private async writeDocRaw(doc: DocMeta, patch: Partial<DocMeta>): Promise<void> {
    if (!doc.__path) return;
    const file = this.app.vault.getAbstractFileByPath(doc.__path);
    if (!(file instanceof TFile)) return;
    const raw = await this.app.vault.read(file);
    const { fm, body } = splitFrontmatter(raw);
    const next: any = { ...fm };
    for (const k of ["name", "icon", "color", "order", "location", "default"] as const) {
      if (patch[k] !== undefined) next[k] = patch[k];
    }
    // Always store the portable (root-relative) form — this also self-heals
    // legacy absolute keys on the next unrelated write (rename/order/default).
    if (next.location) next.location = portableLocationKey(next.location, this.rootPath);
    next.updated_at = nowIso();
    await this.writeFile(doc.__path, joinFrontmatter(next, body));
  }

  async updateDoc(docId: string, patch: { name?: string; icon?: string; color?: string; order?: number; default?: boolean }): Promise<void> {
    const d = this.docById(docId);
    if (!d) return;
    await this.writeDocRaw(d, patch);
    await this.scan();
    this.emit();
  }

  // Persist the Views-bar order: write each chip's `order` to its source file
  // (view frontmatter / doc container), then a single scan. Items are in the
  // desired left→right order.
  async reorderViewsBar(items: Array<{ kind: "view" | "doc"; id: string }>): Promise<void> {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind === "view") {
        const v = this.views.find((x) => x.view_id === it.id);
        if (v) await this.writeViewFile(v, { order: i });
      } else {
        const d = this.docById(it.id);
        if (d) await this.writeDocRaw(d, { order: i });
      }
    }
    await this.scan();
    this.emit();
  }

  // Current Views-bar items at a location in display order (order, then name) —
  // used to position a freshly-created view/doc.
  private viewsBarSorted(key: string): Array<{ kind: "view" | "doc"; id: string }> {
    const list = [
      ...this.views.filter((v) => v.location === key).map((v) => ({ kind: "view" as const, id: v.view_id, order: v.order, name: v.name })),
      ...this.docs.filter((d) => d.location === key).map((d) => ({ kind: "doc" as const, id: d.doc_id, order: d.order, name: d.name })),
    ];
    list.sort((a, b) =>
      ((a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER)) ||
      a.name.localeCompare(b.name),
    );
    return list.map((i) => ({ kind: i.kind, id: i.id }));
  }

  // Place a just-created view/doc at the end of its location's Views-bar order
  // (and normalize everyone's `order` so position is stable thereafter).
  private async appendToViewsBarOrder(key: string, kind: "view" | "doc", id: string): Promise<void> {
    if (!key) { this.emit(); return; }
    const list = this.viewsBarSorted(key);
    const idx = list.findIndex((i) => i.kind === kind && i.id === id);
    if (idx >= 0) { const [it] = list.splice(idx, 1); list.push(it); }
    await this.reorderViewsBar(list);
  }

  // Trash a Doc and all of its pages.
  async deleteDoc(docId: string): Promise<void> {
    for (const p of this.pagesForDoc(docId)) {
      if (p.__path) {
        const f = this.app.vault.getAbstractFileByPath(p.__path);
        if (f instanceof TFile) await this.app.vault.trash(f, true);
      }
    }
    const d = this.docById(docId);
    if (d?.__path) {
      const f = this.app.vault.getAbstractFileByPath(d.__path);
      if (f instanceof TFile) await this.app.vault.trash(f, true);
    }
    await this.scan();
    this.emit();
  }

  // Add a page to a Doc (optionally under a parent page). Returns the page_id.
  async createPage(docId: string, opts: { title?: string; parent_page?: string | null } = {}): Promise<string | undefined> {
    const doc = this.docById(docId);
    if (!doc?.__path) return;
    const dir = doc.__path.split("/").slice(0, -1).join("/");
    const parent = opts.parent_page ?? null;
    const siblings = this.docPages.filter((p) => p.doc_id === docId && (p.parent_page ?? null) === parent);
    const order = siblings.reduce((m, p) => Math.max(m, p.order ?? 0), -1) + 1;
    const title = opts.title || t("common.untitled");
    const now = nowIso();
    const pageId = WorkspaceIndex.rid("PG");
    const fm = { page_id: pageId, doc_id: docId, parent_page: parent, title, order, created_at: now, updated_at: now };
    await this.writeFile(normalizePath(`${dir}/page-${pageId.toLowerCase()}.md`), joinFrontmatter(fm, `\n# ${title}\n`));
    await this.scan();
    this.emit();
    return pageId;
  }

  // Replace a page's markdown body, keeping its frontmatter intact. Used by the
  // demo seeders to give starter pages real content. No scan — callers batch one.
  async setPageBody(pageId: string, markdown: string): Promise<void> {
    const p = this.pageById(pageId);
    if (!p?.__path) return;
    const file = this.app.vault.getAbstractFileByPath(p.__path);
    if (!(file instanceof TFile)) return;
    const raw = await this.app.vault.read(file);
    const { fm } = splitFrontmatter(raw);
    await this.writeFile(p.__path, joinFrontmatter({ ...fm, updated_at: nowIso() }, markdown));
  }

  // Patch a page's frontmatter in place (no scan — callers batch one scan).
  private async writePageRaw(p: DocPage, patch: Partial<DocPage>): Promise<void> {
    if (!p.__path) return;
    const file = this.app.vault.getAbstractFileByPath(p.__path);
    if (!(file instanceof TFile)) return;
    const raw = await this.app.vault.read(file);
    const { fm, body } = splitFrontmatter(raw);
    const next: any = { ...fm };
    for (const k of ["title", "icon", "color", "order"] as const) {
      if (patch[k] !== undefined) next[k] = patch[k];
    }
    if (patch.parent_page !== undefined) next.parent_page = patch.parent_page;
    next.updated_at = nowIso();
    await this.writeFile(p.__path, joinFrontmatter(next, body));
  }

  async updatePage(pageId: string, patch: Partial<DocPage>): Promise<void> {
    const p = this.pageById(pageId);
    if (!p) return;
    await this.writePageRaw(p, patch);
    await this.scan();
    this.emit();
  }

  // Assign sequential `order` to a set of sibling pages (single scan), used for
  // drag/menu reordering.
  async reorderSiblings(pageIds: string[]): Promise<void> {
    for (let i = 0; i < pageIds.length; i++) {
      const p = this.pageById(pageIds[i]);
      if (p) await this.writePageRaw(p, { order: i });
    }
    await this.scan();
    this.emit();
  }

  // Delete a page; its direct children are promoted to the deleted page's
  // parent so a subtree isn't silently lost.
  async deletePage(pageId: string): Promise<void> {
    const p = this.pageById(pageId);
    if (!p) return;
    const children = this.docPages.filter((c) => c.doc_id === p.doc_id && (c.parent_page ?? null) === pageId);
    for (const ch of children) await this.writePageRaw(ch, { parent_page: p.parent_page ?? null });
    if (p.__path) {
      const f = this.app.vault.getAbstractFileByPath(p.__path);
      if (f instanceof TFile) await this.app.vault.trash(f, true);
    }
    await this.scan();
    this.emit();
  }

  // Relocate a Doc (container + all pages) to another Space/Folder: move the
  // files into the target's `_docs/` dir and update the container's `location`.
  // `targetPath` is the destination space/folder dir; "" = workspace root.
  async moveDoc(docId: string, targetPath: string, targetLocationKey: string): Promise<void> {
    const doc = this.docById(docId);
    if (!doc?.__path) throw new Error(t("err.docNotFound"));
    const targetDir = targetPath ? `${targetPath}/${DOCS_DIR}` : DOCS_DIR;
    await this.ensureFolder(targetDir);
    const containerName = doc.__path.split("/").pop()!;
    const files = [doc.__path, ...this.pagesForDoc(docId).map((p) => p.__path).filter((x): x is string => !!x)];
    await this.withSuppression(async () => {
      for (const fp of files) {
        const f = this.app.vault.getAbstractFileByPath(fp);
        if (!(f instanceof TFile)) continue;
        const dest = normalizePath(`${targetDir}/${f.name}`);
        if (dest === fp) continue;
        if (this.app.vault.getAbstractFileByPath(dest)) throw new Error(t("err.docNameExists"));
        // renameFile (not vault.rename) so internal links/embeds are updated.
        await this.app.fileManager.renameFile(f, dest);
      }
      // Re-stamp the container's location (its path changed).
      const newContainerPath = normalizePath(`${targetDir}/${containerName}`);
      const cf = this.app.vault.getAbstractFileByPath(newContainerPath);
      if (cf instanceof TFile) {
        const raw = await this.app.vault.read(cf);
        const { fm, body } = splitFrontmatter(raw);
        await this.writeFile(newContainerPath, joinFrontmatter({ ...fm, location: portableLocationKey(targetLocationKey, this.rootPath), updated_at: nowIso() }, body));
      }
    });
    await this.scan();
    this.emit();
  }

  // Move a single Page to a different Doc. The page becomes a top-level page in
  // the target; its children in the source are promoted to its old parent so the
  // source subtree isn't orphaned. Uses fileManager.renameFile so any
  // attachment/image/internal links inside the page are kept valid when the
  // file path changes.
  async movePageToDoc(pageId: string, targetDocId: string): Promise<void> {
    const p = this.pageById(pageId);
    const target = this.docById(targetDocId);
    if (!p?.__path || !target?.__path) throw new Error(t("err.pageOrDocNotFound"));
    if (p.doc_id === targetDocId) return;
    const targetDir = target.__path.split("/").slice(0, -1).join("/");
    const children = this.docPages.filter((c) => c.doc_id === p.doc_id && (c.parent_page ?? null) === pageId);
    const topSiblings = this.docPages.filter((x) => x.doc_id === targetDocId && (x.parent_page ?? null) === null);
    const newOrder = topSiblings.reduce((m, x) => Math.max(m, x.order ?? 0), -1) + 1;

    const fileName = p.__path.split("/").pop()!;
    let dest = normalizePath(`${targetDir}/${fileName}`);
    if (dest !== p.__path && this.app.vault.getAbstractFileByPath(dest)) {
      const stem = fileName.replace(/\.md$/i, "");
      let n = 2;
      while (this.app.vault.getAbstractFileByPath(normalizePath(`${targetDir}/${stem}-${n}.md`))) n++;
      dest = normalizePath(`${targetDir}/${stem}-${n}.md`);
    }

    await this.withSuppression(async () => {
      for (const ch of children) await this.writePageRaw(ch, { parent_page: p.parent_page ?? null });
      const f = this.app.vault.getAbstractFileByPath(p.__path!);
      if (f instanceof TFile) {
        if (dest !== p.__path) await this.app.fileManager.renameFile(f, dest);
        const moved = this.app.vault.getAbstractFileByPath(dest);
        if (moved instanceof TFile) {
          const raw = await this.app.vault.read(moved);
          const { fm, body } = splitFrontmatter(raw);
          await this.writeFile(dest, joinFrontmatter({ ...fm, doc_id: targetDocId, parent_page: null, order: newOrder, updated_at: nowIso() }, body));
        }
      }
    });
    await this.scan();
    this.emit();
  }

  // ---------- Notes / Activity helpers ----------

  isEmpty(): boolean {
    return this.spaces.length === 0 && this.workspace === null;
  }

  /**
   * User-visible spaces only — excludes the hidden, system-managed "System"
   * space (and any user-hidden space). This is the right count for "does the
   * workspace have real content yet?" decisions: the empty-state CTA and the
   * starter-data seeding guard. Raw `spaces` always carries the System space
   * once `ensureSystemLists()` has run, so it must not be used for those.
   */
  get userSpaces(): SpaceNode[] {
    return this.spaces.filter((s) => !s.config.hidden);
  }
}

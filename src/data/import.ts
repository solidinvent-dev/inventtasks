// Import — recreates a backup bundle (see export.ts) into a destination,
// writing files directly then doing a single rescan. Handles:
//   • collision-safe names (append " (2)", " (3)") for space/folder/list, and
//     for tasks only when merging into an existing list — reported back.
//   • fresh ids for spaces/folders/lists/views (not cross-referenced) and
//     remapped task ids (parent_task, relationships, relationship custom
//     fields, additional_lists) so the imported graph stays consistent.

import { TFile, normalizePath } from "obsidian";
import { t } from "../i18n";
import type InventTasksPlugin from "../main";
import { TaskData, ViewConfig } from "../types";
import { joinFrontmatter, serializeTask, splitFrontmatter } from "./parsers";
import { SPACE_FILE, FOLDER_FILE, LIST_FILE, VIEWS_DIR, WORKSPACE_FILE, WORKSPACE_STATE_FILE } from "../constants";
import { safeFileName, slugify } from "../utils/slug";
import { BackupBundle, BackupSpace, BackupFolder, BackupList, BackupRawFile } from "./export";
import { limit, freeLimit } from "./license";

export interface ImportResult {
  spaces: number; folders: number; lists: number; tasks: number; views: number; rawFiles: number;
  renamed: { type: "space" | "folder" | "list" | "task"; from: string; to: string }[];
}

// Destination depends on the bundle scope:
//   workspace / space → root (spaces created under the vault root)
//   folder            → spacePath
//   list              → spacePath OR folderPath (the parent container)
//   task              → listPath
export interface ImportDestination { spacePath?: string; folderPath?: string; listPath?: string; }

const rand4 = () => Math.floor(Math.random() * 10000).toString().padStart(4, "0");
const rand6 = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const isTaskId = (s: any): s is string => typeof s === "string" && /^TSK-\d{5}$/.test(s);

function uniqueName(desired: string, taken: Set<string>): string {
  const untitled = t("common.untitled");
  const base = (desired || untitled).trim() || untitled;
  if (!taken.has(base.toLowerCase())) { taken.add(base.toLowerCase()); return base; }
  let n = 2;
  while (taken.has(`${base} (${n})`.toLowerCase())) n++;
  const out = `${base} (${n})`;
  taken.add(out.toLowerCase());
  return out;
}

export async function importBackup(
  plugin: InventTasksPlugin,
  bundle: BackupBundle,
  dest: ImportDestination,
  opts?: { topName?: string; applyWorkspaceConfig?: boolean; applyWorkspaceState?: boolean },
): Promise<ImportResult> {
  if (bundle?.format !== "inventtasks-backup") throw new Error(t("err.notBackup"));
  // The import path writes files directly (bypassing createList/createTask), so
  // the working-set budget is enforced here too, before anything is written.
  {
    const open = (g: any) => g !== "done" && g !== "closed"; // only live tasks count
    const add = { lists: 0, tasks: 0 };
    const cl = (bl: BackupList) => { add.lists++; for (const tk of bl.tasks || []) if (open(tk.data?.status_group)) add.tasks++; };
    const cf = (bf: BackupFolder) => (bf.lists || []).forEach(cl);
    const cs = (bs: BackupSpace) => { (bs.folders || []).forEach(cf); (bs.lists || []).forEach(cl); };
    if (bundle.scope === "workspace") (bundle.spaces || []).forEach(cs);
    else if (bundle.scope === "space" && bundle.space) cs(bundle.space);
    else if (bundle.scope === "folder" && bundle.folder) cf(bundle.folder);
    else if (bundle.scope === "list" && bundle.list) cl(bundle.list);
    else if (bundle.scope === "task") {
      if (open(bundle.task?.data?.status_group)) add.tasks++;
      for (const sub of bundle.task_subtasks || []) if (open(sub.data?.status_group)) add.tasks++;
    }
    const curLists = (plugin.index.allLists?.() ?? []).reduce((n, l) => n + (l.config.system_kind ? 0 : 1), 0);
    const curTasks = (plugin.index.allTasks?.() ?? []).filter((tk) => !plugin.index.isSystemTask?.(tk) && open(tk.data.status_group)).length;
    if (curLists + add.lists > limit(1)) throw new Error(t("lim.lists", { n: freeLimit(1) }));
    if (curTasks + add.tasks > limit(2)) throw new Error(t("lim.tasks", { n: freeLimit(2) }));
  }
  const res: ImportResult = { spaces: 0, folders: 0, lists: 0, tasks: 0, views: 0, rawFiles: 0, renamed: [] };
  const createdPaths: string[] = [];

  const rememberCreated = (path: string) => {
    const norm = normalizePath(path);
    if (!createdPaths.includes(norm)) createdPaths.push(norm);
  };
  const ensureTrackedFolder = async (path: string) => {
    const norm = normalizePath(path);
    const existed = !!plugin.app.vault.getAbstractFileByPath(norm);
    const folder = await plugin.index.ensureFolder(norm);
    if (!existed) rememberCreated(norm);
    return folder;
  };
  const writeTrackedFile = async (path: string, contents: string) => {
    const norm = normalizePath(path);
    const existed = !!plugin.app.vault.getAbstractFileByPath(norm);
    const file = await plugin.index.writeFile(norm, contents);
    if (!existed) rememberCreated(norm);
    return file;
  };
  const rollbackCreated = async () => {
    for (const path of createdPaths.slice().sort((a, b) => b.length - a.length)) {
      const af = plugin.app.vault.getAbstractFileByPath(path);
      if (!af) continue;
      // Rolling back files this import itself just created: they never were the
      // user's, so they are removed outright rather than filling their trash.
      // undoing our own writes, not deleting user files
      try { await plugin.app.vault.delete(af, true); } catch { /* best-effort rollback */ }
    }
  };

  // ---- id + path remap state ----
  const idMap = new Map<string, string>();             // old task id → new task id
  const listPathMap = new Map<string, string>();       // old list srcPath → new dir path
  const folderPathMap = new Map<string, string>();     // old folder srcPath → new dir path
  const spacePathMap = new Map<string, string>();      // old space srcPath → new dir path
  const usedIds = new Set<string>(plugin.index.tasksById.keys());
  let idCounter = 1;
  const newTaskId = (): string => {
    let id: string;
    do { id = `TSK-${String(idCounter++).padStart(5, "0")}`; } while (usedIds.has(id));
    usedIds.add(id);
    return id;
  };

  // Pre-pass: assign new ids to every task in the bundle so references resolve.
  const eachBundleTask = (fn: (t: TaskData) => void) => {
    const walkList = (bl: BackupList) => bl.tasks.forEach((t) => fn(t.data));
    const walkFolder = (bf: BackupFolder) => bf.lists.forEach(walkList);
    const walkSpace = (bs: BackupSpace) => { bs.folders.forEach(walkFolder); bs.lists.forEach(walkList); };
    if (bundle.spaces) bundle.spaces.forEach(walkSpace);
    if (bundle.space) walkSpace(bundle.space);
    if (bundle.folder) walkFolder(bundle.folder);
    if (bundle.list) walkList(bundle.list);
    if (bundle.task) fn(bundle.task.data);
    if (bundle.task_subtasks) bundle.task_subtasks.forEach((t) => fn(t.data));
  };
  eachBundleTask((t) => { if (!idMap.has(t.id)) idMap.set(t.id, newTaskId()); });

  const remapId = (old: any): string | undefined => (isTaskId(old) ? idMap.get(old) : undefined);
  // Docs and pages carry their own ids, and importing a container copies its
  // `_docs/` verbatim. Left alone that produces two Docs with the SAME id in one
  // workspace: `docById` answers with whichever is found first, the other
  // becomes unreachable, and every Doc-link field pointing at that id turns
  // ambiguous. Tasks and views are already re-stamped on import; Docs have to
  // be too. Built before anything is written so task references can follow.
  const docIdMap = new Map<string, string>();
  const pageIdMap = new Map<string, string>();
  const isDocId = (v: unknown): v is string => typeof v === "string" && /^DOC-[A-Z0-9]+$/.test(v);
  const isPageId = (v: unknown): v is string => typeof v === "string" && /^PG-[A-Z0-9]+$/.test(v);
  const mapDocRef = (v: any): any => {
    if (isDocId(v)) return docIdMap.get(v) ?? v;
    if (isPageId(v)) return pageIdMap.get(v) ?? v;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const o: any = { ...v };
      if (isDocId(o.doc_id)) o.doc_id = docIdMap.get(o.doc_id) ?? o.doc_id;
      if (isPageId(o.page_id)) o.page_id = pageIdMap.get(o.page_id) ?? o.page_id;
      return o;
    }
    return v;
  };

  const remapCfValue = (v: any): any => {
    if (isTaskId(v)) return idMap.get(v) ?? v;
    if (isDocId(v) || isPageId(v)) return mapDocRef(v);
    if (Array.isArray(v)) return v.map((x) => (isTaskId(x) ? (idMap.get(x) ?? x) : mapDocRef(x)));
    if (v && typeof v === "object") return mapDocRef(v);
    return v;
  };
  const remapTask = (data: TaskData): any => {
    const d: any = { ...data };
    d.id = idMap.get(data.id) || newTaskId();
    if (typeof d.parent_task === "string") d.parent_task = remapId(d.parent_task) ?? null;
    else if (Array.isArray(d.parent_task)) d.parent_task = d.parent_task.map(remapId).filter(Boolean);
    else d.parent_task = d.parent_task ?? null;
    if (d.relationships && typeof d.relationships === "object") {
      const r: any = {};
      if (Array.isArray(d.relationships.blocks)) r.blocks = d.relationships.blocks.map(remapId).filter(Boolean);
      if (Array.isArray(d.relationships.related)) r.related = d.relationships.related.map(remapId).filter(Boolean);
      d.relationships = r;
    }
    if (Array.isArray(d.additional_lists)) d.additional_lists = d.additional_lists.map((p: string) => listPathMap.get(p) || p);
    if (Array.isArray(d.documents)) d.documents = d.documents.map(mapDocRef);
    if (d.custom_fields && typeof d.custom_fields === "object") {
      const cf: any = {};
      for (const [k, v] of Object.entries(d.custom_fields)) cf[k] = remapCfValue(v);
      d.custom_fields = cf;
    }
    return d;
  };

  const rootPath = (): string => {
    const root = plugin.index.rootPath || "/";
    return root === "/" ? "" : normalizePath(root).replace(/\/+$/, "");
  };
  const joinRoot = (child: string): string => {
    const root = rootPath();
    return root ? normalizePath(`${root}/${child}`) : child;
  };
  const relativeToImportRoot = (path: string): string => {
    const srcRoot = (bundle.workspaceConfig as any)?.__root || "";
    const normalized = normalizePath(path);
    if (srcRoot && normalized.startsWith(`${srcRoot}/`)) return normalized.slice(srcRoot.length + 1);
    const marker = normalized.match(/(?:^|\/)(_templates|_docs|_attachments|_workspace(?:-state)?\.md)(?:\/|$)/);
    return marker ? normalized.slice(marker.index! + (normalized[marker.index!] === "/" ? 1 : 0)) : normalized;
  };
  const remapRawPath = (raw: BackupRawFile): string | null => {
    const rel = relativeToImportRoot(raw.path);
    if (raw.kind === "attachment") {
      const match = rel.match(/^_attachments\/([^/]+)\/(.+)$/);
      if (!match) return null;
      const nextId = idMap.get(match[1]);
      return nextId ? joinRoot(`_attachments/${nextId}/${match[2]}`) : null;
    }
    if (raw.kind === "workspace") {
      if (!opts?.applyWorkspaceConfig) return null;
      return joinRoot(WORKSPACE_FILE);
    }
    if (raw.kind === "workspace-state") {
      if (!opts?.applyWorkspaceState) return null;
      return joinRoot(WORKSPACE_STATE_FILE);
    }
    for (const [oldPath, newPath] of [...listPathMap, ...folderPathMap, ...spacePathMap]) {
      if (raw.path === oldPath || raw.path.startsWith(`${oldPath}/`)) return normalizePath(`${newPath}/${raw.path.slice(oldPath.length).replace(/^\/+/, "")}`);
    }
    return joinRoot(rel);
  };
  // Pre-pass: hand every incoming Doc and page a fresh id before a single file
  // is written, so tasks written later can point at the new ones.
  const planDocIds = () => {
    for (const raw of bundle.rawFiles || []) {
      if (raw.kind !== "doc" || raw.encoding === "base64") continue;
      const { fm } = splitFrontmatter(raw.data);
      if (isDocId(fm?.doc_id) && !docIdMap.has(fm.doc_id)) docIdMap.set(fm.doc_id, `DOC-${rand6()}`);
      if (isPageId(fm?.page_id) && !pageIdMap.has(fm.page_id)) pageIdMap.set(fm.page_id, `PG-${rand6()}`);
    }
  };

  // Rewrite a Doc/page file onto its new identity: own id, the Doc it belongs
  // to, and its parent page. Anything not in the map is left as written.
  const restampDoc = (data: string): string => {
    const { fm, body } = splitFrontmatter(data);
    if (!fm || typeof fm !== "object") return data;
    const next: any = { ...fm };
    if (isDocId(next.doc_id)) next.doc_id = docIdMap.get(next.doc_id) ?? next.doc_id;
    if (isPageId(next.page_id)) next.page_id = pageIdMap.get(next.page_id) ?? next.page_id;
    if (isPageId(next.parent_page)) next.parent_page = pageIdMap.get(next.parent_page) ?? next.parent_page;
    return joinFrontmatter(next, body);
  };

  const writeRawFiles = async () => {
    planDocIds();
    for (const raw of bundle.rawFiles || []) {
      const path = remapRawPath(raw);
      if (!path) continue;
      if ((raw.kind === "workspace" || raw.kind === "workspace-state") && plugin.app.vault.getAbstractFileByPath(path)) continue;
      await ensureTrackedFolder(path.split("/").slice(0, -1).join("/"));
      if (raw.encoding === "base64") {
        const bytes = Buffer.from(raw.data, "base64");
        const existing = plugin.app.vault.getAbstractFileByPath(path);
        // Overwrite in place: replacing a file is not deleting it.
        if (existing instanceof TFile) await plugin.app.vault.modifyBinary(existing, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        else if ((plugin.app.vault as any).createBinary) await (plugin.app.vault as any).createBinary(path, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        else await (plugin.app.vault.adapter as any).writeBinary(path, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      } else {
        await writeTrackedFile(path, raw.kind === "doc" ? restampDoc(raw.data) : raw.data);
      }
      res.rawFiles++;
    }
  };

  // ---- view writer (no per-view rescan; replicates index.saveView's layout) ----
  const writeView = async (v: ViewConfig, locationKey: string) => {
    const i = locationKey.indexOf(":");
    const path = i > 0 ? locationKey.slice(i + 1) : "";
    const root = path && path !== "/" ? path : (plugin.index.rootPath && plugin.index.rootPath !== "/" ? plugin.index.rootPath : "");
    const viewsDir = root ? `${root}/${VIEWS_DIR}` : VIEWS_DIR;
    await ensureTrackedFolder(viewsDir);
    const nv: any = { ...v, view_id: `VW-${rand6()}`, location: locationKey };
    delete nv.__path;
    const fileName = `view-${slugify(v.name) || "view"}-${nv.view_id.toLowerCase()}.md`;
    await writeTrackedFile(normalizePath(`${viewsDir}/${fileName}`), joinFrontmatter(nv, `\n# ${v.name}\n\n${v.description ?? ""}\n`));
    res.views++;
  };
  const writeViews = async (views: ViewConfig[] | undefined, locationKey: string) => {
    for (const v of views || []) await writeView(v, locationKey);
  };

  // ---- deferred task writes (after all lists exist, so additional_lists remap) ----
  const pendingLists: { newPath: string; spaceName: string; folderName?: string; listName: string; tasks: BackupList["tasks"]; seedTitles?: string[] }[] = [];

  const createList = async (parentDir: string, spaceName: string, folderName: string | undefined, bl: BackupList, takenListNames: Set<string>, nameOverride?: string) => {
    const desired = nameOverride || bl.config.name;
    const listName = uniqueName(desired, takenListNames);
    if (listName !== desired) res.renamed.push({ type: "list", from: desired, to: listName });
    const dirPath = `${parentDir}/${safeFileName(`List - ${listName}`)}`;
    await ensureTrackedFolder(dirPath);
    const config: any = { ...bl.config, name: listName, list_id: `LST-${rand4()}` };
    await writeTrackedFile(`${dirPath}/${LIST_FILE}`, joinFrontmatter(config, `\n# ${listName}\n\n${config.description || ""}\n`));
    res.lists++;
    listPathMap.set(bl.srcPath, dirPath);
    await writeViews(bl.views, `list:${dirPath}`);
    pendingLists.push({ newPath: dirPath, spaceName, folderName, listName, tasks: bl.tasks });
  };

  const createFolder = async (spaceDir: string, spaceName: string, bf: BackupFolder, takenFolderNames: Set<string>, nameOverride?: string) => {
    const desired = nameOverride || bf.config.name;
    const folderName = uniqueName(desired, takenFolderNames);
    if (folderName !== desired) res.renamed.push({ type: "folder", from: desired, to: folderName });
    const dirPath = `${spaceDir}/${safeFileName(`Folder - ${folderName}`)}`;
    await ensureTrackedFolder(dirPath);
    const config: any = { ...bf.config, name: folderName, folder_id: `FLD-${rand4()}` };
    await writeTrackedFile(`${dirPath}/${FOLDER_FILE}`, joinFrontmatter(config, `\n# ${folderName}\n`));
    res.folders++;
    folderPathMap.set(bf.srcPath, dirPath);
    await writeViews(bf.views, `folder:${dirPath}`);
    const takenListNames = new Set<string>();
    for (const bl of bf.lists) await createList(dirPath, spaceName, folderName, bl, takenListNames);
  };

  const createSpace = async (rootDir: string, bs: BackupSpace, takenSpaceNames: Set<string>, nameOverride?: string) => {
    const desired = nameOverride || bs.config.name;
    const spaceName = uniqueName(desired, takenSpaceNames);
    if (spaceName !== desired) res.renamed.push({ type: "space", from: desired, to: spaceName });
    const baseDir = rootDir && rootDir !== "/" ? rootDir : "";
    const dirPath = baseDir ? `${baseDir}/${safeFileName(`Space - ${spaceName}`)}` : safeFileName(`Space - ${spaceName}`);
    await ensureTrackedFolder(dirPath);
    const config: any = { ...bs.config, name: spaceName, space_id: `SPC-${rand4()}` };
    await writeTrackedFile(`${dirPath}/${SPACE_FILE}`, joinFrontmatter(config, `\n# ${spaceName}\n`));
    res.spaces++;
    spacePathMap.set(bs.srcPath, dirPath);
    await writeViews(bs.views, `space:${dirPath}`);
    const takenFolderNames = new Set<string>();
    const takenListNames = new Set<string>();
    for (const bf of bs.folders) await createFolder(dirPath, spaceName, bf, takenFolderNames);
    for (const bl of bs.lists) await createList(dirPath, spaceName, undefined, bl, takenListNames);
  };

  try {
    // ---- structure creation by scope ----
    const root = plugin.index.rootPath || "/";
    if (bundle.scope === "workspace") {
      const taken = new Set<string>(plugin.index.spaces.map((s) => s.config.name.toLowerCase()));
      for (const bs of bundle.spaces || []) await createSpace(root, bs, taken);
      // Source workspace config is intentionally NOT applied (would clobber the
      // destination vault's own statuses/features). Global saved views are additive.
      await writeViews(bundle.globalViews, "everything");
    } else if (bundle.scope === "space" && bundle.space) {
      const taken = new Set<string>(plugin.index.spaces.map((s) => s.config.name.toLowerCase()));
      await createSpace(root, bundle.space, taken, opts?.topName);
    } else if (bundle.scope === "folder" && bundle.folder) {
      const spacePath = dest.spacePath!;
      const space = plugin.index.findSpace(spacePath);
      const spaceName = space?.config.name || "";
      const taken = new Set<string>((space?.folders || []).map((f) => f.config.name.toLowerCase()));
      await createFolder(spacePath, spaceName, bundle.folder, taken, opts?.topName);
    } else if (bundle.scope === "list" && bundle.list) {
      const parentPath = dest.folderPath || dest.spacePath!;
      const space = plugin.index.findSpace(dest.spacePath || (plugin.index.findFolder(parentPath)?.spacePath || ""));
      const spaceName = space?.config.name || "";
      const folderName = dest.folderPath ? plugin.index.findFolder(dest.folderPath)?.config.name : undefined;
      const existing = dest.folderPath ? (plugin.index.findFolder(dest.folderPath)?.lists || []) : (space?.lists || []);
      const taken = new Set<string>(existing.map((l) => l.config.name.toLowerCase()));
      await createList(parentPath, spaceName, folderName, bundle.list, taken, opts?.topName);
    } else if (bundle.scope === "task" && bundle.task) {
      // Single task (+ optional subtasks) → an existing list. Dedup the main
      // title against the list; subtasks keep their titles, with parent remapped.
      const listPath = dest.listPath!;
      const list = plugin.index.findList(listPath);
      if (!list) throw new Error(t("err.destListNotFound"));
      const spaceName = plugin.index.findSpace(list.spacePath)?.config.name;
      const folderName = list.folderPath ? plugin.index.findFolder(list.folderPath)?.config.name : undefined;
      const taken = new Set<string>(list.taskFiles.map((t) => (t.data.title || "").toLowerCase()));
      const writeTask = async (bt: BackupList["tasks"][number], titleOverride?: string) => {
        const data = remapTask(bt.data);
        const title = titleOverride !== undefined ? titleOverride : (bt.data.title || t("common.untitled"));
        data.title = title;
        data.list = list.config.name;
        data.space = spaceName;
        if (folderName) data.folder = folderName; else delete data.folder;
        const fileName = `${String(data.id).toLowerCase()}-${slugify(title) || "untitled"}.md`;
        await writeTrackedFile(`${listPath}/${safeFileName(fileName)}`, serializeTask(data, bt.body || `\n# ${title}\n`));
        res.tasks++;
      };
      const desired = opts?.topName || bundle.task.data.title || t("common.untitled");
      const title = uniqueName(desired, taken);
      if (title !== desired) res.renamed.push({ type: "task", from: desired, to: title });
      await writeTask(bundle.task, title);
      for (const sub of bundle.task_subtasks || []) await writeTask(sub);
      await writeRawFiles();
      await plugin.index.rescan();
      return res;
    } else {
      throw new Error(t("err.nothingToImport", { scope: bundle.scope }));
    }

    // ---- second pass: write tasks into the freshly-created lists ----
    for (const pl of pendingLists) {
      for (const bt of pl.tasks) {
        const data = remapTask(bt.data);
        data.title = bt.data.title || t("common.untitled"); // lists are new → keep original titles
        data.list = pl.listName;
        data.space = pl.spaceName;
        if (pl.folderName) data.folder = pl.folderName; else delete data.folder;
        const fileName = `${String(data.id).toLowerCase()}-${slugify(data.title) || "untitled"}.md`;
        await writeTrackedFile(`${pl.newPath}/${safeFileName(fileName)}`, serializeTask(data, bt.body || `\n# ${data.title}\n`));
        res.tasks++;
      }
    }

    await writeRawFiles();
    await plugin.index.rescan();
    return res;
  } catch (err) {
    await rollbackCreated();
    await plugin.index.rescan();
    throw err;
  }
}

export function summarizeImport(res: ImportResult): string {
  const parts: string[] = [];
  if (res.spaces) parts.push(t("import.count.spaces", { count: res.spaces }));
  if (res.folders) parts.push(t("import.count.folders", { count: res.folders }));
  if (res.lists) parts.push(t("import.count.lists", { count: res.lists }));
  if (res.tasks) parts.push(t("import.count.tasks", { count: res.tasks }));
  if (res.views) parts.push(t("import.count.views", { count: res.views }));
  if (res.rawFiles) parts.push(t("import.count.rawFiles", { count: res.rawFiles }));
  const base = parts.length ? t("import.summary.done", { parts: parts.join(", ") }) : t("import.summary.empty");
  if (res.renamed.length) return base + t("import.summary.renamedSuffix", { count: res.renamed.length });
  return base;
}


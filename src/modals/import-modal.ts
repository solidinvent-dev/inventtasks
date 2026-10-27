import { App, Modal, Notice } from "obsidian";
import type InventTasksPlugin from "../main";
import { BackupBundle, BackupList, BackupFolder, BackupSpace, ExportScope } from "../data/export";
import { importBackup, ImportDestination, ImportResult, summarizeImport } from "../data/import";
import { t } from "../i18n";

export interface ImportPreset {
  destination: ImportDestination;
  allowedScopes: ExportScope[];
  label: string;
}

function scopeWord(scope: string): string {
  return t(`import.scope.${scope}`) || scope;
}

function countTasks(bundle: BackupBundle): number {
  let n = 0;
  const wl = (bl: BackupList) => { n += bl.tasks.length; };
  const wf = (bf: BackupFolder) => bf.lists.forEach(wl);
  const ws = (bs: BackupSpace) => { bs.folders.forEach(wf); bs.lists.forEach(wl); };
  if (bundle.spaces) bundle.spaces.forEach(ws);
  if (bundle.space) ws(bundle.space);
  if (bundle.folder) wf(bundle.folder);
  if (bundle.list) wl(bundle.list);
  if (bundle.task) n += 1;
  return n;
}

export class ImportModal extends Modal {
  plugin: InventTasksPlugin;
  private bundle: BackupBundle | null = null;
  private destValue = "";
  private busy = false;
  private preset?: ImportPreset;

  constructor(app: App, plugin: InventTasksPlugin, preset?: ImportPreset) {
    super(app);
    this.plugin = plugin;
    this.preset = preset;
  }

  onOpen() {
    this.modalEl.addClass("it-import-modal");
    this.titleEl.setText(t("import.title"));
    this.render();
  }

  private render() {
    const c = this.contentEl;
    c.empty();

    const hint = this.preset
      ? t("import.hintPreset", { label: this.preset.label, scopes: this.preset.allowedScopes.map(scopeWord).join(", ") })
      : t("import.hintRoot");
    c.createEl("p", { cls: "setting-item-description", text: hint });

    const fileRow = c.createDiv({ cls: "it-import-row" });
    const pick = fileRow.createEl("button", { cls: "it-btn-secondary", text: this.bundle ? t("import.chooseDifferent") : t("import.chooseFile") });
    const input = fileRow.createEl("input", { type: "file", attr: { accept: ".json,application/json" } });
    input.hide();
    pick.addEventListener("click", () => input.click());
    input.addEventListener("change", async () => {
      const f = input.files?.[0];
      if (!f) return;
      try {
        const text = await f.text();
        const parsed = JSON.parse(text);
        if (parsed?.format !== "inventtasks-backup") throw new Error(t("import.notBackup"));
        this.bundle = parsed as BackupBundle;
        this.destValue = "";
        this.render();
      } catch (e: any) {
        new Notice(t("import.readFailed", { msg: e?.message ?? String(e) }));
      }
    });

    if (!this.bundle) return;

    const b = this.bundle;
    const info = c.createDiv({ cls: "it-import-info" });
    info.createEl("div", {
      text: t("import.scope", {
        scope: b.scope,
        name: b.scopeName ? t("import.scopeName", { name: b.scopeName }) : "",
      }),
    });
    info.createEl("div", { cls: "setting-item-description", text: t("import.tasksInBackup", { count: countTasks(b) }) });

    if (this.preset && !this.preset.allowedScopes.includes(b.scope)) {
      c.createEl("p", {
        cls: "it-export-error",
        text: t("import.scopeMismatch", {
          fileScope: scopeWord(b.scope),
          label: this.preset.label,
          scopes: this.preset.allowedScopes.map(scopeWord).join(", "),
        }),
      });
      return;
    }

    if (this.preset) {
      c.createEl("p", { cls: "setting-item-description", text: t("import.into", { label: this.preset.label }) });
    } else {
      const needsDest = b.scope === "folder" || b.scope === "list" || b.scope === "task";
      if (needsDest) {
        const opts = this.destinationOptions(b.scope);
        if (opts.length === 0) {
          c.createEl("p", { cls: "it-export-error", text: this.noDestText(b.scope) });
          return;
        }
        const row = c.createDiv({ cls: "it-export-row" });
        row.createSpan({ cls: "it-export-label", text: this.destLabel(b.scope) });
        const sel = row.createEl("select", { cls: "it-input" });
        sel.createEl("option", { value: "", text: t("common.choose") });
        for (const o of opts) sel.createEl("option", { value: o.value, text: o.label });
        sel.value = this.destValue;
        sel.addEventListener("change", () => { this.destValue = sel.value; });
      } else {
        c.createEl("p", { cls: "setting-item-description", text: t("import.intoVaultRoot") });
      }
    }

    const footer = c.createDiv({ cls: "it-modal-footer" });
    footer.createEl("button", { text: t("common.cancel"), cls: "it-btn-ghost" }).addEventListener("click", () => this.close());
    const go = footer.createEl("button", { cls: "it-btn-primary", text: t("common.import") });
    go.addEventListener("click", () => this.doImport());
  }

  private destLabel(scope: string): string {
    if (scope === "folder") return t("import.intoSpace");
    if (scope === "list") return t("import.intoSpaceFolder");
    return t("import.intoList");
  }
  private noDestText(scope: string): string {
    if (scope === "folder") return t("import.noSpaces");
    if (scope === "list") return t("import.noContainers");
    return t("import.noLists");
  }

  private destinationOptions(scope: string): { value: string; label: string }[] {
    const out: { value: string; label: string }[] = [];
    const idx = this.plugin.index;
    // Imports land in user-visible containers only: the hidden system Space and
    // its Reminders / Short notes lists are not import destinations.
    if (scope === "folder") {
      for (const s of idx.userSpaces) out.push({ value: `space:${s.path}`, label: s.config.name });
    } else if (scope === "list") {
      for (const s of idx.userSpaces) {
        out.push({ value: `space:${s.path}`, label: s.config.name });
        for (const f of s.folders) out.push({ value: `folder:${f.path}`, label: `${s.config.name} / ${f.config.name}` });
      }
    } else if (scope === "task") {
      for (const l of idx.allLists()) {
        if (l.config.system_kind) continue;
        const sp = l.spacePath ? idx.findSpace(l.spacePath) : undefined;
        out.push({ value: `list:${l.path}`, label: sp ? `${sp.config.name} / ${l.config.name}` : l.config.name });
      }
    }
    return out;
  }

  private resolveDest(scope: string): ImportDestination | null {
    if (this.preset) return this.preset.destination;
    if (scope === "workspace" || scope === "space") return {};
    if (!this.destValue) return null;
    const i = this.destValue.indexOf(":");
    const kind = this.destValue.slice(0, i), path = this.destValue.slice(i + 1);
    if (scope === "folder" && kind === "space") return { spacePath: path };
    if (scope === "list") return kind === "folder" ? { folderPath: path } : { spacePath: path };
    if (scope === "task" && kind === "list") return { listPath: path };
    return null;
  }

  private async doImport() {
    if (!this.bundle || this.busy) return;
    const dest = this.resolveDest(this.bundle.scope);
    if (dest === null) { new Notice(t("common.pickDestination")); return; }
    this.busy = true;
    try {
      const res = await importBackup(this.plugin, this.bundle, dest);
      this.plugin.refreshViews();
      this.showResult(res);
    } catch (e: any) {
      new Notice(t("import.failed", { msg: e?.message ?? String(e) }));
      this.busy = false;
    }
  }

  private showResult(res: ImportResult) {
    const c = this.contentEl;
    c.empty();
    this.titleEl.setText(t("import.complete"));
    c.createEl("p", { text: summarizeImport(res) });
    if (res.renamed.length) {
      c.createEl("p", { cls: "setting-item-description", text: t("import.renamed", { count: res.renamed.length }) });
      const list = c.createDiv({ cls: "it-import-renames" });
      for (const r of res.renamed.slice(0, 200)) {
        const row = list.createDiv({ cls: "it-import-rename-row" });
        row.createSpan({ cls: "it-import-rename-type", text: r.type });
        row.createSpan({ text: `“${r.from}” → “${r.to}”` });
      }
    }
    const footer = c.createDiv({ cls: "it-modal-footer" });
    footer.createEl("button", { cls: "it-btn-primary", text: t("common.done") }).addEventListener("click", () => this.close());
  }
}

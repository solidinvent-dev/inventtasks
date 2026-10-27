import { App, Modal, Notice, Setting } from "obsidian";
import type InventTasksPlugin from "../main";
import type { BackupSummary } from "../data/incremental-backup";
import { t } from "../i18n";

export class IncrementalBackupRestoreModal extends Modal {
  private plugin: InventTasksPlugin;
  private backups: BackupSummary[] = [];
  private selectedPath = "";
  private mode: "new-folder" | "overwrite" = "new-folder";
  private destinationRoot = "";
  private busy = false;

  constructor(app: App, plugin: InventTasksPlugin) {
    super(app);
    this.plugin = plugin;
  }

  async onOpen() {
    this.modalEl.addClass("it-import-modal");
    this.titleEl.setText(t("backup.restoreTitle"));
    await this.loadBackups();
    this.render();
  }

  private async loadBackups(): Promise<void> {
    try {
      this.backups = await this.plugin.incrementalBackupService.listBackups(this.plugin.prefs);
      this.selectedPath = this.backups[0]?.path || "";
    } catch (e: any) {
      new Notice(t("backup.listFailed", { msg: e?.message ?? String(e) }));
      this.backups = [];
    }
  }

  private render(): void {
    const c = this.contentEl;
    c.empty();
    c.createEl("p", { cls: "setting-item-description", text: t("backup.restoreDesc") });

    if (!this.backups.length) {
      c.createEl("p", { cls: "it-export-error", text: t("backup.noBackups") });
      const footer = c.createDiv({ cls: "it-modal-footer" });
      footer.createEl("button", { cls: "it-btn-primary", text: t("common.done") }).addEventListener("click", () => this.close());
      return;
    }

    new Setting(c)
      .setName(t("backup.restorePoint"))
      .addDropdown((d) => {
        for (const backup of this.backups) {
          d.addOption(backup.path, t("backup.restoreOption", {
            kind: backup.kind,
            date: backup.createdAt,
            files: backup.files,
            size: formatMb(backup.bytes),
          }));
        }
        d.setValue(this.selectedPath);
        d.onChange((value) => { this.selectedPath = value; });
      });

    new Setting(c)
      .setName(t("backup.restoreMode"))
      .setDesc(t("backup.restoreModeDesc"))
      .addDropdown((d) =>
        d.addOption("new-folder", t("backup.restoreNewFolder"))
          .addOption("overwrite", t("backup.restoreOverwrite"))
          .setValue(this.mode)
          .onChange((value) => {
            this.mode = value as "new-folder" | "overwrite";
            this.render();
          })
      );

    if (this.mode === "new-folder") {
      new Setting(c)
        .setName(t("backup.restoreDestination"))
        .setDesc(t("backup.restoreDestinationDesc"))
        .addText((txt) =>
          txt.setPlaceholder(`${this.plugin.prefs.workspaceRoot || "Tasks"} Restored`)
            .setValue(this.destinationRoot)
            .onChange((value) => { this.destinationRoot = value.trim(); })
        );
    } else {
      c.createEl("p", { cls: "it-export-error", text: t("backup.restoreOverwriteWarning") });
    }

    const footer = c.createDiv({ cls: "it-modal-footer" });
    footer.createEl("button", { cls: "it-btn-ghost", text: t("common.cancel") }).addEventListener("click", () => this.close());
    const restore = footer.createEl("button", {
      cls: this.mode === "overwrite" ? "it-btn-danger" : "it-btn-primary",
      text: t("backup.restoreButton"),
    });
    restore.addEventListener("click", () => void this.restore());
  }

  private async restore(): Promise<void> {
    if (this.busy || !this.selectedPath) return;
    this.busy = true;
    try {
      const count = await this.plugin.incrementalBackupService.restoreBackup(this.plugin.prefs, this.selectedPath, {
        mode: this.mode,
        destinationRoot: this.destinationRoot || undefined,
      });
      new Notice(t("backup.restoreDone", { count }));
      // Never let an incomplete restore pass as a clean one.
      const missing = this.plugin.incrementalBackupService.lastRestoreSkipped;
      if (missing.length) {
        new Notice(t("backup.restoreIncomplete", {
          count: String(missing.length),
          files: missing.slice(0, 5).map((m) => m.path).join(", "),
        }), 15000);
      }
      this.close();
    } catch (e: any) {
      new Notice(t("backup.restoreFailed", { msg: e?.message ?? String(e) }));
      this.busy = false;
    }
  }
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

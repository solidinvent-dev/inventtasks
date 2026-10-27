import { App, Modal, Notice, setIcon } from "obsidian";
import type { VersionEntry } from "../sync/client";
import { ConfirmModal } from "./confirm-modal";
import { formatDate } from "../utils/dates";
import { t } from "../i18n";

/**
 * Browses the sync server's version history for one file and restores a chosen
 * version. "Nothing is ever lost" (SYNC_SPECIFICATION.md §0.5) is only useful
 * if it is reachable — this is that reach. Restoring writes the old bytes back
 * to the file; the current content is preserved server-side automatically and
 * the restore itself syncs as a normal change.
 */
/**
 * History source — task sync binds these to SyncManager + a workspace id,
 * Vault Sync to its own manager. The modal itself is scope-agnostic.
 */
export interface SyncHistoryProvider {
  listVersions(path: string): Promise<VersionEntry[]>;
  versionContent(id: number): Promise<ArrayBuffer>;
  restoreVersion(path: string, id: number): Promise<void>;
}

export class SyncHistoryModal extends Modal {
  private readonly provider: SyncHistoryProvider;
  private readonly path: string;
  private versions: VersionEntry[] = [];
  private selectedId: number | null = null;

  constructor(app: App, provider: SyncHistoryProvider, path: string) {
    super(app);
    this.provider = provider;
    this.path = path;
  }

  onOpen(): void {
    this.modalEl.addClass("it-sync-history-modal");
    this.titleEl.setText(t("syncHistory.title"));
    void this.load();
  }

  private async load(): Promise<void> {
    const c = this.contentEl;
    c.empty();
    c.createEl("p", { cls: "setting-item-description it-sync-history-path", text: this.path });
    const listWrap = c.createDiv("it-sync-history-list");
    listWrap.setText(t("syncHistory.loading"));

    try {
      this.versions = await this.provider.listVersions(this.path);
    } catch (e) {
      listWrap.empty();
      listWrap.createEl("p", { cls: "it-export-error", text: t("syncHistory.loadFailed", { msg: e instanceof Error ? e.message : String(e) }) });
      return;
    }

    listWrap.empty();
    if (this.versions.length === 0) {
      listWrap.createEl("p", { cls: "setting-item-description", text: t("syncHistory.empty") });
      return;
    }

    for (const v of this.versions) {
      const row = listWrap.createDiv("it-sync-history-row");
      row.toggleClass("is-selected", v.id === this.selectedId);

      const head = row.createDiv("it-sync-history-row-head");
      const icon = head.createSpan("it-sync-history-icon");
      setIcon(icon, v.deleted ? "trash-2" : v.note === "conflict-loser" ? "git-merge" : "file-clock");
      head.createSpan({ cls: "it-sync-history-when", text: formatDate(v.createdAt, { withTime: true }) });
      if (v.device) head.createSpan({ cls: "it-sync-history-device", text: v.device });
      if (v.note) head.createSpan({ cls: "it-sync-history-badge", text: noteLabel(v.note) });

      const meta = row.createDiv("it-sync-history-meta");
      meta.setText(v.deleted ? t("syncHistory.deletedMarker") : t("syncHistory.size", { size: formatBytes(v.size) }));

      const actions = row.createDiv("it-sync-history-actions");
      if (!v.deleted) {
        const preview = actions.createEl("button", { text: t("syncHistory.preview") });
        preview.addEventListener("click", () => void this.preview(v));
        const restore = actions.createEl("button", { cls: "mod-cta", text: t("syncHistory.restore") });
        restore.addEventListener("click", () => this.confirmRestore(v));
      } else {
        // A tombstone: restoring it means deleting the live file.
        const restore = actions.createEl("button", { cls: "mod-warning", text: t("syncHistory.restoreDeletion") });
        restore.addEventListener("click", () => this.confirmRestore(v));
      }
    }
  }

  private async preview(v: VersionEntry): Promise<void> {
    this.selectedId = v.id;
    const existing = this.contentEl.querySelector(".it-sync-history-preview");
    existing?.remove();
    const box = this.contentEl.createDiv("it-sync-history-preview");
    box.setText(t("syncHistory.loading"));
    try {
      const buf = await this.provider.versionContent(v.id);
      box.empty();
      const text = decodePreview(buf);
      if (text === null) {
        box.createEl("p", { cls: "setting-item-description", text: t("syncHistory.binary", { size: formatBytes(v.size) }) });
      } else {
        box.createEl("pre", { text: text.slice(0, 8000) });
      }
    } catch (e) {
      box.empty();
      box.createEl("p", { cls: "it-export-error", text: e instanceof Error ? e.message : String(e) });
    }
  }

  private confirmRestore(v: VersionEntry): void {
    const when = formatDate(v.createdAt, { withTime: true });
    new ConfirmModal(this.app, {
      title: v.deleted ? t("syncHistory.restoreDeletion") : t("syncHistory.restore"),
      message: v.deleted
        ? t("syncHistory.confirmDeletion", { path: this.path })
        : t("syncHistory.confirmRestore", { path: this.path, when }),
      destructive: !!v.deleted,
      confirmLabel: v.deleted ? t("syncHistory.restoreDeletion") : t("syncHistory.restore"),
      onConfirm: () => void this.doRestore(v),
    }).open();
  }

  private async doRestore(v: VersionEntry): Promise<void> {
    try {
      await this.provider.restoreVersion(this.path, v.id);
      new Notice(t("syncHistory.restored", { path: this.path }));
      this.close();
    } catch (e) {
      new Notice(t("syncHistory.restoreFailed", { msg: e instanceof Error ? e.message : String(e) }), 10000);
    }
  }
}

/** Known server/engine note tags get a friendly label; anything else shows raw. */
function noteLabel(note: string): string {
  if (note === "conflict-loser" || note.startsWith("conflict-loser")) return t("syncHistory.noteConflict");
  if (note === "pre-merge") return t("syncHistory.notePreMerge");
  return note;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Returns decoded text, or null when the content is not valid UTF-8 (binary). */
function decodePreview(buf: ArrayBuffer): string | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return text;
  } catch {
    return null;
  }
}

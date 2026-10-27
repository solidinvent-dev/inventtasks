import { App, Modal } from "obsidian";
import { t } from "../i18n";
import type { MassDeleteChoice } from "../sync/engine";

/**
 * Mass-delete guard: the server wants to delete a large share of this scope's
 * files (someone wiped/overwrote the server workspace from another device).
 * Three-way decision — crucially including the UNDO ("restore to server"):
 * the local copies are pushed back as new revisions, so the deletion is
 * reversed everywhere instead of leaving the sync blocked forever.
 * Dismissing the dialog (Esc / X) counts as "cancel" (stay paused, ask again).
 */
/** How many affected paths the modal renders before "…and N more". */
const PATHS_SHOWN_MAX = 300;

export class SyncMassDeleteModal extends Modal {
  private chosen = false;
  private readonly opts: {
    name: string;
    deletions: number;
    total: number;
    /** The paths the server wants to delete — shown so the user decides on
     *  facts, not on a bare count. */
    paths?: string[];
    onChoose: (choice: MassDeleteChoice) => void;
  };

  constructor(app: App, opts: SyncMassDeleteModal["opts"]) {
    super(app);
    this.opts = opts;
  }

  private choose(choice: MassDeleteChoice): void {
    if (this.chosen) return;
    this.chosen = true;
    // Callback BEFORE close(): desktop fires onClose synchronously and the
    // caller must never see "closed without a decision" after a real click.
    this.opts.onChoose(choice);
    this.close();
  }

  onOpen(): void {
    this.titleEl.setText(t("sync.massDeleteTitle"));
    const c = this.contentEl;
    c.empty();
    const lines = t("sync.massDeleteMsg", {
      name: this.opts.name,
      count: this.opts.deletions,
      total: this.opts.total,
    }).split("\n");
    for (const line of lines) c.createEl("p").setText(line);

    if (this.opts.paths && this.opts.paths.length > 0) {
      const list = c.createDiv({ cls: "it-massdelete-paths" });
      for (const path of this.opts.paths.slice(0, PATHS_SHOWN_MAX)) {
        list.createDiv({ cls: "it-massdelete-path", text: path });
      }
      if (this.opts.paths.length > PATHS_SHOWN_MAX) {
        list.createDiv({
          cls: "it-massdelete-path it-massdelete-more",
          text: t("sync.massDeleteMore", { count: this.opts.paths.length - PATHS_SHOWN_MAX }),
        });
      }
    }

    const option = (label: string, desc: string, choice: MassDeleteChoice, cls: string): void => {
      const row = c.createDiv({ cls: "it-bootstrap-option" });
      const btn = row.createEl("button", { text: label, cls });
      btn.addEventListener("click", () => this.choose(choice));
      row.createDiv({ cls: "it-bootstrap-option-desc", text: desc });
    };

    option(t("sync.massDeleteRestore"), t("sync.massDeleteRestoreDesc"), "restoreServer", "it-btn-primary");
    option(t("sync.massDeleteApply"), t("sync.massDeleteApplyDesc"), "apply", "it-btn-danger");
    option(t("sync.massDeleteLater"), t("sync.massDeleteLaterDesc"), "cancel", "it-btn-ghost");
  }

  onClose(): void {
    super.onClose?.();
    if (!this.chosen) this.opts.onChoose("cancel");
  }
}

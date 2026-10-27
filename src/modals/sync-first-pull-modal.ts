import { App, Modal } from "obsidian";
import { t } from "../i18n";

/**
 * First-connect guard for the EMPTY-device case: the server workspace already
 * holds files and this never-synced device has none. The only sensible action
 * is a full download, but it must be confirmed — never silent. Dismissing the
 * dialog (Esc / X) counts as "cancel" (the manager then turns sync off, same
 * as a bootstrap cancel, so nothing happens until the user re-enables it).
 */
export class SyncFirstPullModal extends Modal {
  private chosen = false;
  private readonly opts: {
    name: string;
    serverFiles: number;
    onChoose: (choice: "pull" | "cancel") => void;
  };

  constructor(app: App, opts: SyncFirstPullModal["opts"]) {
    super(app);
    this.opts = opts;
  }

  private choose(choice: "pull" | "cancel"): void {
    if (this.chosen) return;
    this.chosen = true;
    // Callback BEFORE close(): desktop fires onClose synchronously and the
    // caller must never see "closed without a decision" after a real click.
    this.opts.onChoose(choice);
    this.close();
  }

  onOpen(): void {
    this.titleEl.setText(t("sync.firstPullTitle"));
    const c = this.contentEl;
    c.empty();
    c.createEl("p").setText(t("sync.firstPullMsg", { name: this.opts.name, server: this.opts.serverFiles }));

    const option = (label: string, desc: string, choice: "pull" | "cancel", cls: string): void => {
      const row = c.createDiv({ cls: "it-bootstrap-option" });
      const btn = row.createEl("button", { text: label, cls });
      btn.addEventListener("click", () => this.choose(choice));
      row.createDiv({ cls: "it-bootstrap-option-desc", text: desc });
    };

    option(t("sync.firstPullDownload"), t("sync.firstPullDownloadDesc"), "pull", "it-btn-primary");
    option(t("sync.bootstrapCancel"), t("sync.bootstrapCancelDesc"), "cancel", "it-btn-ghost");
  }

  onClose(): void {
    super.onClose?.();
    if (!this.chosen) this.opts.onChoose("cancel");
  }
}

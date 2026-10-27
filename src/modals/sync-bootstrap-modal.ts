import { App, Modal } from "obsidian";
import { t } from "../i18n";
import type { BootstrapChoice } from "../sync/engine";

/**
 * First-connect guard: shown when a device enables sync and BOTH the device and
 * the server workspace already hold files. The user picks how to reconcile.
 * Dismissing the dialog (Esc / X) counts as "cancel".
 */
export class SyncBootstrapModal extends Modal {
  private chosen = false;
  private readonly opts: {
    wsName: string;
    localFiles: number;
    serverFiles: number;
    onChoose: (choice: BootstrapChoice) => void;
  };

  constructor(app: App, opts: SyncBootstrapModal["opts"]) {
    super(app);
    this.opts = opts;
  }

  private choose(choice: BootstrapChoice): void {
    if (this.chosen) return;
    this.chosen = true;
    this.close();
    this.opts.onChoose(choice);
  }

  onOpen(): void {
    this.titleEl.setText(t("sync.bootstrapTitle"));
    const c = this.contentEl;
    c.empty();
    const intro = c.createEl("p");
    intro.setText(t("sync.bootstrapMsg", {
      name: this.opts.wsName,
      local: this.opts.localFiles,
      server: this.opts.serverFiles,
    }));

    const option = (label: string, desc: string, choice: BootstrapChoice, cls: string): void => {
      const row = c.createDiv({ cls: "it-bootstrap-option" });
      const btn = row.createEl("button", { text: label, cls });
      btn.addEventListener("click", () => this.choose(choice));
      row.createEl("div", { cls: "it-bootstrap-option-desc", text: desc });
    };

    option(t("sync.bootstrapMerge"), t("sync.bootstrapMergeDesc"), "merge", "it-btn-primary");
    option(t("sync.bootstrapOverwriteServer"), t("sync.bootstrapOverwriteServerDesc"), "overwriteServer", "it-btn-ghost");
    option(t("sync.bootstrapOverwriteLocal"), t("sync.bootstrapOverwriteLocalDesc"), "overwriteLocal", "it-btn-ghost");
    option(t("sync.bootstrapCancel"), t("sync.bootstrapCancelDesc"), "cancel", "it-btn-danger");
  }

  onClose(): void {
    super.onClose?.();
    if (!this.chosen) this.opts.onChoose("cancel");
  }
}

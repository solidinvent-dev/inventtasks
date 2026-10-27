import { App, Modal } from "obsidian";
import { t } from "../i18n";

export class ConfirmModal extends Modal {
  title: string;
  message: string;
  onConfirm: () => void;
  destructive: boolean;
  confirmLabel?: string;

  constructor(app: App, opts: { title: string; message: string; destructive?: boolean; confirmLabel?: string; onConfirm: () => void }) {
    super(app);
    this.title = opts.title;
    this.message = opts.message;
    this.onConfirm = opts.onConfirm;
    this.destructive = !!opts.destructive;
    this.confirmLabel = opts.confirmLabel;
  }

  onOpen() {
    this.titleEl.setText(this.title);
    const c = this.contentEl;
    c.empty();
    const lines = this.message.split("\n");
    for (const line of lines) {
      const p = c.createEl("p");
      p.setText(line);
    }
    const actions = c.createDiv({ cls: "it-modal-footer" });
    const cancel = actions.createEl("button", { text: t("common.cancel"), cls: "it-btn-ghost" });
    cancel.addEventListener("click", () => this.close());
    const confirm = actions.createEl("button", {
      text: this.confirmLabel ?? (this.destructive ? t("common.delete") : t("common.confirm")),
      cls: this.destructive ? "it-btn-danger" : "it-btn-primary",
    });
    confirm.addEventListener("click", () => {
      // onConfirm BEFORE close: Modal.close() fires onClose synchronously on
      // desktop, and callers (sync mass-delete guard) treat "closed without a
      // decision" as a refusal — the old order made Delete always lose that
      // race (the prompt kept coming back and nothing was ever deleted).
      try {
        this.onConfirm();
      } finally {
        this.close();
      }
    });
  }
}

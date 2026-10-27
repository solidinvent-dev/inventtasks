import { App, Modal, setIcon } from "obsidian";
import { t } from "../i18n";

export interface SecretPasswordRequest {
  setup: boolean;
  error?: string;
}

/** Password prompt shared by an individual Reveal/Edit action and Unlock all. */
export class SecretPasswordModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    private request: SecretPasswordRequest,
    private resolveResult: (password: string | null) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("it-secret-password-modal");
    this.titleEl.setText(t(this.request.setup ? "secret.setupTitle" : "secret.unlockTitle"));
    const intro = this.contentEl.createDiv({ cls: "setting-item-description", text: t(this.request.setup ? "secret.setupDesc" : "secret.unlockDesc") });
    if (this.request.setup) intro.addClass("it-secret-password-warning");
    if (this.request.error) this.contentEl.createDiv({ cls: "it-secret-password-error", text: this.request.error });

    const passwordRow = this.contentEl.createDiv({ cls: "it-secret-password-row" });
    const input = passwordRow.createEl("input", {
      cls: "it-input",
      attr: { type: "password", autocomplete: "current-password", placeholder: t("secret.password") },
    });
    const show = passwordRow.createEl("button", { cls: "it-icon-btn", attr: { type: "button", "aria-label": t("secret.showPassword") } });
    setIcon(show, "eye");
    show.addEventListener("click", () => {
      const visible = input.type === "text";
      input.type = visible ? "password" : "text";
      setIcon(show, visible ? "eye" : "eye-off");
      input.focus();
    });

    let confirm: HTMLInputElement | null = null;
    if (this.request.setup) {
      confirm = this.contentEl.createEl("input", {
        cls: "it-input it-secret-password-confirm",
        attr: { type: "password", autocomplete: "new-password", placeholder: t("secret.confirmPassword") },
      });
    }
    const error = this.contentEl.createDiv({ cls: "it-secret-password-error" });
    const actions = this.contentEl.createDiv({ cls: "it-modal-actions" });
    const cancel = actions.createEl("button", { text: t("common.cancel") });
    const submit = actions.createEl("button", { cls: "it-btn-primary", text: t(this.request.setup ? "secret.setPassword" : "secret.unlock") });

    const finish = () => {
      const password = input.value;
      if (!password) { error.setText(t("secret.passwordRequired")); input.focus(); return; }
      if (this.request.setup && password.length < 8) { error.setText(t("secret.passwordTooShort")); input.focus(); return; }
      if (confirm && confirm.value !== password) { error.setText(t("secret.passwordMismatch")); confirm.focus(); return; }
      this.settled = true;
      this.resolveResult(password);
      this.close();
    };
    cancel.addEventListener("click", () => this.close());
    submit.addEventListener("click", finish);
    for (const el of [input, confirm].filter(Boolean) as HTMLInputElement[]) {
      el.addEventListener("keydown", (event) => {
        if (event.key === "Enter") { event.preventDefault(); finish(); }
      });
    }
    window.setTimeout(() => input.focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.settled) this.resolveResult(null);
  }
}

export function requestSecretPassword(app: App, request: SecretPasswordRequest): Promise<string | null> {
  return new Promise((resolve) => new SecretPasswordModal(app, request, resolve).open());
}

import { App, Modal } from "obsidian";
import type InventTasksPlugin from "../main";
import type { TaskFile } from "../types";
import { renderIconish } from "../ui/icons";
import { renderSourceBanner } from "./move-modal";
import { t } from "../i18n";

export interface TaskPickerOptions {
  /** Title shown in the modal header. */
  title?: string;
  /** Allow picking many tasks at once (default: true). */
  multi?: boolean;
  /** Task IDs to hide entirely (e.g. the current task + already linked ones). */
  excludeIds?: string[];
  /** Restrict pickable tasks to one list (path). */
  scopeListPath?: string;
  /** Restrict pickable tasks to one space (path). */
  scopeSpacePath?: string;
  /** Optional source-task banner — typically the task we are linking *to*. */
  source?: { id: string; title: string; icon?: string; color?: string };
  /** Subtitle under the source banner — e.g. "Add to: Blocks". */
  contextLabel?: string;
  /** Confirm-button label. Default: "Add" (multi) / "Select" (single). */
  confirmLabel?: string;
  /** Called once with the chosen task ID(s) when the user confirms. */
  onPick: (ids: string[]) => void;
  /** Optional "create a brand-new task" action (e.g. New subtask). When set, a
   *  button is shown in the footer; clicking it closes the picker and runs this
   *  (typically opening a pre-filled create modal). */
  onCreateNew?: () => void;
  /** Label for the create-new button. Default: "New". */
  createNewLabel?: string;
}

export class TaskPickerModal extends Modal {
  private plugin: InventTasksPlugin;
  private opts: TaskPickerOptions;
  private selected = new Set<string>();
  private query = "";

  constructor(app: App, plugin: InventTasksPlugin, opts: TaskPickerOptions) {
    super(app);
    this.plugin = plugin;
    this.opts = opts;
  }

  onOpen() {
    this.containerEl.addClass("it-move-modal-container");
    this.containerEl.addClass("it-task-picker-container");
    this.titleEl.setText(this.opts.title || t("picker.pickTask"));

    const c = this.contentEl;
    c.empty();
    c.addClass("it-move-modal");
    c.addClass("it-task-picker");

    // Source banner (e.g. the task being linked from)
    if (this.opts.source) {
      renderSourceBanner(
        c,
        { name: this.opts.source.title, icon: this.opts.source.icon || "✓", color: this.opts.source.color },
        this.opts.contextLabel ? [{ label: this.opts.contextLabel }] : undefined,
      );
    }

    c.createDiv({ cls: "it-move-modal-section-label", text: this.opts.multi === false ? t("picker.chooseTask") : t("picker.chooseTasks") });

    // Search input
    const searchWrap = c.createDiv({ cls: "it-move-modal-search-wrap" });
    const searchInput = searchWrap.createEl("input", {
      type: "text",
      cls: "it-move-modal-search",
      attr: { placeholder: t("picker.searchTask") },
    });

    const listEl = c.createDiv({ cls: "it-move-modal-list it-task-picker-list" });
    let confirmBtn: HTMLButtonElement;

    const exclude = new Set(this.opts.excludeIds ?? []);
    const candidates = this.collectCandidates(exclude);

    if (candidates.length === 0) {
      c.createDiv({ cls: "it-move-modal-empty", text: t("picker.noTasksToLink") });
      const footer = c.createDiv({ cls: "it-move-modal-footer" });
      this.renderCreateNew(footer);
      const cancel = footer.createEl("button", { cls: "it-secondary-btn", text: t("common.close") });
      cancel.addEventListener("click", () => this.close());
      return;
    }

    const render = () => {
      listEl.empty();
      const needle = this.query.trim().toLowerCase();
      // Group tasks by list. The same source ordering is used as in the sidebar.
      const groups = this.groupByList(candidates, needle);
      if (groups.length === 0) {
        listEl.createDiv({ cls: "it-move-modal-empty", text: t("picker.noTasksMatch") });
        return;
      }
      for (const g of groups) {
        const groupEl = listEl.createDiv({ cls: "it-move-modal-group" });
        const groupHeader = groupEl.createDiv({ cls: "it-move-modal-group-header" });
        const sIcon = renderIconish(groupHeader, g.icon || "📋", { cls: "it-move-modal-group-icon" });
        if (sIcon && g.color) sIcon.style.color = g.color;
        groupHeader.createSpan({ text: g.label, cls: "it-move-modal-group-name" });
        groupHeader.createSpan({ text: `${g.tasks.length}`, cls: "it-task-picker-group-count" });
        for (const task of g.tasks) {
          this.renderTaskOption(groupEl, task, () => {
            if (this.opts.multi === false) {
              this.selected.clear();
              this.selected.add(task.data.id);
              // Auto-confirm in single-select mode
              this.opts.onPick([task.data.id]);
              this.close();
              return;
            }
            if (this.selected.has(task.data.id)) this.selected.delete(task.data.id);
            else this.selected.add(task.data.id);
            if (confirmBtn) {
              confirmBtn.disabled = this.selected.size === 0;
              const label = this.opts.confirmLabel || t("picker.addCount", { count: this.selected.size || "" }).trim();
              confirmBtn.textContent = this.selected.size > 1 ? t("picker.addCount", { count: this.selected.size }) : label;
            }
          });
        }
      }
    };

    render();
    searchInput.addEventListener("input", () => {
      this.query = searchInput.value;
      render();
    });
    searchInput.addEventListener("keydown", (e) => {
      // Enter confirms current selection
      if (e.key === "Enter" && this.opts.multi !== false && this.selected.size > 0) {
        e.preventDefault();
        confirm();
      }
    });
    // Focus the search field as soon as the modal lands.
    window.setTimeout(() => searchInput.focus(), 0);

    const footer = c.createDiv({ cls: "it-move-modal-footer" });
    this.renderCreateNew(footer);
    const cancel = footer.createEl("button", { cls: "it-secondary-btn", text: t("common.cancel") });
    cancel.addEventListener("click", () => this.close());

    const confirm = () => {
      const ids = Array.from(this.selected);
      if (ids.length === 0) return;
      this.opts.onPick(ids);
      this.close();
    };

    if (this.opts.multi !== false) {
      confirmBtn = footer.createEl("button", { cls: "it-btn-primary", text: this.opts.confirmLabel || t("linked.add") });
      confirmBtn.disabled = true;
      confirmBtn.addEventListener("click", confirm);
    }
  }

  // Footer "create new" button (left-aligned via a flex spacer), shown only
  // when the caller supplied onCreateNew. Closing first keeps modal stacking
  // shallow — the create modal opens cleanly on top of the task modal.
  private renderCreateNew(footer: HTMLElement) {
    if (!this.opts.onCreateNew) return;
    const btn = footer.createEl("button", { cls: "it-btn-primary it-task-picker-new", text: this.opts.createNewLabel || t("common.new") });
    btn.addEventListener("click", () => { this.close(); this.opts.onCreateNew!(); });
    footer.createDiv({ cls: "it-flex-grow" });
  }

  private collectCandidates(exclude: Set<string>): TaskFile[] {
    const idx = this.plugin.index;
    let pool: TaskFile[];
    if (this.opts.scopeListPath) {
      const l = idx.findList(this.opts.scopeListPath);
      pool = l ? l.taskFiles.filter((task) => !task.data.archived) : [];
    } else if (this.opts.scopeSpacePath) {
      pool = idx.tasksFor({ kind: "space", path: this.opts.scopeSpacePath });
    } else {
      pool = idx.normalTasks();
    }
    return pool.filter((task) => !exclude.has(task.data.id));
  }

  private groupByList(
    tasks: TaskFile[],
    needle: string,
  ): Array<{ key: string; label: string; icon?: string; color?: string; tasks: TaskFile[] }> {
    const idx = this.plugin.index;
    const map = new Map<string, { key: string; label: string; icon?: string; color?: string; tasks: TaskFile[] }>();
    for (const task of tasks) {
      if (needle) {
        const hay = `${task.data.id} ${task.data.title || ""} ${task.data.custom_id || ""}`.toLowerCase();
        if (!hay.includes(needle)) continue;
      }
      const list = task.listPath ? idx.findList(task.listPath) : undefined;
      const space = list?.spacePath ? idx.findSpace(list.spacePath) : undefined;
      const key = list?.path || "__nolist";
      const label = list ? `${space?.config.name ? space.config.name + " / " : ""}${list.config.name}` : t("picker.otherTasks");
      let bucket = map.get(key);
      if (!bucket) {
        bucket = { key, label, icon: list?.config.icon, color: list?.config.color, tasks: [] };
        map.set(key, bucket);
      }
      bucket.tasks.push(task);
    }
    // Sort buckets by label, tasks inside each bucket by ID for stability.
    return Array.from(map.values())
      .map((b) => ({ ...b, tasks: b.tasks.sort((a, b) => (a.data.id || "").localeCompare(b.data.id || "")) }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  private renderTaskOption(parent: HTMLElement, tf: TaskFile, onToggle: () => void) {
    const idx = this.plugin.index;
    const statusSet = idx.resolveStatusSet(tf.listPath || "").statuses;
    const status = statusSet.find((s) => s.id === tf.data.status);
    const priorities = idx.resolvePriorities({ listPath: tf.listPath });
    const prio = tf.data.priority ? priorities.find((p) => p.id === tf.data.priority) : undefined;

    const el = parent.createDiv({ cls: "it-move-modal-option it-task-picker-option" });
    if (this.selected.has(tf.data.id)) el.addClass("is-selected");

    // Accent bar uses the task's status color so users can visually scan.
    const bar = el.createDiv({ cls: "it-move-modal-option-bar" });
    bar.style.background = status?.color || "#9E9E9E";

    // Checkbox for multi-select; single-select uses just hover affordance.
    if (this.opts.multi !== false) {
      const cb = el.createEl("input", { type: "checkbox", cls: "it-task-picker-check" });
      cb.checked = this.selected.has(tf.data.id);
      cb.addEventListener("click", (ev) => {
        ev.stopPropagation();
        onToggle();
        cb.checked = this.selected.has(tf.data.id);
        el.toggleClass("is-selected", this.selected.has(tf.data.id));
      });
    }

    const content = el.createDiv({ cls: "it-move-modal-option-content" });
    const header = content.createDiv({ cls: "it-move-modal-option-header" });
    const ico = renderIconish(header, tf.data.icon || "✓", { cls: "it-move-modal-option-icon" });
    if (ico && tf.data.color) ico.style.color = tf.data.color;
    header.createSpan({ text: tf.data.title || t("common.untitled"), cls: "it-move-modal-option-name" });

    const meta = content.createDiv({ cls: "it-move-modal-option-meta it-task-picker-meta" });
    meta.createSpan({ text: tf.data.custom_id || tf.data.id, cls: "it-task-picker-id" });
    if (status) {
      const chip = meta.createSpan({ cls: "it-task-picker-status", text: status.name });
      chip.style.setProperty("--chip-color", status.color);
    }
    if (prio) {
      const flag = meta.createSpan({ cls: "it-task-picker-priority", text: prio.label });
      flag.style.color = prio.color;
    }

    el.addEventListener("click", () => {
      onToggle();
      el.toggleClass("is-selected", this.selected.has(tf.data.id));
      const cb = el.querySelector("input.it-task-picker-check") as HTMLInputElement | null;
      if (cb) cb.checked = this.selected.has(tf.data.id);
    });
  }
}

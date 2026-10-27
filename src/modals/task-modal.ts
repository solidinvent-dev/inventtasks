import { App, Modal, MarkdownRenderer, Notice, Component, setIcon } from "obsidian";
import type InventTasksPlugin from "../main";
import { TaskFile, TaskData, PriorityId, CustomFieldDef, CustomFieldOption, StatusDef, ChecklistItem, CommentEntry, LinkedValue, TaskAttachment, RecurringConfig, DocMeta, parentTaskIds, normalizeParentTask } from "../types";
import { DOC_ICON, DOC_ACCENT } from "../constants";
import { addCfAttachments, removeCfAttachment, renameCfAttachment, addMainAttachments, removeMainAttachment, renameMainAttachment, openAttachmentInDefaultApp, humanFileSize, resolveAttachmentVaultPath, resolveCoverUrl, applyCoverBackground, coverColorValue } from "../data/attachments";
import { pickCheckboxCheckedStatus, pickCheckboxUncheckedStatus, type CheckboxAction } from "../data/status-helpers";
import {
  getBlocks, getWaitingOn, getRelated,
  addBlock, removeBlock,
  addWaitingOn, removeWaitingOn,
  addRelated, removeRelated,
} from "../data/relationships";
import { appendActivity } from "../data/activity";
import { addComment, editComment, removeComment, moveComment } from "../data/comments";
import { statusChip, priorityChip, tagChip, buildDropdown, showPopover, applyChipStyleByKind } from "../ui/components";
import { dayKey, formatDate } from "../utils/dates";
import { renderDateTimeInput } from "../ui/datetime-field";
import { ConfirmModal } from "./confirm-modal";
import { ConfigModal } from "./config-modal";
import { MoveTaskModal } from "./move-modal";
import { ExportModal } from "./export-modal";
import { SaveTemplateModal } from "./template-modals";
import { AddToListModal } from "./add-to-list-modal";
import { TaskPickerModal } from "./task-picker-modal";
import { DocPickerModal } from "./doc-picker-modal";
import { QuickTaskModal } from "./create-modals";
import { ActivityModal } from "./activity-modal";
import { showContextMenu } from "../ui/menu";
import { favoriteToggleItems } from "../views/favorites";
import { LinkedValueModal, LocationModal } from "./linked-value-modal";
import { renderCustomFieldValue } from "../ui/cf-render";
import { renderIconish, renderCfTypeIcon, renderFieldIcon } from "../ui/icons";
import { renderBuyLicenseLink } from "../ui/logo";
import { computeAutoProgress, isEmptyCustomFieldValue } from "../data/custom-fields";
import { isSecretCustomFieldType } from "../data/custom-fields";
import { MAX_TASK_TITLE_LENGTH, parseNonNegativeInteger, validateTaskTitle } from "../data/task-values";
import { SecretModalVisibility } from "../data/secret-fields";
import { canAttachSubtask } from "../data/subtasks";
import { fieldLabel as i18nFieldLabel, t as tr, weekdayMin } from "../i18n";
import { fireAndForget } from "../utils/async";

export class TaskModal extends Modal {
  plugin: InventTasksPlugin;
  task: TaskFile;
  comp: Component;
  // UI-only state — persists across re-renders triggered by patches.
  private descriptionEditing = false;
  private editingCommentId: string | null = null;
  private editingMarkdownFieldIds = new Set<string>();
  // Visibility inside THIS modal only. The session key is deliberately
  // separate: entering a password must not reveal unrelated controls/views.
  private secretVisibility = new SecretModalVisibility();
  private secretPlaintext = new Map<string, string>();
  private observedSecretLockGeneration: number;

  constructor(app: App, plugin: InventTasksPlugin, task: TaskFile, options: { editDescription?: boolean } = {}) {
    super(app);
    this.plugin = plugin;
    this.task = task;
    this.comp = new Component();
    this.descriptionEditing = options.editDescription === true;
    this.observedSecretLockGeneration = plugin.secretWorkspaceLockGeneration;
  }

  onOpen() {
    this.modalEl.addClass("it-task-modal");
    this.titleEl.empty();
    this.comp.load();
    this.render();
    // Keep the browser off the first header button — landing on Delete or
    // Archive and pressing Enter would be nasty. Blurring outright used to do
    // it, but that dropped focus all the way onto <body>: the dialog was then
    // unreachable from the keyboard without tabbing through the whole document
    // behind it. Park focus on the dialog itself instead, so the tab sequence
    // starts inside it and assistive tech announces it, while no control is
    // primed to fire.
    this.modalEl.setAttribute("tabindex", "-1");
    window.setTimeout(() => {
      const active = document.activeElement as HTMLElement | null;
      if (!active || !this.modalEl.contains(active) || active.tagName === "BUTTON") this.modalEl.focus();
    }, 0);
    const unsub = this.plugin.index.onChange(() => {
      const fresh = this.plugin.index.tasksById.get(this.task.data.id);
      if (fresh) {
        this.task = fresh;
        if (this.deferRenderWhileNativePickerOpen()) return;
        this.render();
      } else {
        this.close();
      }
    });
    this.comp.register(unsub);
  }

  onClose() {
    this.comp.unload();
    this.contentEl.empty();
  }

  // The wide (ClickUp-style two-pane) layout is offered whenever the window is
  // wide enough for the two-column grid to fit — desktop AND web. On narrow
  // windows / phones the single-column classic layout is the only option (the
  // rail would be cramped), so the toggle is hidden too. Width-based rather
  // than Platform.isMobile so a wide browser/web window gets it and a narrow
  // one doesn't. Matches the CSS that collapses the rail at <= 900px.
  private wideLayoutAvailable(): boolean {
    return window.innerWidth > 900;
  }

  private useWideLayout(): boolean {
    if (!this.wideLayoutAvailable()) return false;
    return (this.plugin.prefs.taskModalLayout ?? "wide") === "wide";
  }

  private async toggleLayout() {
    const next = this.useWideLayout() ? "classic" : "wide";
    this.plugin.prefs.taskModalLayout = next;
    await this.plugin.saveSettings();
    this.render();
  }

  // Returns whichever ancestor (contentEl or one of its ancestors up to
  // modalEl) is actually the scrolling element. Obsidian themes vary in
  // whether they put `overflow: auto` on `.modal-content` or `.modal`, so
  // we discover it at runtime rather than guess.
  private getScrollContainer(): HTMLElement {
    let el: HTMLElement | null = this.contentEl;
    while (el && el !== this.modalEl.parentElement) {
      const cs = getComputedStyle(el);
      if (cs.overflowY === "auto" || cs.overflowY === "scroll") {
        if (el.scrollHeight > el.clientHeight) return el;
      }
      el = el.parentElement;
    }
    return this.contentEl;
  }

  private openStatusEditor() {
    const idx = this.plugin.index;
    const listPath = this.task.listPath || "";
    const list = idx.findList(listPath);
    // If the list has its own status set, edit at list level.
    // Otherwise, prefer editing at space level (where most users define their workflows).
    if (list?.config.status_set?.length) {
      new ConfigModal(this.app, this.plugin, "list", listPath, "statuses").open();
    } else if (list?.spacePath) {
      new ConfigModal(this.app, this.plugin, "space", list.spacePath, "statuses").open();
    } else {
      new Notice(tr("task.notice.noListContextStatuses"));
    }
  }

  private openTaskTypesEditor() {
    const idx = this.plugin.index;
    const listPath = this.task.listPath || "";
    const list = idx.findList(listPath);
    if (list?.config.task_types?.length) {
      new ConfigModal(this.app, this.plugin, "list", listPath, "task_types").open();
    } else if (list?.folderPath) {
      const folder = idx.findFolder(list.folderPath);
      if (folder?.config.task_types?.length) {
        new ConfigModal(this.app, this.plugin, "folder", list.folderPath, "task_types").open();
        return;
      }
      if (list.spacePath) new ConfigModal(this.app, this.plugin, "space", list.spacePath, "task_types").open();
    } else if (list?.spacePath) {
      new ConfigModal(this.app, this.plugin, "space", list.spacePath, "task_types").open();
    } else {
      new ConfigModal(this.app, this.plugin, "workspace", undefined, "task_types").open();
    }
  }

  private openFieldsEditor() {
    const idx = this.plugin.index;
    const listPath = this.task.listPath || "";
    const list = idx.findList(listPath);
    if (list?.config.custom_fields?.length) {
      new ConfigModal(this.app, this.plugin, "list", listPath, "fields").open();
    } else if (list?.spacePath) {
      new ConfigModal(this.app, this.plugin, "space", list.spacePath, "fields").open();
    } else if (list) {
      new ConfigModal(this.app, this.plugin, "list", listPath, "fields").open();
    } else {
      new Notice(tr("task.notice.noListContext"));
    }
  }

  /**
   * Hold back a re-render while a native date/time picker is open.
   *
   * Saving a field rebuilds the whole modal, which is normally invisible. It is
   * not invisible on iOS: tapping an EMPTY date input opens the picker and the
   * webview immediately reports today as the value, so we save, rebuild, and the
   * picker loses the element it was anchored to and closes — leaving today's date
   * behind. The user has to tap a second time, on the now-filled field, to choose
   * anything. Same for time.
   *
   * The fix is not to skip the save but to stop destroying the control the user is
   * still using: redraw once the field is done with, which on every platform is
   * the moment it loses focus.
   */
  private pendingRenderWhileEditing = false;
  private deferRenderWhileNativePickerOpen(): boolean {
    const active = document.activeElement;
    if (!(active instanceof HTMLInputElement)) return false;
    if (active.type !== "date" && active.type !== "time") return false;
    if (!this.modalEl.contains(active)) return false;
    if (this.pendingRenderWhileEditing) return true;   // already queued
    this.pendingRenderWhileEditing = true;
    active.addEventListener("blur", () => {
      this.pendingRenderWhileEditing = false;
      const fresh = this.plugin.index.tasksById.get(this.task.data.id);
      if (fresh) { this.task = fresh; this.render(); }
    }, { once: true });
    return true;
  }

  private async patch(fn: (d: TaskData, body: string) => { data: TaskData; body?: string } | void) {
    // updateTask fires emit() which our onChange listener turns into a full
    // render() — that destroys and rebuilds the DOM, which by itself resets
    // the modal's scroll. We capture scrollTop here (synchronously, before
    // any await yields control back to the browser) and re-apply it after.
    // The vault's own 'modify' event then triggers a debounced second
    // re-render ~350ms later; render() does its own scroll preservation, so
    // both renders end up in the right place.
    const sc = this.getScrollContainer();
    const beforeScroll = sc.scrollTop;
    try {
      await this.plugin.index.updateTask(this.task.data.id, fn);
    } catch (e) {
      new Notice(tr("task.notice.updateFailed", { msg: (e as Error).message }));
    }
    if (beforeScroll > 0) {
      const sc2 = this.getScrollContainer();
      sc2.scrollTop = beforeScroll;
      // Defensive second set after the next paint, in case scrollHeight
      // wasn't fully computed when the sync set ran (also covers the
      // ~350ms-later vault-event re-render that fires after this returns).
      window.requestAnimationFrame(() => { sc2.scrollTop = beforeScroll; });
    }
  }

  private renderDateTimePair(
    parent: HTMLElement,
    value: unknown,
    onChange: (value: string | null) => void | Promise<void>,
  ) {
    // Modal-only styling (`it-mdt`) — larger than the dense list/table controls
    // so Start/Due/datetime read at the same size as the Date/Time custom fields.
    renderDateTimeInput({
      parent,
      kind: "datetime",
      value,
      onCommit: (next) => void onChange(next),
      pairClass: "it-modal-datetime-pair",
      dateClass: "it-mdt it-mdt-date",
      timeClass: "it-mdt it-mdt-time",
    });
  }

  // ----- Cover image (display + add / change / remove) -----
  private async setCover(value: string | undefined) {
    await this.patch((d) => ({ data: { ...d, cover_image: value || undefined } }));
  }

  private renderCover(c: HTMLElement, t: TaskFile) {
    // Only the cover image lives here (above the header). Adding/changing it is
    // an icon button in the header actions row (see render()).
    if (!t.data.cover_image) return;
    const cover = c.createDiv({ cls: "it-task-cover" });
    applyCoverBackground(cover, this.plugin.index, t.data.cover_image);
    const actions = cover.createDiv({ cls: "it-task-cover-actions" });
    const change = actions.createEl("button", { cls: "it-cover-btn", text: tr("task.cover.change"), attr: { type: "button" } });
    change.addEventListener("click", (e) => { e.stopPropagation(); this.openCoverMenu(e.currentTarget as HTMLElement); });
    const remove = actions.createEl("button", { cls: "it-cover-btn", text: tr("task.cover.remove"), attr: { type: "button" } });
    remove.addEventListener("click", (e) => { e.stopPropagation(); void this.setCover(undefined); });
  }

  private openCoverMenu(anchor: HTMLElement) {
    const idx = this.plugin.index;
    const closePop = () => document.querySelectorAll(".it-popover").forEach((el) => el.remove());
    const isImg = (a: TaskAttachment) => /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(a.name || "") || (a.mime || "").startsWith("image/");
    showPopover(anchor, (root) => {
      root.addClass("it-cover-menu");
      const t = this.task;

      // Upload a new image (added as a main attachment, then set as cover).
      const up = root.createEl("button", { cls: "it-cover-menu-item", attr: { type: "button" } });
      setIcon(up.createSpan({ cls: "it-cover-menu-ic" }), "upload");
      up.createSpan({ text: tr("task.cover.upload") });
      const fileInput = root.createEl("input", { type: "file", attr: { accept: "image/*" } });
      fileInput.hide();
      up.addEventListener("click", () => fileInput.click());
      fileInput.addEventListener("change", fireAndForget(async () => {
        if (!fileInput.files?.length) return;
        closePop();
        await addMainAttachments(idx, t.data.id, fileInput.files);
        const atts = this.task.data.attachments || [];
        const last = atts[atts.length - 1];
        if (last) await this.setCover(resolveAttachmentVaultPath(idx, t.data.id, last));
      }));

      // Pick from existing image attachments.
      const imgs = (t.data.attachments || []).filter(isImg);
      root.createDiv({ cls: "it-cover-menu-label", text: tr("task.cover.fromAttachments") });
      if (imgs.length === 0) {
        root.createDiv({ cls: "it-cover-menu-empty", text: tr("task.cover.noImageAttachments") });
      } else {
        const list = root.createDiv({ cls: "it-cover-menu-atts" });
        for (const a of imgs) {
          const item = list.createEl("button", { cls: "it-cover-menu-att", attr: { type: "button", title: a.name } });
          const vp = resolveAttachmentVaultPath(idx, t.data.id, a);
          item.style.backgroundImage = `url("${resolveCoverUrl(idx, vp)}")`;
          item.addEventListener("click", fireAndForget(async () => { closePop(); await this.setCover(vp); }));
        }
      }

      // Plain color cover. Prefixing the stored CSS color keeps it distinct
      // from a vault path and makes the representation explicit/exportable.
      root.createDiv({ cls: "it-cover-menu-label", text: tr("task.cover.fromColor") });
      const colorRow = root.createDiv({ cls: "it-cover-menu-color" });
      const colorInput = colorRow.createEl("input", { type: "color" });
      colorInput.value = coverColorValue(t.data.cover_image) || "#7c5cff";
      const colorBtn = colorRow.createEl("button", { cls: "it-btn-primary it-btn-mini", text: tr("common.set"), attr: { type: "button" } });
      colorBtn.addEventListener("click", fireAndForget(async () => { closePop(); await this.setCover(`color:${colorInput.value}`); }));

      // From URL.
      root.createDiv({ cls: "it-cover-menu-label", text: tr("task.cover.fromUrl") });
      const urlRow = root.createDiv({ cls: "it-cover-menu-url" });
      const input = urlRow.createEl("input", { cls: "it-input", attr: { type: "text", placeholder: tr("task.cover.urlPlaceholder") } });
      input.value = (t.data.cover_image && /^https?:/i.test(t.data.cover_image)) ? t.data.cover_image : "";
      const setBtn = urlRow.createEl("button", { cls: "it-btn-primary it-btn-mini", text: tr("common.set"), attr: { type: "button" } });
      setBtn.addEventListener("click", fireAndForget(async () => { const v = input.value.trim(); if (!v) return; closePop(); await this.setCover(v); }));

      if (t.data.cover_image) {
        const rm = root.createEl("button", { cls: "it-cover-menu-item it-cover-menu-remove", attr: { type: "button" } });
        setIcon(rm.createSpan({ cls: "it-cover-menu-ic" }), "trash");
        rm.createSpan({ text: tr("task.cover.removeCover") });
        rm.addEventListener("click", fireAndForget(async () => { closePop(); await this.setCover(undefined); }));
      }
    });
  }

  render() {
    if (this.observedSecretLockGeneration !== this.plugin.secretWorkspaceLockGeneration) {
      this.observedSecretLockGeneration = this.plugin.secretWorkspaceLockGeneration;
      this.secretVisibility = new SecretModalVisibility();
      this.secretPlaintext.clear();
      this.editingMarkdownFieldIds.clear();
    }
    const c = this.contentEl;
    // Capture scroll on whichever ancestor actually scrolls (varies by
    // theme), then preserve it across the rebuild so editing a field
    // doesn't bounce the modal back to the top.
    const scrollEl = this.getScrollContainer();
    const prevScroll = scrollEl.scrollTop;
    c.empty();

    const idx = this.plugin.index;
    const t = this.task;
    const listPath = t.listPath || "";
    const statusSet = idx.resolveStatusSet(listPath).statuses;
    const status = statusSet.find((s) => s.id === t.data.status);
    const priorities = idx.resolvePriorities({ listPath });
    const customFields = idx.resolveCustomFields(listPath, t.data.type);
    const taskTypes = idx.resolveTaskTypes({ listPath });
    const currentType = taskTypes.find((tt) => tt.id === t.data.type) || taskTypes[0];
    const features = idx.resolveFeatures({ listPath });
    const chipStyles = idx.resolveChipStyles({ listPath });

    // ----- Header (cover + breadcrumb + id) -----
    if (features.cover_images !== false) this.renderCover(c, t);

    const header = c.createDiv({ cls: "it-task-header" });

    // Action icons row — sits at the very top of the header, above the type/id
    // row, so the long list of buttons never crowds the task id.
    const headerActions = header.createDiv({ cls: "it-task-header-actions" });
    // Layout switcher (classic single column ↔ wide two-pane). Shown only when
    // the window is wide enough to host the wide layout — so it's available on
    // desktop and a wide web window, and hidden on narrow windows / mobile.
    if (this.wideLayoutAvailable()) {
      const wide = this.useWideLayout();
      const layoutBtn = headerActions.createEl("button", {
        cls: "it-icon-btn it-layout-toggle" + (wide ? " is-wide" : ""),
        attr: { "aria-label": wide ? tr("task.header.layoutClassic") : tr("task.header.layoutWide") },
      });
      setIcon(layoutBtn, wide ? "panel-right" : "square");
      layoutBtn.addEventListener("click", () => void this.toggleLayout());
    }
    if (features.cover_images !== false) {
      const coverBtn = headerActions.createEl("button", { cls: "it-icon-btn", attr: { "aria-label": t.data.cover_image ? tr("task.header.changeCover") : tr("task.header.addCover") } });
      setIcon(coverBtn, "image");
      coverBtn.addEventListener("click", (e) => this.openCoverMenu(e.currentTarget as HTMLElement));
    }
    if (this.plugin.prefs.activityConfig.showActivity) {
      const actBtn = headerActions.createEl("button", { cls: "it-icon-btn", attr: { "aria-label": tr("task.header.activityLog") } });
      setIcon(actBtn, "history");
      actBtn.addEventListener("click", () => {
        new ActivityModal(this.app, this.plugin, this.task).open();
      });
    }
    const favBtn = headerActions.createEl("button", { cls: "it-icon-btn", attr: { "aria-label": tr("task.header.favorite") } });
    setIcon(favBtn, "star");
    favBtn.addEventListener("click", (e) => showContextMenu(e, favoriteToggleItems(this.plugin, t.data.id)));
    const linkBtn = headerActions.createEl("button", { cls: "it-icon-btn", attr: { "aria-label": tr("task.header.copyLink") } });
    setIcon(linkBtn, "link");
    linkBtn.addEventListener("click", () => void this.plugin.copyElementLink("task", t.data.id));
    const openBtn = headerActions.createEl("button", { cls: "it-icon-btn", attr: { "aria-label": tr("task.header.openMd") } });
    setIcon(openBtn, "external-link");
    openBtn.addEventListener("click", fireAndForget(async () => {
      await this.plugin.index.openTaskInEditor(t.data.id);
      this.close();
    }));
    const exportBtn = headerActions.createEl("button", { cls: "it-icon-btn", attr: { "aria-label": tr("task.header.export") } });
    setIcon(exportBtn, "download");
    exportBtn.addEventListener("click", () => {
      new ExportModal(this.app, this.plugin, { scope: "task", taskId: t.data.id }).open();
    });
    const tplBtn = headerActions.createEl("button", { cls: "it-icon-btn", attr: { "aria-label": tr("task.header.saveTemplate") } });
    setIcon(tplBtn, "layout-template");
    tplBtn.addEventListener("click", () => {
      new SaveTemplateModal(this.app, this.plugin, "task", { taskId: t.data.id }, { name: t.data.title || tr("list.task"), icon: t.data.icon }).open();
    });
    const moveBtn = headerActions.createEl("button", { cls: "it-icon-btn", attr: { "aria-label": tr("task.header.moveToList") } });
    setIcon(moveBtn, "folder-input");
    moveBtn.addEventListener("click", () => {
      new MoveTaskModal(this.app, this.plugin, t.data.id).open();
    });
    const archiveBtn = headerActions.createEl("button", {
      cls: "it-icon-btn",
      attr: { "aria-label": tr(t.data.archived ? "common.unarchive" : "common.archive") },
    });
    setIcon(archiveBtn, t.data.archived ? "archive-restore" : "archive");
    archiveBtn.addEventListener("click", fireAndForget(async () => {
      const archived = !t.data.archived;
      try {
        await this.plugin.index.setTasksArchived([t.data.id], archived);
        new Notice(tr(archived ? "table.bulkArchived" : "table.bulkUnarchived", { count: 1 }));
        this.close();
      } catch (error) {
        new Notice(tr("common.failed", { msg: (error as Error | undefined)?.message ?? String(error) }));
      }
    }));
    const delBtn = headerActions.createEl("button", { cls: "it-icon-btn it-danger", attr: { "aria-label": tr("task.header.delete") } });
    setIcon(delBtn, "trash");
    delBtn.addEventListener("click", () => {
      new ConfirmModal(this.app, {
        title: tr("task.confirm.deleteTitle"),
        message: tr("task.confirm.deleteMsg", { title: t.data.title }),
        destructive: true,
        onConfirm: fireAndForget(async () => {
          await this.plugin.index.deleteTask(t.data.id);
          this.close();
        }),
      }).open();
    });

    // Second row: task type badge + IDs, below the action icons row. The type
    // badge and the id are each display-only-gated (modal_task_type /
    // modal_task_id) — hiding them here does NOT change the task's actual type
    // or id, only whether they're shown in this modal.
    const idRow = header.createDiv({ cls: "it-task-id-row" });

    // Task type picker — rendered first so the user sees the type before the ID.
    if (features.modal_task_type !== false) {
      const typeBadge = idRow.createEl("button", { cls: "it-type-badge it-type-badge-clickable" });
      if (currentType?.icon) {
        const typeIconEl = renderIconish(typeBadge, currentType.icon, { cls: "it-type-icon" });
        if (typeIconEl && currentType?.color) typeIconEl.style.color = currentType.color;
      }
      typeBadge.createSpan({ text: currentType?.name || t.data.type || tr("list.task") });
      if (currentType?.color) typeBadge.style.setProperty("--type-color", currentType.color);

      typeBadge.addEventListener("click", (e) => {
        showPopover(e.currentTarget as HTMLElement, (root) => {
          buildDropdown({
            parent: root,
            current: t.data.type || "task",
            items: taskTypes.map((tt) => ({ value: tt.id, label: tt.name, color: tt.color, icon: tt.icon })),
            onSelect: fireAndForget(async (v) => {
              await this.patch((d) => ({ data: { ...d, type: v } }));
              document.querySelectorAll(".it-popover").forEach((el) => el.remove());
            }),
          });
        });
      });
    }

    if (features.modal_task_id !== false) {
      const idChip = idRow.createEl("button", {
        cls: "it-task-id it-task-id-copyable",
        attr: { type: "button", title: tr("menu.copyId"), "aria-label": tr("menu.copyId") },
      });
      idChip.createSpan({ text: t.data.id });
      idChip.addEventListener("click", (e) => { e.stopPropagation(); void this.plugin.copyTextToClipboard(t.data.id); });
      if (t.data.custom_id) {
        const customChip = idRow.createEl("button", {
          cls: "it-task-id custom it-task-id-copyable",
          attr: { type: "button", title: tr("menu.copyId"), "aria-label": tr("menu.copyId") },
        });
        customChip.createSpan({ text: t.data.custom_id });
        customChip.addEventListener("click", (e) => { e.stopPropagation(); void this.plugin.copyTextToClipboard(t.data.custom_id ?? ""); });
      }
    }

    // Both id-row elements can be hidden — drop the empty row so it leaves no gap.
    if (idRow.childElementCount === 0) idRow.remove();

    // Breadcrumb (Space / Folder / List) — display-only-gated (modal_breadcrumb).
    // Each segment is a button: click copies that container's stable id, hover
    // highlights it. The trailing icon opens a small menu with the four
    // path-shaped variants the External API distinguishes.
    if (features.modal_breadcrumb !== false) {
      const breadcrumb = header.createDiv({ cls: "it-breadcrumb" });
      const bcList = idx.findList(listPath);
      const bcFolder = bcList?.folderPath ? idx.findFolder(bcList.folderPath) : undefined;
      const bcSpace = bcList?.spacePath ? idx.findSpace(bcList.spacePath) : undefined;
      type BcSeg = { label: string; icon?: string; color?: string; id?: string };
      const segments: BcSeg[] = [];
      if (bcSpace) segments.push({ label: bcSpace.config.name, icon: bcSpace.config.icon, color: bcSpace.config.color, id: bcSpace.config.space_id });
      if (bcFolder) segments.push({ label: bcFolder.config.name, icon: bcFolder.config.icon, color: bcFolder.config.color, id: bcFolder.config.folder_id });
      if (bcList) segments.push({ label: bcList.config.name, icon: bcList.config.icon, color: bcList.config.color, id: bcList.config.list_id });
      segments.forEach((s) => {
        if (breadcrumb.childElementCount > 0) breadcrumb.createSpan({ text: "/", cls: "it-breadcrumb-sep" });
        const seg = breadcrumb.createEl("button", {
          cls: "it-breadcrumb-seg it-breadcrumb-copyable",
          attr: { type: "button", title: `${s.label} · ${tr("menu.copyId")}`, "aria-label": `${s.label} — ${tr("menu.copyId")}` },
        });
        const ico = renderIconish(seg, s.icon || "🏷️", { cls: "it-breadcrumb-icon" });
        if (ico && s.color) ico.style.color = s.color;
        seg.createSpan({ text: s.label, cls: "it-breadcrumb-name" });
        seg.addEventListener("click", (e) => { e.stopPropagation(); void this.plugin.copyTextToClipboard(s.id ?? ""); });
      });
      // Trailing path menu — one icon, four path variants for the task's home
      // List. Keeps the breadcrumb row uncluttered while exposing everything
      // the External API accepts or returns under path / storage_path /
      // source_path / ancestry.
      if (bcList) {
        const displayPath = bcList.path;                 // directory (matches API container `path`)
        const storagePath = bcList.path;                 // same on disk for a container directory
        const sourcePath = bcList.configPath;            // marker file, e.g. …/_list.md
        const ancestryIds = segments.map((s) => s.id).filter((id): id is string => !!id && !!id.trim()).join("/");
        const pathBtn = breadcrumb.createEl("button", {
          cls: "it-breadcrumb-path-btn",
          attr: { type: "button", title: tr("menu.copyPathMenu"), "aria-label": tr("menu.copyPathMenu") },
        });
        setIcon(pathBtn, "folder-tree");
        pathBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          showContextMenu(e, [
            { label: tr("menu.copyPath"), icon: "folder-tree", onClick: () => void this.plugin.copyTextToClipboard(displayPath, "deepLink.pathCopied") },
            { label: tr("menu.copyStoragePath"), icon: "hard-drive", onClick: () => void this.plugin.copyTextToClipboard(storagePath, "deepLink.storagePathCopied") },
            { label: tr("menu.copyAncestry"), icon: "git-fork", onClick: () => void this.plugin.copyTextToClipboard(ancestryIds, "deepLink.ancestryCopied") },
            { label: tr("menu.copySourcePath"), icon: "file-code", onClick: () => void this.plugin.copyTextToClipboard(sourcePath, "deepLink.sourcePathCopied") },
          ]);
        });
      }
    }

    // ----- Title (editable) -----
    const titleEl = c.createEl("input", {
      type: "text",
      cls: "it-task-title-input",
      attr: { required: "true", maxlength: String(MAX_TASK_TITLE_LENGTH) },
    });
    titleEl.value = t.data.title || "";
    titleEl.placeholder = tr("task.titlePlaceholder");
    titleEl.addEventListener("change", fireAndForget(async () => {
      const checkedTitle = validateTaskTitle(titleEl.value);
      if (!checkedTitle.valid) {
        const message = checkedTitle.reason === "required"
          ? tr("err.taskTitleRequired")
          : tr("err.taskTitleTooLong", { max: String(MAX_TASK_TITLE_LENGTH) });
        titleEl.value = t.data.title || "";
        new Notice(message);
        return;
      }
      const v = checkedTitle.value;
      if (v !== t.data.title) await this.patch((d) => ({
        data: { ...d, title: v, activity: appendActivity(d.activity, { kind: "title", from: d.title, to: v }) },
      }));
    }));

    // ----- Layout scaffold -----
    // Desktop "wide" mode splits the body into a wider main column (left,
    // holding most of the content + property fields) and a narrow rail (right,
    // holding the linked-item sections + Comments) — ClickUp-style.
    //
    // We pre-create one ordered host div per section so each column's VISUAL
    // order is independent of the build order below. In classic mode every
    // host resolves to `c`, so sections build in their original source order
    // and the single-column layout is preserved exactly.
    const wide = this.useWideLayout();
    this.modalEl.toggleClass("it-task-modal-wide", wide);
    // Both layouts pre-create one ordered host div per section, so each
    // section's POSITION is decided here (independent of build order below).
    // `H(key)` returns the section's host. Order differs per layout.
    const hosts: Record<string, HTMLElement> = {};
    if (wide) {
      const grid = c.createDiv({ cls: "it-task-wide-grid" });
      const mainCol = grid.createDiv({ cls: "it-task-wide-main" });
      const sideCol = grid.createDiv({ cls: "it-task-wide-side" });
      const mk = (parent: HTMLElement, k: string) => { hosts[k] = parent.createDiv({ cls: "it-host it-host-" + k }); };
      // LEFT column — big space. The wide column has room to pair some fields
      // two-up: Context|Tags on one row, Dates|Recurring on the next.
      mk(mainCol, "fields");
      const ctRow = mainCol.createDiv({ cls: "it-host-pair" });
      mk(ctRow, "context");
      mk(ctRow, "tags");
      const drRow = mainCol.createDiv({ cls: "it-host-pair" });
      mk(drRow, "dates");
      mk(drRow, "recurring");
      for (const k of ["desc", "parents", "subtasks", "checklist", "custom", "lists", "attach"]) mk(mainCol, k);
      // RIGHT rail — linked-item sections, then Comments at the bottom.
      for (const k of ["rel", "docs", "comments"]) mk(sideCol, k);
    } else {
      // Classic single column — same original order, except Context/Tags are
      // lifted to sit directly under Status/Priority (above the dates).
      for (const k of ["fields", "context", "tags", "dates", "recurring", "custom", "lists", "parents", "subtasks", "checklist", "attach", "rel", "docs", "desc", "comments"]) {
        hosts[k] = c.createDiv({ cls: "it-host it-host-" + k });
      }
    }
    const H = (key: string): HTMLElement => hosts[key];

    // ----- Fields bar -----
    const fieldsWrap = H("fields").createDiv({ cls: "it-task-fields" });
    const bar = fieldsWrap.createDiv({ cls: "it-fields-bar it-primary-fields-bar" });

    // Status chip — display-only-gated (modal_status). Hiding it here keeps the
    // status itself intact (Board columns, checkboxes, grouping still use it).
    if (features.modal_status !== false) {
      renderFieldIcon(bar, "status"); // colored field icon ahead of the status chip
      statusChip(bar, status, (e) => {
        showPopover(e.currentTarget as HTMLElement, (root) => {
          buildDropdown({
            parent: root,
            current: t.data.status ?? "",
            items: [
              ...statusSet.map((s) => ({ value: s.id, label: s.name, color: s.color })),
              { value: "", label: tr("action.noStatus"), color: "var(--text-muted)" },
            ],
            onSelect: fireAndForget(async (v) => {
              document.querySelectorAll(".it-popover").forEach((el) => el.remove());
              if (!v) {
                // Clear status → also clear status_group, otherwise the task keeps
                // a stale group (updateTask only re-derives it for a truthy status).
                await this.patch((d) => ({
                  data: { ...d, status: undefined, status_group: undefined, activity: appendActivity(d.activity, { kind: "status", from: d.status ?? null, to: null }) },
                }));
                return;
              }
              await this.applyStatusChange(v, statusSet);
            }),
            footer: [
              {
                label: tr("task.header.editStatuses"),
                onClick: () => this.openStatusEditor(),
              },
            ],
          });
        });
      }, chipStyles);
    }

    if (features.priorities !== false) renderFieldIcon(bar, "priority");
    if (features.priorities !== false) priorityChip(bar, t.data.priority, priorities, (e) => {
      showPopover(e.currentTarget as HTMLElement, (root) => {
        buildDropdown<PriorityId | null>({
          parent: root,
          current: t.data.priority,
          items: [
            ...priorities.map((p) => ({ value: p.id, label: p.label, color: p.color })),
            { value: null, label: tr("task.header.noPriority"), color: "#9E9E9E" },
          ],
          onSelect: fireAndForget(async (v, popover) => {
            popover?.remove();
            await this.patch((d) => ({
              data: { ...d, priority: v ?? null, activity: appendActivity(d.activity, { kind: "priority", from: d.priority ?? null, to: v ?? null }) },
            }));
          }),
          footer: [
            { label: tr("task.header.editPriorities"), onClick: () => new ConfigModal(this.app, this.plugin, "workspace", undefined, "priorities").open() },
          ],
        });
      });
    }, chipStyles);

    // Status + priority can both be hidden → drop the empty primary bar so it
    // leaves no blank strip above the dates.
    if (bar.childElementCount === 0) fieldsWrap.remove();

    // Dates + time metrics live in their OWN .it-task-fields block (separate
    // from Status/Priority above) so Context/Tags can sit between them.
    const datesWrap = H("dates").createDiv({ cls: "it-task-fields" });
    const datesBar = (features.start_dates !== false || features.due_dates !== false)
      ? datesWrap.createDiv({ cls: "it-task-field-row it-task-date-row" }) : null;

    if (features.start_dates !== false && datesBar) {
      const startWrap = datesBar.createDiv({ cls: "it-field-group" });
      this.renderFieldLabel(startWrap, "start_date", tr("col.start"));
      this.renderDateTimePair(startWrap, t.data.start_date, async (next) => {
        if (!(await this.confirmDateOrder(next, this.task.data.due_date ?? null))) { this.render(); return; }
        await this.patch((d) => ({
          data: { ...d, start_date: next, activity: appendActivity(d.activity, { kind: "start_date", from: d.start_date ?? null, to: next }) },
        }));
      });
    }

    if (features.due_dates !== false && datesBar) {
      const dueWrap = datesBar.createDiv({ cls: "it-field-group" });
      this.renderFieldLabel(dueWrap, "due_date", tr("col.due"));
      this.renderDateTimePair(dueWrap, t.data.due_date, async (next) => {
        if (!(await this.confirmDateOrder(this.task.data.start_date ?? null, next))) { this.render(); return; }
        await this.patch((d) => ({
          data: { ...d, due_date: next, activity: appendActivity(d.activity, { kind: "due_date", from: d.due_date ?? null, to: next }) },
        }));
      });
    }

    const metricsBar = (
      features.time_estimate !== false ||
      features.time_tracking !== false ||
      features.sprint_points !== false
    ) ? datesWrap.createDiv({ cls: "it-task-field-row it-task-metric-row" }) : null;

    // Time estimate
    if (features.time_estimate !== false && metricsBar) {
      const estWrap = metricsBar.createDiv({ cls: "it-field-group it-compact-field-group" });
      this.renderFieldLabel(estWrap, "time_estimate", tr("col.est"));
      const estEdit = estWrap.createDiv({ cls: "it-compact-number-edit" });
      const estInput = estEdit.createEl("input", { type: "number", cls: "it-input it-input-small it-compact-number-input", attr: { min: "0", step: "1", placeholder: "min" } });
      estInput.value = String(t.data.time_estimate ?? "");
      estEdit.createSpan({ cls: "it-input-suffix", text: "min" });
      estInput.addEventListener("change", fireAndForget(async () => {
        const checked = parseNonNegativeInteger(estInput.value);
        if (!checked.valid) { estInput.value = String(t.data.time_estimate ?? ""); new Notice(tr("err.taskMetricInvalid")); return; }
        await this.patch((d) => ({ data: { ...d, time_estimate: checked.value } }));
      }));
    }

    // Time tracked
    if (features.time_tracking !== false && metricsBar) {
      const trackedWrap = metricsBar.createDiv({ cls: "it-field-group it-compact-field-group" });
      this.renderFieldLabel(trackedWrap, "time_tracked", tr("col.tracked"));
      const trackedEdit = trackedWrap.createDiv({ cls: "it-compact-number-edit" });
      const trackedInput = trackedEdit.createEl("input", { type: "number", cls: "it-input it-input-small it-compact-number-input", attr: { min: "0", step: "1", placeholder: "min" } });
      trackedInput.value = String(t.data.time_tracked ?? "");
      trackedEdit.createSpan({ cls: "it-input-suffix", text: "min" });
      trackedInput.addEventListener("change", fireAndForget(async () => {
        const checked = parseNonNegativeInteger(trackedInput.value);
        if (!checked.valid) { trackedInput.value = String(t.data.time_tracked ?? ""); new Notice(tr("err.taskMetricInvalid")); return; }
        await this.patch((d) => ({ data: { ...d, time_tracked: checked.value } }));
      }));
    }

    // Sprint points
    if (features.sprint_points !== false && metricsBar) {
      const spWrap = metricsBar.createDiv({ cls: "it-field-group it-compact-field-group" });
      this.renderFieldLabel(spWrap, "sprint_points", tr("col.pts"));
      const spEdit = spWrap.createDiv({ cls: "it-compact-number-edit" });
      const spInput = spEdit.createEl("input", { type: "number", cls: "it-input it-input-small it-compact-number-input", attr: { min: "0", step: "1", placeholder: "pts" } });
      spInput.value = String(t.data.sprint_points ?? "");
      spEdit.createSpan({ cls: "it-input-suffix", text: "pts" });
      spInput.addEventListener("change", fireAndForget(async () => {
        const checked = parseNonNegativeInteger(spInput.value);
        if (!checked.valid) { spInput.value = String(t.data.sprint_points ?? ""); new Notice(tr("err.taskMetricInvalid")); return; }
        await this.patch((d) => ({ data: { ...d, sprint_points: checked.value } }));
      }));
    }

    // ----- Recurring (due-date repeat config) -----
    // Sits directly under the date/time/sprint fields so the user finds
    // recurring config right next to the due_date it affects. Recurrence
    // reschedules the due date, so it hides together with due dates.
    if (features.recurring_tasks !== false && features.due_dates !== false) {
      this.renderRecurringSection(H("recurring"));
    }

    // ----- Tags row -----
    if (features.tags !== false) {
      const tagsSection = H("tags").createDiv({ cls: "it-section" });
      const tagsHeader = tagsSection.createDiv({ cls: "it-section-title-row" });
      const tagsTitle = tagsHeader.createDiv({ cls: "it-section-title" });
      renderFieldIcon(tagsTitle, "tags");
      tagsTitle.createSpan({ text: this.flabel("tags") });
      const tagsList = tagsSection.createDiv({ cls: "it-tags-list" });
      const renderTags = () => {
        tagsList.empty();
        const palette = this.plugin.index.resolveTagsPalette({ listPath: this.task.listPath });
        const colorMap = new Map(palette.map((td) => [td.name, td.color]));
        const tags = t.data.tags || [];
        for (const tg of tags) {
          const chip = tagChip(tagsList, tg, colorMap.get(tg), undefined, chipStyles);
          const x = chip.createSpan({ text: "×", cls: "it-tag-remove" });
          x.addEventListener("click", fireAndForget(async (ev) => {
            ev.stopPropagation();
            const next = (t.data.tags || []).filter((y) => y !== tg);
            await this.patch((d) => ({ data: { ...d, tags: next } }));
            renderTags();
          }));
        }
        const addBtn = tagsList.createEl("button", { cls: "it-chip it-chip-add it-chip-add-icon", attr: { "aria-label": tr("task.tags.add"), title: tr("task.tags.add") } });
        setIcon(addBtn, "plus");
        addBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          const palette2 = this.plugin.index.resolveTagsPalette({ listPath: this.task.listPath });
          showPopover(addBtn, (root) => {
            root.addClass("it-tag-picker");
            const searchInput = root.createEl("input", {
              type: "text",
              cls: "it-tag-picker-input",
              placeholder: tr("task.tags.searchPlaceholder"),
            });
            const listEl = root.createDiv({ cls: "it-tag-picker-list" });
            const refresh = (query: string) => {
              listEl.empty();
              const current = new Set<string>(t.data.tags || []);
              const q = query.toLowerCase();
              // Include already-selected tags that aren't in the palette (e.g.
              // free-typed ones) so the user can see/untoggle them here too.
              const merged: Array<{ name: string; color?: string }> = [
                ...palette2,
                ...(t.data.tags || []).filter((nm) => !palette2.some((td) => td.name === nm)).map((nm) => ({ name: nm })),
              ];
              const filtered = merged.filter((td) => !q || td.name.toLowerCase().includes(q));
              if (filtered.length === 0 && !q) {
                listEl.createDiv({ cls: "it-tag-picker-empty", text: tr("task.tags.noPalette") });
              }
              for (const td of filtered) {
                const isOn = current.has(td.name);
                const item = listEl.createEl("button", { cls: "it-tag-picker-item" + (isOn ? " is-active" : "") });
                if (td.color) item.style.setProperty("--chip-color", td.color);
                item.createSpan({ text: "#" + td.name, cls: "it-tag-picker-name" });
                item.addEventListener("mousedown", fireAndForget(async (ev) => {
                  ev.preventDefault();
                  ev.stopPropagation();
                  const next = current.has(td.name)
                    ? (t.data.tags || []).filter((x) => x !== td.name)
                    : [...(t.data.tags || []), td.name];
                  await this.patch((d) => ({ data: { ...d, tags: next } }));
                  renderTags();
                  refresh(searchInput.value.trim());
                }));
              }
              if (q && !palette2.some((td) => td.name.toLowerCase() === q) && !(t.data.tags || []).includes(q)) {
                const addItem = listEl.createEl("button", { cls: "it-tag-picker-item it-tag-picker-add" });
                addItem.setText(tr("task.tags.addNamed", { name: query }));
                addItem.addEventListener("mousedown", fireAndForget(async (ev) => {
                  ev.preventDefault();
                  ev.stopPropagation();
                  const next = [...(t.data.tags || []), query];
                  await this.patch((d) => ({ data: { ...d, tags: next } }));
                  renderTags();
                  searchInput.value = "";
                  refresh("");
                }));
              }
            };
            searchInput.addEventListener("input", () => refresh(searchInput.value.trim()));
            searchInput.addEventListener("keydown", fireAndForget(async (ev) => {
              if (ev.key === "Enter") {
                ev.preventDefault();
                const v = searchInput.value.trim();
                if (v && !(t.data.tags || []).includes(v)) {
                  const next = [...(t.data.tags || []), v];
                  await this.patch((d) => ({ data: { ...d, tags: next } }));
                  renderTags();
                  searchInput.value = "";
                  refresh("");
                }
              }
            }));
            refresh("");
            window.requestAnimationFrame(() => searchInput.focus());
          });
        });
      };
      renderTags();
    }

    // ----- Context labels (multi) -----
    if (features.context !== false) {
      const ctxSection = H("context").createDiv({ cls: "it-section" });
      const ctxHeader = ctxSection.createDiv({ cls: "it-section-title-row" });
      const ctxTitle = ctxHeader.createDiv({ cls: "it-section-title" });
      renderFieldIcon(ctxTitle, "context");
      ctxTitle.createSpan({ text: this.flabel("context") });
      const ctxList = ctxSection.createDiv({ cls: "it-tags-list" });
      // Same UX as Tags: show ONLY the selected context labels (each removable),
      // plus a "+" icon that opens a search/pick popover. Showing the entire
      // palette inline (old behaviour) didn't scale.
      const renderContext = () => {
        ctxList.empty();
        const palette = this.plugin.index.resolveContextLabels({ listPath: this.task.listPath });
        const colorMap = new Map(palette.map((l) => [l.name, l.color]));
        const selected = t.data.context || [];
        for (const cx of selected) {
          const chip = ctxList.createEl("button", { cls: "it-chip it-chip-tag is-active" });
          const col = colorMap.get(cx);
          if (col) chip.style.setProperty("--chip-color", col);
          applyChipStyleByKind(chip, "context", chipStyles);
          chip.createSpan({ text: cx });
          const x = chip.createSpan({ text: "×", cls: "it-tag-remove" });
          x.addEventListener("click", fireAndForget(async (ev) => {
            ev.stopPropagation();
            const next = (t.data.context || []).filter((y) => y !== cx);
            await this.patch((d) => ({ data: { ...d, context: next } }));
            renderContext();
          }));
        }
        const addBtn = ctxList.createEl("button", { cls: "it-chip it-chip-add it-chip-add-icon", attr: { "aria-label": tr("task.context.add"), title: tr("task.context.add") } });
        setIcon(addBtn, "plus");
        addBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          const palette2 = this.plugin.index.resolveContextLabels({ listPath: this.task.listPath });
          showPopover(addBtn, (root) => {
            root.addClass("it-tag-picker");
            const searchInput = root.createEl("input", {
              type: "text",
              cls: "it-tag-picker-input",
              placeholder: tr("task.context.searchPlaceholder"),
            });
            const listEl = root.createDiv({ cls: "it-tag-picker-list" });
            const refresh = (query: string) => {
              listEl.empty();
              const current = new Set<string>(t.data.context || []);
              const q = query.toLowerCase();
              // Include already-selected context labels not in the palette too.
              const merged: Array<{ name: string; color?: string }> = [
                ...palette2,
                ...(t.data.context || []).filter((nm) => !palette2.some((l) => l.name === nm)).map((nm) => ({ name: nm })),
              ];
              const filtered = merged.filter((l) => !q || l.name.toLowerCase().includes(q));
              if (filtered.length === 0 && !q) {
                listEl.createDiv({ cls: "it-tag-picker-empty", text: tr("task.context.noPalette") });
              }
              for (const l of filtered) {
                const isOn = current.has(l.name);
                const item = listEl.createEl("button", { cls: "it-tag-picker-item" + (isOn ? " is-active" : "") });
                if (l.color) item.style.setProperty("--chip-color", l.color);
                item.createSpan({ text: l.name, cls: "it-tag-picker-name" });
                item.addEventListener("mousedown", fireAndForget(async (ev) => {
                  ev.preventDefault();
                  ev.stopPropagation();
                  const next = current.has(l.name)
                    ? (t.data.context || []).filter((x) => x !== l.name)
                    : [...(t.data.context || []), l.name];
                  await this.patch((d) => ({ data: { ...d, context: next } }));
                  renderContext();
                  refresh(searchInput.value.trim());
                }));
              }
              if (q && !palette2.some((l) => l.name.toLowerCase() === q) && !(t.data.context || []).includes(query)) {
                const addItem = listEl.createEl("button", { cls: "it-tag-picker-item it-tag-picker-add" });
                addItem.setText(tr("task.context.addNamed", { name: query }));
                addItem.addEventListener("mousedown", fireAndForget(async (ev) => {
                  ev.preventDefault();
                  ev.stopPropagation();
                  const next = [...(t.data.context || []), query];
                  await this.patch((d) => ({ data: { ...d, context: next } }));
                  renderContext();
                  searchInput.value = "";
                  refresh("");
                }));
              }
            };
            searchInput.addEventListener("input", () => refresh(searchInput.value.trim()));
            searchInput.addEventListener("keydown", fireAndForget(async (ev) => {
              if (ev.key === "Enter") {
                ev.preventDefault();
                const v = searchInput.value.trim();
                if (v && !(t.data.context || []).includes(v)) {
                  const next = [...(t.data.context || []), v];
                  await this.patch((d) => ({ data: { ...d, context: next } }));
                  renderContext();
                  searchInput.value = "";
                  refresh("");
                }
              }
            }));
            refresh("");
            window.requestAnimationFrame(() => searchInput.focus());
          });
        });
      };
      renderContext();
    }

    // ----- Custom fields -----
    // Display-only-gated (modal_custom_fields): the custom-field values are
    // untouched and still appear in views — only this modal section is hidden.
    if (features.modal_custom_fields !== false) {
      const cfSec = H("custom").createDiv({ cls: "it-section" });
      const cfHeader = cfSec.createDiv({ cls: "it-section-title-row" });
      cfHeader.createDiv({ cls: "it-section-title", text: tr("task.customFields.title") });
      const secretFields = customFields.filter((field) => isSecretCustomFieldType(field.type));
      if (secretFields.length > 0) {
        const secretActions = cfHeader.createDiv({ cls: "it-secret-header-actions" });
        const allVisible = secretFields.every((field) => this.isSecretFieldVisibleInModal(field.id));
        const secretsBtn = secretActions.createEl("button", {
          cls: "it-btn-ghost it-secret-all-btn",
          text: tr(allVisible ? "secret.lockAll" : "secret.unlockAll"),
        });
        setIcon(secretsBtn.createSpan({ cls: "it-secret-btn-icon" }), allVisible ? "eye-off" : "eye");
        secretsBtn.addEventListener("click", fireAndForget(async () => {
          if (secretFields.every((field) => this.isSecretFieldVisibleInModal(field.id))) {
            this.secretVisibility.hideAll(secretFields.map((field) => field.id));
            for (const field of secretFields) {
              this.editingMarkdownFieldIds.delete(field.id);
              this.secretPlaintext.delete(field.id);
            }
            this.render();
            return;
          }
          const plaintext = await this.plugin.decryptSecretFieldValuesForModal(
            secretFields.map((field) => t.data.custom_fields?.[field.id])
          );
          if (plaintext === null) return;
          let failed = false;
          for (let i = 0; i < secretFields.length; i++) {
            const value = plaintext[i];
            if (value === null) failed = true;
            else this.secretPlaintext.set(secretFields[i].id, value);
          }
          this.secretVisibility.revealAll();
          if (failed) new Notice(tr("secret.decryptFailed"));
          this.render();
        }));

        const workspaceVisible = this.plugin.isSecretWorkspaceUnlocked();
        const workspaceBtn = secretActions.createEl("button", {
          cls: "it-btn-ghost it-secret-workspace-btn",
          text: tr(workspaceVisible ? "secret.lockWorkspace" : "secret.unlockWorkspace"),
        });
        setIcon(workspaceBtn.createSpan({ cls: "it-secret-btn-icon" }), workspaceVisible ? "lock-keyhole" : "key-round");
        workspaceBtn.addEventListener("click", fireAndForget(async () => {
          if (this.plugin.isSecretWorkspaceUnlocked()) {
            this.plugin.lockSecretWorkspace();
          } else if (await this.plugin.unlockSecretWorkspace()) {
            this.secretVisibility.clearHidden();
            this.render();
          }
        }));
      }

      if (customFields.length === 0) {
        cfSec.createDiv({ cls: "it-empty-row", text: tr("task.customFields.empty") });
      } else {
        if (customFields.some((field) => field.required)) {
          cfSec.createDiv({ cls: "setting-item-description", text: tr("task.customFields.requiredHint") });
        }
        const grid = cfSec.createDiv({ cls: "it-cf-grid" });
        for (const f of customFields) {
          const row = grid.createDiv({ cls: "it-cf-row" });
          if (f.required) row.addClass("is-required");
          if (f.required && f.type !== "progress_auto" && isEmptyCustomFieldValue(t.data.custom_fields?.[f.id])) row.addClass("is-missing");
          const name = row.createDiv({ cls: "it-cf-name" });
          renderCfTypeIcon(name, f.type); // colored type icon leads the field label
          name.createSpan({ text: `${f.name}${f.required ? " *" : ""}` });
          if (f.required) name.setAttribute("title", tr("task.customFields.requiredTitle"));
          const valWrap = row.createDiv({ cls: "it-cf-val" });
          const v = t.data.custom_fields?.[f.id];
          this.renderCustomField(valWrap, f, v);
        }
      }
    }

    // ----- Lists (Multiple Lists) -----
    // Home list is the file's physical location (read-only here — use Move to
    // change it); additional lists make the task also appear in those lists.
    if (features.multiple_lists !== false) {
      const listsSec = H("lists").createDiv({ cls: "it-section" });
      const listsHead = listsSec.createDiv({ cls: "it-section-title-row" });
      listsHead.createDiv({ cls: "it-section-title", text: tr("task.lists.title") });
      const addToListBtn = listsHead.createEl("button", { cls: "it-btn-ghost", text: tr("task.lists.addToList") });
      const listsRow = listsSec.createDiv({ cls: "it-lists-row" });

      const homeList = idx.findList(t.listPath || "");
      const homeChip = listsRow.createSpan({ cls: "it-chip it-chip-home" });
      setIcon(homeChip.createSpan({ cls: "it-chip-home-ic" }), "home");
      homeChip.createSpan({ text: homeList ? homeList.config.name : (t.data.list || "—") });
      homeChip.setAttribute("title", tr("task.lists.homeTitle"));

      const additional = Array.isArray(t.data.additional_lists) ? t.data.additional_lists : [];
      for (const p of additional) {
        const ln = idx.findList(p);
        const chip = listsRow.createSpan({ cls: "it-chip it-chip-tag it-chip-list-ref" });
        const ico = renderIconish(chip, ln?.config.icon || "📋", { cls: "it-chip-list-ic" });
        if (ln?.config.color) {
          chip.style.setProperty("--chip-color", ln.config.color);
          if (ico) ico.style.color = ln.config.color;
        }
        chip.createSpan({ text: ln ? ln.config.name : p });
        const x = chip.createSpan({ text: "×", cls: "it-tag-remove" });
        x.setAttribute("aria-label", tr("task.lists.removeFromList"));
        x.addEventListener("click", fireAndForget(async (ev) => {
          ev.stopPropagation();
          new ConfirmModal(this.app, {
            title: tr("modal.deleteConfirm"),
            message: tr("action.removeFromList"),
            destructive: true,
            confirmLabel: tr("common.remove"),
            onConfirm: fireAndForget(async () => {
              try { await this.plugin.index.removeTaskFromList(t.data.id, p); }
              catch (e) { new Notice(tr("task.notice.failed", { msg: (e as Error).message })); }
            }),
          }).open();
        }));
      }
      if (additional.length === 0) listsRow.createSpan({ cls: "it-empty-inline", text: tr("task.lists.onlyHome") });

      addToListBtn.addEventListener("click", () => {
        new AddToListModal(this.app, this.plugin, {
          excludePaths: [t.listPath || "", ...additional],
          onPick: fireAndForget(async (listPath) => {
            try { await this.plugin.index.addTaskToList(t.data.id, listPath); }
            catch (e) { new Notice(tr("task.notice.failed", { msg: (e as Error).message })); }
          }),
        }).open();
      });
    }

    // ----- Parent tasks -----
    // Display-only-gated (modal_parents): parent links still work everywhere,
    // this only hides the section in the modal.
    if (features.modal_parents !== false) {
    const parentSec = H("parents").createDiv({ cls: "it-section" });
    const parentHeader = parentSec.createDiv({ cls: "it-section-title-row" });
    parentHeader.createDiv({ cls: "it-section-title", text: tr("task.parents.title") });
    const addParent = parentHeader.createEl("button", { cls: "it-btn-ghost", text: tr("task.parents.add") });
    const parentList = parentSec.createDiv({ cls: "it-subtasks-list" });
    const currentParents = parentTaskIds(t.data);
    addParent.addEventListener("click", () => {
      // Walk down the descendant tree so a task can't be made a parent of its
      // own ancestor (would form a cycle).
      const descendantIds = new Set<string>();
      const queue = [t.data.id];
      while (queue.length) {
        const cur = queue.shift()!;
        for (const x of this.plugin.index.allTasks()) {
          if (parentTaskIds(x.data).includes(cur) && !descendantIds.has(x.data.id)) {
            descendantIds.add(x.data.id);
            queue.push(x.data.id);
          }
        }
      }
      new TaskPickerModal(this.app, this.plugin, {
        title: tr("task.parents.pickerTitle"),
        multi: true,
        excludeIds: [t.data.id, ...currentParents, ...descendantIds],
        source: { id: t.data.id, title: t.data.title || tr("task.untitled"), icon: t.data.icon, color: t.data.color },
        contextLabel: tr("task.parents.pickerContext", { title: t.data.title || tr("task.untitled") }),
        confirmLabel: tr("task.picker.add"),
        onPick: fireAndForget(async (picked) => {
          const newParents = picked.filter((p) => !currentParents.includes(p));
          const next = [...currentParents, ...newParents];
          try {
            // Single write on current task: parent_task + one activity entry per new parent
            await this.plugin.index.updateTask(t.data.id, (d: TaskData) => {
              let activity = d.activity;
              for (const pid of newParents) {
                activity = appendActivity(activity, { kind: "parent_added", id: pid });
              }
              return { data: { ...d, parent_task: normalizeParentTask(next), activity } };
            });
            // Mirror activity on each new parent's side: "subtask_added"
            for (const pid of newParents) {
              await this.plugin.index.updateTask(pid, (d: TaskData) => ({
                data: { ...d, activity: appendActivity(d.activity, { kind: "subtask_added", id: t.data.id }) },
              }));
            }
          } catch (e) {
            new Notice(tr("task.notice.failed", { msg: (e as Error).message }));
          }
        }),
      }).open();
    });
    if (currentParents.length === 0) {
      parentList.createDiv({ cls: "it-empty-row", text: tr("task.parents.empty") });
    } else {
      for (const pid of currentParents) {
        const parent = this.plugin.index.tasksById.get(pid);
        const row = parentList.createDiv({ cls: "it-subtask-row" });
        this.renderLinkedTypeIcon(row, parent);
        const title = row.createSpan({
          text: parent ? (parent.data.title || tr("task.untitled")) : pid,
          cls: "it-subtask-title",
        });
        title.addEventListener("click", () => {
          if (parent) new TaskModal(this.app, this.plugin, parent).open();
        });
        const rm = row.createEl("button", {
          cls: "it-icon-btn it-icon-btn-mini it-subtask-remove",
          attr: { "aria-label": tr("task.parents.remove") },
        });
        setIcon(rm, "x");
        rm.addEventListener("click", fireAndForget(async (e) => {
          e.stopPropagation();
          const next = currentParents.filter((x) => x !== pid);
          try {
            await this.plugin.index.updateTask(t.data.id, (d: TaskData) => ({
              data: { ...d, parent_task: normalizeParentTask(next), activity: appendActivity(d.activity, { kind: "parent_removed", id: pid }) },
            }));
            await this.plugin.index.updateTask(pid, (d: TaskData) => ({
              data: { ...d, activity: appendActivity(d.activity, { kind: "subtask_removed", id: t.data.id }) },
            }));
          } catch (err) {
            new Notice(tr("task.notice.failed", { msg: (err as Error).message }));
          }
        }));
      }
    }
    } // end modal_parents gate

    // ----- Subtasks -----
    // Display-only-gated (modal_subtasks): subtask relationships are unchanged
    // (still shown in List/Table/Gantt trees) — this only hides the section here.
    if (features.modal_subtasks !== false) {
    const subSec = H("subtasks").createDiv({ cls: "it-section" });
    const subHeader = subSec.createDiv({ cls: "it-section-title-row" });
    subHeader.createDiv({ cls: "it-section-title", text: tr("task.subtasks.title") });
    const addSub = subHeader.createEl("button", { cls: "it-btn-ghost", text: tr("task.subtasks.add") });
    const subList = subSec.createDiv({ cls: "it-subtasks-list" });
    addSub.addEventListener("click", () => {
      const cur = this.task;
      const existingChildIds = this.plugin.index.allTasks()
        .filter((x) => parentTaskIds(x.data).includes(cur.data.id))
        .map((x) => x.data.id);
      // Walk up the parent DAG so a task can't be made a subtask of its
      // own descendant (would form a cycle).
      const ancestorIds = new Set<string>();
      const queue = [...parentTaskIds(cur.data)];
      while (queue.length) {
        const pid = queue.shift()!;
        if (ancestorIds.has(pid)) continue;
        ancestorIds.add(pid);
        const p = this.plugin.index.tasksById.get(pid);
        if (p) queue.push(...parentTaskIds(p.data));
      }
      new TaskPickerModal(this.app, this.plugin, {
        title: tr("task.subtasks.pickerTitle"),
        multi: true,
        excludeIds: [cur.data.id, ...existingChildIds, ...ancestorIds],
        source: { id: cur.data.id, title: cur.data.title || tr("task.untitled"), icon: cur.data.icon, color: cur.data.color },
        contextLabel: tr("task.subtasks.pickerContext", { title: cur.data.title || tr("task.untitled") }),
        confirmLabel: tr("task.picker.add"),
        // Create a brand-new task as a subtask — pre-filled with the parent's
        // list + parent_task, then the full editor opens for the rest.
        createNewLabel: tr("task.subtasks.new"),
        onCreateNew: () => {
          const features = this.plugin.index.resolveFeatures({ listPath: cur.listPath ?? undefined });
          if (!canAttachSubtask(cur.data.id, features, this.plugin.index.tasksById)) {
            new Notice(tr("err.subtaskMaxDepth"));
            return;
          }
          new QuickTaskModal(this.app, this.plugin, {
            listPath: cur.listPath ?? undefined,
            preset: { parent_task: cur.data.id },
          }).open();
        },
        onPick: fireAndForget(async (picked) => {
          const newlyLinked: string[] = [];
          for (const pid of picked) {
            try {
              let wasAdded = false;
              await this.plugin.index.updateTask(pid, (d: TaskData) => {
                const existing = parentTaskIds(d);
                if (existing.includes(cur.data.id)) return; // already a parent — no-op
                wasAdded = true;
                const next = [...existing, cur.data.id];
                return {
                  data: { ...d, parent_task: normalizeParentTask(next), activity: appendActivity(d.activity, { kind: "parent_added", id: cur.data.id }) },
                };
              });
              if (wasAdded) newlyLinked.push(pid);
            } catch (e) {
              new Notice(tr("task.notice.failedLink", { id: pid, msg: (e as Error).message }));
            }
          }
          // Log "subtask_added" on current task for each newly-linked child
          if (newlyLinked.length > 0) {
            try {
              await this.plugin.index.updateTask(cur.data.id, (d: TaskData) => {
                let activity = d.activity;
                for (const pid of newlyLinked) {
                  activity = appendActivity(activity, { kind: "subtask_added", id: pid });
                }
                return { data: { ...d, activity } };
              });
            } catch (e) {
              new Notice(tr("task.notice.failed", { msg: (e as Error).message }));
            }
          }
        }),
      }).open();
    });
    const subtasks = this.plugin.index.allTasks().filter((x) =>
      parentTaskIds(x.data).includes(t.data.id) && (x.data.archived === true) === (t.data.archived === true),
    );
    if (subtasks.length === 0) {
      subList.createDiv({ cls: "it-empty-row", text: tr("task.subtasks.empty") });
    } else {
      for (const sub of subtasks) {
        const row = subList.createDiv({ cls: "it-subtask-row" });
        const cb = row.createEl("input", { type: "checkbox" });
        cb.checked = sub.data.status_group === "done" || sub.data.status_group === "closed";
        cb.addEventListener("change", fireAndForget(async () => {
          const set = this.plugin.index.resolveStatusSet(sub.listPath).statuses;
          // Subtask checkbox has its OWN preference (task_behavior.
          // subtasks_checkbox_action) — independent of the list-row
          // checkbox setting. Resolved at the SUBTASK's location so the
          // setting follows the subtask's own list, not the parent's.
          const preference = this.plugin.index.resolveTaskBehaviorValue<CheckboxAction>(
            "subtasks_checkbox_action",
            { kind: "list", path: sub.listPath || "" },
            (v) => v === "done" || v === "closed",
            "done",
          );
          const target = cb.checked
            ? pickCheckboxCheckedStatus(set, preference)
            : pickCheckboxUncheckedStatus(set);
          if (target) await this.plugin.index.updateTask(sub.data.id, (d: TaskData) => ({
            data: { ...d, status: target, activity: appendActivity(d.activity, { kind: "status", from: d.status ?? null, to: target }) },
          }));
        }));
        this.renderLinkedTypeIcon(row, sub);
        const title = row.createSpan({ text: sub.data.title, cls: "it-subtask-title" });
        title.addEventListener("click", () => {
          new TaskModal(this.app, this.plugin, sub).open();
        });
        const rm = row.createEl("button", {
          cls: "it-icon-btn it-icon-btn-mini it-subtask-remove",
          attr: { "aria-label": tr("task.subtasks.remove") },
        });
        setIcon(rm, "x");
        rm.addEventListener("click", fireAndForget(async (e) => {
          e.stopPropagation();
          try {
            await this.plugin.index.updateTask(sub.data.id, (d: TaskData) => {
              const next = parentTaskIds(d).filter((x) => x !== t.data.id);
              return {
                data: { ...d, parent_task: normalizeParentTask(next), activity: appendActivity(d.activity, { kind: "parent_removed", id: t.data.id }) },
              };
            });
            await this.plugin.index.updateTask(t.data.id, (d: TaskData) => ({
              data: { ...d, activity: appendActivity(d.activity, { kind: "subtask_removed", id: sub.data.id }) },
            }));
          } catch (err) {
            new Notice(tr("task.notice.failed", { msg: (err as Error).message }));
          }
        }));
      }
    }
    } // end modal_subtasks gate

    // ----- Checklist -----
    if (features.checklists !== false) this.renderChecklistSection(H("checklist"));

    // ----- Attachments -----
    if (features.attachments !== false) this.renderAttachmentsSection(H("attach"));

    // ----- Relationships -----
    if (features.dependencies !== false) {
      const idx = this.plugin.index;
      const rel = H("rel").createDiv({ cls: "it-section it-section-relationships" });
      rel.createDiv({ cls: "it-section-title", text: tr("task.relationships.title") });
      this.renderRelGroup(rel, tr("task.relationships.blocks"), "blocks", getBlocks(t), tr("task.relationships.addBlocked"));
      this.renderRelGroup(rel, tr("task.relationships.waitingOn"), "waiting_on", getWaitingOn(t, idx), tr("task.relationships.addWaiting"));
      this.renderRelGroup(rel, tr("task.relationships.related"), "related", getRelated(t, idx), tr("task.relationships.addRelated"));
    }

    // ----- Documents (links to Docs) -----
    if (features.documents !== false) this.renderDocumentsSection(H("docs"));

    // ----- Description (markdown body, read/edit toggle) -----
    // In wide mode this renders into its pre-created host high in the LEFT
    // column (right under the property fields); classic keeps original order.
    if (features.description !== false) this.renderDescriptionSection(H("desc"));

    // ----- Comments (manual, editable, reorderable, MD-rendered) -----
    // Activity log moved to its own modal — see the "history" button in the
    // header actions row. In wide mode comments form the bottom of the right
    // rail (ClickUp-style); in classic mode they stay at the end of `c`.
    if (this.plugin.prefs.activityConfig.showComments && features.comments !== false) {
      this.renderCommentsSection(H("comments"));
    }

    // Footer dates
    const footer = c.createDiv({ cls: "it-task-footer" });
    if (t.data.created_at) footer.createSpan({ text: tr("task.footer.created", { date: formatDate(t.data.created_at, { withTime: true }) }) });
    if (t.data.updated_at) footer.createSpan({ text: tr("task.footer.updated", { date: formatDate(t.data.updated_at, { withTime: true }) }) });
    // Quiet purchase nudge for free-tier users (renders nothing once licensed).
    renderBuyLicenseLink(footer, { compact: true });

    // Restore the scroll position captured before c.empty(). We set both
    // synchronously and on the next frame: the sync set covers the common
    // case where scrollHeight is already up-to-date; the rAF backup covers
    // edge cases where the browser hasn't finished laying out yet.
    if (prevScroll > 0) {
      // Re-resolve in case the scroll container's identity changed across
      // the rebuild (e.g., contentEl was the scroller, now an ancestor is).
      const sc = this.getScrollContainer();
      sc.scrollTop = prevScroll;
      window.requestAnimationFrame(() => { sc.scrollTop = prevScroll; });
    }
  }

  // Renders the task-type icon (colored to match the type) before a linked
  // task's title. Used wherever we list related tasks (Parent tasks,
  // Subtasks, Blocks, Waiting on, Related) so users can scan by type.
  private renderLinkedTypeIcon(parent: HTMLElement, linked: TaskFile | undefined): void {
    if (!linked) return;
    const types = this.plugin.index.resolveTaskTypes({ listPath: linked.listPath });
    const type = types.find((tt) => tt.id === linked.data.type) || types[0];
    if (!type?.icon) return;
    const ico = renderIconish(parent, type.icon, { cls: "it-linked-type-icon" });
    if (ico && type.color) ico.style.color = type.color;
  }

  // Renders markdown into `el` using Obsidian's pipeline (embeds, internal
  // links, images, etc.). Bound to `this.comp` so child components clean
  // up when the modal closes.
  private renderMarkdownInto(el: HTMLElement, md: string): void {
    el.empty();
    if (!md.trim()) {
      el.createDiv({ cls: "it-empty-row", text: tr("task.description.empty") });
      return;
    }
    // Note: `MarkdownRenderer.render` is the modern API; sourcePath gives
    // internal links a base to resolve against. Pass our task's file path.
    void MarkdownRenderer.render(this.plugin.app, md, el, this.task.filePath, this.comp);
  }

  private descriptionBody(): string {
    return (this.task.body || "").replace(/^[ \t]*\r?\n/, "");
  }

  private renderDescriptionSection(parent: HTMLElement) {
    const sec = parent.createDiv({ cls: "it-section" });
    const head = sec.createDiv({ cls: "it-section-title-row" });
    head.createDiv({ cls: "it-section-title", text: tr("task.description.title") });
    const toggleBtn = head.createEl("button", {
      cls: "it-btn-ghost",
      text: this.descriptionEditing ? tr("common.cancel") : tr("task.description.edit"),
    });

    if (this.descriptionEditing) {
      const ta = sec.createEl("textarea", { cls: "it-task-body" });
      ta.value = this.descriptionBody();
      ta.rows = 12;
      ta.placeholder = tr("task.description.placeholder");
      const actions = sec.createDiv({ cls: "it-desc-actions" });
      const save = actions.createEl("button", { cls: "it-btn-primary", text: tr("common.save") });
      save.addEventListener("click", fireAndForget(async () => {
        const newBody = ta.value;
        this.descriptionEditing = false;
        try {
          await this.patch(() => ({ data: {} as TaskData, body: newBody }));
        } catch (e) {
          new Notice(tr("task.notice.failed", { msg: (e as Error).message }));
        }
      }));
      toggleBtn.addEventListener("click", () => {
        this.descriptionEditing = false;
        this.render();
      });
    } else {
      const view = sec.createDiv({ cls: "it-task-body-rendered markdown-rendered" });
      this.renderMarkdownInto(view, this.descriptionBody());
      toggleBtn.addEventListener("click", () => {
        this.descriptionEditing = true;
        this.render();
      });
    }
  }

  private renderCommentsSection(parent: HTMLElement) {
    const idx = this.plugin.index;
    const taskId = this.task.data.id;
    const comments: CommentEntry[] = Array.isArray(this.task.data.comments) ? this.task.data.comments : [];

    const sec = parent.createDiv({ cls: "it-section it-comments-section" });
    const head = sec.createDiv({ cls: "it-section-title-row" });
    head.createDiv({ cls: "it-section-title", text: tr("task.comments.title") });
    if (comments.length > 0) head.createSpan({ cls: "it-checklist-progress", text: String(comments.length) });

    // ---- Existing comments ----
    const listEl = sec.createDiv({ cls: "it-comments-list" });
    if (comments.length === 0) {
      listEl.createDiv({ cls: "it-empty-row", text: tr("task.comments.empty") });
    } else {
      comments.forEach((cm, i) => {
        const row = listEl.createDiv({ cls: "it-comment-row" });

        const headerRow = row.createDiv({ cls: "it-comment-header" });
        // Created + (optional) edited as TWO spans so the narrow wide-modal rail
        // can drop the "edited …" part onto its own line (CSS); inline elsewhere.
        const tsWrap = headerRow.createDiv({ cls: "it-comment-ts" });
        tsWrap.createSpan({ cls: "it-comment-ts-created", text: formatDate(cm.created_at, { withTime: true }) });
        if (cm.updated_at) {
          tsWrap.createSpan({
            cls: "it-comment-ts-edited",
            text: tr("task.comments.editedSuffix", { edited: formatDate(cm.updated_at, { withTime: true }) }),
          });
        }
        const actions = headerRow.createDiv({ cls: "it-comment-actions" });

        const isEditing = this.editingCommentId === cm.id;

        const upBtn = actions.createEl("button", { cls: "it-icon-btn it-icon-btn-mini", attr: { "aria-label": tr("task.comments.moveUp") } });
        setIcon(upBtn, "chevron-up");
        upBtn.disabled = i === 0 || isEditing;
        upBtn.addEventListener("click", fireAndForget(async () => {
          try { await moveComment(idx, taskId, cm.id, "up"); } catch (e) { new Notice(tr("task.notice.failed", { msg: (e as Error).message })); }
        }));

        const downBtn = actions.createEl("button", { cls: "it-icon-btn it-icon-btn-mini", attr: { "aria-label": tr("task.comments.moveDown") } });
        setIcon(downBtn, "chevron-down");
        downBtn.disabled = i === comments.length - 1 || isEditing;
        downBtn.addEventListener("click", fireAndForget(async () => {
          try { await moveComment(idx, taskId, cm.id, "down"); } catch (e) { new Notice(tr("task.notice.failed", { msg: (e as Error).message })); }
        }));

        const editBtn = actions.createEl("button", { cls: "it-icon-btn it-icon-btn-mini", attr: { "aria-label": isEditing ? tr("task.comments.cancelEdit") : tr("task.comments.edit") } });
        setIcon(editBtn, isEditing ? "x" : "pencil");
        editBtn.addEventListener("click", () => {
          this.editingCommentId = isEditing ? null : cm.id;
          this.render();
        });

        const rmBtn = actions.createEl("button", { cls: "it-icon-btn it-icon-btn-mini it-danger", attr: { "aria-label": tr("task.comments.delete") } });
        setIcon(rmBtn, "trash");
        rmBtn.disabled = isEditing;
        rmBtn.addEventListener("click", () => {
          new ConfirmModal(this.app, {
            title: tr("task.comments.deleteTitle"),
            message: tr("task.comments.deleteMsg"),
            destructive: true,
            onConfirm: fireAndForget(async () => {
              try { await removeComment(idx, taskId, cm.id); } catch (e) { new Notice(tr("task.notice.failed", { msg: (e as Error).message })); }
            }),
          }).open();
        });

        if (isEditing) {
          const ta = row.createEl("textarea", { cls: "it-input it-comment-input" });
          ta.value = cm.text;
          ta.rows = Math.max(3, Math.min(12, cm.text.split("\n").length + 1));
          window.setTimeout(() => ta.focus(), 0);
          const editActions = row.createDiv({ cls: "it-comment-actions" });
          const saveBtn = editActions.createEl("button", { cls: "it-btn-primary", text: tr("common.save") });
          const cancelBtn = editActions.createEl("button", { cls: "it-btn-ghost", text: tr("common.cancel") });
          const doSave = async () => {
            const newText = ta.value.trim();
            if (!newText) return;
            this.editingCommentId = null;
            try { await editComment(idx, taskId, cm.id, newText); } catch (e) { new Notice(tr("task.notice.failed", { msg: (e as Error).message })); }
          };
          saveBtn.addEventListener("click", fireAndForget(doSave));
          cancelBtn.addEventListener("click", () => {
            this.editingCommentId = null;
            this.render();
          });
          ta.addEventListener("keydown", (ev) => {
            if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter") { ev.preventDefault(); void doSave(); }
            else if (ev.key === "Escape") { ev.preventDefault(); this.editingCommentId = null; this.render(); }
          });
        } else {
          const body = row.createDiv({ cls: "it-comment-body markdown-rendered" });
          this.renderMarkdownInto(body, cm.text);
        }
      });
    }

    // ---- Add new comment form (at the BOTTOM, after the existing list) ----
    const addWrap = sec.createDiv({ cls: "it-comment-add" });
    const addArea = addWrap.createEl("textarea", { cls: "it-input it-comment-input" });
    addArea.rows = 3;
    addArea.placeholder = tr("task.comments.placeholder");
    const addActions = addWrap.createDiv({ cls: "it-comment-actions" });
    const submit = addActions.createEl("button", { cls: "it-btn-primary it-add-comment-btn", text: tr("task.comments.add") });
    const doSubmit = async () => {
      const text = addArea.value.trim();
      if (!text) return;
      try {
        await addComment(idx, taskId, text);
      } catch (e) {
        new Notice(tr("task.notice.failed", { msg: (e as Error).message }));
      }
    };
    submit.addEventListener("click", fireAndForget(doSubmit));
    addArea.addEventListener("keydown", (ev) => {
      if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter") { ev.preventDefault(); void doSubmit(); }
    });
  }

  private renderChecklistSection(parent: HTMLElement) {
    const t = this.task;
    const items: ChecklistItem[] = Array.isArray(t.data.checklist) ? t.data.checklist : [];

    const sec = parent.createDiv({ cls: "it-section" });
    const head = sec.createDiv({ cls: "it-section-title-row" });
    const titleRow = head.createDiv({ cls: "it-checklist-title-row" });
    titleRow.createDiv({ cls: "it-section-title", text: tr("task.checklist.title") });
    if (items.length > 0) {
      const done = items.filter((it) => it.done).length;
      titleRow.createSpan({ cls: "it-checklist-progress", text: tr("task.checklist.progress", { done, total: items.length }) });
    }
    const addBtn = head.createEl("button", { cls: "it-btn-ghost", text: tr("task.checklist.add") });

    const listEl = sec.createDiv({ cls: "it-checklist-list" });

    // Single helper: produce next checklist + a matching activity entry,
    // commit via this.patch (one file write, one render).
    const commit = async (next: ChecklistItem[], entry: Parameters<typeof appendActivity>[1]) => {
      try {
        await this.patch((d) => ({
          data: { ...d, checklist: next.length ? next : undefined, activity: appendActivity(d.activity, entry) },
        }));
      } catch (e) {
        new Notice(tr("task.notice.failed", { msg: (e as Error).message }));
      }
    };

    if (items.length === 0) {
      listEl.createDiv({ cls: "it-empty-row", text: tr("task.checklist.empty") });
    } else {
      for (const it of items) {
        const row = listEl.createDiv({ cls: "it-checklist-row" });
        const cb = row.createEl("input", { type: "checkbox" });
        cb.checked = it.done;
        cb.addEventListener("change", () => {
          const next = items.map((x) => (x.id === it.id ? { ...x, done: cb.checked } : x));
          void commit(next, { kind: cb.checked ? "checklist_checked" : "checklist_unchecked", id: it.id, text: it.text });
        });
        const input = row.createEl("input", { type: "text", cls: "it-checklist-text" });
        input.value = it.text;
        if (it.done) row.addClass("is-done");
        input.addEventListener("change", () => {
          const text = input.value.trim();
          if (!text) {
            void commit(items.filter((x) => x.id !== it.id), { kind: "checklist_removed", id: it.id, text: it.text });
            return;
          }
          if (text === it.text) return;
          void commit(items.map((x) => (x.id === it.id ? { ...x, text } : x)), { kind: "checklist_text_changed", id: it.id, from: it.text, to: text });
        });
        const rm = row.createEl("button", {
          cls: "it-icon-btn it-icon-btn-mini it-checklist-remove",
          attr: { "aria-label": tr("task.checklist.remove") },
        });
        setIcon(rm, "x");
        rm.addEventListener("click", () => {
          void commit(items.filter((x) => x.id !== it.id), { kind: "checklist_removed", id: it.id, text: it.text });
        });
      }
    }

    addBtn.addEventListener("click", () => {
      // Append a draft row with an empty input. Save on Enter / blur with
      // non-empty text; discard on Esc or blur-with-empty so the user can
      // back out without saving a blank item.
      const row = listEl.createDiv({ cls: "it-checklist-row it-checklist-row-edit" });
      const cb = row.createEl("input", { type: "checkbox" });
      cb.disabled = true;
      const input = row.createEl("input", {
        type: "text",
        cls: "it-checklist-text",
        attr: { placeholder: tr("task.checklist.newPlaceholder") },
      });
      let saved = false;
      const cancel = () => row.remove();
      const save = async () => {
        if (saved) return;
        const text = input.value.trim();
        if (!text) { cancel(); return; }
        saved = true;
        const item: ChecklistItem = { id: `chk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, text, done: false };
        await commit([...items, item], { kind: "checklist_added", id: item.id, text });
      };
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") { ev.preventDefault(); void save(); }
        else if (ev.key === "Escape") { ev.preventDefault(); cancel(); }
      });
      input.addEventListener("blur", () => { void save(); });
      window.setTimeout(() => input.focus(), 0);
    });
  }

  // ---------- Attachments (main module) ----------
  private bindAttachmentDrop(
    target: HTMLElement,
    onFiles: (files: FileList) => Promise<void>,
  ): void {
    const hasFiles = (ev: DragEvent) => Array.from(ev.dataTransfer?.types || []).includes("Files");
    target.addEventListener("dragenter", (ev) => {
      if (!hasFiles(ev)) return;
      ev.preventDefault();
      target.addClass("is-file-dragover");
    });
    target.addEventListener("dragover", (ev) => {
      if (!hasFiles(ev)) return;
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = "copy";
      target.addClass("is-file-dragover");
    });
    target.addEventListener("dragleave", (ev) => {
      if (ev.relatedTarget instanceof Node && target.contains(ev.relatedTarget)) return;
      target.removeClass("is-file-dragover");
    });
    target.addEventListener("drop", fireAndForget(async (ev) => {
      target.removeClass("is-file-dragover");
      if (!hasFiles(ev) || !ev.dataTransfer?.files.length) return;
      ev.preventDefault();
      ev.stopPropagation();
      try { await onFiles(ev.dataTransfer.files); }
      catch (e) { new Notice(tr("task.notice.failed", { msg: (e as Error).message })); }
    }));
  }

  private beginAttachmentRename(
    row: HTMLElement,
    link: HTMLElement,
    currentName: string,
    onRename: (name: string) => Promise<void>,
  ): void {
    if (row.querySelector(".it-attachment-rename-input")) return;
    link.hide();
    const input = row.createEl("input", {
      type: "text",
      cls: "it-input it-attachment-rename-input",
      attr: { "aria-label": tr("task.attachments.rename") },
    });
    input.value = currentName;
    row.insertBefore(input, link);
    let finished = false;
    const cancel = () => {
      if (finished) return;
      finished = true;
      input.remove();
      link.show();
    };
    const save = async () => {
      if (finished) return;
      const next = input.value.trim();
      if (!next || next === currentName) { cancel(); return; }
      finished = true;
      try { await onRename(next); }
      catch (e) {
        new Notice(tr("task.notice.failed", { msg: (e as Error).message }));
        input.remove();
        link.show();
      }
    };
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); void save(); }
      else if (ev.key === "Escape") { ev.preventDefault(); cancel(); }
    });
    input.addEventListener("blur", () => void save());
    input.focus();
    input.select();
  }

  private renderAttachmentsSection(parent: HTMLElement) {
    const t = this.task;
    const list: TaskAttachment[] = Array.isArray(t.data.attachments) ? t.data.attachments : [];

    const sec = parent.createDiv({ cls: "it-section it-attachments-section" });
    const head = sec.createDiv({ cls: "it-section-title-row" });
    head.createDiv({ cls: "it-section-title", text: tr("task.attachments.title") });
    if (list.length > 0) head.createSpan({ cls: "it-checklist-progress", text: String(list.length) });
    head.createSpan({ cls: "it-attachment-drop-hint", text: tr("task.attachments.dropHint") });
    const addBtn = head.createEl("button", { cls: "it-btn-ghost", text: tr("task.attachments.add") });

    const listEl = sec.createDiv({ cls: "it-attachments-list" });
    if (list.length === 0) {
      listEl.createDiv({ cls: "it-empty-row", text: tr("task.attachments.empty") });
    } else {
      for (const a of list) {
        const row = listEl.createDiv({ cls: "it-attachment-row" });
        const ico = row.createSpan({ cls: "it-attachment-icon" });
        setIcon(ico, "paperclip");
        const link = row.createEl("a", { cls: "it-attachment-name", text: a.name });
        link.addEventListener("click", (ev) => {
          ev.preventDefault();
          openAttachmentInDefaultApp(this.plugin.index, t.data.id, a);
        });
        row.createSpan({ cls: "it-attachment-size", text: humanFileSize(a.size) });
        if (a.mime) row.createSpan({ cls: "it-attachment-mime", text: a.mime });
        const rename = row.createEl("button", {
          cls: "it-icon-btn it-icon-btn-mini",
          attr: { "aria-label": tr("task.attachments.rename") },
        });
        setIcon(rename, "file-edit");
        rename.addEventListener("click", () => this.beginAttachmentRename(
          row,
          link,
          a.name,
          (name) => renameMainAttachment(this.plugin.index, t.data.id, a.path, name),
        ));
        const rm = row.createEl("button", {
          cls: "it-icon-btn it-icon-btn-mini it-danger",
          attr: { "aria-label": tr("common.remove") },
        });
        setIcon(rm, "trash");
        rm.addEventListener("click", () => {
          new ConfirmModal(this.app, {
            title: tr("task.attachments.removeTitle"),
            message: tr("task.attachments.removeMsg", { name: a.name }),
            destructive: true,
            onConfirm: fireAndForget(async () => {
              try { await removeMainAttachment(this.plugin.index, t.data.id, a.path); }
              catch (e) { new Notice(tr("task.notice.failed", { msg: (e as Error).message })); }
            }),
          }).open();
        });
      }
    }

    // Hidden <input type=file>, triggered by the button.
    const fileInput = sec.createEl("input", { type: "file", attr: { multiple: "true" } });
    fileInput.hide();
    addBtn.addEventListener("click", () => fileInput.click());
    this.bindAttachmentDrop(sec, (files) => addMainAttachments(this.plugin.index, t.data.id, files));
    fileInput.addEventListener("change", fireAndForget(async () => {
      if (!fileInput.files || fileInput.files.length === 0) return;
      try { await addMainAttachments(this.plugin.index, t.data.id, fileInput.files); }
      catch (e) { new Notice(tr("task.notice.failed", { msg: (e as Error).message })); }
      fileInput.value = "";
    }));
  }

  // A field label with its colored field-type icon (built-in fields), so the
  // standard fields read consistently with custom fields.
  // Custom display names for built-in fields, resolved for THIS task's list
  // (per-scope, inherited). Display-only — never affects the stored property.
  private fieldLabelOverrides(): Record<string, string> {
    return this.plugin.index.resolveFieldLabels({ listPath: this.task.listPath ?? undefined });
  }

  // Location-aware label. A custom override always wins; otherwise the caller's
  // compact label (e.g. "Start") is kept, falling back to the i18n field name.
  private flabel(key: string, compact?: string): string {
    const custom = this.fieldLabelOverrides()[key];
    return custom || compact || i18nFieldLabel(key);
  }

  private renderFieldLabel(parent: HTMLElement, key: string, label?: string): HTMLElement {
    const lbl = parent.createSpan({ cls: "it-field-label" });
    renderFieldIcon(lbl, key);
    lbl.createSpan({ text: this.flabel(key, label) });
    return lbl;
  }

  // ---------- Recurring (reschedule-only) ----------
  private renderRecurringSection(parent: HTMLElement) {
    const t = this.task;
    const r = t.data.recurring;
    const enabled = !!r?.enabled;

    const sec = parent.createDiv({ cls: "it-section it-recurring-section" });
    const head = sec.createDiv({ cls: "it-section-title-row" });
    head.createDiv({ cls: "it-section-title", text: tr("task.recurring.title") });
    const toggle = head.createEl("input", { type: "checkbox" });
    toggle.checked = enabled;
    toggle.addEventListener("change", fireAndForget(async () => {
      try {
        await this.patch((d) => {
          const cur = d.recurring ?? { enabled: false, pattern: "weekly" as const, every: 1 };
          const next: RecurringConfig = { ...cur, enabled: toggle.checked };
          return {
            data: {
              ...d,
              recurring: next,
              activity: appendActivity(d.activity, { kind: toggle.checked ? "recurring_enabled" : "recurring_disabled" }),
            },
          };
        });
      } catch (e) { new Notice(tr("task.notice.failed", { msg: (e as Error).message })); }
    }));

    if (!enabled) {
      sec.createDiv({ cls: "it-empty-row", text: tr("task.recurring.offHint") });
      return;
    }

    const cfg: RecurringConfig = r;
    const body = sec.createDiv({ cls: "it-recurring-body" });

    // ----- Pattern + interval -----
    const patternRow = body.createDiv({ cls: "it-recurring-row" });
    patternRow.createSpan({ cls: "it-field-label", text: tr("task.recurring.repeats") });
    patternRow.createSpan({ text: tr("task.recurring.every") });
    const everyInput = patternRow.createEl("input", { type: "number", cls: "it-input it-input-small", attr: { min: "1" } });
    everyInput.value = String(cfg.every ?? 1);
    const patternSel = patternRow.createEl("select", { cls: "it-input" });
    for (const p of ["daily", "weekly", "monthly", "yearly"] as const) {
      const o = patternSel.createEl("option", { value: p, text: tr(`task.recurring.pattern.${p}`) });
      if (p === cfg.pattern) o.selected = true;
    }
    const writePattern = async () => {
      const every = Math.max(1, parseInt(everyInput.value, 10) || 1);
      const pattern = patternSel.value as RecurringConfig["pattern"];
      await this.patch((d) => {
        const cur = d.recurring ?? { enabled: true, pattern: "weekly" as const };
        return { data: { ...d, recurring: { ...cur, pattern, every } } };
      });
    };
    everyInput.addEventListener("change", fireAndForget(writePattern));
    patternSel.addEventListener("change", fireAndForget(writePattern));

    // ----- Weekly: days of week -----
    if (cfg.pattern === "weekly") {
      const daysRow = body.createDiv({ cls: "it-recurring-row" });
      daysRow.createSpan({ cls: "it-field-label", text: tr("task.recurring.on") });
      const days = (cfg.on ?? []).map((s) => s.toLowerCase());
      const dowIds = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
      for (let di = 0; di < dowIds.length; di++) {
        const d = dowIds[di];
        const chip = daysRow.createEl("button", { cls: "it-chip it-chip-tag" + (days.includes(d) ? " is-active" : ""), text: weekdayMin(di) });
        chip.addEventListener("click", fireAndForget(async () => {
          const next = days.includes(d) ? days.filter((x) => x !== d) : [...days, d];
          await this.patch((dd) => {
            const cur = dd.recurring ?? { enabled: true, pattern: "weekly" as const };
            return { data: { ...dd, recurring: { ...cur, on: next } } };
          });
        }));
      }
    }

    // ----- Monthly / yearly: day of month -----
    // Yearly needs it for the same reason monthly does: a 29 February series
    // must come back to the 29th on the next leap year rather than settle on
    // the 28th.
    if (cfg.pattern === "monthly" || cfg.pattern === "yearly") {
      const domRow = body.createDiv({ cls: "it-recurring-row" });
      domRow.createSpan({ cls: "it-field-label", text: tr("task.recurring.dayOfMonth") });
      const domInput = domRow.createEl("input", { type: "number", cls: "it-input it-input-small", attr: { min: "1", max: "31" } });
      domInput.value = String(cfg.day_of_month ?? "");
      // Left blank, the day is taken from the Item's due date and then kept for
      // the rest of the series. Showing that day as the placeholder means the
      // field states what will actually happen instead of looking unset.
      const anchorDay = Number(String(t.data.due_date ?? "").slice(8, 10));
      domInput.placeholder = Number.isFinite(anchorDay) && anchorDay >= 1 && anchorDay <= 31
        ? String(anchorDay)
        : tr("task.recurring.dayOfMonthPlaceholder");
      domInput.addEventListener("change", fireAndForget(async () => {
        const n = parseInt(domInput.value, 10);
        const dom = Number.isFinite(n) ? Math.max(1, Math.min(31, n)) : undefined;
        await this.patch((d) => {
          const cur = d.recurring ?? { enabled: true, pattern: cfg.pattern };
          return { data: { ...d, recurring: { ...cur, day_of_month: dom } } };
        });
      }));
    }

    // ----- End condition -----
    const endRow = body.createDiv({ cls: "it-recurring-row" });
    endRow.createSpan({ cls: "it-field-label", text: tr("task.recurring.ends") });
    const endSel = endRow.createEl("select", { cls: "it-input" });
    for (const opt of [
      { v: "never", l: "task.recurring.end.never" },
      { v: "date", l: "task.recurring.end.onDate" },
      { v: "after_n_occurrences", l: "task.recurring.end.afterN" },
    ]) {
      const o = endSel.createEl("option", { value: opt.v, text: tr(opt.l) });
      if ((cfg.end?.type ?? "never") === opt.v) o.selected = true;
    }
    const endDateInput = endRow.createEl("input", { type: "date", cls: "it-input" });
    endDateInput.value = cfg.end?.date ?? "";
    endDateInput.style.display = cfg.end?.type === "date" ? "" : "none";
    const endCountInput = endRow.createEl("input", { type: "number", cls: "it-input it-input-small", attr: { min: "1" } });
    endCountInput.value = String(cfg.end?.count ?? "");
    endCountInput.placeholder = tr("task.recurring.endCountPlaceholder");
    endCountInput.style.display = cfg.end?.type === "after_n_occurrences" ? "" : "none";
    const writeEnd = async () => {
      const type = endSel.value as "never" | "date" | "after_n_occurrences";
      let end: RecurringConfig["end"];
      if (type === "never") end = { type };
      else if (type === "date") end = { type, date: endDateInput.value || undefined };
      else end = { type, count: parseInt(endCountInput.value, 10) || undefined };
      await this.patch((d) => {
        const cur = d.recurring ?? { enabled: true, pattern: "weekly" as const };
        return { data: { ...d, recurring: { ...cur, end } } };
      });
    };
    endSel.addEventListener("change", fireAndForget(writeEnd));
    endDateInput.addEventListener("change", fireAndForget(writeEnd));
    endCountInput.addEventListener("change", fireAndForget(writeEnd));

    // ----- Status info -----
    if ((cfg.occurrences_passed ?? 0) > 0) {
      body.createDiv({ cls: "it-empty-row", text: tr("task.recurring.pastOccurrences", { count: cfg.occurrences_passed ?? 0 }) });
    }
  }

  // Inspect open items (checklist, subtasks, waiting-on) and return a list
  // of human-readable lines for the close-confirmation prompt. Empty array
  /**
   * A start date later than the due date is almost always a slip, but it is a
   * legitimate thing to park while planning — so this warns and lets the user
   * decide rather than refusing the edit. Resolves true to keep the value,
   * false to discard it (the caller re-renders, restoring the stored dates).
   * Anything else — either date missing, or the order already sane — passes
   * straight through without a prompt.
   */
  private confirmDateOrder(start: string | null, due: string | null): Promise<boolean> {
    if (!start || !due) return Promise.resolve(true);
    const startKey = dayKey(start);
    const dueKey = dayKey(due);
    if (!startKey || !dueKey || startKey <= dueKey) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let decided = false;
      const modal = new ConfirmModal(this.app, {
        title: tr("task.confirm.dateOrder.title"),
        message: tr("task.confirm.dateOrder.message", {
          start: formatDate(start, { withTime: false }),
          due: formatDate(due, { withTime: false }),
        }),
        confirmLabel: tr("task.confirm.dateOrder.keep"),
        onConfirm: () => { decided = true; resolve(true); },
      });
      const close = modal.onClose.bind(modal);
      // Dismissing the dialog is a refusal, not a silent accept.
      modal.onClose = () => { close(); if (!decided) resolve(false); };
      modal.open();
    });
  }

  // means "nothing pending — close without prompt".
  private collectOpenItems(): string[] {
    const lines: string[] = [];
    const t = this.task;
    const features = this.plugin.index.resolveFeatures({ listPath: t.listPath });
    const items: ChecklistItem[] = Array.isArray(t.data.checklist) ? t.data.checklist : [];
    if (features.incomplete_warning !== false) {
      const openChk = items.filter((it) => !it.done).length;
      if (openChk > 0) {
        lines.push(openChk === 1
          ? tr("task.confirm.openItems.checklistOne", { count: openChk })
          : tr("task.confirm.openItems.checklist", { count: openChk }));
      }
    }

    const isClosedTask = (tf: TaskFile) =>
      tf.data.status_group === "done" || tf.data.status_group === "closed";

    if (features.incomplete_warning !== false) {
      const subs = this.plugin.index.allTasks().filter((x) =>
        parentTaskIds(x.data).includes(t.data.id) && (x.data.archived === true) === (t.data.archived === true),
      );
      const openSubs = subs.filter((s) => !isClosedTask(s)).length;
      if (openSubs > 0) {
        lines.push(openSubs === 1
          ? tr("task.confirm.openItems.subtasksOne", { count: openSubs })
          : tr("task.confirm.openItems.subtasks", { count: openSubs }));
      }
    }

    if (features.dependency_warning !== false) {
      const waitingIds = getWaitingOn(t, this.plugin.index);
      const openWaiting = waitingIds
        .map((id) => this.plugin.index.tasksById.get(id))
        .filter((x): x is TaskFile => !!x && !isClosedTask(x)).length;
      if (openWaiting > 0) {
        lines.push(openWaiting === 1
          ? tr("task.confirm.openItems.blockersOne", { count: openWaiting })
          : tr("task.confirm.openItems.blockers", { count: openWaiting }));
      }
    }

    return lines;
  }

  // Wraps a status change so that closing the task while open items remain
  // shows a non-blocking confirmation (user can still close anyway).
  //
  // Recurring tasks: the actual reschedule-instead-of-close (bump due_date,
  // reset to the default status, log the move) is applied CENTRALLY by
  // WorkspaceIndex.updateTask for every status-change surface (modal, list
  // chip, board drag, table edit) — here we only pick the matching confirm
  // copy so the user knows the close will reschedule.
  private async applyStatusChange(newStatusId: string, statusSet: StatusDef[]) {
    const so = statusSet.find((s) => s.id === newStatusId);
    const closing = so?.group === "done" || so?.group === "closed";
    const shouldReschedule = closing && this.task.data.recurring?.enabled;

    const writeStatus = () => this.patch((d) => ({
      data: { ...d, status: newStatusId, activity: appendActivity(d.activity, { kind: "status", from: d.status ?? null, to: newStatusId }) },
    }));

    if (!closing) {
      await writeStatus();
      return;
    }
    const open = this.collectOpenItems();
    if (open.length === 0) {
      await writeStatus();
      return;
    }
    const itemsList = open.join("\n• ");
    new ConfirmModal(this.app, {
      title: shouldReschedule ? tr("task.confirm.rescheduleTitle") : tr("task.confirm.closeWithOpenTitle"),
      message: shouldReschedule
        ? tr("task.confirm.rescheduleMsg", { items: itemsList })
        : tr("task.confirm.closeWithOpenMsg", { items: itemsList }),
      confirmLabel: shouldReschedule ? tr("task.confirm.reschedule") : tr("task.confirm.closeAnyway"),
      onConfirm: fireAndForget(writeStatus),
    }).open();
  }

  private renderRelGroup(
    parent: HTMLElement,
    label: string,
    key: "blocks" | "waiting_on" | "related",
    ids: string[],
    addLabel: string,
  ) {
    const wrap = parent.createDiv({ cls: "it-rel-group" });
    // Hint describes how this relationship appears from the partner's side.
    // Blocks / Waiting on are inverses of each other; Related is symmetric.
    const mirrorKey = key === "blocks" ? "task.relationships.mirrorBlocks" : key === "waiting_on" ? "task.relationships.mirrorWaiting" : "task.relationships.mirrorRelated";
    const head = wrap.createDiv({ cls: "it-rel-header" });
    const labelWrap = head.createDiv({ cls: "it-rel-label" });
    labelWrap.createDiv({ cls: "it-rel-title", text: label });
    labelWrap.createDiv({ cls: "it-rel-mirror-hint", text: tr(mirrorKey) });

    const idx = this.plugin.index;
    const currentId = this.task.data.id;

    const addOne = async (partnerId: string) => {
      try {
        if (key === "blocks") await addBlock(idx, currentId, partnerId);
        else if (key === "waiting_on") await addWaitingOn(idx, currentId, partnerId);
        else await addRelated(idx, currentId, partnerId);
      } catch (e) {
        new Notice(tr("task.notice.failed", { msg: (e as Error).message }));
      }
    };
    const removeOne = async (partnerId: string) => {
      try {
        if (key === "blocks") await removeBlock(idx, currentId, partnerId);
        else if (key === "waiting_on") await removeWaitingOn(idx, currentId, partnerId);
        else await removeRelated(idx, currentId, partnerId);
      } catch (e) {
        new Notice(tr("task.notice.failed", { msg: (e as Error).message }));
      }
    };

    const inverseLabel = key === "blocks" ? tr("task.relationships.waitingOn") : key === "waiting_on" ? tr("task.relationships.blocks") : tr("task.relationships.related");

    // Add button lives in the header so it aligns right, like "+ Add subtask".
    const add = head.createEl("button", { cls: "it-btn-ghost it-rel-add", text: addLabel });
    add.addEventListener("click", () => {
      const t = this.task;
      new TaskPickerModal(this.app, this.plugin, {
        title: tr("task.relationships.linkPickerTitle", { label }),
        multi: true,
        excludeIds: [t.data.id, ...ids],
        source: { id: t.data.id, title: t.data.title || tr("task.untitled"), icon: t.data.icon, color: t.data.color },
        contextLabel: tr("task.relationships.linkContext", { label, inverse: inverseLabel }),
        confirmLabel: tr("task.picker.link"),
        onPick: fireAndForget(async (picked) => {
          for (const pid of picked) await addOne(pid);
        }),
      }).open();
    });

    const items = wrap.createDiv({ cls: "it-rel-items" });
    if (ids.length === 0) items.createSpan({ cls: "it-empty-inline", text: tr("task.relationships.none") });

    for (const id of ids) {
      const linked = this.plugin.index.tasksById.get(id);
      const displayTitle = linked ? (linked.data.title || tr("task.untitled")) : id;
      const chip = items.createEl("button", { cls: "it-chip it-chip-link" });
      chip.setAttribute("title", linked ? `${displayTitle} (${id})` : id);
      this.renderLinkedTypeIcon(chip, linked);
      chip.createSpan({ cls: "it-chip-link-title", text: displayTitle });
      if (linked) {
        chip.addEventListener("click", () => { this.close(); new TaskModal(this.app, this.plugin, linked).open(); });
      }
      const x = chip.createSpan({ text: "×", cls: "it-tag-remove" });
      x.addEventListener("click", (e) => {
        e.stopPropagation();
        new ConfirmModal(this.app, {
          title: tr("modal.deleteConfirm"),
          message: label,
          destructive: true,
          confirmLabel: tr("common.remove"),
          onConfirm: () => void removeOne(id),
        }).open();
      });
    }
  }

  // Built-in "Documents" field — links from this task to Docs (a plain id list
  // on the task; no inverse/mirroring). Sits under Relationships.
  private renderDocumentsSection(c: HTMLElement) {
    const t = this.task;
    const ids: string[] = Array.isArray(t.data.documents) ? t.data.documents : [];
    const sec = c.createDiv({ cls: "it-section it-section-documents" });
    const head = sec.createDiv({ cls: "it-section-title-row" });
    const titleWrap = head.createDiv({ cls: "it-section-title" });
    renderFieldIcon(titleWrap, "documents");
    titleWrap.createSpan({ text: " " + this.flabel("documents") });
    const add = head.createEl("button", { cls: "it-btn-ghost", text: tr("task.documents.add") });
    add.addEventListener("click", () => {
      new DocPickerModal(this.app, this.plugin, {
        title: tr("task.documents.pickerTitle"),
        multi: true,
        excludeIds: ids,
        source: { title: t.data.title || tr("task.untitled"), icon: t.data.icon, color: t.data.color },
        contextLabel: tr("task.documents.pickerContext"),
        confirmLabel: tr("task.picker.link"),
        onPick: fireAndForget(async (picked) => {
          await this.plugin.index.updateTask(t.data.id, (d: TaskData) => {
            const cur = Array.isArray(d.documents) ? d.documents : [];
            const next = [...cur];
            for (const id of picked) if (!next.includes(id)) next.push(id);
            return { data: { ...d, documents: next } };
          });
        }),
      }).open();
    });
    const list = sec.createDiv({ cls: "it-subtasks-list" });
    if (ids.length === 0) {
      list.createDiv({ cls: "it-empty-row", text: tr("task.documents.empty") });
      return;
    }
    for (const id of ids) {
      const doc = this.plugin.index.docById(id);
      const row = list.createDiv({ cls: "it-subtask-row" });
      const ico = renderIconish(row, doc?.icon || DOC_ICON, { cls: "it-linked-type-icon" });
      if (ico) ico.style.color = doc?.color || DOC_ACCENT;
      const title = row.createSpan({ text: doc ? doc.name : id, cls: "it-subtask-title" });
      if (doc) title.addEventListener("click", () => this.openLinkedDoc(doc));
      const rm = row.createEl("button", { cls: "it-icon-btn it-icon-btn-mini it-subtask-remove", attr: { "aria-label": tr("task.documents.remove") } });
      setIcon(rm, "x");
      rm.addEventListener("click", fireAndForget(async (e) => {
        e.stopPropagation();
        await this.plugin.index.updateTask(t.data.id, (d: TaskData) => {
          const cur: string[] = Array.isArray(d.documents) ? d.documents : [];
          const next = cur.filter((x) => x !== id);
          return { data: { ...d, documents: next.length ? next : undefined } };
        });
      }));
    }
  }

  // Open a linked Doc in the main view (closing this modal first).
  private openLinkedDoc(doc: DocMeta) {
    if (!doc.__path) return;
    const taskId = this.task.data.id;
    this.close();
    const mv = this.plugin.getMainView();
    if (mv) mv.openDocLocation(doc.__path, undefined, taskId);
    else void this.plugin.activateView().then(() => this.plugin.getMainView()?.openDocLocation(doc.__path!, undefined, taskId));
  }

  private renderCustomField(parent: HTMLElement, f: CustomFieldDef, value: unknown) {
    const setValue = async (v: unknown) => {
      const isEmpty = isEmptyCustomFieldValue(v);
      if (f.required && isEmpty) {
        new Notice(tr("task.notice.requiredField", { name: f.name }));
        this.render();
        return;
      }
      let stored = v;
      if (isSecretCustomFieldType(f.type)) {
        if (isEmpty) {
          if (!(await this.plugin.authorizeSecretFieldChange())) return;
          this.secretPlaintext.delete(f.id);
        } else {
          try {
            stored = await this.plugin.encryptSecretFieldValue(String(v));
            if (!stored) return;
            this.secretPlaintext.set(f.id, String(v));
          } catch (e) {
            new Notice(tr("task.notice.failed", { msg: (e as Error | undefined)?.message || String(e) }));
            return;
          }
        }
      }
      await this.patch((d) => {
        const cf = { ...(d.custom_fields || {}) };
        if (isEmpty) delete cf[f.id];
        else cf[f.id] = stored;
        return { data: { ...d, custom_fields: cf } };
      });
    };
    switch (f.type) {
      case "text": {
        const i = parent.createEl("input", { type: "text", cls: "it-input" });
        i.value = (value as string | undefined) ?? "";
        i.addEventListener("change", () => void setValue(i.value));
        break;
      }
      case "textarea": {
        const ta = parent.createEl("textarea", { cls: "it-input" });
        ta.value = (value as string | undefined) ?? "";
        ta.rows = 3;
        ta.addEventListener("change", () => void setValue(ta.value));
        break;
      }
      case "markdown": {
        this.renderMarkdownCustomField(parent, f, String((value as string | undefined) ?? ""), setValue, false);
        break;
      }
      case "secret_text":
      case "secret_textarea":
      case "secret_markdown": {
        this.renderSecretCustomField(parent, f, value, setValue);
        break;
      }
      case "url":
      case "email":
      case "phone": {
        // Linked types are edited in a dedicated modal (label + value). The
        // task-modal row only displays the rendered link plus edit/× actions.
        const cur: LinkedValue | null = (value && typeof value === "object" && "value" in value)
          ? { label: (value as LinkedValue).label, value: (value as LinkedValue).value }
          : (typeof value === "string" && value ? { value } : null);
        const wrap = parent.createDiv({ cls: "it-cf-linked-display" });
        const kind = f.type;
        if (cur) {
          // Reuse the shared cf-render output so the display matches what
          // the list/board/calendar/table views show — single source.
          renderCustomFieldValue(wrap, f, cur, { task: this.task, index: this.plugin.index, mode: "list" });
          const edit = wrap.createEl("button", {
            cls: "it-icon-btn it-icon-btn-mini it-cf-linked-edit-btn",
            attr: { "aria-label": tr("task.comments.edit") },
          });
          setIcon(edit, "pencil");
          edit.addEventListener("click", () => {
            new LinkedValueModal(this.app, {
              kind, fieldName: f.name, current: cur,
              onSave: (next) => void setValue(next),
            }).open();
          });
          const rm = wrap.createEl("button", {
            cls: "it-icon-btn it-icon-btn-mini it-danger it-cf-linked-remove-btn",
            attr: { "aria-label": tr("common.remove") },
          });
          setIcon(rm, "x");
          rm.addEventListener("click", () => {
            new ConfirmModal(this.app, {
              title: tr("modal.deleteConfirm"),
              message: f.name,
              destructive: true,
              confirmLabel: tr("common.remove"),
              onConfirm: () => void setValue(null),
            }).open();
          });
        } else {
          const add = wrap.createEl("button", { cls: "it-btn-ghost", text: tr("task.customFields.addNamed", { name: f.name }) });
          add.addEventListener("click", () => {
            new LinkedValueModal(this.app, {
              kind, fieldName: f.name,
              onSave: (next) => void setValue(next),
            }).open();
          });
        }
        break;
      }
      case "location": {
        // Location uses a dedicated modal with label (address text), URL (map
        // link) and optional coordinates (lat/lng) fields.
        const curLoc = (() => {
          if (!value) return undefined;
          if (typeof value === "object" && ("url" in value || "lat" in value || "lng" in value || "label" in value)) {
            return value as import("../types").LocationValue;
          }
          // Legacy LinkedValue fallback
          if (typeof value === "object" && typeof (value as LinkedValue).value === "string") {
            const legacy = value as LinkedValue;
            const v: string = legacy.value;
            if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return { label: legacy.label, url: v };
            return { label: legacy.label || v };
          }
          if (typeof value === "string" && value) return { label: value };
          return undefined;
        })();
        const wrapLoc = parent.createDiv({ cls: "it-cf-linked-display" });
        if (curLoc) {
          renderCustomFieldValue(wrapLoc, f, curLoc, { task: this.task, index: this.plugin.index, mode: "list" });
          const edit = wrapLoc.createEl("button", {
            cls: "it-icon-btn it-icon-btn-mini it-cf-linked-edit-btn",
            attr: { "aria-label": tr("task.comments.edit") },
          });
          setIcon(edit, "pencil");
          edit.addEventListener("click", () => {
            new LocationModal(this.app, {
              fieldName: f.name, current: curLoc,
              onSave: (next) => void setValue(next),
            }).open();
          });
          const rm = wrapLoc.createEl("button", {
            cls: "it-icon-btn it-icon-btn-mini it-danger it-cf-linked-remove-btn",
            attr: { "aria-label": tr("common.remove") },
          });
          setIcon(rm, "x");
          rm.addEventListener("click", () => {
            new ConfirmModal(this.app, {
              title: tr("modal.deleteConfirm"),
              message: f.name,
              destructive: true,
              confirmLabel: tr("common.remove"),
              onConfirm: () => void setValue(null),
            }).open();
          });
        } else {
          const add = wrapLoc.createEl("button", { cls: "it-btn-ghost", text: tr("task.customFields.addNamed", { name: f.name }) });
          add.addEventListener("click", () => {
            new LocationModal(this.app, {
              fieldName: f.name,
              onSave: (next) => void setValue(next),
            }).open();
          });
        }
        break;
      }
      case "number": {
        const i = parent.createEl("input", { type: "number", cls: "it-input" });
        i.value = (value as string | undefined) ?? "";
        i.addEventListener("change", () => {
          const n = parseFloat(i.value);
          void setValue(isNaN(n) ? null : n);
        });
        break;
      }
      case "money": {
        const wrap = parent.createDiv({ cls: "it-cf-money-edit" });
        const i = wrap.createEl("input", { type: "number", cls: "it-input" });
        i.value = (value as string | undefined) ?? "";
        wrap.createSpan({ text: " " + (f.currency || "PLN"), cls: "it-input-suffix" });
        i.addEventListener("change", () => {
          const n = parseFloat(i.value);
          void setValue(isNaN(n) ? null : n);
        });
        break;
      }
      case "date": {
        renderDateTimeInput({
          parent,
          kind: "date",
          value,
          onCommit: (next) => void setValue(next),
          singleClass: "it-input",
        });
        break;
      }
      case "datetime": {
        this.renderDateTimePair(parent, value, (next) => setValue(next));
        break;
      }
      case "time": {
        renderDateTimeInput({
          parent,
          kind: "time",
          value,
          onCommit: (next) => void setValue(next),
          singleClass: "it-input it-inline-kind-time",
        });
        break;
      }
      case "checkbox": {
        const i = parent.createEl("input", { type: "checkbox" });
        i.checked = !!value;
        i.addEventListener("change", () => void setValue(i.checked));
        break;
      }
      case "dropdown": {
        // Render as a colored chip + popover dropdown so option colors are
        // visible (the native <select> ignores all styling). Empty state
        // shows a neutral "—" chip the user can click to pick a value.
        const opts: CustomFieldOption[] = f.options || [];
        const cfStyles = this.plugin.index.resolveChipStyles({ listPath: this.task.listPath });
        const currentOpt = opts.find((o) => (o.value ?? o.label) === value);
        const chip = parent.createEl("button", { cls: "it-chip it-chip-tag", text: currentOpt?.label || tr("task.customFields.pickValue") });
        chip.style.setProperty("--chip-color", currentOpt?.color || "#9E9E9E");
        applyChipStyleByKind(chip, "custom_field", cfStyles);
        chip.addEventListener("click", (e) => {
          showPopover(e.currentTarget as HTMLElement, (root) => {
            buildDropdown<string | null>({
              parent: root,
              current: value as string | null | undefined,
              items: [
                ...opts.map((o) => ({ value: o.value ?? o.label, label: o.label, color: o.color })),
                { value: null, label: tr("task.customFields.noneOption"), color: "#9E9E9E" },
              ],
              onSelect: (v) => {
                void setValue(v ?? null);
                document.querySelectorAll(".it-popover").forEach((el) => el.remove());
              },
            });
          });
        });
        break;
      }
      case "labels": {
        const cur: string[] = Array.isArray(value) ? (value as string[]) : (value ? [value as string] : []);
        const wrap = parent.createDiv({ cls: "it-labels-multi" });
        const cfStyles = this.plugin.index.resolveChipStyles({ listPath: this.task.listPath });
        for (const opt of f.options || []) {
          const id = opt.value ?? opt.label;
          const isActive = cur.includes(id);
          const chip = wrap.createEl("button", { cls: "it-chip it-chip-tag", text: opt.label });
          if (opt.color) chip.style.setProperty("--chip-color", opt.color);
          if (isActive) chip.addClass("is-active");
          applyChipStyleByKind(chip, "custom_field", cfStyles);
          chip.addEventListener("click", () => {
            const idx = cur.indexOf(id);
            if (idx >= 0) cur.splice(idx, 1); else cur.push(id);
            void setValue(cur.slice());
            chip.toggleClass("is-active", cur.includes(id));
          });
        }
        break;
      }
      case "rating": {
        const max = f.scale || 5;
        const stars = parent.createDiv({ cls: "it-rating" });
        for (let i = 1; i <= max; i++) {
          const s = stars.createEl("button", { cls: "it-rating-star", text: i <= ((value as number | undefined) || 0) ? (f.icon || "★") : (f.icon ? "" : "☆") });
          if (f.icon) s.setText(i <= ((value as number | undefined) || 0) ? f.icon : "·");
          s.addEventListener("click", () => void setValue(i === value ? null : i));
        }
        break;
      }
      case "progress_manual": {
        const v = typeof value === "number" ? value : 0;
        const wrap = parent.createDiv({ cls: "it-progress" });
        const bar = wrap.createDiv({ cls: "it-progress-bar" });
        bar.style.width = `${Math.min(100, Math.max(0, v))}%`;
        const lbl = wrap.createSpan({ text: `${v}%`, cls: "it-progress-label" });
        const inp = parent.createEl("input", { type: "range", attr: { min: "0", max: "100", value: String(v) } });
        inp.addEventListener("input", () => {
          const n = parseInt(inp.value, 10);
          bar.style.width = `${n}%`;
          lbl.setText(`${n}%`);
        });
        inp.addEventListener("change", () => void setValue(parseInt(inp.value, 10)));
        break;
      }
      case "progress_auto": {
        // Read-only — computed live from subtasks or checklist per config.
        const src = f.progress_source || "subtasks";
        const allTasks = this.task.data.archived ? this.plugin.index.archivedTasks() : this.plugin.index.normalTasks();
        const p = Math.round(computeAutoProgress(this.task, f, { allTasks }));
        const wrap = parent.createDiv({ cls: "it-progress" });
        const bar = wrap.createDiv({ cls: "it-progress-bar" });
        bar.style.width = `${p}%`;
        wrap.createSpan({ text: tr("task.customFields.progressAuto", { percent: p, source: src }), cls: "it-progress-label" });
        break;
      }
      case "relationship": {
        const ids: string[] = Array.isArray(value) ? (value as unknown[]).filter((x): x is string => typeof x === "string") : [];
        const wrap = parent.createDiv({ cls: "it-rel-group it-cf-tasks" });
        const items = wrap.createDiv({ cls: "it-rel-items" });
        if (ids.length === 0) items.createSpan({ cls: "it-empty-inline", text: tr("task.relationships.none") });
        for (const id of ids) {
          const linked = this.plugin.index.tasksById.get(id);
          const displayTitle = linked ? (linked.data.title || tr("task.untitled")) : id;
          const chip = items.createEl("button", { cls: "it-chip it-chip-link" });
          chip.setAttribute("title", linked ? `${displayTitle} (${id})` : id);
          chip.createSpan({ cls: "it-chip-link-title", text: displayTitle });
          if (linked) {
            chip.addEventListener("click", () => { this.close(); new TaskModal(this.app, this.plugin, linked).open(); });
          }
          const x = chip.createSpan({ text: "×", cls: "it-tag-remove" });
          x.addEventListener("click", (ev) => {
            ev.stopPropagation();
            void setValue(ids.filter((i) => i !== id));
          });
        }
        // Action sits in its own row so chips never touch the add button —
        // visually separates "what's linked" from "link something new".
        const actions = wrap.createDiv({ cls: "it-cf-tasks-actions" });
        const add = actions.createEl("button", { cls: "it-btn-ghost", text: tr("task.customFields.linkTask") });
        add.addEventListener("click", () => {
          new TaskPickerModal(this.app, this.plugin, {
            title: tr("task.customFields.linkPickerTitle", { name: f.name || f.id }),
            multi: true,
            excludeIds: [this.task.data.id, ...ids],
            source: {
              id: this.task.data.id,
              title: this.task.data.title || tr("task.untitled"),
              icon: this.task.data.icon,
              color: this.task.data.color,
            },
            contextLabel: tr("task.customFields.fieldContext", { name: f.name || f.id }),
            confirmLabel: tr("task.picker.link"),
            onPick: (picked) => void setValue([...ids, ...picked]),
          }).open();
        });
        break;
      }
      case "doc_relationship": {
        const ids: string[] = Array.isArray(value) ? (value as unknown[]).filter((x): x is string => typeof x === "string") : [];
        const wrap = parent.createDiv({ cls: "it-rel-group it-cf-tasks" });
        const items = wrap.createDiv({ cls: "it-rel-items" });
        if (ids.length === 0) items.createSpan({ cls: "it-empty-inline", text: tr("task.relationships.none") });
        for (const id of ids) {
          const doc = this.plugin.index.docById(id);
          const displayTitle = doc ? doc.name : id;
          const chip = items.createEl("button", { cls: "it-chip it-chip-link" });
          chip.setAttribute("title", displayTitle);
          const ic = renderIconish(chip, doc?.icon || DOC_ICON, { cls: "it-linked-type-icon" });
          if (ic) ic.style.color = doc?.color || DOC_ACCENT;
          chip.createSpan({ cls: "it-chip-link-title", text: displayTitle });
          if (doc) chip.addEventListener("click", () => this.openLinkedDoc(doc));
          const x = chip.createSpan({ text: "×", cls: "it-tag-remove" });
          x.addEventListener("click", (ev) => { ev.stopPropagation(); void setValue(ids.filter((i) => i !== id)); });
        }
        const actions = wrap.createDiv({ cls: "it-cf-tasks-actions" });
        const add = actions.createEl("button", { cls: "it-btn-ghost", text: tr("task.customFields.linkDoc") });
        add.addEventListener("click", () => {
          new DocPickerModal(this.app, this.plugin, {
            title: tr("task.customFields.docPickerTitle", { name: f.name || f.id }),
            multi: true,
            excludeIds: ids,
            source: { title: this.task.data.title || tr("task.untitled"), icon: this.task.data.icon, color: this.task.data.color },
            contextLabel: tr("task.customFields.fieldContext", { name: f.name || f.id }),
            confirmLabel: tr("task.picker.link"),
            onPick: (picked) => void setValue([...ids, ...picked]),
          }).open();
        });
        break;
      }
      case "attachment": {
        // Multi-file attachment field. Storage goes under
        // _attachments/<task_id>/cf-<field_id>/ via the attachments module.
        const list: TaskAttachment[] = Array.isArray(value) ? (value as TaskAttachment[]) : [];
        const wrap = parent.createDiv({ cls: "it-cf-attachment-edit" });
        if (list.length === 0) wrap.createSpan({ cls: "it-empty-inline", text: tr("task.customFields.noFiles") });
        for (const a of list) {
          const row = wrap.createDiv({ cls: "it-attachment-row" });
          const ico = row.createSpan({ cls: "it-attachment-icon" });
          setIcon(ico, "paperclip");
          const link = row.createEl("a", { cls: "it-attachment-name", text: a.name });
          link.addEventListener("click", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            openAttachmentInDefaultApp(this.plugin.index, this.task.data.id, a);
          });
          row.createSpan({ cls: "it-attachment-size", text: humanFileSize(a.size) });
          const rename = row.createEl("button", {
            cls: "it-icon-btn it-icon-btn-mini",
            attr: { "aria-label": tr("task.attachments.rename") },
          });
          setIcon(rename, "file-edit");
          rename.addEventListener("click", () => this.beginAttachmentRename(
            row,
            link,
            a.name,
            (name) => renameCfAttachment(this.plugin.index, this.task.data.id, f.id, a.path, name),
          ));
          const rm = row.createEl("button", {
            cls: "it-icon-btn it-icon-btn-mini it-danger",
            attr: { "aria-label": tr("common.remove") },
          });
          setIcon(rm, "x");
          rm.addEventListener("click", fireAndForget(async () => {
            if (f.required && list.length <= 1) { new Notice(tr("task.notice.requiredField", { name: f.name })); return; }
            new ConfirmModal(this.app, {
              title: tr("task.attachments.removeTitle"),
              message: tr("task.attachments.removeMsg", { name: a.name }),
              destructive: true,
              confirmLabel: tr("common.remove"),
              onConfirm: fireAndForget(async () => {
                try { await removeCfAttachment(this.plugin.index, this.task.data.id, f.id, a.path); }
                catch (e) { new Notice(tr("task.notice.failed", { msg: (e as Error).message })); }
              }),
            }).open();
          }));
        }
        const addRow = wrap.createDiv({ cls: "it-attachment-add" });
        const fileInput = addRow.createEl("input", { type: "file", attr: { multiple: "true" } });
        fileInput.hide();
        const addBtn = addRow.createEl("button", { cls: "it-btn-ghost", text: tr("task.attachments.add") });
        addBtn.addEventListener("click", () => fileInput.click());
        this.bindAttachmentDrop(wrap, (files) => addCfAttachments(this.plugin.index, this.task.data.id, f.id, files));
        fileInput.addEventListener("change", fireAndForget(async () => {
          if (!fileInput.files || fileInput.files.length === 0) return;
          try { await addCfAttachments(this.plugin.index, this.task.data.id, f.id, fileInput.files); }
          catch (e) { new Notice(tr("task.notice.failed", { msg: (e as Error).message })); }
          fileInput.value = "";
        }));
        break;
      }
      default: {
        const i = parent.createEl("input", { type: "text", cls: "it-input" });
        const raw = value as string | number | boolean | object | null | undefined;
        i.value = raw != null ? (typeof raw === "object" ? JSON.stringify(raw) : String(raw)) : "";
        i.placeholder = `(${f.type as string})`;
        i.addEventListener("change", () => void setValue(i.value));
      }
    }
  }

  private renderMarkdownCustomField(
    parent: HTMLElement,
    field: { id: string; name: string },
    value: string,
    onSave: (value: string) => Promise<void>,
    secret: boolean,
  ): void {
    const editing = this.editingMarkdownFieldIds.has(field.id);
    const wrap = parent.createDiv({ cls: "it-cf-markdown" + (secret ? " is-secret" : "") });
    const actions = wrap.createDiv({ cls: "it-cf-markdown-actions" });
    const edit = actions.createEl("button", {
      cls: "it-btn-ghost",
      text: editing ? tr("common.cancel") : tr("task.description.edit"),
    });
    if (editing) {
      const ta = wrap.createEl("textarea", { cls: "it-task-body it-cf-markdown-editor" });
      ta.value = value;
      ta.rows = 12;
      ta.placeholder = tr("task.description.placeholder");
      const save = actions.createEl("button", { cls: "it-btn-primary", text: tr("common.save") });
      save.addEventListener("click", fireAndForget(async () => {
        this.editingMarkdownFieldIds.delete(field.id);
        await onSave(ta.value);
      }));
      edit.addEventListener("click", () => {
        this.editingMarkdownFieldIds.delete(field.id);
        this.render();
      });
    } else {
      const view = wrap.createDiv({ cls: "it-task-body-rendered it-cf-markdown-rendered markdown-rendered" });
      this.renderMarkdownInto(view, value);
      edit.addEventListener("click", () => {
        this.editingMarkdownFieldIds.add(field.id);
        this.render();
      });
    }
  }

  private renderSecretCustomField(
    parent: HTMLElement,
    field: { id: string; name: string; type: string },
    encryptedValue: unknown,
    onSave: (value: string) => Promise<void>,
  ): void {
    const revealed = this.isSecretFieldVisibleInModal(field.id);
    const plaintext = revealed
      ? (this.secretPlaintext.has(field.id) ? this.secretPlaintext.get(field.id)! : this.plugin.secretFieldPlaintext(encryptedValue))
      : null;

    if (!revealed || plaintext === null) {
      const locked = parent.createDiv({ cls: "it-cf-secret-control is-locked" });
      locked.createSpan({ cls: "it-cf-secret-mask", text: "••••••••" });
      const reveal = locked.createEl("button", {
        cls: "it-icon-btn it-cf-secret-toggle",
        attr: { type: "button", "aria-label": tr("secret.reveal"), title: tr("secret.reveal") },
      });
      setIcon(reveal, "eye");
      reveal.addEventListener("click", fireAndForget(async () => {
        const values = await this.plugin.decryptSecretFieldValuesForModal([encryptedValue]);
        if (values === null) return;
        if (values[0] === null) {
          new Notice(tr("secret.decryptFailed"));
          return;
        }
        this.secretPlaintext.set(field.id, values[0]);
        this.secretVisibility.revealOne(field.id);
        this.render();
      }));
      return;
    }

    const wrap = parent.createDiv({ cls: "it-cf-secret-control is-unlocked" });
    const valueHost = wrap.createDiv({ cls: "it-cf-secret-value" });
    if (field.type === "secret_markdown") {
      this.renderMarkdownCustomField(valueHost, field, plaintext, onSave, true);
    } else if (field.type === "secret_textarea") {
      const ta = valueHost.createEl("textarea", { cls: "it-input" });
      ta.value = plaintext;
      ta.rows = 4;
      ta.addEventListener("change", () => void onSave(ta.value));
    } else {
      const input = valueHost.createEl("input", { cls: "it-input", attr: { type: "text" } });
      input.value = plaintext;
      input.addEventListener("change", () => void onSave(input.value));
    }
    const hide = wrap.createEl("button", {
      cls: "it-icon-btn it-cf-secret-toggle",
      attr: { type: "button", "aria-label": tr("secret.hide"), title: tr("secret.hide") },
    });
    setIcon(hide, "eye-off");
    hide.addEventListener("click", () => {
      this.editingMarkdownFieldIds.delete(field.id);
      this.secretVisibility.hideOne(field.id);
      this.secretPlaintext.delete(field.id);
      this.render();
    });
  }

  private isSecretFieldVisibleInModal(fieldId: string): boolean {
    return this.secretVisibility.isVisible(fieldId, this.plugin.isSecretWorkspaceUnlocked());
  }
}

import { App, Modal } from "obsidian";
import type InventTasksPlugin from "../main";
import { exportTimeView, defaultTimeExportRange, TimeExportFormat, TimeExportInput, TimeExportTheme } from "../data/timeline-export";
import { ctxDateFields } from "../views/time-grid";
import { dayKey, todayKey } from "../utils/dates";
import { t, viewLabel } from "../i18n";

export class TimeExportModal extends Modal {
  private plugin: InventTasksPlugin;
  private format: TimeExportFormat;
  private input: TimeExportInput;
  private dateFrom: string;
  private dateTo: string;
  private showTaskLabels = false;
  private showUnscheduled: boolean;
  private markerEnabled = false;
  private markerDate = todayKey();
  private theme: TimeExportTheme = "light";
  private error = "";

  constructor(app: App, plugin: InventTasksPlugin, format: TimeExportFormat, input: TimeExportInput) {
    super(app);
    this.plugin = plugin;
    this.format = format;
    this.input = input;
    const range = defaultTimeExportRange(input.tasks, ctxDateFields(input.context));
    this.dateFrom = range.dateFrom;
    this.dateTo = range.dateTo;
    this.showUnscheduled = input.viewType === "timeline";
  }

  onOpen() {
    this.modalEl.addClass("it-export-modal");
    this.modalEl.addClass("it-time-export-modal");
    this.titleEl.setText(t("timeExport.title", {
      view: viewLabel(this.input.viewType),
      format: this.format.toUpperCase(),
    }));
    this.render();
  }

  private render() {
    const c = this.contentEl;
    c.empty();
    c.createEl("p", {
      cls: "setting-item-description",
      text: t("timeExport.intro"),
    });

    const body = c.createDiv({ cls: "it-export-body" });
    this.dateInput(body, t("timeExport.from"), this.dateFrom, (v) => { this.dateFrom = v; });
    this.dateInput(body, t("timeExport.to"), this.dateTo, (v) => { this.dateTo = v; });
    this.themeInput(body);
    this.checkbox(body, t("timeExport.fullLabels"), this.showTaskLabels, (v) => { this.showTaskLabels = v; });
    body.createEl("p", {
      cls: "setting-item-description it-time-export-hint",
      text: t("timeExport.fieldsHint"),
    });

    if (this.input.viewType === "timeline") {
      this.checkbox(body, t("timeExport.unscheduled"), this.showUnscheduled, (v) => { this.showUnscheduled = v; });
      body.createEl("p", {
        cls: "setting-item-description it-time-export-hint",
        text: t("timeExport.unscheduledHint"),
      });
    }

    this.checkbox(body, t("timeExport.marker"), this.markerEnabled, (v) => {
      this.markerEnabled = v;
      this.render();
    });
    if (this.markerEnabled) {
      this.dateInput(body, t("timeExport.markerDate"), this.markerDate, (v) => { this.markerDate = v; });
    }

    if (this.error) c.createEl("p", { cls: "it-export-error", text: this.error });

    const footer = c.createDiv({ cls: "it-modal-footer" });
    footer.createEl("button", { text: t("common.cancel"), cls: "it-btn-ghost" }).addEventListener("click", () => this.close());
    footer.createEl("button", { text: t("timeExport.exportBtn", { format: this.format.toUpperCase() }), cls: "it-btn-primary" })
      .addEventListener("click", () => { void this.doExport(); });
  }

  private dateInput(parent: HTMLElement, label: string, value: string, onChange: (value: string) => void) {
    const row = parent.createDiv({ cls: "it-export-row" });
    row.createSpan({ cls: "it-export-label", text: label });
    const input = row.createEl("input", { type: "date", cls: "it-input" });
    input.value = value;
    input.addEventListener("input", () => onChange(input.value));
  }

  private checkbox(parent: HTMLElement, label: string, checked: boolean, onChange: (checked: boolean) => void) {
    const row = parent.createDiv({ cls: "it-export-row it-time-export-check" });
    const input = row.createEl("input", { type: "checkbox" });
    input.checked = checked;
    input.addEventListener("change", () => onChange(input.checked));
    row.createSpan({ text: label });
  }

  private themeInput(parent: HTMLElement) {
    const row = parent.createDiv({ cls: "it-export-row" });
    row.createSpan({ cls: "it-export-label", text: t("timeExport.printTheme") });
    const select = row.createEl("select", { cls: "it-input" });
    select.createEl("option", { value: "light", text: t("timeExport.themeLight") });
    select.createEl("option", { value: "dark", text: t("timeExport.themeDark") });
    select.value = this.theme;
    select.addEventListener("change", () => { this.theme = select.value as TimeExportTheme; });
  }

  private async doExport() {
    const dateFrom = dayKey(this.dateFrom);
    const dateTo = dayKey(this.dateTo);
    const markerDate = dayKey(this.markerDate);
    if (!dateFrom || !dateTo) {
      this.error = t("timeExport.errDates");
      this.render();
      return;
    }
    if (dateFrom > dateTo) {
      this.error = t("timeExport.errRange");
      this.render();
      return;
    }
    if (this.markerEnabled && !markerDate) {
      this.error = t("timeExport.errMarker");
      this.render();
      return;
    }
    if (this.markerEnabled && markerDate && (markerDate < dateFrom || markerDate > dateTo)) {
      this.error = t("timeExport.errMarkerRange");
      this.render();
      return;
    }
    try {
      const exported = await exportTimeView(this.plugin, this.format, {
        ...this.input,
        options: {
          dateFrom,
          dateTo,
          showTaskLabels: this.showTaskLabels,
          showUnscheduled: this.showUnscheduled,
          markerEnabled: this.markerEnabled,
          markerDate: markerDate || todayKey(),
          theme: this.theme,
        },
      });
      if (exported) this.close();
    } catch (e) {
      this.error = t("timeExport.failed", { msg: (e as Error | undefined)?.message ?? String(e) });
      this.render();
    }
  }
}

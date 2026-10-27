import { App, Modal, Notice } from "obsidian";
import type { LinkedValue, LocationValue } from "../types";
import { t } from "../i18n";

export type LinkedKind = "url" | "email" | "phone" | "location";

export interface LinkedValueModalOpts {
  kind: LinkedKind;
  // Field name shown in the modal title (e.g. "Spec URL", "Contact email").
  fieldName: string;
  // Current value, if editing; undefined when adding fresh.
  current?: LinkedValue;
  onSave: (next: LinkedValue) => void;
}

const PLACEHOLDER: Record<LinkedKind, () => string> = {
  url: () => t("linked.placeholder.url"),
  email: () => t("linked.placeholder.email"),
  phone: () => t("linked.placeholder.phone"),
  location: () => t("linked.placeholder.location"),
};

const HINT: Record<LinkedKind, () => string> = {
  url: () => t("linked.hint.url"),
  email: () => t("linked.hint.email"),
  phone: () => t("linked.hint.phone"),
  location: () => t("linked.hint.location"),
};

const LABEL_FOR_VALUE: Record<LinkedKind, () => string> = {
  url: () => t("linked.url"),
  email: () => t("linked.email"),
  phone: () => t("linked.phone"),
  location: () => t("linked.placeMapUrl"),
};

// Modal for editing a single linked custom-field value: label + value pair.
// Used by url, email, phone, and location field types so the row in the
// task modal stays compact (just the rendered link + edit/delete buttons).
export class LinkedValueModal extends Modal {
  private opts: LinkedValueModalOpts;
  private label: string;
  private value: string;

  constructor(app: App, opts: LinkedValueModalOpts) {
    super(app);
    this.opts = opts;
    this.label = opts.current?.label ?? "";
    this.value = opts.current?.value ?? "";
  }

  onOpen() {
    const c = this.contentEl;
    this.titleEl.setText(`${this.opts.current ? t("linked.edit") : t("linked.add")} ${this.opts.fieldName}`);
    c.empty();
    c.addClass("it-linked-value-modal");

    // Label input
    const labelWrap = c.createDiv({ cls: "it-modal-form-row" });
    labelWrap.createEl("label", { cls: "it-modal-form-label", text: t("linked.labelOptional") });
    const labelInput = labelWrap.createEl("input", { type: "text", cls: "it-input" });
    labelInput.value = this.label;
    labelInput.placeholder = t("linked.labelPlaceholder");
    labelInput.addEventListener("input", () => { this.label = labelInput.value; });

    // Value input
    const valueWrap = c.createDiv({ cls: "it-modal-form-row" });
    valueWrap.createEl("label", { cls: "it-modal-form-label", text: LABEL_FOR_VALUE[this.opts.kind]() });
    const valueInput = valueWrap.createEl("input", {
      type: this.opts.kind === "email" ? "email" : (this.opts.kind === "phone" ? "tel" : (this.opts.kind === "location" ? "text" : "url")),
      cls: "it-input",
    });
    valueInput.value = this.value;
    valueInput.placeholder = PLACEHOLDER[this.opts.kind]();
    valueInput.addEventListener("input", () => { this.value = valueInput.value; });

    // Hint
    c.createDiv({ cls: "setting-item-description", text: HINT[this.opts.kind]() });

    // Footer actions
    const actions = c.createDiv({ cls: "it-modal-footer" });
    actions.createEl("button", { cls: "it-btn-ghost", text: t("common.cancel") })
      .addEventListener("click", () => this.close());
    const saveBtn = actions.createEl("button", { cls: "it-btn-primary", text: t("common.save") });
    const submit = () => {
      const v = this.value.trim();
      if (!v) { new Notice(t("common.valueRequired")); valueInput.focus(); return; }
      const lbl = this.label.trim();
      this.opts.onSave(lbl ? { label: lbl, value: v } : { value: v });
      this.close();
    };
    saveBtn.addEventListener("click", submit);
    // Cmd/Ctrl+Enter shortcut
    [labelInput, valueInput].forEach((el) => {
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); submit(); }
        else if (e.key === "Escape") { e.preventDefault(); this.close(); }
      });
    });

    setTimeout(() => (this.value ? valueInput.focus() : labelInput.focus()), 0);
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ---- Location modal (dedicated for the location field type) ----
// Shows four fields: Label (address text), URL (map link), Latitude, Longitude.
// Backward-compatible: accepts old LinkedValue { label?, value } as `current`
// (where `value` may be a URL or plain address string).

export interface LocationModalOpts {
  fieldName: string;
  current?: LocationValue;
  onSave: (next: LocationValue) => void;
}

function extractCoordsFromUrl(url: string): { lat: number; lng: number } | null {
  // Matches @lat,lng in Google Maps URLs and similar.
  const m = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };
  // Also match ?q=lat,lng pattern (e.g. /maps?q=51.1,17.0)
  const q = url.match(/[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (q) return { lat: parseFloat(q[1]), lng: parseFloat(q[2]) };
  return null;
}

export class LocationModal extends Modal {
  private opts: LocationModalOpts;
  private label: string;
  private url: string;
  private lat: string;
  private lng: string;

  constructor(app: App, opts: LocationModalOpts) {
    super(app);
    this.opts = opts;
    this.label = opts.current?.label ?? "";
    this.url = opts.current?.url ?? "";
    this.lat = opts.current?.lat != null ? String(opts.current.lat) : "";
    this.lng = opts.current?.lng != null ? String(opts.current.lng) : "";
  }

  onOpen() {
    const c = this.contentEl;
    this.titleEl.setText(`${this.opts.current ? t("linked.edit") : t("linked.add")} ${this.opts.fieldName}`);
    c.empty();
    c.addClass("it-linked-value-modal");

    // Label — human-readable address
    const labelWrap = c.createDiv({ cls: "it-modal-form-row" });
    labelWrap.createEl("label", { cls: "it-modal-form-label", text: t("linked.addressText") });
    const labelInput = labelWrap.createEl("input", { type: "text", cls: "it-input" });
    labelInput.value = this.label;
    labelInput.placeholder = t("linked.addressPlaceholder");
    labelInput.addEventListener("input", () => { this.label = labelInput.value; });

    // URL — direct map link
    const urlWrap = c.createDiv({ cls: "it-modal-form-row" });
    urlWrap.createEl("label", { cls: "it-modal-form-label", text: t("linked.mapUrl") });
    const urlInput = urlWrap.createEl("input", { type: "url", cls: "it-input" });
    urlInput.value = this.url;
    urlInput.placeholder = t("linked.mapUrlPlaceholder");
    urlInput.addEventListener("input", () => { this.url = urlInput.value; });

    // "Extract from URL" button
    const extractBtn = urlWrap.createEl("button", { cls: "it-btn-ghost", text: t("linked.extractCoords") });
    extractBtn.style.marginTop = "4px";
    extractBtn.addEventListener("click", () => {
      const coords = extractCoordsFromUrl(this.url.trim());
      if (coords) {
        this.lat = String(coords.lat);
        this.lng = String(coords.lng);
        latInput.value = this.lat;
        lngInput.value = this.lng;
        new Notice(t("linked.coordsExtracted"));
      } else {
        new Notice(t("linked.coordsNotFound"));
      }
    });

    // Coordinates row
    c.createDiv({ cls: "setting-item-description", text: t("linked.coordsOptional") });
    const coordsWrap = c.createDiv({ cls: "it-modal-form-row it-cf-coords-row" });

    const latWrap = coordsWrap.createDiv({ cls: "it-cf-coord-field" });
    latWrap.createEl("label", { cls: "it-modal-form-label", text: t("linked.latitude") });
    const latInput = latWrap.createEl("input", { type: "number", cls: "it-input" });
    latInput.value = this.lat;
    latInput.placeholder = t("linked.latPlaceholder");
    latInput.setAttribute("step", "any");
    latInput.addEventListener("input", () => { this.lat = latInput.value; });

    const lngWrap = coordsWrap.createDiv({ cls: "it-cf-coord-field" });
    lngWrap.createEl("label", { cls: "it-modal-form-label", text: t("linked.longitude") });
    const lngInput = lngWrap.createEl("input", { type: "number", cls: "it-input" });
    lngInput.value = this.lng;
    lngInput.placeholder = t("linked.lngPlaceholder");
    lngInput.setAttribute("step", "any");
    lngInput.addEventListener("input", () => { this.lng = lngInput.value; });

    // Hint
    c.createDiv({
      cls: "setting-item-description",
      text: t("linked.locationHint"),
    });

    // Footer
    const actions = c.createDiv({ cls: "it-modal-footer" });
    actions.createEl("button", { cls: "it-btn-ghost", text: t("common.cancel") })
      .addEventListener("click", () => this.close());
    const saveBtn = actions.createEl("button", { cls: "it-btn-primary", text: t("common.save") });
    const submit = () => {
      const lbl = this.label.trim();
      const url = this.url.trim();
      const lat = parseFloat(this.lat);
      const lng = parseFloat(this.lng);
      if (!lbl && !url && (isNaN(lat) || isNaN(lng))) {
        new Notice(t("linked.locationRequired"));
        labelInput.focus();
        return;
      }
      const next: LocationValue = {};
      if (lbl) next.label = lbl;
      if (url) next.url = url;
      if (!isNaN(lat)) next.lat = lat;
      if (!isNaN(lng)) next.lng = lng;
      this.opts.onSave(next);
      this.close();
    };
    saveBtn.addEventListener("click", submit);
    [labelInput, urlInput].forEach((el) => {
      el.addEventListener("keydown", (e) => {
        if (e.key === "Escape") { e.preventDefault(); this.close(); }
      });
    });

    setTimeout(() => labelInput.focus(), 0);
  }

  onClose() {
    this.contentEl.empty();
  }
}

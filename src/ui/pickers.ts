import { setIcon, Setting } from "obsidian";
import { showPopover } from "./components";
import { renderIconish } from "./icons";
import { fireAndForget } from "../utils/async";
import { pickerCategoryLabel, t } from "../i18n";

// Centralised palettes used by both the color and icon pickers.
export const COLOR_PALETTE = [
  "#F44336", "#E91E63", "#9C27B0", "#673AB7", "#3F51B5",
  "#2196F3", "#03A9F4", "#00BCD4", "#009688", "#4CAF50",
  "#8BC34A", "#CDDC39", "#FFEB3B", "#FFC107", "#FF9800",
  "#FF5722", "#795548", "#9E9E9E", "#607D8B",
  "#0091FF", "#6647F0", "#FF02F0", "#7612FA", "#ED5F00",
];

export const EMOJI_CHOICES = [
  "📋","📌","📅","🎯","✅","🚀","💼","🏠","📥","📤","🛠️","🧪","🐛","📖","💡","🎨",
  "🔥","⭐","📈","🗂️","🏷️","📣","🌱","🧭","🔔","🎓","⚙️","🛒","💰","🏃","🍱","☕",
  "🎵","📷","💎","🤝","📝","🧠","⏰","🍀","🔒","🌍","🧩","📦","📊",
];

// Curated set of Lucide icon names useful for tasks/workspaces/etc.
export const LUCIDE_CHOICES = [
  "check-square", "list", "list-tree", "list-checks", "list-todo",
  "folder", "folder-open", "folder-plus", "archive", "inbox",
  "calendar", "calendar-clock", "clock", "alarm-clock", "timer",
  "flag", "bookmark", "star", "heart", "bell",
  "bug", "wrench", "hammer", "settings", "sliders",
  "file", "file-text", "file-code", "file-check",
  "home", "briefcase", "building", "building-2", "shopping-cart", "package",
  "users", "user", "user-check", "user-plus",
  "lightbulb", "sparkles", "zap", "rocket", "flame",
  "tag", "tags", "hash", "at-sign", "link",
  "target", "trophy", "award", "crown",
  "book", "book-open", "graduation-cap", "compass", "map-pin",
  "music", "camera", "image", "video", "mic",
  "lock", "unlock", "shield", "key",
  "trending-up", "bar-chart", "pie-chart", "activity",
  "git-branch", "code", "terminal", "database",
  "globe", "leaf",
  "puzzle", "layers", "boxes", "container",
  "arrow-up", "arrow-down", "arrow-right", "arrow-left",
  "plus", "minus", "x", "check",
];

function isHex(s: string | undefined | null): boolean {
  return !!s && /^#[0-9a-fA-F]{3,8}$/.test(s.trim());
}

export function looksLucide(s: string | undefined | null): boolean {
  return !!s && /^[a-z][a-z0-9-]*$/i.test(s) && s.length > 1;
}

// ============================================================================
// Color picker — popover with palette grid, manual hex input, native picker,
// and a copy-to-clipboard button. Used everywhere a color is chosen.
// ============================================================================
export function openColorPicker(
  anchor: HTMLElement,
  current: string | undefined,
  onPick: (color: string) => void
) {
  showPopover(anchor, (root) => {
    const wrap = root.createDiv({ cls: "it-color-picker" });

    // Palette
    const grid = wrap.createDiv({ cls: "it-color-picker-grid" });
    for (const c of COLOR_PALETTE) {
      const btn = grid.createEl("button", {
        cls: "it-color-picker-swatch" + (c === current ? " is-active" : ""),
        attr: { type: "button", "aria-label": c, title: c },
      });
      btn.style.background = c;
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        onPick(c);
        closePopover();
      });
    }

    // Input row — manual hex + native picker + copy
    const inputRow = wrap.createDiv({ cls: "it-color-picker-input-row" });
    const preview = inputRow.createDiv({ cls: "it-color-picker-preview" });
    preview.style.background = current || "#9E9E9E";

    const input = inputRow.createEl("input", {
      type: "text",
      cls: "it-input-inline it-color-picker-input",
      attr: { spellcheck: "false", placeholder: "#RRGGBB" },
    });
    input.value = current || "";
    input.addEventListener("input", () => {
      const v = input.value.trim();
      if (isHex(v)) preview.style.background = v;
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const v = input.value.trim();
        if (isHex(v)) {
          onPick(v);
          closePopover();
        }
      }
    });
    input.addEventListener("change", () => {
      const v = input.value.trim();
      if (isHex(v)) {
        onPick(v);
        closePopover();
      }
    });

    // Native browser color picker
    const nativeBtn = inputRow.createEl("button", {
      cls: "it-icon-btn",
      attr: { type: "button", "aria-label": t("pickerUi.nativePicker"), title: t("pickerUi.nativePicker") },
    });
    setIcon(nativeBtn, "palette");
    nativeBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const inp = nativeBtn.ownerDocument.body.createEl("input", { type: "color", cls: "it-hidden-color-input" });
      inp.value = isHex(current) ? current! : "#9E9E9E";
      inp.addEventListener("change", () => {
        onPick(inp.value);
        inp.remove();
        closePopover();
      });
      inp.addEventListener("blur", () => window.setTimeout(() => inp.remove(), 300));
      inp.click();
    });

    // Copy to clipboard
    const copyBtn = inputRow.createEl("button", {
      cls: "it-icon-btn",
      attr: { type: "button", "aria-label": t("pickerUi.copyClipboard"), title: t("pickerUi.copyClipboard") },
    });
    setIcon(copyBtn, "copy");
    copyBtn.addEventListener("click", fireAndForget(async (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const v = input.value.trim() || current;
      if (!v) return;
      try {
        await navigator.clipboard.writeText(v);
        copyBtn.addClass("it-just-copied");
        window.setTimeout(() => copyBtn.removeClass("it-just-copied"), 800);
      } catch { /* clipboard unavailable */ }
    }));
  });
}

// ============================================================================
// Icon picker — popover with two tabs (Emoji / Lucide), manual entry, search,
// and lazy-loaded full catalogues.
//
// Quick picks (EMOJI_CHOICES / LUCIDE_CHOICES) render synchronously. The
// full catalogues live in separate modules (`./full-emoji`, `./full-lucide`)
// and are imported on demand the first time the user toggles "Browse all"
// or starts typing in the search box.
// ============================================================================

// Module-level cache so subsequent picker opens don't re-import.
let fullEmojiCache: typeof import("./full-emoji") | null = null;
let fullLucideCache: typeof import("./full-lucide") | null = null;

async function loadFullEmoji(): Promise<typeof import("./full-emoji")> {
  if (!fullEmojiCache) fullEmojiCache = await import("./full-emoji");
  return fullEmojiCache;
}
async function loadFullLucide(): Promise<typeof import("./full-lucide")> {
  if (!fullLucideCache) fullLucideCache = await import("./full-lucide");
  return fullLucideCache;
}

export function openIconPicker(
  anchor: HTMLElement,
  current: string | undefined,
  onPick: (icon: string) => void
) {
  showPopover(anchor, (root) => {
    const wrap = root.createDiv({ cls: "it-icon-picker" });
    let tab: "emoji" | "lucide" = looksLucide(current) ? "lucide" : "emoji";
    // Open in "all" mode by default so users see every available glyph
    // (categorised). They can flip to the small curated set via the toggle.
    let mode: "quick" | "all" = "all";
    let query = "";
    let activeCategory: string | null = null;

    const tabs = wrap.createDiv({ cls: "it-icon-picker-tabs" });
    const emojiTab = tabs.createEl("button", { cls: "it-picker-tab", text: t("pickerUi.emoji"), attr: { type: "button" } });
    const lucideTab = tabs.createEl("button", { cls: "it-picker-tab", text: t("pickerUi.iconTab"), attr: { type: "button" } });

    const body = wrap.createDiv({ cls: "it-icon-picker-body" });

    const render = () => {
      body.empty();
      emojiTab.toggleClass("is-active", tab === "emoji");
      lucideTab.toggleClass("is-active", tab === "lucide");

      // Manual input + search row
      const inputRow = body.createDiv({ cls: "it-icon-picker-input-row" });
      const preview = inputRow.createSpan({ cls: "it-icon-picker-preview" });
      if (current) renderIconish(preview, current);
      const input = inputRow.createEl("input", {
        type: "text",
        cls: "it-input-inline it-icon-picker-input",
        attr: { spellcheck: "false" },
      });
      input.value = query || current || "";
      input.placeholder =
        mode === "all"
          ? (tab === "emoji" ? t("pickerUi.searchAllEmoji") : t("pickerUi.searchAllIcons"))
          : (tab === "emoji" ? t("pickerUi.pasteEmoji") : t("pickerUi.lucideSearch"));

      // Browse-all toggle
      const browseBtn = inputRow.createEl("button", {
        cls: "it-icon-btn it-icon-picker-browse",
        attr: { type: "button", title: mode === "quick" ? t("pickerUi.browseAll") : t("pickerUi.showQuick") },
      });
      setIcon(browseBtn, mode === "quick" ? "layout-grid" : "star");
      browseBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        mode = mode === "quick" ? "all" : "quick";
        query = "";
        activeCategory = null;
        render();
      });

      const commit = () => {
        const v = input.value.trim();
        // If it's exactly an entry in the catalogue (or any non-empty string),
        // accept it as-is. Matching is delegated to renderIconish at display.
        if (v) { onPick(v); closePopover(); }
      };
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          // Enter on a non-empty search with results: pick first result
          if (query && resultCells.length > 0) {
            (resultCells[0] as HTMLButtonElement).click();
            return;
          }
          commit();
        }
      });
      input.addEventListener("input", () => {
        const v = input.value;
        query = v;
        // Auto-switch into "all" mode the moment the user starts searching —
        // gives them the full catalogue without an extra click.
        if (v && mode === "quick") mode = "all";
        void renderGrid();
      });

      // Container that gets re-rendered when query/category changes (without
      // tearing down the search row above — keeps focus inside the input).
      const gridHost = body.createDiv({ cls: "it-icon-picker-grid-host" });
      let resultCells: HTMLElement[] = [];

      const renderGrid = async () => {
        gridHost.empty();
        resultCells = [];

        if (mode === "quick") {
          // Quick-picks: small curated set, instant render.
          const items = tab === "emoji" ? EMOJI_CHOICES : LUCIDE_CHOICES;
          const filtered = filterItems(items, query);
          renderCells(gridHost, filtered, current, onPick, resultCells);

          // "Show all" footer hint
          const hint = gridHost.createDiv({ cls: "it-icon-picker-hint" });
          hint.createSpan({ text: tab === "emoji"
            ? t("pickerUi.searchHintEmoji")
            : t("pickerUi.searchHintIcons") });
          return;
        }

        // "All" mode — lazy-load and render the full catalogue.
        const loadingEl = gridHost.createDiv({ cls: "it-icon-picker-loading", text: t("common.loading") });

        if (tab === "emoji") {
          const mod = await loadFullEmoji();
          loadingEl.remove();
          renderEmojiAll(gridHost, mod, query, activeCategory, (cat) => {
            activeCategory = cat;
            void renderGrid();
          }, current, onPick, resultCells);
        } else {
          const mod = await loadFullLucide();
          loadingEl.remove();
          renderLucideAll(gridHost, mod, query, activeCategory, (cat) => {
            activeCategory = cat;
            void renderGrid();
          }, current, onPick, resultCells);
        }
      };

      void renderGrid();
      // Focus the input on every re-render so the user can keep typing.
      // Defer so it runs after the popover has been positioned.
      window.setTimeout(() => {
        try { input.focus(); input.setSelectionRange(input.value.length, input.value.length); } catch { /* noop */ }
      }, 0);
    };

    emojiTab.addEventListener("click", (e) => { e.preventDefault(); tab = "emoji"; query = ""; activeCategory = null; render(); });
    lucideTab.addEventListener("click", (e) => { e.preventDefault(); tab = "lucide"; query = ""; activeCategory = null; render(); });
    render();
  });
}

// Filter a flat array by a case-insensitive needle. Empty needle returns all.
function filterItems(items: string[], q: string): string[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return items;
  return items.filter((it) => it.toLowerCase().includes(needle));
}

// Render a flat grid of cells. Lucide cells try to render the SVG; if Obsidian
// doesn't have the icon, the cell is omitted (graceful degrade — we never
// show a broken/empty cell).
function renderCells(
  parent: HTMLElement,
  items: string[],
  current: string | undefined,
  onPick: (v: string) => void,
  collector: HTMLElement[],
) {
  const grid = parent.createDiv({ cls: "it-icon-picker-grid" });
  if (items.length === 0) {
    parent.createDiv({ cls: "it-icon-picker-empty", text: t("common.noMatches") });
    return;
  }
  for (const it of items) {
    const isLucide = /^[a-z][a-z0-9-]*$/i.test(it) && it.length > 1;
    const cell = grid.createEl("button", {
      cls: "it-icon-picker-cell" + (it === current ? " is-active" : ""),
      attr: { type: "button", "aria-label": it, title: it },
    });
    if (isLucide) {
      setIcon(cell, it);
      if (!cell.firstElementChild) {
        // Icon not registered in this Obsidian build — skip it
        cell.remove();
        continue;
      }
    } else {
      cell.setText(it);
    }
    cell.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onPick(it);
      closePopover();
    });
    collector.push(cell);
  }
}

function renderEmojiAll(
  parent: HTMLElement,
  mod: typeof import("./full-emoji"),
  query: string,
  activeCategory: string | null,
  onCategory: (cat: string | null) => void,
  current: string | undefined,
  onPick: (v: string) => void,
  collector: HTMLElement[],
) {
  // Category chips
  const chips = parent.createDiv({ cls: "it-icon-picker-cats" });
  const allChip = chips.createEl("button", { cls: "it-icon-picker-cat" + (activeCategory == null ? " is-active" : ""), text: t("common.all"), attr: { type: "button" } });
  allChip.addEventListener("click", (e) => { e.preventDefault(); onCategory(null); });
  for (const c of mod.EMOJI_CATEGORIES) {
    const chip = chips.createEl("button", { cls: "it-icon-picker-cat" + (activeCategory === c.key ? " is-active" : ""), text: pickerCategoryLabel("emoji", c.key, c.label), attr: { type: "button" } });
    chip.addEventListener("click", (e) => { e.preventDefault(); onCategory(c.key); });
  }

  // Build the working set
  const needle = query.trim().toLowerCase();
  const categories = activeCategory ? mod.EMOJI_CATEGORIES.filter((c) => c.key === activeCategory) : mod.EMOJI_CATEGORIES;

  let totalShown = 0;
  for (const cat of categories) {
    const filtered = needle ? cat.emojis.filter((e) => e.toLowerCase().includes(needle)) : cat.emojis;
    if (filtered.length === 0) continue;
    const section = parent.createDiv({ cls: "it-icon-picker-section" });
    section.createDiv({ cls: "it-icon-picker-section-label", text: pickerCategoryLabel("emoji", cat.key, cat.label) });
    renderCells(section, filtered, current, onPick, collector);
    totalShown += filtered.length;
  }
  if (totalShown === 0) {
    parent.createDiv({ cls: "it-icon-picker-empty", text: t("pickerUi.noEmoji") });
  }
}

function renderLucideAll(
  parent: HTMLElement,
  mod: typeof import("./full-lucide"),
  query: string,
  activeCategory: string | null,
  onCategory: (cat: string | null) => void,
  current: string | undefined,
  onPick: (v: string) => void,
  collector: HTMLElement[],
) {
  // Category chips
  const chips = parent.createDiv({ cls: "it-icon-picker-cats" });
  const allChip = chips.createEl("button", { cls: "it-icon-picker-cat" + (activeCategory == null ? " is-active" : ""), text: t("common.all"), attr: { type: "button" } });
  allChip.addEventListener("click", (e) => { e.preventDefault(); onCategory(null); });
  for (const c of mod.LUCIDE_CATEGORIES) {
    const chip = chips.createEl("button", { cls: "it-icon-picker-cat" + (activeCategory === c.key ? " is-active" : ""), text: pickerCategoryLabel("lucide", c.key, c.label), attr: { type: "button" } });
    chip.addEventListener("click", (e) => { e.preventDefault(); onCategory(c.key); });
  }

  const needle = query.trim().toLowerCase();
  const categories = activeCategory ? mod.LUCIDE_CATEGORIES.filter((c) => c.key === activeCategory) : mod.LUCIDE_CATEGORIES;

  let totalShown = 0;
  for (const cat of categories) {
    const filtered = needle ? cat.icons.filter((i) => i.toLowerCase().includes(needle)) : cat.icons;
    if (filtered.length === 0) continue;
    const section = parent.createDiv({ cls: "it-icon-picker-section" });
    section.createDiv({ cls: "it-icon-picker-section-label", text: pickerCategoryLabel("lucide", cat.key, cat.label) });
    renderCells(section, filtered, current, onPick, collector);
    totalShown += filtered.length;
  }
  if (totalShown === 0) {
    parent.createDiv({ cls: "it-icon-picker-empty", text: t("pickerUi.noIcons") });
  }
}

function closePopover() {
  // Popovers open in whichever window holds their trigger (see showPopover).
  for (const doc of new Set([document, activeDocument])) {
    doc.querySelectorAll(".it-popover").forEach((el) => el.remove());
  }
}

// ============================================================================
// Setting rows — render the trigger inline (Obsidian Setting style) so each
// config form has a consistent affordance. Each row opens the corresponding
// popover and lets the user clear the value if needed.
// ============================================================================
export function renderIconRow(
  parent: HTMLElement,
  label: string,
  current: string | undefined,
  onChange: (v: string) => void,
  opts?: { desc?: string; color?: string }
) {
  const s = new Setting(parent).setName(label);
  if (opts?.desc) s.setDesc(opts.desc);
  const trigger = s.controlEl.createEl("button", {
    cls: "it-secondary-btn it-icon-row-trigger",
    attr: { type: "button" },
  });
  const refresh = () => {
    trigger.empty();
    const prev = trigger.createSpan({ cls: "it-icon-row-preview" });
    // Lucide SVGs honor `currentColor`; emoji glyphs are unaffected, so
    // applying the color here only tints flat icons.
    if (opts?.color) prev.style.color = opts.color;
    if (current) renderIconish(prev, current, { fallback: "·" });
    else prev.setText(t("pickerUi.none"));
  };
  refresh();
  trigger.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openIconPicker(trigger, current, (v) => {
      current = v;
      onChange(v);
      refresh();
    });
  });
}

export function renderColorRow(
  parent: HTMLElement,
  label: string,
  current: string | undefined,
  onChange: (v: string) => void,
  desc?: string
) {
  const s = new Setting(parent).setName(label);
  if (desc) s.setDesc(desc);
  const trigger = s.controlEl.createEl("button", {
    cls: "it-secondary-btn it-color-row-trigger",
    attr: { type: "button" },
  });
  const refresh = () => {
    trigger.empty();
    const swatch = trigger.createSpan({ cls: "it-color-row-swatch" });
    swatch.style.background = current || "transparent";
    trigger.createSpan({ text: current || t("pickerUi.none"), cls: "it-color-row-label" });
  };
  refresh();
  trigger.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openColorPicker(trigger, current, (v) => {
      current = v;
      onChange(v);
      refresh();
    });
  });
}

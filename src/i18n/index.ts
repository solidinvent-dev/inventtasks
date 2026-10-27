import { en } from "./locales/en";
import { pl } from "./locales/pl";
import { de } from "./locales/de";
import { fr } from "./locales/fr";
import { it } from "./locales/it";
import { es } from "./locales/es";
import type { SubtaskMode } from "../data/subtasks";

export type AppLanguage = "en" | "pl" | "de" | "fr" | "it" | "es";

const LOCALES: Record<AppLanguage, Record<string, string>> = { en, pl, de, fr, it, es };

/** Plugin proper nouns — never translated; available as {Vault}, {Space}, … in strings. */
export const PROPER_NOUNS: Record<string, string> = {
  Vault: "Vault",
  Vaults: "Vaults",
  Space: "Space",
  Spaces: "Spaces",
  Folder: "Folder",
  List: "List",
  Lists: "Lists",
  Workspace: "Workspace",
  Doc: "Doc",
  Docs: "Docs",
  InventTasks: "InventTasks",
  Obsidian: "Obsidian",
};

/** Keys whose entire value is a plugin proper noun (always English). */
const PROPER_NOUN_KEYS = new Set([
  "common.vault",
  "common.workspace",
  "field.space",
  "field.folder",
  "field.list",
  "nav.spaces",
  // View TYPE names are descriptive, not product nouns, so they follow the
  // interface language — Calendar always did, and leaving the rest in English
  // made one menu read "List, Board, Table, Kalendarz, Gantt, Timeline".
  // "Gantt" stays because it is a person's name, and "Doc" because it is one of
  // the product's own nouns alongside Space, List and Vault.
  "view.gantt",
  "view.doc",
  "hierarchy.space",
  "hierarchy.folder",
  "hierarchy.list",
  "hierarchy.workspace",
  "hierarchy.doc",
  "settings.vaults",
]);

export const LANGUAGE_OPTIONS: { value: AppLanguage; labelKey: string }[] = [
  { value: "en", labelKey: "lang.en" },
  { value: "pl", labelKey: "lang.pl" },
  { value: "de", labelKey: "lang.de" },
  { value: "fr", labelKey: "lang.fr" },
  { value: "it", labelKey: "lang.it" },
  { value: "es", labelKey: "lang.es" },
];

let currentLocale: AppLanguage = "en";

export function setLocale(lang: string | undefined): void {
  currentLocale = lang && lang in LOCALES ? (lang as AppLanguage) : "en";
}

export function t(key: string, vars?: Record<string, string | number>): string {
  const base = PROPER_NOUN_KEYS.has(key)
    ? LOCALES.en[key]
    : LOCALES[currentLocale][key] ?? LOCALES.en[key];
  let str = base ?? key;
  const merged: Record<string, string | number> = { ...PROPER_NOUNS, ...vars };
  for (const [k, v] of Object.entries(merged)) {
    str = str.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
  }
  return str;
}

/** Hierarchy breadcrumb / fallback labels (Space, Folder, List, …). */
export function hierarchyLabel(kind: string): string {
  return t(`hierarchy.${kind}`) || kind;
}

export function fieldLabel(key: string): string {
  return t(`field.${key}`) || key;
}

// Location-aware field label: a resolved per-scope custom name (from
// WorkspaceIndex.resolveFieldLabels) wins over the i18n default. `overrides`
// only ever contains non-empty custom names, so a plain lookup is enough.
// Display-only — the underlying markdown property / storage key is unchanged.
export function fieldLabelFrom(overrides: Record<string, string> | undefined, key: string): string {
  const custom = overrides && overrides[key];
  return (typeof custom === "string" && custom) ? custom : fieldLabel(key);
}

export function customFieldTypeLabel(type: string | undefined): string {
  if (!type) return t("field.field");
  return t(`cfType.${type}`) || type;
}

export function colorSchemeLabel(id: string): string {
  return t(`colorScheme.${id}`) || id;
}

export function hotkeyLabel(id: string): string {
  return t(`hotkey.${id}`) || id;
}

export function navLabel(key: string): string {
  return t(`nav.${key}`) || key;
}

export function menuLabel(key: string): string {
  return t(`menu.${key}`) || key;
}

export function viewLabel(view: string): string {
  return t(`view.${view}`) || view;
}

/** Monday = 0 … Sunday = 6 */
export function weekdayShort(i: number): string {
  return t(`cal.dow.short.${i}`);
}

export function weekdayMin(i: number): string {
  return t(`cal.dow.min.${i}`);
}

export function weekdayLong(i: number): string {
  return t(`cal.dow.long.${i}`);
}

/** January = 0 … December = 11 */
export function monthName(i: number): string {
  return t(`cal.month.${i}`);
}

export function zoomLabel(zoom: string): string {
  if (zoom === "day" || zoom === "week" || zoom === "month") return viewLabel(zoom);
  return t(`timeGrid.zoom.${zoom}`) || zoom;
}

export function pickerCategoryLabel(kind: "emoji" | "lucide", key: string, fallback?: string): string {
  return t(`pickerCat.${kind}.${key}`) || fallback || key;
}

export function calendarColorSourceLabel(value: string): string {
  if (value === "default") return t("calendarColor.default");
  if (value === "type") return fieldLabel("type");
  return fieldLabel(value) || value;
}

export function getSubtaskModes(): { value: SubtaskMode; label: string; icon: string; desc: string }[] {
  return [
    { value: "parents", label: t("subtask.parents"), icon: "list", desc: t("subtask.parentsDesc") },
    { value: "nested", label: t("subtask.nested"), icon: "list-tree", desc: t("subtask.nestedDesc") },
    { value: "flat", label: t("subtask.flat"), icon: "rows-3", desc: t("subtask.flatDesc") },
  ];
}

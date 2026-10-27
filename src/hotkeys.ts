import { Platform } from "obsidian";
import type InventTasksPlugin from "./main";
import { SearchModal } from "./modals/search-modal";

// A bindable action. Combos are normalized strings like "Mod+Shift+T" where
// "Mod" = Cmd on macOS / Ctrl on Windows. defaultCombo "" means no default.
export interface HotkeyAction {
  id: string;
  label: string;
  defaultCombo: string;
  run: (plugin: InventTasksPlugin) => void;
}

// Defaults are deliberately Mod+Shift / Alt combos that don't collide with the
// common Obsidian core shortcuts (palette/switcher/settings/new-note/etc.). They
// only fire while the InventTasks view is focused (see main.ts handleHotkey), so
// they never override Obsidian globally.
export const HOTKEY_ACTIONS: HotkeyAction[] = [
  // NOTE: defaults avoid macOS system combos. Mod+Shift+digits are taken by the
  // macOS screenshot tools (⌘⇧3/4/5/6) and Mod+Shift+T is reopen-closed-tab in
  // Chromium/Electron — so view switches + new-task use Mod+Alt (⌘⌥) instead,
  // which macOS passes through to the focused app.
  { id: "new-task",        label: "New task",                  defaultCombo: "Mod+Alt+T", run: (p) => p.getMainView()?.quickCreateTask() },
  { id: "search",          label: "Search (tasks, docs, lists…)", defaultCombo: "Mod+Alt+S", run: (p) => new SearchModal(p.app, p).open() },
  { id: "back",            label: "Navigate back",             defaultCombo: "Alt+ArrowLeft",  run: (p) => p.getMainView()?.goBack() },
  { id: "forward",         label: "Navigate forward",          defaultCombo: "Alt+ArrowRight", run: (p) => p.getMainView()?.goForward() },
  { id: "view-list",       label: "Switch to List view",       defaultCombo: "Mod+Alt+1", run: (p) => p.getMainView()?.setViewType("list") },
  { id: "view-board",      label: "Switch to Board view",      defaultCombo: "Mod+Alt+2", run: (p) => p.getMainView()?.setViewType("board") },
  { id: "view-calendar",   label: "Switch to Calendar view",   defaultCombo: "Mod+Alt+3", run: (p) => p.getMainView()?.setViewType("calendar") },
  { id: "view-table",      label: "Switch to Table view",      defaultCombo: "Mod+Alt+4", run: (p) => p.getMainView()?.setViewType("table") },
  { id: "view-gantt",      label: "Switch to Gantt view",      defaultCombo: "Mod+Alt+5", run: (p) => p.getMainView()?.setViewType("gantt") },
  { id: "view-timeline",   label: "Switch to Timeline view",   defaultCombo: "Mod+Alt+6", run: (p) => p.getMainView()?.setViewType("timeline") },
  { id: "go-today",        label: "Go to Today",               defaultCombo: "Mod+Alt+Y", run: (p) => p.getMainView()?.selectLocation({ kind: "today" }) },
  { id: "go-everything",   label: "Go to Everything",          defaultCombo: "",            run: (p) => p.getMainView()?.selectLocation({ kind: "everything" }) },
  { id: "toggle-closed",   label: "Toggle show closed",        defaultCombo: "",            run: (p) => p.getMainView()?.toggleShowClosed() },
];

// Common Obsidian-core combos — used only to show a soft "may overlap" hint when
// recording (our shortcuts are view-scoped, so they still work, but the hint
// helps users avoid surprises).
export const COMMON_OBSIDIAN_COMBOS = new Set([
  "Mod+P", "Mod+O", "Mod+E", "Mod+N", "Mod+F", "Mod+G", "Mod+W", "Mod+T",
  "Mod+,", "Mod+Z", "Mod+S", "Mod+L", "Mod+K", "Mod+Shift+F", "Mod+Shift+N",
]);

// Build a normalized combo from a keyboard event, or "" if it's modifier-only
// or has no usable modifier (we never bind bare keys).
export function comboFromEvent(e: KeyboardEvent): string {
  const key = normalizeKey(e);
  if (!key) return "";
  const parts: string[] = [];
  const mod = Platform.isMacOS ? e.metaKey : e.ctrlKey;
  if (mod) parts.push("Mod");
  if (Platform.isMacOS && e.ctrlKey) parts.push("Ctrl");
  if (!Platform.isMacOS && e.metaKey) parts.push("Meta");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (parts.length === 0) return ""; // require a modifier
  parts.push(key);
  return parts.join("+");
}

function normalizeKey(e: KeyboardEvent): string {
  const code = e.code || "";
  if (code.startsWith("Key")) return code.slice(3);     // KeyT -> T
  if (code.startsWith("Digit")) return code.slice(5);   // Digit1 -> 1
  if (code.startsWith("Numpad") && code.length > 6) return code.slice(6);
  if (code.startsWith("Arrow")) return code;            // ArrowLeft …
  if (/^F\d{1,2}$/.test(code)) return code;             // F1..F12
  if (["Enter", "Backspace", "Delete", "Escape", "Tab", "Home", "End", "PageUp", "PageDown", "Space"].includes(code)) return code;
  if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return "";
  return e.key.length === 1 ? e.key.toUpperCase() : "";
}

// Effective binding for each action (override ?? default). "" = disabled.
export function resolveHotkeys(plugin: InventTasksPlugin): Record<string, string> {
  const overrides = plugin.prefs.hotkeys || {};
  const out: Record<string, string> = {};
  for (const a of HOTKEY_ACTIONS) {
    out[a.id] = Object.prototype.hasOwnProperty.call(overrides, a.id) ? overrides[a.id] : a.defaultCombo;
  }
  return out;
}

// Pretty-print a combo for the current platform.
export function formatCombo(combo: string): string {
  if (!combo) return "";
  const parts = combo.split("+");
  const key = parts.pop() || "";
  const mac = Platform.isMacOS;
  const modMap: Record<string, string> = mac
    ? { Mod: "⌘", Alt: "⌥", Shift: "⇧", Ctrl: "⌃", Meta: "⊞" }
    : { Mod: "Ctrl", Alt: "Alt", Shift: "Shift", Ctrl: "Ctrl", Meta: "Win" };
  const keyMap: Record<string, string> = { ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓", Escape: "Esc", Space: "Space" };
  const mods = parts.map((p) => modMap[p] || p);
  const k = keyMap[key] || key;
  return mac ? mods.join("") + k : [...mods, k].join("+");
}

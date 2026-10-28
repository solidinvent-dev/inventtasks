import { setIcon } from "obsidian";
import { mobileBottomInset } from "./components";

export interface MenuAction {
  label: string;
  /** Lucide icon name */
  icon?: string;
  /** Mark as destructive — renders in danger color */
  danger?: boolean;
  onClick: () => void;
}

export type MenuItem = MenuAction | "separator";

// Expando holding the listener teardown for the open menu.
interface MenuWithCleanup extends HTMLElement {
  _cleanup?: () => void;
}

let activeMenu: HTMLElement | null = null;

/**
 * Show a custom context menu at the mouse-event position.
 * Replaces Obsidian's native Menu for visual consistency.
 */
export function showContextMenu(e: MouseEvent, items: MenuItem[]): void {
  // Dismiss any previously open menu
  dismissActiveMenu();

  e.stopPropagation();
  e.preventDefault();

  // The window the click happened in: Obsidian 1.14 renders settings in their
  // own window, and views can be popped out, so `document` is not always it.
  const doc = (e.target as Node | null)?.ownerDocument ?? activeDocument;
  const win = doc.defaultView ?? window;

  // Built straight into the click's document; it is measured and positioned
  // below, before the browser paints.
  const menu = doc.body.createDiv({ cls: "it-popover it-ctx-menu", attr: { role: "menu" } });
  const list = menu.createDiv({ cls: "it-popover-menu" });

  for (const item of items) {
    if (item === "separator") {
      list.createDiv({ cls: "it-popover-sep" });
      continue;
    }

    const btn = list.createEl("button", {
      cls: "it-popover-item" + (item.danger ? " it-ctx-item-danger" : ""),
      attr: { role: "menuitem", type: "button" },
    });

    if (item.icon) setIcon(btn.createSpan({ cls: "it-popover-icon" }), item.icon);

    btn.createSpan({ text: item.label });

    btn.addEventListener("mousedown", (ev) => {
      ev.stopPropagation();
    });
    btn.addEventListener("click", () => {
      dismissActiveMenu();
      item.onClick();
    });
  }

  // Measure and position after appending to body
  menu.addClass("it-measuring"); // laid out but invisible until positioned
  doc.body.appendChild(menu);
  activeMenu = menu;

  const vw = win.innerWidth;
  // On mobile, exclude the area behind Obsidian's bottom navbar so the menu and
  // its lowest items stay on-screen and tappable.
  const vh = win.innerHeight - mobileBottomInset(doc);
  // Cap height so a long menu stays on-screen and scrolls instead of running off.
  menu.style.maxHeight = `${vh - 16}px`;
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;

  let x = e.clientX;
  let y = e.clientY;
  if (x + mw > vw - 8) x = vw - mw - 8;
  if (y + mh > vh - 8) y = vh - mh - 8;
  if (x < 4) x = 4;
  if (y < 4) y = 4;

  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  menu.removeClass("it-measuring");

  // Close on outside click or Escape
  const onOutside = (ev: MouseEvent) => {
    if (!menu.contains(ev.target as Node)) dismissActiveMenu();
  };
  const onEscape = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") dismissActiveMenu();
  };

  // Defer so the current click doesn't immediately dismiss
  window.setTimeout(() => {
    doc.addEventListener("mousedown", onOutside, { capture: true });
    doc.addEventListener("keydown", onEscape, { capture: true });
  }, 0);

  (menu as MenuWithCleanup)._cleanup = () => {
    doc.removeEventListener("mousedown", onOutside, { capture: true });
    doc.removeEventListener("keydown", onEscape, { capture: true });
  };
}

function dismissActiveMenu() {
  if (!activeMenu) return;
  (activeMenu as MenuWithCleanup)._cleanup?.();
  activeMenu.remove();
  activeMenu = null;
}

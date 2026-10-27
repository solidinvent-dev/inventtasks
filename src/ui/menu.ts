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

  const menu = document.createElement("div");
  menu.className = "it-popover it-ctx-menu";
  menu.setAttribute("role", "menu");

  const list = document.createElement("div");
  list.className = "it-popover-menu";
  menu.appendChild(list);

  for (const item of items) {
    if (item === "separator") {
      const sep = document.createElement("div");
      sep.className = "it-popover-sep";
      list.appendChild(sep);
      continue;
    }

    const btn = document.createElement("button");
    btn.className = "it-popover-item" + (item.danger ? " it-ctx-item-danger" : "");
    btn.setAttribute("role", "menuitem");
    btn.setAttribute("type", "button");

    if (item.icon) {
      const iconWrap = document.createElement("span");
      iconWrap.className = "it-popover-icon";
      setIcon(iconWrap, item.icon);
      btn.appendChild(iconWrap);
    }

    const labelSpan = document.createElement("span");
    labelSpan.textContent = item.label;
    btn.appendChild(labelSpan);

    btn.addEventListener("mousedown", (ev) => {
      ev.stopPropagation();
    });
    btn.addEventListener("click", () => {
      dismissActiveMenu();
      item.onClick();
    });

    list.appendChild(btn);
  }

  // Measure and position after appending to body
  menu.style.position = "fixed";
  menu.style.zIndex = "10000";
  menu.style.visibility = "hidden";
  document.body.appendChild(menu);
  activeMenu = menu;

  const vw = window.innerWidth;
  // On mobile, exclude the area behind Obsidian's bottom navbar so the menu and
  // its lowest items stay on-screen and tappable.
  const vh = window.innerHeight - mobileBottomInset();
  // Cap height so a long menu stays on-screen and scrolls instead of running off.
  menu.style.maxHeight = `${vh - 16}px`;
  menu.style.overflowY = "auto";
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
  menu.style.visibility = "";

  // Close on outside click or Escape
  const onOutside = (ev: MouseEvent) => {
    if (!menu.contains(ev.target as Node)) dismissActiveMenu();
  };
  const onEscape = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") dismissActiveMenu();
  };

  // Defer so the current click doesn't immediately dismiss
  window.setTimeout(() => {
    document.addEventListener("mousedown", onOutside, { capture: true });
    document.addEventListener("keydown", onEscape, { capture: true });
  }, 0);

  (menu as any)._cleanup = () => {
    document.removeEventListener("mousedown", onOutside, { capture: true });
    document.removeEventListener("keydown", onEscape, { capture: true });
  };
}

function dismissActiveMenu() {
  if (!activeMenu) return;
  (activeMenu as any)._cleanup?.();
  activeMenu.remove();
  activeMenu = null;
}

// Brand assets: the InventTasks logo and the discreet "Buy license" pill shown
// to free-tier users.

import { isLicensed } from "../data/license";
import { WEBSITE_URL } from "../constants";
import { t } from "../i18n";
// Brand assets are theme-paired: the "light" files carry the dark drawing meant
// for light backgrounds; the "dark" files carry the light drawing for dark
// backgrounds. Both are embedded and CSS shows the right one for the active
// theme (`.theme-dark` — set by Obsidian and by the web app), so the logo never
// sits on a clashing background. Sources live in src/img/brand/ (shared by the
// plugin and the web app bundle); downscaled to keep the plugin light.
import wordmarkLightSrc from "../img/brand/wordmark-light.webp";
import wordmarkDarkSrc from "../img/brand/wordmark-dark.webp";
import iconLightSrc from "../img/brand/icon-light.webp";
import iconDarkSrc from "../img/brand/icon-dark.webp";

/** Brand red from the logo. Mirrored in styles.css as --it-brand-red. */
export const BRAND_RED = "#E12D2D";
const WORDMARK_ASPECT = 1016 / 312;
const ICON_ASPECT = 263 / 312;

/** A small 4-point sparkle (used by the buy pill). */
export const SPARK_SVG = `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M8 0.5 L9.9 6.1 L15.5 8 L9.9 9.9 L8 15.5 L6.1 9.9 L0.5 8 L6.1 6.1 Z" fill="currentColor"/>
</svg>`;

/**
 * Render the real InventTasks brand mark. `wordmark: true` shows the full
 * "InventTasks" logo; otherwise the compact square icon (for tight spots where
 * the wordmark would be clipped). `size` is the height in px — the frame width
 * follows the artwork's aspect ratio. Both theme variants are emitted; the
 * stylesheet reveals the one matching the active theme.
 */
export function renderLogo(
  parent: HTMLElement,
  opts: { size?: number; wordmark?: boolean; cls?: string } = {},
): HTMLElement {
  const size = opts.size ?? 28;
  const wordmark = opts.wordmark ?? false;
  const aspect = wordmark ? WORDMARK_ASPECT : ICON_ASPECT;
  const variant = wordmark ? "wordmark" : "icon";
  const wrap = parent.createDiv({ cls: `it-logo is-${variant}${opts.cls ? ` ${opts.cls}` : ""}` });
  const mark = wrap.createSpan({ cls: "it-logo-mark" });
  mark.style.width = `${Math.round(size * aspect)}px`;
  mark.style.height = `${size}px`;
  mark.createEl("img", {
    cls: "it-logo-img is-light",
    attr: { src: wordmark ? wordmarkLightSrc : iconLightSrc, alt: "", draggable: "false" },
  });
  mark.createEl("img", {
    cls: "it-logo-img is-dark",
    attr: { src: wordmark ? wordmarkDarkSrc : iconDarkSrc, alt: "", draggable: "false" },
  });
  return wrap;
}

/**
 * Discreet purchase nudge for free-tier users: a small pill that opens the
 * website. Renders NOTHING once a license is active (`isLicensed()`), so paid
 * users never see it — the only purchase entry point that remains is the
 * License section in plugin settings.
 */
export function renderBuyLicenseLink(
  parent: HTMLElement,
  opts: { compact?: boolean } = {},
): HTMLElement | null {
  if (isLicensed()) return null;
  const pill = parent.createEl("a", {
    cls: `it-buy-pill${opts.compact ? " is-compact" : ""}`,
    attr: {
      href: WEBSITE_URL,
      target: "_blank",
      rel: "noopener",
      "aria-label": t("buy.tooltip"),
      title: t("buy.tooltip"),
    },
  });
  const spark = pill.createSpan({ cls: "it-buy-pill-spark" });
  spark.innerHTML = SPARK_SVG;
  pill.createSpan({ cls: "it-buy-pill-label", text: t("buy.cta") });
  return pill;
}

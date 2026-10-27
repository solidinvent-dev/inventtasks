// Formatted overlay for native <input type="date"> / <input type="time">.
//
// Why this exists: Chromium (and therefore Obsidian) renders native date/time
// inputs in the OS locale and ignores both an explicit `lang` attribute and any
// app-level preference. So a "Date format" / "Time format" setting can never be
// honoured by the native control's own text. To make the setting actually work
// in the editable cells we keep the native input (for its picker, keyboard and
// mobile behaviour) but rebuild its chrome ourselves:
//
//   • A leading icon — calendar for dates, clock for times — sits in the
//     input's left padding and opens the native picker when clicked. It's
//     always visible (rest and edit), so the layout is always "icon then value".
//   • The native picker indicator (which lives on the right) is hidden.
//   • At rest the native text is hidden (::-webkit-datetime-edit transparent)
//     and our overlay shows the value in the configured format, after the icon.
//   • On focus the overlay hides and the native editable segments reappear so
//     typing still works exactly as before.
//
// The overlay text re-derives from the input's ISO value (`input.value` is
// always ISO regardless of locale), so it stays correct as the user edits.

import { setIcon } from "obsidian";
import { formatDate, formatTimeOfDay, uses24HourTime } from "../utils/dates";

export type DateTimeInputKind = "date" | "time" | "datetime";

export interface DateTimeInputHandle {
  reset(value: any): void;
}

export interface RenderDateTimeInputOptions {
  parent: HTMLElement;
  kind: DateTimeInputKind;
  value: any;
  onCommit: (value: string | null, handle: DateTimeInputHandle) => void;
  pairClass?: string;
  dateClass?: string;
  timeClass?: string;
  singleClass?: string | ((kind: Exclude<DateTimeInputKind, "datetime">) => string);
  stopClick?: boolean;
}

// Wraps an already-rendered native date/time input with a leading picker icon +
// a formatted value overlay. The input must already be attached to the DOM.
// Call once per input.
export function attachDateTimeOverlay(input: HTMLInputElement, kind: "date" | "time"): void {
  const parent = input.parentElement;
  if (!parent) return;

  // Insert a positioning host in the input's place, then move the input inside.
  const host = createSpan({ cls: "it-dtf-host it-dtf-host-" + kind });
  parent.insertBefore(host, input);
  host.appendChild(input);

  // Reserve room on the left for the leading icon. Inline style so it wins over
  // every context's padding rule (incl. the more-specific `.is-mobile` ones).
  input.style.paddingLeft = "20px";

  // Leading icon (calendar / clock) — opens the native picker on click and
  // stays visible while editing. The stylesheet positions it in the left pad.
  const icon = host.createSpan({ cls: "it-dtf-icon" });
  setIcon(icon, kind === "time" ? "clock" : "calendar");
  icon.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    input.focus();
    try { (input as any).showPicker?.(); } catch { /* unsupported — focus opens it on mobile */ }
  });

  // Formatted value, shown at rest; hidden on focus so the native editable
  // segments take over (see styles.css).
  const overlay = host.createSpan({ cls: "it-dtf-overlay" });
  const paint = () => {
    const v = input.value;
    if (v) {
      overlay.setText(kind === "time" ? formatTimeOfDay(v) : formatDate(v, { withTime: false }));
      overlay.removeClass("is-empty");
    } else {
      // Empty value: just the icon shows, so the field still reads as a
      // date/time field the user can click.
      overlay.setText("");
      overlay.addClass("is-empty");
    }
  };

  input.addEventListener("input", paint);
  input.addEventListener("change", paint);
  paint();
}

export function splitDateTimeValue(value: any): { date: string; time: string } {
  const s = String(value ?? "");
  if (!s) return { date: "", time: "" };
  const [date, time = ""] = s.split("T");
  return { date: date.slice(0, 10), time: time.slice(0, 5) };
}

export function normalizeDateTimeInputValue(value: any, kind: DateTimeInputKind): string {
  if (kind === "datetime") return splitDateTimeValue(value).date;
  const s = String(value ?? "");
  if (!s) return "";
  if (kind === "date") return s.slice(0, 10);
  return s.slice(0, 5);
}

export function dateTimeInputAttrs(): Record<string, string> {
  // `lang` is a hint for native edit segments. The overlay above is what
  // actually enforces the user's configured 24h/12h display format.
  return { lang: uses24HourTime() ? "en-GB" : "en-US" };
}

function singleClassFor(
  kind: Exclude<DateTimeInputKind, "datetime">,
  singleClass: RenderDateTimeInputOptions["singleClass"],
): string {
  if (typeof singleClass === "function") return singleClass(kind);
  if (typeof singleClass === "string") return singleClass;
  return `it-inline-datetime it-inline-kind-${kind}`;
}

export function renderDateTimeInput(opts: RenderDateTimeInputOptions): DateTimeInputHandle {
  const stop = (e: Event) => e.stopPropagation();

  if (opts.kind === "datetime") {
    const wrap = opts.parent.createSpan({ cls: opts.pairClass || "it-inline-datetime-pair" });
    const date = wrap.createEl("input", {
      type: "date",
      cls: opts.dateClass || "it-inline-datetime it-inline-kind-date",
      attr: dateTimeInputAttrs(),
    });
    const time = wrap.createEl("input", {
      type: "time",
      cls: opts.timeClass || "it-inline-datetime it-inline-kind-time",
      attr: dateTimeInputAttrs(),
    });
    attachDateTimeOverlay(date, "date");
    attachDateTimeOverlay(time, "time");
    const applyValue = (next: any) => {
      const parts = splitDateTimeValue(next);
      date.value = parts.date;
      time.value = parts.time;
      date.dispatchEvent(new Event("input"));
      time.dispatchEvent(new Event("input"));
    };
    let handle: DateTimeInputHandle;
    const commit = () => {
      const next = date.value ? (time.value ? `${date.value}T${time.value}` : date.value) : null;
      opts.onCommit(next, handle);
    };
    if (opts.stopClick) {
      date.addEventListener("click", stop);
      time.addEventListener("click", stop);
    }
    date.addEventListener("change", commit);
    time.addEventListener("change", commit);
    handle = { reset: applyValue };
    applyValue(opts.value);
    return handle;
  }

  const kind = opts.kind;
  const input = opts.parent.createEl("input", {
    type: kind,
    cls: singleClassFor(kind, opts.singleClass),
    attr: dateTimeInputAttrs(),
  });
  input.value = normalizeDateTimeInputValue(opts.value, kind);
  attachDateTimeOverlay(input, kind);
  if (opts.stopClick) input.addEventListener("click", stop);
  let handle: DateTimeInputHandle;
  handle = {
    reset(next) {
      input.value = normalizeDateTimeInputValue(next, kind);
      input.dispatchEvent(new Event("input"));
    },
  };
  input.addEventListener("change", () => opts.onCommit(input.value || null, handle));
  return handle;
}

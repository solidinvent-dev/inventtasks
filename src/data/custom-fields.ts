import { CustomFieldDef, TaskFile, parentTaskIds } from "../types";

export function isSecretCustomFieldType(type: string | undefined): boolean {
  return type === "secret_text" || type === "secret_textarea" || type === "secret_markdown";
}

export interface CustomFieldValueContext {
  subtaskStats?: Map<string, { total: number; done: number }>;
  allTasks?: TaskFile[];
  taskTitles?: Map<string, string>;
}

export function isEmptyCustomFieldValue(value: unknown): boolean {
  return value === undefined || value === null || value === "" ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0);
}

export function computeAutoProgress(
  task: TaskFile,
  field: CustomFieldDef,
  context: CustomFieldValueContext = {},
): number {
  if ((field.progress_source || "subtasks") === "checklist") {
    const items = Array.isArray(task.data.checklist) ? task.data.checklist : [];
    if (items.length === 0) return 0;
    return (items.filter((item) => item.done).length / items.length) * 100;
  }

  const prebuilt = context.subtaskStats?.get(task.data.id);
  if (prebuilt) return prebuilt.total ? (prebuilt.done / prebuilt.total) * 100 : 0;
  const subtasks = (context.allTasks || []).filter((candidate) => parentTaskIds(candidate.data).includes(task.data.id));
  if (subtasks.length === 0) return 0;
  const done = subtasks.filter((candidate) => candidate.data.status_group === "done" || candidate.data.status_group === "closed").length;
  return (done / subtasks.length) * 100;
}

export function effectiveCustomFieldValue(
  task: TaskFile,
  field: CustomFieldDef,
  context: CustomFieldValueContext = {},
): unknown {
  if (field.type === "progress_auto") return computeAutoProgress(task, field, context);
  return task.data.custom_fields?.[field.id];
}

function optionLabel(field: CustomFieldDef, raw: unknown): string {
  return field.options?.find((option) => (option.value ?? option.label) === raw || option.label === raw)?.label ?? String(raw);
}

export function customFieldText(
  field: CustomFieldDef,
  raw: unknown,
  context: CustomFieldValueContext = {},
): string {
  // Exports, filters and grouping must never stringify ciphertext or silently
  // leak a decrypted session value. Secret values are display-only there.
  if (isSecretCustomFieldType(field.type)) return "";
  if (isEmptyCustomFieldValue(raw)) return "";
  if (Array.isArray(raw)) {
    if (field.type === "attachment") return (raw as Array<{ name?: string } | null | undefined>).map((item) => item?.name).filter(Boolean).join("; ");
    if (field.type === "relationship") return raw.map((id) => context.taskTitles?.get(String(id)) || String(id)).join("; ");
    if (field.options) return raw.map((value) => optionLabel(field, value)).join("; ");
    return raw.map(String).join("; ");
  }
  if (field.type === "location" && typeof raw === "object") {
    const loc = raw as { label?: string; lat?: number | null; lng?: number | null; url?: string; value?: string };
    if (loc.label) return loc.label;
    if (loc.lat != null && loc.lng != null) return `${loc.lat}, ${loc.lng}`;
    if (loc.url) return loc.url;
    // Legacy LinkedValue fallback
    if (loc.value) return String(loc.label ?? loc.value);
    return "";
  }
  if (typeof raw === "object") {
    const obj = raw as { label?: string; value?: string; name?: string };
    return String(obj.label ?? obj.value ?? obj.name ?? JSON.stringify(raw));
  }
  if (field.type === "dropdown") return optionLabel(field, raw);
  if (field.type === "progress_manual" || field.type === "progress_auto") return `${Math.round(Number(raw) || 0)}%`;
  const scalar = raw as string | number | boolean;
  return String(scalar);
}

export function customFieldSortValue(
  field: CustomFieldDef,
  raw: unknown,
  context: CustomFieldValueContext = {},
): string | number | boolean | null {
  if (isSecretCustomFieldType(field.type)) return null;
  if (isEmptyCustomFieldValue(raw)) return null;
  if (typeof raw === "number" || typeof raw === "boolean") return raw;
  if (Array.isArray(raw)) {
    if (raw.length === 0) return null;
    if (field.type === "attachment") return String((raw as Array<{ name?: string } | null | undefined>)[0]?.name || "").toLowerCase();
    if (field.type === "relationship") return (context.taskTitles?.get(String(raw[0])) || String(raw[0])).toLowerCase();
    return optionLabel(field, raw[0]).toLowerCase();
  }
  return customFieldText(field, raw, context).toLowerCase();
}

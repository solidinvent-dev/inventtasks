// Canonical validation for core Item values. Native input attributes are only
// hints: paste, programmatic edits and some Electron versions can still emit a
// change event with invalid data, so every write path uses these real gates.

export const MAX_TASK_TITLE_LENGTH = 250;

export type TaskTitleValidation =
  | { valid: true; value: string }
  | { valid: false; reason: "required" | "too_long" };

export function validateTaskTitle(raw: unknown): TaskTitleValidation {
  const value = String(raw ?? "").trim();
  if (!value) return { valid: false, reason: "required" };
  if (value.length > MAX_TASK_TITLE_LENGTH) return { valid: false, reason: "too_long" };
  return { valid: true, value };
}

export type MetricValidation =
  | { valid: true; value: number | undefined }
  | { valid: false };

export function parseNonNegativeInteger(raw: unknown): MetricValidation {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return { valid: true, value: undefined };
  }
  const value = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isSafeInteger(value) || value < 0) return { valid: false };
  return { valid: true, value };
}

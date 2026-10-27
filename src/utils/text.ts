/**
 * Text form of a value read from frontmatter or user input. Scalars convert as
 * String() would; null/undefined become ""; anything else is shown as JSON
 * rather than as "[object Object]".
 */
export function scalarText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/**
 * Which parts of an Item the global search looks at.
 *
 * The always-on set — title, id, custom id, tags, context — is small, bounded
 * and already in memory, so it costs nothing per keystroke. Bodies and
 * custom-field values are different: they are unbounded user text, and matching
 * them means walking every Item's full content on each character typed. That is
 * fine on a small vault and noticeable on a large one, so both are opt-in and
 * default to off rather than being quietly enabled for everyone.
 */
export interface SearchScopeOptions {
  /** Match the Item's markdown body. */
  bodies?: boolean;
  /** Match the values stored in custom fields. */
  customFields?: boolean;
}

interface MatchableTask {
  title?: string | null;
  id?: string | null;
  custom_id?: string | null;
  tags?: string[] | null;
  context?: string[] | null;
  custom_fields?: Record<string, unknown> | null;
}

const has = (value: string | null | undefined, needle: string): boolean =>
  !!value && value.toLowerCase().includes(needle);

const anyHas = (values: string[] | null | undefined, needle: string): boolean =>
  (values ?? []).some((v) => has(v, needle));

/**
 * Flatten one custom-field value to searchable text. Values are strings,
 * numbers, booleans, lists of those, or objects (secret values, linked refs).
 * Objects are deliberately NOT stringified: a secret field holds ciphertext and
 * an iv, and matching those would both be useless and leak their shape into
 * results.
 */
function customFieldText(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value === "string") return [value];
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (Array.isArray(value)) return value.flatMap(customFieldText);
  return [];
}

/** True when the Item matches `query` under the given scope. `query` is lowercase. */
export function taskMatchesQuery(
  data: MatchableTask,
  body: string | null | undefined,
  query: string,
  opts: SearchScopeOptions = {},
): boolean {
  if (!query) return false;
  if (
    has(data.title, query) ||
    has(data.id, query) ||
    has(data.custom_id, query) ||
    anyHas(data.tags, query) ||
    anyHas(data.context, query)
  ) return true;

  if (opts.customFields) {
    for (const value of Object.values(data.custom_fields ?? {})) {
      if (customFieldText(value).some((text) => has(text, query))) return true;
    }
  }
  if (opts.bodies && has(body, query)) return true;
  return false;
}

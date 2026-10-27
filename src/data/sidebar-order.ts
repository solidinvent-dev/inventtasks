import type { SidebarOrder } from "../types";

/**
 * Whether every reference in a stored sidebar order can be resolved right now.
 *
 * The order is stored as portable refs and projected onto the tree for display;
 * anything that does not resolve is simply skipped when rendering. That is fine
 * for display and wrong for WRITING: converting the stored order to its portable
 * form round-trips it through the resolved set, so a reference that happens to be
 * unresolvable at this moment disappears — and once written back, a temporary
 * absence becomes a permanent loss of the user's ordering.
 *
 * A reference can be unresolvable for entirely ordinary reasons: sync has not
 * pulled that Space yet, a cloud-storage folder is still a placeholder, a
 * restore is in progress. So the migration asks this first and rewrites nothing
 * unless the whole order resolves; if something is missing it leaves the file
 * alone and tries again on a later load.
 */
export function sidebarOrderResolvesFully(
  stored: SidebarOrder | undefined,
  resolve: (ref: string, kinds?: Array<"space" | "folder" | "list" | "doc">) => string | undefined,
): boolean {
  if (!stored) return true;
  for (const ref of stored.spaces ?? []) {
    if (!resolve(ref, ["space"])) return false;
  }
  for (const [parentRef, childRefs] of Object.entries(stored.children ?? {})) {
    if (!resolve(parentRef, ["space", "folder"])) return false;
    for (const ref of childRefs ?? []) {
      if (!resolve(ref)) return false;
    }
  }
  return true;
}

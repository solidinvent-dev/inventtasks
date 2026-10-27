// Shared subtask-presentation model used by every view.
//
// A task is a "subtask" when it has a parent_task. Each view can choose how
// subtasks appear; we expose three modes (the third axis — collapsed vs
// expanded for nested — is a transient per-parent toggle, not a separate mode):
//
//   parents → only top-level tasks; subtasks hidden everywhere.
//   nested  → subtasks shown indented under their parent. Only row/tree views
//             (List, Table, Gantt) can actually indent; the flat views (Board,
//             Calendar, Timeline) treat "nested" like "parents" (subtasks live
//             under the parent, surfaced via its subtask-count badge).
//   flat    → subtasks shown as standalone tasks, grouped/sorted like any task.
//
// Grouping + sorting "follow" the mode automatically: callers pass an already
// filtered+sorted list, so nested siblings keep the active sort order, and
// nested grouping buckets only the roots (a parent + its subtasks stay together
// in the parent's group).

import { TaskFile, parentTaskIds } from "../types";

export type SubtaskMode = "parents" | "nested" | "flat";
export const DEFAULT_SUBTASK_MODE: SubtaskMode = "nested";

/** Max task depth index when nested subtasks enabled (0=root … 2=third level). */
export const NESTED_SUBTASK_MAX_DEPTH = 2;
/** Max task depth index when nested subtasks disabled (0=root, 1=direct subtask only). */
export const SINGLE_SUBTASK_MAX_DEPTH = 1;

export function maxSubtaskDepth(features: Record<string, boolean>): number {
  return features.nested_subtasks === false ? SINGLE_SUBTASK_MAX_DEPTH : NESTED_SUBTASK_MAX_DEPTH;
}

/** Depth of a task in the parent chain (root = 0). */
export function taskDepth(taskId: string, tasksById: Map<string, TaskFile>): number {
  let depth = 0;
  let cur: string | undefined = taskId;
  const seen = new Set<string>();
  while (cur) {
    if (seen.has(cur)) return depth;
    seen.add(cur);
    const tf = tasksById.get(cur);
    if (!tf) return depth;
    const parents = parentTaskIds(tf.data);
    if (!parents.length) return depth;
    depth++;
    cur = parents[0];
  }
  return depth;
}

/** Whether a new subtask may be attached to this parent given feature flags. */
export function canAttachSubtask(
  parentId: string,
  features: Record<string, boolean>,
  tasksById: Map<string, TaskFile>,
): boolean {
  return taskDepth(parentId, tasksById) < maxSubtaskDepth(features);
}

/**
 * True when `candidateId` sits somewhere below `ancestorId` in the subitem tree.
 *
 * Used to refuse a parent assignment that would close a loop — an Item nested
 * under itself, or under one of its own subitems. `taskDepth` stops such a loop
 * from hanging, but it cannot tell you the assignment was illegal in the first
 * place, so the check has to happen before the write.
 */
export function isDescendantOf(
  candidateId: string,
  ancestorId: string,
  tasksById: Map<string, TaskFile>,
): boolean {
  const seen = new Set<string>();
  let cur: string | undefined = candidateId;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    if (cur === ancestorId) return true;
    cur = parentTaskIds(tasksById.get(cur)?.data ?? {})[0];
  }
  return false;
}

export const SUBTASK_MODES: { value: SubtaskMode; label: string; icon: string; desc: string }[] = [
  { value: "parents", label: "Tasks only", icon: "list", desc: "Hide subtasks" },
  { value: "nested", label: "Subtasks nested", icon: "list-tree", desc: "Indented under their parent" },
  { value: "flat", label: "Subtasks as tasks", icon: "rows-3", desc: "Shown as standalone tasks" },
];

// Views that can indent → "nested" produces a real tree there. Elsewhere it
// collapses to "parents" semantics (see header).
const NESTABLE = new Set(["list", "table", "gantt"]);

export function normalizeSubtaskMode(v: unknown): SubtaskMode {
  if (v === "parents" || v === "nested" || v === "flat") return v;
  return DEFAULT_SUBTASK_MODE;
}

export function isSubtask(t: TaskFile): boolean {
  return parentTaskIds(t.data).length > 0;
}

// Whether subtasks should be INCLUDED in the task set for a given view+mode.
// (Inclusion is decided centrally; the actual indentation is a render concern
// handled by the nestable views.)
export function includeSubtasks(mode: SubtaskMode, viewType: string): boolean {
  if (mode === "flat") return true;
  if (mode === "nested") return NESTABLE.has(viewType);
  return false; // parents
}

export interface NestedRow { task: TaskFile; depth: number; hasChildren: boolean; }

export interface SubtaskTree {
  roots: TaskFile[];
  childrenOf: Map<string, TaskFile[]>;
  hasChildren: (id: string) => boolean;
}

// Build a parent→children tree over the VISIBLE set. A task whose parent isn't
// in the set becomes a root (nothing is orphaned). Input order is preserved, so
// siblings follow the caller's active sort. A multi-parent task attaches to its
// first visible parent (rendered once).
export function buildSubtaskTree(tasks: TaskFile[]): SubtaskTree {
  const visible = new Set(tasks.map((t) => t.data.id));
  const childrenOf = new Map<string, TaskFile[]>();
  const roots: TaskFile[] = [];
  for (const t of tasks) {
    const parent = parentTaskIds(t.data).find((p) => visible.has(p));
    if (!parent) roots.push(t);
    else {
      if (!childrenOf.has(parent)) childrenOf.set(parent, []);
      childrenOf.get(parent)!.push(t);
    }
  }
  return { roots, childrenOf, hasChildren: (id) => (childrenOf.get(id)?.length ?? 0) > 0 };
}

// DFS-flatten roots into depth-annotated rows. Collapsed parents hide their
// descendants. Guards cycles and runaway nesting.
export function flattenSubtaskRows(
  roots: TaskFile[],
  tree: SubtaskTree,
  collapsed?: Set<string>,
  maxDepth = 6,
): NestedRow[] {
  const out: NestedRow[] = [];
  const seen = new Set<string>();
  const walk = (t: TaskFile, depth: number) => {
    if (seen.has(t.data.id) || depth > maxDepth) return;
    seen.add(t.data.id);
    const kids = tree.childrenOf.get(t.data.id) || [];
    out.push({ task: t, depth, hasChildren: kids.length > 0 });
    if (collapsed?.has(t.data.id)) return;
    for (const c of kids) walk(c, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return out;
}

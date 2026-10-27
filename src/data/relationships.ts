// Single-source-of-truth model for task relationships.
//
// Storage rules:
//   - `blocks`  : stored on the BLOCKER. The downstream task (the one being
//                 blocked) is NOT touched. `waiting_on` is purely derived.
//   - `related` : stored on whichever task the user added it from. Symmetry
//                 is preserved at read time by unioning both sides.
//
// `waiting_on` does NOT exist in storage anymore — it is a view computed
// from inverse `blocks`. Setting "A waits on B" is the same write as
// "B blocks A".
//
// All writes go through `updateTask`, which is a single-file atomic write
// with optimistic in-memory update + emit. No more mirror batching.

import type { TaskFile } from "../types";
import type { WorkspaceIndex } from "./workspace-index";
import { appendActivity } from "./activity";

// ---------- Reads ----------

export function getBlocks(t: TaskFile): string[] {
  return t.data.relationships?.blocks ?? [];
}

export function getWaitingOn(t: TaskFile, idx: WorkspaceIndex): string[] {
  // Inverse of blocks: any task X that lists `t` in its blocks → t waits on X.
  return idx.allTasks()
    .filter((x) => x.data.id !== t.data.id && (x.data.relationships?.blocks ?? []).includes(t.data.id))
    .map((x) => x.data.id);
}

export function getRelated(t: TaskFile, idx: WorkspaceIndex): string[] {
  const own = t.data.relationships?.related ?? [];
  const inverse = idx.allTasks()
    .filter((x) => x.data.id !== t.data.id && (x.data.relationships?.related ?? []).includes(t.data.id))
    .map((x) => x.data.id);
  return Array.from(new Set([...own, ...inverse]));
}

// ---------- Writes ----------
// Each helper modifies exactly one file (single-source). Reads stay
// consistent because the inverse view is derived live.

// Writes the new value for `relationships[key]` and folds in an activity
// entry on the same task — all in one updateTask call (single file write,
// single emit). The activity entry is built by the caller because the
// meaning of "added/removed" differs per direction.
type Kind = "blocks" | "related";

async function setBucket(
  idx: WorkspaceIndex,
  taskId: string,
  key: Kind,
  mutate: (current: string[]) => string[] | undefined,
  activityEntry?: Parameters<typeof appendActivity>[1],
): Promise<void> {
  await idx.updateTask(taskId, (d) => {
    const cur = d.relationships?.[key] ?? [];
    const next = mutate(cur);
    if (next === undefined) return; // mutator signaled no-op
    const rels = { ...(d.relationships || {}) };
    if (next.length === 0) delete rels[key];
    else rels[key] = next;
    const out: any = { ...d, relationships: rels };
    if (activityEntry) out.activity = appendActivity(d.activity, activityEntry);
    return { data: out };
  });
}

// Logs a free-standing activity entry on a task without touching anything
// else. Used to mirror the "I took this action" perspective for actions
// whose canonical storage lives on a different task (waiting_on, related,
// subtask/parent on the partner side).
async function logOnly(
  idx: WorkspaceIndex,
  taskId: string,
  entry: Parameters<typeof appendActivity>[1],
): Promise<void> {
  await idx.updateTask(taskId, (d) => ({
    data: { ...d, activity: appendActivity(d.activity, entry) },
  }));
}

// "current blocks partner" → store partner.id under current.blocks
export async function addBlock(idx: WorkspaceIndex, currentId: string, partnerId: string): Promise<void> {
  if (currentId === partnerId) return;
  await setBucket(
    idx, currentId, "blocks",
    (cur) => cur.includes(partnerId) ? undefined : [...cur, partnerId],
    { kind: "blocks_added", id: partnerId },
  );
}

export async function removeBlock(idx: WorkspaceIndex, currentId: string, partnerId: string): Promise<void> {
  await setBucket(
    idx, currentId, "blocks",
    (cur) => cur.includes(partnerId) ? cur.filter((x) => x !== partnerId) : undefined,
    { kind: "blocks_removed", id: partnerId },
  );
}

// "current waits on partner" === "partner blocks current". Canonical
// storage write goes on the partner; second write logs the action on the
// current task so its activity reflects the user's perspective.
export async function addWaitingOn(idx: WorkspaceIndex, currentId: string, partnerId: string): Promise<void> {
  await addBlock(idx, partnerId, currentId);
  await logOnly(idx, currentId, { kind: "waiting_added", id: partnerId });
}

export async function removeWaitingOn(idx: WorkspaceIndex, currentId: string, partnerId: string): Promise<void> {
  await removeBlock(idx, partnerId, currentId);
  await logOnly(idx, currentId, { kind: "waiting_removed", id: partnerId });
}

// Related is symmetric — link is owned by whoever added it. Before writing
// we check both sides so we never end up with a redundant double-link.
// Activity is logged on BOTH sides so each task's history shows the link.
export async function addRelated(idx: WorkspaceIndex, currentId: string, partnerId: string): Promise<void> {
  if (currentId === partnerId) return;
  const cur = idx.tasksById.get(currentId);
  const other = idx.tasksById.get(partnerId);
  if (!cur || !other) return;
  if ((cur.data.relationships?.related ?? []).includes(partnerId)) return;
  if ((other.data.relationships?.related ?? []).includes(currentId)) return;
  await setBucket(
    idx, currentId, "related",
    (c) => [...c, partnerId],
    { kind: "related_added", id: partnerId },
  );
  await logOnly(idx, partnerId, { kind: "related_added", id: currentId });
}

// Remove related — link may live on either side; clean wherever found.
// Activity logged on both sides for symmetry.
export async function removeRelated(idx: WorkspaceIndex, currentId: string, partnerId: string): Promise<void> {
  const cur = idx.tasksById.get(currentId);
  const other = idx.tasksById.get(partnerId);
  if (cur && (cur.data.relationships?.related ?? []).includes(partnerId)) {
    await setBucket(
      idx, currentId, "related",
      (c) => c.filter((x) => x !== partnerId),
      { kind: "related_removed", id: partnerId },
    );
  } else {
    await logOnly(idx, currentId, { kind: "related_removed", id: partnerId });
  }
  if (other && (other.data.relationships?.related ?? []).includes(currentId)) {
    await setBucket(
      idx, partnerId, "related",
      (c) => c.filter((x) => x !== currentId),
      { kind: "related_removed", id: currentId },
    );
  } else {
    await logOnly(idx, partnerId, { kind: "related_removed", id: currentId });
  }
}

// Total relationship count for badge displays (Blocks + Waiting on + Related).
export function relationshipCount(t: TaskFile, idx: WorkspaceIndex): number {
  return getBlocks(t).length + getWaitingOn(t, idx).length + getRelated(t, idx).length;
}

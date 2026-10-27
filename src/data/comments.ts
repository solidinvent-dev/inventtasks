// Comments — manually authored, timestamped, markdown-bodied entries
// stored as a JSON array in a task's frontmatter under `comments`. Each
// operation is a single-file updateTask + folded activity log entry.

import type { CommentEntry, TaskData } from "../types";
import type { WorkspaceIndex } from "./workspace-index";
import { appendActivity } from "./activity";

function genId(): string {
  return `cmt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function snippet(text: string, max = 60): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

export async function addComment(idx: WorkspaceIndex, taskId: string, text: string): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;
  const entry: CommentEntry = {
    id: genId(),
    text: trimmed,
    created_at: new Date().toISOString(),
  };
  await idx.updateTask(taskId, (d: TaskData) => ({
    data: {
      ...d,
      comments: [...(d.comments ?? []), entry],
      activity: appendActivity(d.activity, { kind: "comment_added", id: entry.id, text: snippet(trimmed) }),
    },
  }));
}

export async function editComment(idx: WorkspaceIndex, taskId: string, commentId: string, newText: string): Promise<void> {
  const trimmed = newText.trim();
  if (!trimmed) return;
  await idx.updateTask(taskId, (d: TaskData) => {
    const list: CommentEntry[] = d.comments ?? [];
    const next = list.map((c) => c.id === commentId ? { ...c, text: trimmed, updated_at: new Date().toISOString() } : c);
    return {
      data: {
        ...d,
        comments: next,
        activity: appendActivity(d.activity, { kind: "comment_edited", id: commentId, text: snippet(trimmed) }),
      },
    };
  });
}

export async function removeComment(idx: WorkspaceIndex, taskId: string, commentId: string): Promise<void> {
  await idx.updateTask(taskId, (d: TaskData) => {
    const list: CommentEntry[] = d.comments ?? [];
    const target = list.find((c) => c.id === commentId);
    const next = list.filter((c) => c.id !== commentId);
    return {
      data: {
        ...d,
        comments: next.length ? next : undefined,
        activity: appendActivity(d.activity, {
          kind: "comment_removed",
          id: commentId,
          text: target ? snippet(target.text) : undefined,
        }),
      },
    };
  });
}

// Move a comment up or down by one position in the array. Order in the
// array is the order shown in the UI. Returns silently if already at the
// boundary or comment not found (no activity entry for reorders — too
// noisy and not really a "change" worth logging).
export async function moveComment(
  idx: WorkspaceIndex,
  taskId: string,
  commentId: string,
  direction: "up" | "down",
): Promise<void> {
  await idx.updateTask(taskId, (d: TaskData) => {
    const list: CommentEntry[] = (d.comments ?? []).slice();
    const i = list.findIndex((c) => c.id === commentId);
    if (i < 0) return;
    const j = direction === "up" ? i - 1 : i + 1;
    if (j < 0 || j >= list.length) return;
    const [item] = list.splice(i, 1);
    list.splice(j, 0, item);
    return { data: { ...d, comments: list } };
  });
}

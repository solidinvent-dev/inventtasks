import { WorkspaceIndex } from "./workspace-index";
import { addBlock, addRelated } from "./relationships";
import { t } from "../i18n";
import type { TaskData } from "../types";

// ===================================================================
// Basic starter — a tiny, welcoming starting point for a brand-new user.
// Intentionally minimal: one space, one list, a handful of tasks. No
// status/priority/field overrides anywhere — everything inherits from
// the workspace defaults so the user gets a clean baseline to learn on.
// ===================================================================
export async function bootstrapDemo(idx: WorkspaceIndex) {
  idx.bulk = true;
  try {
  // Ensure the workspace config exists with the default flat icon and name.
  if (!idx.workspace) {
    await idx.createWorkspaceConfig(t("demo.workspaceName"));
    await idx.scan();
  }
  if (idx.userSpaces.length > 0) return;

  // One welcoming space — no statusSet override, no custom fields, etc.
  // Lower levels inherit everything from the workspace.
  const personalPath = await idx.createSpace(t("demo.spaceName"), {
    icon: "home",
    color: "#6647F0",
    description: t("demo.spaceDesc"),
  });

  const inboxPath = await idx.createList(personalPath, t("demo.listName"), {
    icon: "list-todo",
    color: "#0091FF",
    description: t("demo.listDesc"),
    defaultView: "list",
  });

  await idx.scan();

  const today = new Date();
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const addDays = (n: number) => { const d = new Date(today); d.setDate(d.getDate() + n); return d; };

  // A short, encouraging series of tasks that nudge the user toward the
  // main affordances of the app without overwhelming them. Each title is
  // self-contained — there's no inheritance trickery or hidden setup.
  await idx.createTask({
    listPath: inboxPath,
    title: t("demo.taskWelcome"),
    priority: 2,
    due_date: fmt(addDays(0)),
  });
  await idx.createTask({
    listPath: inboxPath,
    title: t("demo.taskStatus"),
    priority: 3,
    due_date: fmt(addDays(1)),
  });
  await idx.createTask({
    listPath: inboxPath,
    title: t("demo.taskViews"),
    priority: 3,
    due_date: fmt(addDays(2)),
  });
  await idx.createTask({
    listPath: inboxPath,
    title: t("demo.taskNew"),
    priority: 3,
    due_date: fmt(addDays(3)),
  });
  await idx.createTask({
    listPath: inboxPath,
    title: t("demo.taskDone"),
    priority: 4,
    due_date: fmt(addDays(4)),
  });

  await idx.scan();
  } finally { idx.bulk = false; }
}

// ===================================================================
// Rich tester demo — exercises essentially every feature of the app within
// free-plan limits: 1 space, 1 folder, 3 lists and 25 active tasks with
// custom statuses/fields, subtasks, relationships, docs and recurring work.
// ===================================================================
export async function bootstrapRichDemo(idx: WorkspaceIndex) {
  idx.bulk = true;
  try {
  if (!idx.workspace) {
    await idx.createWorkspaceConfig(t("demo.workspaceName"));
    await idx.scan();
  }

  // Seed a richer tag palette at workspace level so tasks in every space
  // pull from the same vocabulary. Idempotent: only seeds new entries.
  const existingTags = new Set((idx.workspace?.tags_palette || []).map((t) => t.name));
  const wantTags = [
    { name: "urgent",        color: "#EF4444" },
    { name: "blocked",       color: "#F97316" },
    { name: "backend",       color: "#3B82F6" },
    { name: "frontend",      color: "#22C55E" },
    { name: "auth",          color: "#8B5CF6" },
    { name: "design",        color: "#EC4899" },
    { name: "research",      color: "#14B8A6" },
    { name: "docs",          color: "#0EA5E9" },
    { name: "qa",            color: "#F59E0B" },
    { name: "mobile",        color: "#FB7185" },
    { name: "infra",         color: "#64748B" },
    { name: "health",        color: "#10B981" },
    { name: "errands",       color: "#A855F7" },
    { name: "fun",           color: "#F472B6" },
    { name: "writing",       color: "#06B6D4" },
    { name: "open-source",   color: "#84CC16" },
  ];
  const newTags = wantTags.filter((t) => !existingTags.has(t.name));
  if (newTags.length > 0) {
    await idx.updateWorkspaceConfig({
      tags_palette: [...(idx.workspace?.tags_palette || []), ...newTags],
    });
    await idx.scan();
  }

  const today = new Date();
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const fmtDateTime = (d: Date) => d.toISOString();
  const addDays = (n: number) => {
    const d = new Date(today);
    d.setDate(d.getDate() + n);
    return d;
  };

  // Helper: create a task then patch in the richer fields createTask
  // doesn't expose directly (start_date, time tracking, sprint points,
  // custom fields, relationships, body markdown, etc.). Returns the task ID.
  const richTask = async (opts: {
    listPath: string;
    title: string;
    type?: string;
    status?: string;
    priority?: 1 | 2 | 3 | 4 | null;
    due_date?: string;
    start_date?: string;
    tags?: string[];
    context?: string[];
    time_estimate?: number;
    time_tracked?: number;
    sprint_points?: number;
    custom_fields?: Record<string, unknown>;
    parent_task?: string;
    relationships?: { blocks?: string[]; waiting_on?: string[]; related?: string[] };
    recurring?: { enabled: boolean; pattern: "daily" | "weekly" | "monthly" | "yearly"; every?: number; on?: string[]; day_of_month?: number };
    checklist?: { text: string; done?: boolean }[];
    comments?: { text: string; ago_days?: number }[];
    body?: string;
    icon?: string;
  }): Promise<string> => {
    const tf = await idx.createTask({
      listPath: opts.listPath,
      title: opts.title,
      type: opts.type,
      status: opts.status,
      priority: opts.priority ?? null,
      due_date: opts.due_date,
      tags: opts.tags,
      context: opts.context,
      parent_task: opts.parent_task,
    });
    const extras: Partial<TaskData> = {};
    if (opts.start_date !== undefined) extras.start_date = opts.start_date;
    if (opts.time_estimate !== undefined) extras.time_estimate = opts.time_estimate;
    if (opts.time_tracked !== undefined) extras.time_tracked = opts.time_tracked;
    if (opts.sprint_points !== undefined) extras.sprint_points = opts.sprint_points;
    if (opts.custom_fields !== undefined) extras.custom_fields = opts.custom_fields;
    if (opts.icon !== undefined) extras.icon = opts.icon;
    if (opts.recurring !== undefined) extras.recurring = opts.recurring;
    if (opts.checklist !== undefined) {
      extras.checklist = opts.checklist.map((c, i) => ({
        id: `cl-${tf.data.id.toLowerCase()}-${i}`,
        text: c.text,
        done: !!c.done,
      }));
    }
    if (opts.comments !== undefined) {
      extras.comments = opts.comments.map((c, i) => {
        const ts = fmtDateTime(addDays(-(c.ago_days ?? 0)));
        return { id: `cm-${tf.data.id.toLowerCase()}-${i}`, text: c.text, created_at: ts };
      });
    }
    if (Object.keys(extras).length > 0 || opts.body) {
      await idx.updateTask(tf.data.id, (d: TaskData) => ({
        data: { ...d, ...extras },
        body: opts.body,
      }));
    }
    // Relationships now go through the single-source helpers so the demo
    // data uses the same canonical storage shape as user-edited data:
    //   blocks      → store on the new task (it blocks the partner)
    //   waiting_on  → store on the partner as `blocks: [new]` (inverse)
    //   related     → store on the new task (owner-of-link convention)
    if (opts.relationships) {
      for (const blockedId of opts.relationships.blocks ?? []) {
        await addBlock(idx, tf.data.id, blockedId);
      }
      for (const upstreamId of opts.relationships.waiting_on ?? []) {
        await addBlock(idx, upstreamId, tf.data.id);
      }
      for (const relId of opts.relationships.related ?? []) {
        await addRelated(idx, tf.data.id, relId);
      }
    }
    return tf.data.id;
  };

  // Helper: create a Doc at a location (list / folder / space) with one or more
  // pages carrying real markdown. The first page reuses the auto-created starter
  // page; subsequent ones are added (optionally nested under a parent). Returns
  // the new doc_id so it can be referenced from doc_relationship custom fields.
  const seedDoc = async (opts: {
    name: string;
    location: { listPath?: string; folderPath?: string; spacePath?: string };
    locationKey: string;
    icon?: string;
    color?: string;
    pages: { title: string; body: string; children?: { title: string; body: string }[] }[];
  }): Promise<string> => {
    const docId = await idx.createDoc(opts.name, opts.location, opts.locationKey, { icon: opts.icon, color: opts.color });
    // The auto-created starter page becomes the first authored page.
    const starter = idx.pagesForDoc(docId)[0];
    for (let i = 0; i < opts.pages.length; i++) {
      const spec = opts.pages[i];
      let pageId: string | undefined;
      if (i === 0 && starter) {
        await idx.updatePage(starter.page_id, { title: spec.title });
        pageId = starter.page_id;
      } else {
        pageId = await idx.createPage(docId, { title: spec.title });
      }
      if (pageId) await idx.setPageBody(pageId, spec.body);
      for (const child of spec.children ?? []) {
        const childId = await idx.createPage(docId, { title: child.title, parent_page: pageId });
        if (childId) await idx.setPageBody(childId, child.body);
      }
    }
    return docId;
  };

  // ============ Free-plan friendly rich demo ============
  // Exactly: 1 Space, 1 Folder, 3 Lists, 25 non-done/non-closed tasks.
  const workPath = await idx.createSpace("Product Lab", {
    icon: "rocket",
    color: "#0091FF",
    description: "A compact workspace that demonstrates InventTasks without exceeding free-plan limits.",
  });

  await idx.updateSpaceConfig(workPath, {
    status_set: [
      { id: "backlog", name: "Backlog", group: "not_started", color: "#9E9E9E", order: 0, is_default: true },
      { id: "todo", name: "To Do", group: "active", color: "#2196F3", order: 1 },
      { id: "in_progress", name: "In Progress", group: "active", color: "#FF9800", order: 2 },
      { id: "review", name: "Review", group: "active", color: "#9C27B0", order: 3 },
      { id: "done", name: "Done", group: "done", color: "#4CAF50", order: 4 },
      { id: "closed", name: "Closed", group: "closed", color: "#2E7D32", order: 5 },
    ],
    custom_fields: [
      {
        id: "cf_client", name: "Client", type: "dropdown",
        options: [
          { value: "acme", label: "ACME", color: "#3B82F6" },
          { value: "globex", label: "Globex", color: "#8B5CF6" },
          { value: "initech", label: "Initech", color: "#22C55E" },
        ],
      },
      {
        id: "cf_effort", name: "Effort", type: "dropdown",
        options: [
          { value: "xs", label: "XS", color: "#22C55E" },
          { value: "s", label: "S", color: "#84CC16" },
          { value: "m", label: "M", color: "#F59E0B" },
          { value: "l", label: "L", color: "#F97316" },
          { value: "xl", label: "XL", color: "#EF4444" },
        ],
      },
      { id: "cf_billable", name: "Billable", type: "checkbox" },
      { id: "cf_spec_url", name: "Spec", type: "url" },
      { id: "cf_completion", name: "Completion", type: "progress_auto", progress_source: "subtasks" },
      { id: "cf_ship_date", name: "Target ship", type: "date" },
      { id: "cf_owner_email", name: "Owner", type: "email" },
      { id: "cf_reference_doc", name: "Reference doc", type: "doc_relationship" },
    ],
  });

  const sprintFolderPath = await idx.createFolder(workPath, "Launch Plan", {
    icon: "zap",
    color: "#F59E0B",
  });

  const backlogPath = await idx.createList(sprintFolderPath, "Backlog", {
    icon: "list-todo",
    color: "#0EA5E9",
    description: "Ideas, stories and bugs waiting to be pulled into the launch.",
    defaultView: "board",
  });

  const buildPath = await idx.createList(sprintFolderPath, "Build", {
    icon: "hammer",
    color: "#22C55E",
    description: "Implementation work currently moving through the workflow.",
    defaultView: "list",
  });

  const opsPath = await idx.createList(sprintFolderPath, "Operations", {
    icon: "calendar-check",
    color: "#EC4899",
    description: "Meetings, release tasks and operational follow-up.",
    defaultView: "calendar",
  });

  await idx.updateListConfig(opsPath, {
    custom_fields: [
      { id: "cf_meet_time", name: "Time", type: "time" },
      { id: "cf_meet_link", name: "Call link", type: "url" },
      { id: "cf_meet_room", name: "Room", type: "text" },
    ],
  });

  await idx.scan();

  const engHandbookDoc = await seedDoc({
    name: "Launch handbook",
    location: { spacePath: workPath },
    locationKey: `space:${workPath}`,
    icon: "book-marked",
    color: "#0091FF",
    pages: [
      {
        title: "Overview",
        body: "\n# Launch handbook\n\nThe single source of truth for how this sample team ships a product launch.\n",
        children: [
          { title: "Onboarding checklist", body: "\n# Onboarding checklist\n\n- [x] Vault access\n- [x] Install toolchain\n- [ ] Pair on a starter ticket\n- [ ] Ship first PR\n" },
          { title: "Definition of done", body: "\n# Definition of done\n\n1. Code reviewed and merged\n2. Tests green in CI\n3. Docs updated\n4. Released behind a flag\n" },
        ],
      },
      {
        title: "Release process",
        body: "\n# Release process\n\n`main -> staging -> canary (5%) -> 100%`\n",
      },
    ],
  });

  const launchSpecDoc = await seedDoc({
    name: "Launch spec",
    location: { folderPath: sprintFolderPath },
    locationKey: `folder:${sprintFolderPath}`,
    icon: "file-lock-2",
    color: "#8B5CF6",
    pages: [
      {
        title: "Goals & scope",
        body: "\n# Product launch — goals & scope\n\nShip the first public version with onboarding, notifications and a small set of polished workflows.\n",
      },
      {
        title: "Sequence",
        body: "\n# Sequence\n\n1. Finalize scope\n2. Build core flows\n3. Run QA\n4. Prepare launch materials\n5. Publish and monitor feedback\n",
      },
    ],
  });

  const storyOnboarding = await richTask({
    listPath: backlogPath, title: "Design first-run onboarding flow",
    type: "story", priority: 1, status: "in_progress",
    start_date: fmt(addDays(-3)), due_date: fmt(addDays(4)),
    time_estimate: 16 * 60, time_tracked: 6 * 60, sprint_points: 8,
    tags: ["frontend", "design"], context: ["BUSINESS"],
    custom_fields: {
      cf_client: "acme",
      cf_effort: "l",
      cf_billable: true,
      cf_spec_url: { label: "Launch spec", value: "https://example.com/launch-spec" },
      cf_ship_date: fmt(addDays(4)),
      cf_owner_email: { label: "Alice (tech lead)", value: "alice@acme.example" },
      cf_reference_doc: [launchSpecDoc],
    },
    checklist: [
      { text: "Empty workspace choice", done: true },
      { text: "Minimal demo option", done: true },
      { text: "Full demo option", done: false },
      { text: "Mobile copy review", done: false },
    ],
    comments: [
      { text: "Keep the first-run choice simple: empty, minimal or full demo.", ago_days: 3 },
      { text: "Make sure mobile users can read every button.", ago_days: 1 },
    ],
    body: "\n# Design first-run onboarding flow\n\nLet a new user choose how much starter content to create.\n",
  });

  const bugMobile = await richTask({
    listPath: backlogPath, title: "Fix mobile bottom-bar overlap",
    type: "bug", priority: 1, status: "todo",
    start_date: fmt(addDays(0)), due_date: fmt(addDays(2)),
    time_estimate: 3 * 60, time_tracked: 30, sprint_points: 2,
    tags: ["frontend", "mobile", "urgent"], context: ["BUSINESS"],
    custom_fields: { cf_client: "globex", cf_effort: "s", cf_billable: true },
  });

  await richTask({
    listPath: backlogPath, title: "Write backup restore checklist",
    type: "task", priority: 2, status: "review",
    start_date: fmt(addDays(-4)), due_date: fmt(addDays(1)),
    time_estimate: 6 * 60, time_tracked: 5 * 60, sprint_points: 3,
    tags: ["docs", "qa"], context: ["BUSINESS"],
    custom_fields: { cf_client: "initech", cf_effort: "m", cf_billable: false },
    relationships: { blocks: [bugMobile] },
  });

  await richTask({
    listPath: backlogPath, title: "Finalize import/export copy",
    type: "story", priority: 2, status: "todo",
    start_date: fmt(addDays(1)), due_date: fmt(addDays(8)),
    time_estimate: 8 * 60, sprint_points: 5,
    tags: ["docs"], context: ["BUSINESS"],
    custom_fields: { cf_client: "acme", cf_effort: "xl", cf_billable: true },
    relationships: { waiting_on: [storyOnboarding] },
  });

  await richTask({
    listPath: backlogPath, title: "Review calendar sync warnings",
    type: "story", priority: 3, status: "in_progress",
    start_date: fmt(addDays(-2)), due_date: fmt(addDays(5)),
    time_estimate: 10 * 60, time_tracked: 4 * 60, sprint_points: 5,
    tags: ["backend", "qa"], context: ["BUSINESS"],
    custom_fields: { cf_client: "globex", cf_effort: "m", cf_billable: true },
  });

  await richTask({ listPath: backlogPath, parent_task: storyOnboarding, title: "Empty workspace option", type: "task", priority: 2, status: "done", due_date: fmt(addDays(-1)), time_estimate: 90, time_tracked: 75, tags: ["frontend"] });
  await richTask({ listPath: backlogPath, parent_task: storyOnboarding, title: "Minimal demo option", type: "task", priority: 2, status: "in_progress", due_date: fmt(addDays(1)), time_estimate: 90, time_tracked: 30, tags: ["frontend"] });
  await richTask({ listPath: backlogPath, parent_task: storyOnboarding, title: "Full demo option", type: "task", priority: 1, status: "todo", due_date: fmt(addDays(3)), time_estimate: 4 * 60, sprint_points: 3, tags: ["frontend"] });

  await richTask({ listPath: buildPath, title: "Implement external notification defaults", type: "task", priority: 2, status: "in_progress", start_date: fmt(addDays(-1)), due_date: fmt(addDays(3)), time_estimate: 5 * 60, time_tracked: 2 * 60, sprint_points: 3, tags: ["backend"], context: ["BUSINESS"], custom_fields: { cf_client: "acme", cf_effort: "m", cf_billable: true } });
  await richTask({ listPath: buildPath, title: "Wire incremental backup restore modal", type: "task", priority: 2, status: "todo", start_date: fmt(addDays(0)), due_date: fmt(addDays(4)), time_estimate: 4 * 60, sprint_points: 3, tags: ["backend", "qa"], context: ["BUSINESS"], custom_fields: { cf_client: "initech", cf_effort: "m", cf_billable: false } });
  await richTask({ listPath: buildPath, title: "Polish board card density", type: "task", priority: 3, status: "todo", start_date: fmt(addDays(2)), due_date: fmt(addDays(6)), time_estimate: 3 * 60, sprint_points: 2, tags: ["frontend", "design"], context: ["BUSINESS"], custom_fields: { cf_client: "globex", cf_effort: "s", cf_billable: true } });
  await richTask({ listPath: buildPath, title: "Add Health panel duplicate-ID repair", type: "task", priority: 2, status: "review", start_date: fmt(addDays(-2)), due_date: fmt(addDays(1)), time_estimate: 2 * 60, time_tracked: 110, sprint_points: 2, tags: ["backend", "qa"], context: ["BUSINESS"], custom_fields: { cf_client: "globex", cf_effort: "s", cf_billable: true } });
  await richTask({ listPath: buildPath, title: "Improve saved view defaults", type: "task", priority: 3, status: "todo", start_date: fmt(addDays(1)), due_date: fmt(addDays(7)), time_estimate: 2 * 60, sprint_points: 2, tags: ["frontend"], context: ["BUSINESS"], custom_fields: { cf_client: "acme", cf_effort: "s", cf_billable: true } });
  await richTask({ listPath: buildPath, title: "Tune recurring task projection", type: "task", priority: 3, status: "in_progress", start_date: fmt(addDays(-1)), due_date: fmt(addDays(5)), time_estimate: 3 * 60, time_tracked: 45, sprint_points: 2, tags: ["backend"], context: ["BUSINESS"], recurring: { enabled: true, pattern: "weekly", every: 1, on: ["mon", "wed"] }, custom_fields: { cf_client: "initech", cf_effort: "s", cf_billable: false } });
  await richTask({ listPath: buildPath, title: "Validate table column calculations", type: "task", priority: 3, status: "todo", start_date: fmt(addDays(2)), due_date: fmt(addDays(8)), time_estimate: 2 * 60, sprint_points: 2, tags: ["qa"], context: ["BUSINESS"], custom_fields: { cf_client: "initech", cf_effort: "xs", cf_billable: false } });
  await richTask({ listPath: buildPath, title: "Refine docs page tree drag targets", type: "task", priority: 4, status: "todo", start_date: fmt(addDays(3)), due_date: fmt(addDays(9)), time_estimate: 2 * 60, sprint_points: 1, tags: ["frontend", "docs"], context: ["BUSINESS"], custom_fields: { cf_client: "globex", cf_effort: "s", cf_billable: true, cf_reference_doc: [engHandbookDoc] } });

  await richTask({ listPath: opsPath, title: "Sprint planning", type: "meeting", priority: 2, due_date: fmt(addDays(1)), start_date: fmt(addDays(1)), time_estimate: 90, tags: [], context: ["BUSINESS"], status: "todo", custom_fields: { cf_meet_time: "10:00", cf_meet_link: { label: "Meet", value: "https://meet.example.com/sprint" }, cf_meet_room: "Helsinki" } });
  await richTask({ listPath: opsPath, title: "1:1 with Alice", type: "meeting", priority: 3, due_date: fmt(addDays(2)), start_date: fmt(addDays(2)), time_estimate: 30, context: ["BUSINESS"], status: "todo", custom_fields: { cf_meet_time: "14:30", cf_meet_room: "Phone booth 2" } });
  await richTask({ listPath: opsPath, title: "Architecture review", type: "meeting", priority: 2, due_date: fmt(addDays(4)), start_date: fmt(addDays(4)), time_estimate: 60, tags: ["backend"], context: ["BUSINESS"], status: "todo", custom_fields: { cf_meet_time: "11:00", cf_meet_link: { value: "https://meet.example.com/arch" } }, comments: [{ text: "Bring the launch sequence diagram.", ago_days: 0 }] });
  await richTask({ listPath: opsPath, title: "Prepare release notes draft", type: "task", priority: 2, status: "todo", due_date: fmt(addDays(6)), time_estimate: 90, tags: ["docs"], context: ["BUSINESS"], custom_fields: { cf_client: "acme", cf_effort: "s", cf_billable: true } });
  await richTask({ listPath: opsPath, title: "Collect QA sign-off", type: "task", priority: 2, status: "todo", due_date: fmt(addDays(7)), time_estimate: 60, tags: ["qa"], context: ["BUSINESS"], custom_fields: { cf_client: "initech", cf_effort: "s", cf_billable: false } });
  await richTask({ listPath: opsPath, title: "Monitor launch-day feedback", type: "task", priority: 1, status: "backlog", due_date: fmt(addDays(10)), time_estimate: 2 * 60, sprint_points: 3, tags: ["qa"], context: ["BUSINESS"], custom_fields: { cf_client: "globex", cf_effort: "m", cf_billable: true, cf_ship_date: fmt(addDays(10)) } });
  await richTask({ listPath: opsPath, title: "Schedule post-launch retro", type: "task", priority: 3, status: "backlog", due_date: fmt(addDays(12)), time_estimate: 45, tags: ["docs"], context: ["BUSINESS"], custom_fields: { cf_client: "acme", cf_effort: "xs", cf_billable: false } });
  await richTask({ listPath: opsPath, title: "Publish launch FAQ", type: "task", priority: 2, status: "todo", due_date: fmt(addDays(8)), time_estimate: 2 * 60, tags: ["docs"], context: ["BUSINESS"], custom_fields: { cf_client: "globex", cf_effort: "s", cf_billable: true } });
  await richTask({ listPath: opsPath, title: "Smoke-test mobile views", type: "task", priority: 2, status: "in_progress", due_date: fmt(addDays(3)), time_estimate: 90, time_tracked: 20, tags: ["mobile", "qa"], context: ["BUSINESS"], custom_fields: { cf_client: "initech", cf_effort: "s", cf_billable: false } });
  await richTask({ listPath: opsPath, title: "Record demo walkthrough", type: "task", priority: 3, status: "todo", due_date: fmt(addDays(9)), time_estimate: 60, tags: ["docs"], context: ["BUSINESS"], custom_fields: { cf_client: "acme", cf_effort: "xs", cf_billable: false } });

  await idx.scan();
  } finally { idx.bulk = false; }
}

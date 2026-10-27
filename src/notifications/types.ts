// ---------- Notifications module — type definitions ----------
//
// The notification system is split into three clearly-owned layers:
//
//  1. ACCOUNTS (plugin-wide, data.json): the physical delivery endpoints —
//     one ntfy server/topic. Secrets are protected
//     via secure-storage before hitting disk.
//  2. CONFIG (per workspace, data.json): what the user wants — master switch,
//     per-channel toggles, triggers. Plain device-local settings; never
//     round-tripped through vault files, so UI toggles can't be reverted by
//     a stale file merge.
//  3. RUNTIME STATE (per workspace, vault-synced `_workspace-state.md`):
//     what already happened — the sent-dedup map, the dispatch history and
//     the last channel error. Synced across devices so two clients don't
//     double-send; merged strictly IN PLACE (see store.ts) so live object
//     references never go stale.

export type NotifChannel = "system" | "ntfy";

export const NOTIF_CHANNELS: NotifChannel[] = ["system", "ntfy"];

// ---- Accounts (global, data.json) ----

export interface NtfyAccount {
  serverUrl: string;    // default: https://ntfy.sh
  topic: string;        // the topic phones subscribe to
  authToken?: string;   // optional Bearer token for private topics
}

export function defaultNtfyAccount(): NtfyAccount {
  return { serverUrl: "https://ntfy.sh", topic: "" };
}

// ---- Per-workspace config (data.json) ----

export interface TriggerConfig {
  enabled: boolean;
  channels: NotifChannel[];
}

export interface BeforeDueTriggerConfig extends TriggerConfig {
  minutesBefore: number[];  // active tiers: 15, 60, 1440
}

export interface DigestTriggerConfig extends TriggerConfig {
  time: string;             // "HH:MM", 24-hour
}

export interface WorkspaceNotifConfig {
  enabled: boolean;
  /** Per-channel master toggles for this workspace. A channel that is off here
   *  never sends, regardless of trigger channel lists. */
  channels: { system: boolean; ntfy: boolean };
  triggers: {
    /** Task past its due date (re-fires once per day until done). */
    overdue: TriggerConfig;
    /** Explicit alarm — an item in the Reminders system list reaching its time. */
    reminder: TriggerConfig;
    /** Pre-due warnings at the configured tiers (15 min / 1 h / 1 d …). */
    before_due: BeforeDueTriggerConfig;
    /** Task's start time arriving. */
    started: TriggerConfig;
    /** Once-a-day summary at a fixed time. */
    digest: DigestTriggerConfig;
  };
}

export function defaultWorkspaceNotifConfig(): WorkspaceNotifConfig {
  return {
    enabled: false,
    channels: { system: true, ntfy: false },
    triggers: {
      overdue: { enabled: true, channels: ["system", "ntfy"] },
      reminder: { enabled: true, channels: ["system", "ntfy"] },
      before_due: { enabled: true, channels: ["system", "ntfy"], minutesBefore: [15, 60, 1440] },
      started: { enabled: false, channels: ["system", "ntfy"] },
      digest: { enabled: false, channels: ["system", "ntfy"], time: "08:00" },
    },
  };
}

/** Deep-default a (possibly partial / older) persisted config from data.json. */
export function normalizeWorkspaceNotifConfig(partial?: Partial<WorkspaceNotifConfig>): WorkspaceNotifConfig {
  const def = defaultWorkspaceNotifConfig();
  const channels = (list: unknown): NotifChannel[] | undefined =>
    Array.isArray(list) ? (list.filter((c) => NOTIF_CHANNELS.includes(c as NotifChannel)) as NotifChannel[]) : undefined;
  const trigger = <T extends TriggerConfig>(def: T, raw?: Partial<T>): T => ({
    ...def,
    ...(raw || {}),
    enabled: typeof raw?.enabled === "boolean" ? raw.enabled : def.enabled,
    channels: channels(raw?.channels) ?? def.channels,
  });
  const rawTriggers = partial?.triggers;
  return {
    enabled: typeof partial?.enabled === "boolean" ? partial.enabled : def.enabled,
    channels: {
      system: typeof partial?.channels?.system === "boolean" ? partial.channels.system : def.channels.system,
      ntfy: typeof partial?.channels?.ntfy === "boolean" ? partial.channels.ntfy : def.channels.ntfy,
    },
    triggers: {
      overdue: trigger(def.triggers.overdue, rawTriggers?.overdue),
      reminder: trigger(def.triggers.reminder, rawTriggers?.reminder),
      before_due: {
        ...trigger(def.triggers.before_due, rawTriggers?.before_due),
        minutesBefore: Array.isArray(rawTriggers?.before_due?.minutesBefore)
          ? rawTriggers.before_due.minutesBefore.filter((m) => Number.isFinite(m) && m > 0)
          : def.triggers.before_due.minutesBefore,
      },
      started: trigger(def.triggers.started, rawTriggers?.started),
      digest: {
        ...trigger(def.triggers.digest, rawTriggers?.digest),
        time: typeof rawTriggers?.digest?.time === "string" ? rawTriggers.digest.time : def.triggers.digest.time,
      },
    },
  };
}

// ---- Runtime state (vault-synced) ----

export interface NotifChannelResult {
  channel: NotifChannel;
  ok: boolean;
  message?: string;
}

/** Display kind of a history entry. Before-due tiers are recorded as
 *  "reminder" with `minutesBefore` set; explicit alarms have it unset. */
export type NotifHistoryKind = "overdue" | "reminder" | "started" | "digest" | "batch";

export interface NotifHistoryItem {
  kind: "overdue" | "reminder" | "started";
  taskId?: string;
  taskTitle?: string;
  listPath?: string;
  minutesBefore?: number;
}

/** One row in the Notifications → History tab: a single dispatch attempt with
 *  the per-channel outcome (ok / failed). Every attempt is recorded — including
 *  total failures, which the UI shows with red channel icons. */
export interface NotifHistoryEntry {
  /** Unique id — makes cross-device history merging trivial. */
  id: string;
  ts: string;
  kind: NotifHistoryKind;
  /** Per-channel delivery result, in display order. */
  channels: NotifChannelResult[];
  taskId?: string;
  taskTitle?: string;
  listPath?: string;
  minutesBefore?: number;
  /** digest / batch: number of tasks summarised. */
  count?: number;
  /** batch: the individual task notifications merged into this send. */
  items?: NotifHistoryItem[];
  /** Consecutive identical failed attempts coalesced into this entry. */
  attempts?: number;
}

export interface NotifRuntimeState {
  /** Dedup log: notification key → ISO timestamp of last send. */
  sent: Record<string, string>;
  /** Dispatch log, newest first. */
  history: NotifHistoryEntry[];
  /** Tombstone for "Clear history": merges drop entries at/before this time,
   *  so cleared entries can't be resurrected from another device's file. */
  historyClearedAt?: string;
  /** Last channel failure — surfaced in settings / health diagnostics. */
  lastError?: { ts: string; channel: NotifChannel; message: string };
  lastDigestDate?: string;   // "YYYY-MM-DD" of the last digest sent
  lastDigestTime?: string;   // "HH:MM" slot used on that date
}

export function defaultNotifRuntimeState(): NotifRuntimeState {
  return { sent: {}, history: [] };
}

// ---- Notification payload (internal, passed to channels) ----

export interface NotifPayload {
  title: string;
  body: string;
  /** Priority 1(min) – 5(max), ntfy-compatible. */
  priority: 1 | 2 | 3 | 4 | 5;
  /** Emoji tags for ntfy. */
  tags?: string[];
  /** Deep link opened on click. */
  clickUrl?: string;
}

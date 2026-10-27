import { requestUrl } from "obsidian";
import { taskHash, taskToVTodo, taskToVEvent } from "./ics";
import type { TaskFile } from "../types";
import type { CalDavConfig, SyncedEventEntry } from "./types";

const CRLF = "\r\n";

function basicAuth(username: string, password: string): string {
  return "Basic " + btoa(`${username}:${password}`);
}

function caldavHeaders(config: CalDavConfig, extra?: Record<string, string>): Record<string, string> {
  return {
    Authorization: basicAuth(config.username, config.password),
    "Content-Type": "text/calendar; charset=utf-8",
    ...extra,
  };
}

/** List existing InventTasks events (by UID prefix) from CalDAV server. */
async function listExistingEvents(
  config: CalDavConfig,
  calPath: string,
): Promise<Record<string, string>> {
  const compName = config.eventFormat === "vevent" ? "VEVENT" : "VTODO";
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:getetag/>
    <C:calendar-data/>
  </D:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      <C:comp-filter name="${compName}"/>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>`;

  const uidToPath: Record<string, string> = {};
  try {
    const resp = await requestUrl({
      url: calPath,
      method: "REPORT",
      headers: {
        Authorization: basicAuth(config.username, config.password),
        "Depth": "1",
        "Content-Type": "application/xml; charset=utf-8",
      },
      body,
      throw: false,
    });
    if (resp.status !== 207) return uidToPath;

    // Pair each UID with the href of the SAME <response> block rather than by
    // position in the whole document. Two things went wrong before:
    //
    //   * `UID:([^\r\n]+)` ran to the end of the line, so a server that closes
    //     the tag right after the last property yielded
    //     `inventtasks-TSK-9@inventtasks</C:calendar-data>` — an id we no longer
    //     recognise as ours, so that event was never cleaned up and stayed in the
    //     user's calendar for good;
    //   * pairing the Nth uid with the (N+1)th href assumed exactly one leading
    //     href and one per entry, so a single extra <D:href> anywhere (a
    //     principal URL, a sync token block) shifted every pair by one and made
    //     us delete at the wrong path.
    for (const block of resp.text.split(/<D:response[\s>]/i).slice(1)) {
      const uid = block.match(/UID:([^\r\n<]+)/)?.[1]?.trim();
      if (!uid) continue;
      const href = block.match(/<D:href[^>]*>([^<]+)<\/D:href>/i)?.[1]?.trim();
      uidToPath[uid] = href || `${calPath.replace(/\/$/, "")}/${uid}.ics`;
    }
  } catch (e) {
    console.warn("[InventTasks] CalDAV REPORT failed:", e);
  }
  return uidToPath;
}

/** Extract the InventTasks task id from a UID like `inventtasks-<id>@inventtasks`. */
function taskIdFromUid(uid: string): string | undefined {
  const m = uid.match(/^inventtasks-(.+)@inventtasks$/);
  return m?.[1];
}

/**
 * Sync the desired tasks to a CalDAV server. `desiredTasks` is already filtered to
 * the export scope; any InventTasks object whose task is not in that set is deleted.
 */
/**
 * Where the calendar actually lives, given a server URL and a calendar path.
 *
 * The path may arrive in any of three shapes, and all three are things servers
 * and users really produce: a full URL (what Nextcloud and Fastmail show you,
 * and what a discovery href can contain), an absolute path rooted at the host,
 * or a fragment relative to the server URL. Gluing the strings together handled
 * only the last one — a pasted full URL produced
 * `http://host/cal/http://host/cal/`, and an absolute path doubled whatever
 * folder the server URL already named. Resolving it as a URL gets all three
 * right, and falls back to the old concatenation if the input is unparseable.
 */
export function resolveCalendarPath(config: { serverUrl: string; calendarPath?: string }): string {
  const base = config.serverUrl.replace(/\/?$/, "/");
  if (!config.calendarPath) return config.serverUrl;
  try {
    return new URL(config.calendarPath, base).toString();
  } catch {
    return base + config.calendarPath.replace(/^\//, "");
  }
}

export async function syncToCalDav(
  config: CalDavConfig,
  desiredTasks: TaskFile[],
  syncedEvents: Record<string, SyncedEventEntry>,
): Promise<Record<string, SyncedEventEntry>> {
  if (!config.enabled || !config.serverUrl) return syncedEvents;

  const calPath = resolveCalendarPath(config);
  const itemPathFor = (uid: string) => `${calPath.replace(/\/$/, "")}/${uid}.ics`;

  const existingUids = await listExistingEvents(config, calPath);
  const updated = { ...syncedEvents };
  const desiredIds = new Set<string>();
  const useVEvent = config.eventFormat === "vevent";

  for (const task of desiredTasks) {
    const id = task.data.id;
    if (!id) continue;
    desiredIds.add(id);

    const hash = taskHash(task);
    const existing = updated[id];
    if (existing?.caldav && existing.lastHash === hash) continue;

    const uid = `inventtasks-${id}@inventtasks`;
    const component = useVEvent ? taskToVEvent(task) : taskToVTodo(task);
    if (!component) continue; // taskToVEvent returns null when task has no dates

    const icsContent = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//InventTasks//Obsidian Task Manager//EN",
      "CALSCALE:GREGORIAN",
      component,
      "END:VCALENDAR",
    ].join(CRLF) + CRLF;

    const itemPath = existingUids[uid] || itemPathFor(uid);

    try {
      const resp = await requestUrl({
        url: itemPath,
        method: "PUT",
        headers: caldavHeaders(config),
        body: icsContent,
        throw: false,
      });
      if (resp.status >= 200 && resp.status < 300) {
        updated[id] = { ...updated[id], caldav: uid, lastHash: hash };
      } else {
        console.warn(`[InventTasks] CalDAV PUT failed for ${id}: HTTP ${resp.status}`);
      }
    } catch (e) {
      console.error(`[InventTasks] CalDAV sync error for ${id}:`, e);
    }
  }

  // Delete objects for tasks no longer desired — from BOTH the remote listing and
  // our synced map, falling back to the conventional {uid}.ics path when the server
  // didn't return an href (so done/closed/removed tasks are reliably cleaned up).
  const toDelete = new Map<string, string>(); // uid → path
  for (const [uid, path] of Object.entries(existingUids)) {
    const taskId = taskIdFromUid(uid);
    if (taskId && !desiredIds.has(taskId)) toDelete.set(uid, path || itemPathFor(uid));
  }
  for (const [taskId, entry] of Object.entries(updated)) {
    if (entry.caldav && !desiredIds.has(taskId)) {
      toDelete.set(entry.caldav, existingUids[entry.caldav] || itemPathFor(entry.caldav));
    }
  }

  for (const [uid, path] of toDelete) {
    try {
      await requestUrl({
        url: path,
        method: "DELETE",
        headers: { Authorization: basicAuth(config.username, config.password) },
        throw: false,
      });
    } catch { /* Non-fatal */ }
    const taskId = taskIdFromUid(uid);
    if (taskId && updated[taskId]) {
      const copy = { ...updated[taskId] };
      delete copy.caldav;
      if (Object.keys(copy).length) updated[taskId] = copy;
      else delete updated[taskId];
    }
  }

  return updated;
}

/** Test CalDAV connectivity. Returns null on success, error string on failure. */
export async function testCalDav(config: CalDavConfig): Promise<string | null> {
  if (!config.serverUrl) return "Server URL is required.";
  try {
    const resp = await requestUrl({
      url: config.serverUrl.replace(/\/$/, "") + "/",
      method: "PROPFIND",
      headers: {
        Authorization: basicAuth(config.username, config.password),
        "Depth": "0",
        "Content-Type": "application/xml; charset=utf-8",
      },
      body: `<?xml version="1.0" encoding="UTF-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>`,
      throw: false,
    });
    if (resp.status === 401) return "Authentication failed. Check username and password.";
    if (resp.status === 404) return "Server not found. Check server URL.";
    if (resp.status === 207 || resp.status === 200) return null;
    return `Unexpected response: HTTP ${resp.status}`;
  } catch (e: any) {
    return e?.message || String(e);
  }
}

import { requestUrl } from "obsidian";
import type { NtfyAccount, NotifPayload } from "../types";
import { t } from "../../i18n";

/**
 * ntfy.sh push notification channel.
 * Sends HTTP POST to the configured ntfy server — works on all platforms
 * (desktop + mobile). Users receive push notifications via the ntfy app
 * even when Obsidian is closed on mobile.
 *
 * IMPORTANT: ntfy's JSON publishing endpoint is the server ROOT (e.g.
 * https://ntfy.sh/), with the topic carried INSIDE the JSON body. Posting a
 * JSON body to the topic URL (…/my-topic) makes ntfy treat the whole JSON
 * string as the literal message text — which is why notifications used to
 * show raw JSON. Always POST to the root URL for structured messages.
 */
export class NtfyChannel {
  /** Returns null on success, or an error string on failure. */
  async send(account: NtfyAccount, payload: NotifPayload): Promise<string | null> {
    if (!account.topic) return "ntfy topic is not configured.";

    const rootUrl = (account.serverUrl || "https://ntfy.sh").replace(/\/$/, "") + "/";
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (account.authToken) headers["Authorization"] = `Bearer ${account.authToken}`;

    try {
      const resp = await requestUrl({
        url: rootUrl,
        method: "POST",
        headers,
        body: JSON.stringify(buildNtfyBody(account.topic, payload)),
        throw: false,
      });
      if (resp.status >= 400) {
        console.warn(`[InventTasks] ntfy send failed: HTTP ${resp.status}`, resp.text);
        return `ntfy HTTP ${resp.status}`;
      }
      return null;
    } catch (e: any) {
      console.error("[InventTasks] ntfy send error:", e);
      return e?.message || String(e);
    }
  }

  /** Test connectivity by publishing a test message. Null = success. */
  async test(account: NtfyAccount): Promise<string | null> {
    if (!account.topic) return t("notifChannel.ntfy.topicRequired");
    const err = await this.send(account, {
      title: t("notifChannel.ntfy.testTitle"),
      body: t("notifChannel.ntfy.testBody"),
      priority: 3,
      tags: ["white_check_mark"],
    });
    if (err === "ntfy HTTP 401" || err === "ntfy HTTP 403") return t("notifChannel.ntfy.authFailed");
    return err;
  }
}

/** Build the JSON publish body for the ntfy root endpoint. */
function buildNtfyBody(topic: string, payload: NotifPayload): Record<string, unknown> {
  const body: Record<string, unknown> = {
    topic,
    title: payload.title,
    message: payload.body,
    priority: payload.priority,
    // Render Markdown in the ntfy web app / supported clients. Harmless on
    // clients that don't support it (they show the plain text).
    markdown: true,
  };
  if (payload.tags?.length) body["tags"] = payload.tags;
  if (payload.clickUrl) {
    body["click"] = payload.clickUrl;
    body["actions"] = [{ action: "view", label: t("notifChannel.ntfy.openAction"), url: payload.clickUrl }];
  }
  return body;
}

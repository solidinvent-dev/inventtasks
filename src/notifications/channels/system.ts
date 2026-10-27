import type { NotifPayload } from "../types";

/**
 * System (OS) notification channel.
 * Uses the Web Notification API — works in Electron (desktop) and in
 * foreground Obsidian on all platforms.
 */
export class SystemChannel {
  async init(): Promise<void> {
    if (!("Notification" in window)) return;
    if (Notification.permission !== "granted" && Notification.permission !== "denied") {
      try { await Notification.requestPermission(); } catch { /* unavailable */ }
    }
  }

  isAvailable(): boolean {
    return "Notification" in window && Notification.permission === "granted";
  }

  /**
   * Whether this channel exists on this platform at all — the question readiness
   * has to ask, which is not the same as "can it deliver right now".
   *
   * Obsidian's Android webview has no Notification API whatsoever, so the channel
   * can never fire there. Readiness used to look only at whether the user had
   * ticked the box, so on a phone the default configuration (system on, nothing
   * else) planned notifications and dropped every one: nothing sent, nothing
   * recorded, nothing said.
   *
   * A DENIED permission is deliberately still "possible": the send then fails
   * visibly, which is how the product already reports it — a red history entry
   * plus lastError, so the user learns why nothing arrives. Refusing readiness
   * there would replace a clear explanation with silence.
   */
  isPossible(): boolean {
    return "Notification" in window;
  }

  /** Re-request permission on demand (settings "Test" button). */
  async requestPermission(): Promise<boolean> {
    await this.init();
    return this.isAvailable();
  }

  send(payload: NotifPayload): boolean {
    // Check live permission — it may have been granted/revoked after init().
    if (!this.isAvailable()) return false;
    try {
      const body = payload.clickUrl ? `${payload.body}\n${payload.clickUrl}` : payload.body;
      const notif = new Notification(payload.title, {
        body,
        silent: false,
        tag: payload.clickUrl || undefined,
        requireInteraction: true,
        data: payload.clickUrl ? { clickUrl: payload.clickUrl } : undefined,
      } as NotificationOptions & { requireInteraction?: boolean });
      const clickUrl = payload.clickUrl;
      if (clickUrl) {
        notif.onclick = () => {
          try {
            openExternal(clickUrl);
            notif.close();
          } catch { /* ignore */ }
        };
      }
      return true;
    } catch (e) {
      // Notification API may throw in some contexts (e.g. background tabs).
      console.warn("[InventTasks] System notification failed:", e);
      return false;
    }
  }
}

function openExternal(url: string): void {
  // Obsidian routes window.open through the OS, which also hands obsidian://
  // deep links back to the app.
  window.open(url, "_blank");
}

/**
 * HTTP transport over Obsidian's requestUrl — identical behaviour on desktop
 * and mobile, no CORS involvement. The WebSocket watch lives in manager.ts
 * (native WebSocket; auth is in-band, see server watch route).
 */

import { requestUrl } from "obsidian";
import {
  SYNC_PROTOCOL_VERSION,
  type ChangesResponse, type PushRequest, type PushResponse,
  type ServerInfo, type SnapshotLine, type StashVersionRequest, type VersionListResponse,
} from "../../shared/protocol";
export type { VersionEntry, VersionListResponse } from "../../shared/protocol";
import type { SyncTransport } from "./engine";
import { SyncError } from "./engine";

/**
 * Not every error body is the server's JSON. A proxy or CDN sitting in front
 * of it answers with an HTML page, and pasting raw markup into a status line
 * tells the user nothing. Prefer the page's title, fall back to its text, and
 * never emit tags.
 */
function summarizeErrorBody(body: string | undefined): string {
  if (!body) return "";
  const text = body.trim();
  if (!text.startsWith("<")) return text.slice(0, 120);
  const title = /<title>([^<]+)<\/title>/i.exec(text)?.[1];
  const stripped = (title ?? text.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
  return stripped.slice(0, 120);
}

export class HttpSyncTransport implements SyncTransport {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly workspace: string,
  ) {}

  private wsUrl(suffix: string): string {
    return `${this.baseUrl}/api/v1/workspaces/${encodeURIComponent(this.workspace)}${suffix}`;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return { Authorization: `Bearer ${this.token}`, ...extra };
  }

  private fail(status: number, path: string, body?: string): never {
    if (status === 401) throw new SyncError("unauthorized — check the API token", status);
    let detail = "";
    try { detail = body ? (JSON.parse(body).error ?? "") : ""; } catch { detail = summarizeErrorBody(body); }
    throw new SyncError(`server replied ${status} for ${path}${detail ? `: ${detail}` : ""}`, status);
  }

  /** Public endpoint — server reachability + protocol compatibility. */
  async info(): Promise<ServerInfo> {
    const res = await requestUrl({ url: `${this.baseUrl}/api/v1/info`, throw: false });
    if (res.status !== 200) this.fail(res.status, "/info", res.text);
    const info = res.json as ServerInfo;
    if (info.protocolVersion !== SYNC_PROTOCOL_VERSION) {
      throw new SyncError(`protocol mismatch: server ${info.protocolVersion}, plugin ${SYNC_PROTOCOL_VERSION}`);
    }
    return info;
  }

  /** Cheap authenticated probe for "Test connection". */
  async ping(): Promise<void> {
    const res = await requestUrl({
      url: this.wsUrl("/versions?path=__ping__"), headers: this.headers(), throw: false,
    });
    if (res.status !== 200) this.fail(res.status, "/versions", res.text);
    void (res.json as VersionListResponse);
  }

  async changes(since: number): Promise<ChangesResponse> {
    const res = await requestUrl({
      url: this.wsUrl(`/changes?since=${since}`), headers: this.headers(), throw: false,
    });
    if (res.status !== 200) this.fail(res.status, "/changes", res.text);
    return res.json as ChangesResponse;
  }

  async push(req: PushRequest): Promise<PushResponse> {
    const res = await requestUrl({
      url: this.wsUrl("/push"),
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(req),
      throw: false,
    });
    if (res.status !== 200) this.fail(res.status, "/push", res.text);
    return res.json as PushResponse;
  }

  async snapshot(): Promise<SnapshotLine[]> {
    const res = await requestUrl({
      url: this.wsUrl("/snapshot"), headers: this.headers(), throw: false,
    });
    if (res.status !== 200) this.fail(res.status, "/snapshot", res.text);
    return res.text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as SnapshotLine);
  }

  async uploadBlob(hash: string, data: ArrayBuffer): Promise<void> {
    const res = await requestUrl({
      url: this.wsUrl(`/blobs/${hash}`),
      method: "PUT",
      headers: this.headers({ "Content-Type": "application/octet-stream" }),
      body: data,
      throw: false,
    });
    if (res.status !== 200) this.fail(res.status, "/blobs", res.text);
  }

  async downloadBlob(hash: string): Promise<ArrayBuffer> {
    const res = await requestUrl({
      url: this.wsUrl(`/blobs/${hash}`), headers: this.headers(), throw: false,
    });
    if (res.status !== 200) this.fail(res.status, "/blobs", res.text);
    return res.arrayBuffer;
  }

  async stashVersion(req: StashVersionRequest): Promise<void> {
    const res = await requestUrl({
      url: this.wsUrl("/versions"),
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(req),
      throw: false,
    });
    if (res.status !== 200) this.fail(res.status, "/versions", res.text);
  }

  /** Server-side version history for one file (newest first). */
  async listVersions(path: string, limit = 100): Promise<VersionListResponse> {
    const res = await requestUrl({
      url: this.wsUrl(`/versions?path=${encodeURIComponent(path)}&limit=${limit}`),
      headers: this.headers(),
      throw: false,
    });
    if (res.status !== 200) this.fail(res.status, "/versions", res.text);
    return res.json as VersionListResponse;
  }

  /** Raw bytes of one stored version (by its history id). */
  async versionContent(id: number): Promise<ArrayBuffer> {
    const res = await requestUrl({
      url: this.wsUrl(`/versions/${id}/content`), headers: this.headers(), throw: false,
    });
    if (res.status !== 200) this.fail(res.status, "/versions/content", res.text);
    return res.arrayBuffer;
  }
}

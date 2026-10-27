// ---------- Deep links (obsidian:// URLs to any InventTasks element) ----------
//
// A deep link addresses one element across two nesting levels:
//   1. The Obsidian vault (`vault` = app.vault.getName()) — lets Obsidian (and
//      the OS, for desktop/mobile shortcuts) route to the right vault.
//   2. The plugin workspace (`ws` = the active WorkspaceEntry id) — one vault can
//      hold several InventTasks workspaces (different roots), switched via ribbon.
//
// The element itself is addressed by a STABLE id (task id, doc_id, view_id,
// space_id, folder_id, list_id) so the link survives renames and moves. Lists/
// spaces/folders are NOT addressed by path for that reason.
//
// URL shape: obsidian://inventtasks?vault=<v>&ws=<w>&kind=<k>&id=<i>[&page=<p>]

export const DEEP_LINK_ACTION = "inventtasks";

export const DEEP_LINK_KINDS = ["task", "doc", "view", "list", "folder", "space", "workspace"] as const;
export type DeepLinkKind = (typeof DEEP_LINK_KINDS)[number];

export interface DeepLinkParams {
  vault: string;          // Obsidian vault name
  ws: string;             // plugin workspace id (WorkspaceEntry.id)
  kind: DeepLinkKind;
  id?: string;            // element id (omitted for kind="workspace")
  page?: string;          // doc page id (kind="doc" only)
}

function enc(s: string): string {
  return encodeURIComponent(s);
}

// Build a shareable obsidian:// link. Values are percent-encoded so Obsidian's
// decoder (which runs decodeURIComponent over each query value) restores them
// verbatim — important for vault names with spaces.
export function buildDeepLink(p: DeepLinkParams): string {
  const parts = [`vault=${enc(p.vault)}`];
  if (p.ws) parts.push(`ws=${enc(p.ws)}`);
  parts.push(`kind=${enc(p.kind)}`);
  if (p.id) parts.push(`id=${enc(p.id)}`);
  if (p.page) parts.push(`page=${enc(p.page)}`);
  return `obsidian://${DEEP_LINK_ACTION}?${parts.join("&")}`;
}

// Validate + normalize the key-value bag Obsidian hands the protocol handler
// (already URL-decoded). Returns null when the link isn't a usable element link.
export function parseDeepLink(params: Record<string, string>): DeepLinkParams | null {
  const kind = params.kind as DeepLinkKind;
  if (!kind || !(DEEP_LINK_KINDS as readonly string[]).includes(kind)) return null;
  if (kind !== "workspace" && !params.id) return null;
  return {
    vault: params.vault || "",
    ws: params.ws || "",
    kind,
    id: params.id || undefined,
    page: params.page || undefined,
  };
}

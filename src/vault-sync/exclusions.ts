/**
 * Vault Sync exclusion rules — pure (no Obsidian imports), unit-tested.
 *
 * Two views over one rule set:
 *   - isExcludedPath(rel): authoritative per-FILE decision — fed to the
 *     SyncEngine's `exclude` option, so it also filters remote entries
 *     (nothing excluded is ever written locally or pushed).
 *   - isPrunedDir(rel): true only when NOTHING under the directory can be
 *     included — fed to VaultSyncFs so the walker skips whole subtrees.
 *     (.obsidian must NOT be pruned when only the plugins toggle is on.)
 *
 * All paths are vault-relative with `/` separators (the module always syncs
 * root "/", so engine-relative == vault-absolute).
 */

export interface VaultExcludeConfig {
  /** Obsidian config dir name (app.vault.configDir), usually ".obsidian". */
  configDir: string;
  /** This plugin's id (its own state/secrets must never sync). */
  pluginId: string;
  /** workspaceRoot of every configured InventTasks workspace. */
  workspaceRoots: string[];
  /**
   * Live set of AUTO-DETECTED task-workspace roots (dirs holding a
   * _workspace.md / _workspace-state.md marker — see detectWorkspaceRoots).
   * Read on every check, so the manager can grow it as markers are seen
   * locally or in server responses. Settings-based roots alone are not
   * enough: another device's data.json may list different roots, and a root
   * changed in settings must not leak the old folder into vault sync.
   */
  extraRoots?: () => ReadonlySet<string>;
  syncObsidianConfig: boolean;
  syncObsidianPlugins: boolean;
  /** User patterns, one per entry (see matchPattern). */
  ignorePatterns: string[];
}

/** Files that mark a directory as an InventTasks workspace root. */
export const WORKSPACE_MARKERS = new Set(["_workspace.md", "_workspace-state.md"]);

/**
 * Parent dirs of workspace marker files among `paths` — the auto-detected
 * task-workspace roots. A marker at the VAULT root ("") is ignored here
 * (a whole-vault task workspace is the overlap-guard case, not an exclusion).
 */
export function detectWorkspaceRoots(paths: Iterable<string>): string[] {
  const roots: string[] = [];
  for (const p of paths) {
    const slash = p.lastIndexOf("/");
    const base = slash >= 0 ? p.slice(slash + 1) : p;
    if (WORKSPACE_MARKERS.has(base) && slash > 0) roots.push(p.slice(0, slash));
  }
  return roots;
}

export interface VaultExclusions {
  isExcludedPath(rel: string): boolean;
  isPrunedDir(rel: string): boolean;
}

/**
 * Simplified gitignore-style matcher over a relative path:
 *   - `*` matches within one segment, `**` across segments;
 *   - a pattern without `/` matches at ANY depth (like gitignore);
 *   - a trailing `/` or a glob-free pattern also excludes the whole subtree.
 * Comments (#…) and blank lines never match. Case-sensitive, like the vault.
 */
export function matchPattern(pattern: string, rel: string): boolean {
  const p = pattern.trim();
  if (!p || p.startsWith("#")) return false;
  const subtree = p.endsWith("/");
  const body = (subtree ? p.slice(0, -1) : p).replace(/^\/+/, "");
  if (!body) return false;
  const prefix = body.includes("/") ? "^" : "(^|/)"; // no slash → any depth
  const core = globCore(body);
  if (new RegExp(`${prefix}${core}$`).test(rel)) return true;
  if (subtree || !body.includes("*")) {
    return new RegExp(`${prefix}${core}/`).test(rel); // subtree beneath a dir match
  }
  return false;
}

/** Glob body → regex source (no anchors). */
function globCore(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
        if (glob[i + 1] === "/") i++; // "**/" also matches zero directories
      } else {
        out += "[^/]*";
      }
    } else if ("\\^$.|?+()[]{}".includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return out;
}

const inSubtree = (rel: string, root: string): boolean =>
  rel === root || rel.startsWith(`${root}/`);

export function buildVaultExclusions(cfg: VaultExcludeConfig): VaultExclusions {
  const configDir = cfg.configDir.replace(/^\/+|\/+$/g, "") || ".obsidian";
  const roots = cfg.workspaceRoots
    .map((r) => (r || "").trim().replace(/^\/+|\/+$/g, ""))
    .filter((r) => r.length > 0 && r !== "."); // ""/"/" roots are handled by the enable-guard
  const patterns = cfg.ignorePatterns.map((p) => p.trim()).filter((p) => p && !p.startsWith("#"));

  /** Shared trunk: rules identical for files and dirs. null = not decided here. */
  const common = (rel: string): boolean | null => {
    if (inSubtree(rel, ".trash") || inSubtree(rel, ".git")) return true;
    for (const root of roots) if (inSubtree(rel, root)) return true;
    const detected = cfg.extraRoots?.();
    if (detected) {
      for (const root of detected) if (root && inSubtree(rel, root)) return true;
    }
    // Workspace marker files themselves never sync, wherever they sit — even
    // before their directory has been registered as a detected root.
    const base = rel.slice(rel.lastIndexOf("/") + 1);
    if (WORKSPACE_MARKERS.has(base)) return true;
    return null;
  };

  const isExcludedPath = (rel: string): boolean => {
    const c = common(rel);
    if (c !== null) return c;

    if (inSubtree(rel, configDir)) {
      const inner = rel === configDir ? "" : rel.slice(configDir.length + 1);
      // Per-device / volatile files — never synced regardless of toggles.
      if (inner === "workspace.json" || inner === "workspace-mobile.json") return true;
      if (inSubtree(inner, "cache")) return true;
      // This plugin's own secrets + sync client state.
      if (inner === `plugins/${cfg.pluginId}/data.json`) return true;
      if (inSubtree(inner, `plugins/${cfg.pluginId}/sync`)) return true;
      if (inSubtree(inner, "plugins")) return !cfg.syncObsidianPlugins;
      return !cfg.syncObsidianConfig;
    }

    for (const p of patterns) if (matchPattern(p, rel)) return true;
    return false;
  };

  const isPrunedDir = (rel: string): boolean => {
    const c = common(rel);
    if (c !== null) return c;

    if (inSubtree(rel, configDir)) {
      if (rel === configDir) return !cfg.syncObsidianConfig && !cfg.syncObsidianPlugins;
      const inner = rel.slice(configDir.length + 1);
      if (inSubtree(inner, "cache")) return true;
      if (inSubtree(inner, `plugins/${cfg.pluginId}/sync`)) return true;
      if (inSubtree(inner, "plugins")) return !cfg.syncObsidianPlugins;
      return !cfg.syncObsidianConfig;
    }

    // User patterns: prune only unambiguous subtree patterns (no globs);
    // glob patterns keep filtering per file via isExcludedPath.
    for (const p of patterns) {
      if (!p.includes("*") && matchPattern(p, rel)) return true;
    }
    return false;
  };

  return { isExcludedPath, isPrunedDir };
}

/**
 * A task workspace whose root is the WHOLE vault would double-sync everything
 * this module covers — enabling Vault Sync alongside it is refused.
 */
export function overlappingWholeVaultRoot(workspaceRoots: string[]): boolean {
  return workspaceRoots.some((r) => {
    const t = (r || "").trim().replace(/^\/+|\/+$/g, "");
    return t.length === 0 || t === ".";
  });
}

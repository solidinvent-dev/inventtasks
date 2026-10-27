// Secrets (sync tokens, the ntfy token, the CalDAV password) are kept in
// Obsidian's SecretStorage; data.json holds only a `secret:<id>` reference.
//
// Before 1.2.0 they were encrypted with Electron's safeStorage and stored as
// `enc:v1:<base64>`. That needed `require("electron")`, which Obsidian's
// plugin policy reserves for desktop-only plugins. Those values cannot be
// decrypted without Electron, so they are dropped on load and counted, and
// the plugin asks the user to enter them again.

import type { App } from "obsidian";

/** The subset of Obsidian's SecretStorage (API 1.11.4) used here. */
interface SecretStore {
  setSecret(id: string, secret: string): void;
  getSecret(id: string): string | null;
}

const REF_PREFIX = "secret:";
const LEGACY_PREFIX = "enc:v1:";

let store: SecretStore | undefined;
let legacyDropped = 0;

export function configureSecretStorage(app: App): void {
  store = (app as unknown as { secretStorage?: SecretStore }).secretStorage;
}

/** Stable SecretStorage id: lowercase alphanumerics and dashes only. */
export function secretId(name: string): string {
  return `inventtasks-${name}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
}

/** Store `value` under `id` and return the reference to persist instead.
 *  Without SecretStorage (the browser web app) the value passes through. */
export function protectSecret(id: string, value: string | undefined): string | undefined {
  if (!store || value === undefined || value.startsWith(REF_PREFIX)) return value;
  try {
    if ((store.getSecret(id) ?? "") !== value) store.setSecret(id, value);
    return value ? `${REF_PREFIX}${id}` : value;
  } catch {
    return value;
  }
}

export function revealSecret(value: string | undefined): string | undefined {
  if (!value) return value;
  if (value.startsWith(REF_PREFIX)) {
    try {
      return store?.getSecret(value.slice(REF_PREFIX.length)) ?? "";
    } catch {
      return "";
    }
  }
  if (value.startsWith(LEGACY_PREFIX)) {
    legacyDropped++;
    return "";
  }
  return value;
}

/** How many pre-1.2.0 encrypted secrets were dropped since the last call. */
export function takeLegacySecretsDropped(): number {
  const n = legacyDropped;
  legacyDropped = 0;
  return n;
}

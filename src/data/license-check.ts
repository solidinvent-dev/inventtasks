/**
 * Daily licence revocation check. The plugin never asks "does this email have a
 * license" (activation stays fully offline) — it asks the vendor endpoint
 * whether the activated email has been REVOKED (e.g. a key leaked publicly).
 *
 * Trust model: the request proves possession of the deterministic license key,
 * and the endpoint's answer is a nonce-bound statement
 * `IT1S2|<emailHash>|ok|<ts>|<nonce>` / `...|rev|...`, Ed25519-SIGNED with the
 * same vendor key that signs license keys. Older stored V1 statements remain
 * readable. No network / unreachable endpoint = no change: the newest locally
 * stored statement (plus the ordinary offline key check) stands.
 *
 * The newest statement is persisted in several places (plugin settings,
 * localStorage, and each workspace's shared-state file — which syncs, so a
 * revocation reaches the user's other devices through their own sync) and
 * self-heals across them. Re-activating a revoked email is refused while the
 * newest statement for it says "rev"; a newer signed "ok" (support resolved
 * the case) lifts the hold everywhere the same way.
 */

import { Notice, requestUrl } from "obsidian";
import type InventTasksPlugin from "../main";
import { LICENSE_STATUS_URL } from "../constants";
import { t } from "../i18n";
import { sha256Hex } from "../sync/util";
import { verifyVendorSignature, isRevoked, setRevoked, keyValid, sealEmail, setLicense } from "./license";
import { observeStateSeed, setStateSeed } from "./workspace-state";

// Storage names for the newest signed licence status. "seed" is a historical
// name kept so existing installs keep their stored status across the update;
// it holds a vendor-signed "ok"/"rev" statement, nothing else.
const LS_SEED = "inventtasks:seed";
const LS_CHECKED = "inventtasks:seed-sync";
const CHECK_EVERY_MS = 24 * 3600_000;
const TICK_MS = 60 * 60_000;
const FIRST_TICK_MS = 90_000;
// An activation the endpoint could not confirm leaves the device running on
// key validity alone. It is asked again shortly, then every half hour, until
// one answer gets through — see scheduleConfirmation().
const FIRST_RETRY_MS = 60_000;
const RETRY_EVERY_MS = 30 * 60_000;
const NETWORK_STAMP_TOLERANCE_SECONDS = 300;

export interface Stamp {
  /** Full signed payload (`IT1S|eh|st|ts` or nonce-bound `IT1S2|eh|st|ts|nonce`). */
  p: string;
  /** Signature (b64u). */
  s: string;
  eh: string;
  st: "ok" | "rev";
  ts: number;
  /** Present on V2 statements returned for an authenticated status request. */
  nonce?: string;
}

const STAMP_V1_RE = /^IT1S\|([0-9a-f]{64})\|(ok|rev)\|(\d{1,12})$/;
const STAMP_V2_RE = /^IT1S2\|([0-9a-f]{64})\|(ok|rev)\|(\d{1,12})\|([0-9a-f]{64})$/;
const PROOF_PREFIX = "IT1P";
const ENC = new TextEncoder();

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function normalizedEmail(email: string): string {
  return String(email || "").trim().toLowerCase();
}

function canonicalLicenseKey(key: string): string {
  const raw = String(key || "");
  const dot = raw.indexOf(".");
  const body = (dot >= 0 ? raw.slice(dot + 1) : raw).replace(/[^A-Za-z0-9\-_]/g, "");
  // Ed25519 signatures are 64 bytes, whose unpadded base64url spelling ends
  // with four unused bits. The offline decoder deliberately accepts those
  // equivalent spellings; decode+re-encode here so every offline-valid key
  // derives exactly the same status-proof HMAC key as the Worker.
  try {
    const base64 = body.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
    if (binary.length === 64) {
      const canonicalBody = btoa(binary)
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
      return `IT1.${canonicalBody}`;
    }
  } catch { /* invalid keys are rejected by the ordinary offline verifier */ }
  return `IT1.${body}`;
}

/** Build the authenticated body sent to /status. Injectable values keep tests deterministic. */
export async function makeStatusRequest(
  email: string,
  licenseKey: string,
  ts = Math.floor(Date.now() / 1000),
  nonce?: string,
): Promise<{ e: string; ts: number; n: string; p: string }> {
  const e = normalizedEmail(email);
  const n = nonce ?? bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    ENC.encode(canonicalLicenseKey(licenseKey)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", hmacKey, ENC.encode(`${PROOF_PREFIX}|${e}|${ts}|${n}`));
  return { e, ts, n, p: bytesToHex(new Uint8Array(mac)) };
}

/** Parse+verify one stored/received statement. `verify` injectable for tests. */
export function parseStamp(raw: unknown, verify: (p: string, s: string) => boolean = verifyVendorSignature): Stamp | null {
  try {
    const obj = typeof raw === "string" ? JSON.parse(atob(raw)) : raw;
    if (!obj || typeof obj.p !== "string" || typeof obj.s !== "string") return null;
    const v2 = STAMP_V2_RE.exec(obj.p);
    const m = v2 ?? STAMP_V1_RE.exec(obj.p);
    if (!m) return null;
    if (!verify(obj.p, obj.s)) return null;
    return {
      p: obj.p,
      s: obj.s,
      eh: m[1],
      st: m[2] as "ok" | "rev",
      ts: parseInt(m[3], 10),
      ...(v2 ? { nonce: v2[4] } : {}),
    };
  } catch {
    return null;
  }
}

export function encodeStamp(stamp: Pick<Stamp, "p" | "s">): string {
  return btoa(JSON.stringify({ p: stamp.p, s: stamp.s }));
}

/** Total ordering used everywhere stamps compete for the same licence. */
export function compareStampOrder(a: Stamp, b: Stamp): number {
  if (a.ts !== b.ts) return a.ts > b.ts ? 1 : -1;
  const aVersion = a.nonce ? 2 : 1;
  const bVersion = b.nonce ? 2 : 1;
  if (aVersion !== bVersion) return aVersion > bVersion ? 1 : -1;
  if (a.st !== b.st) return a.st === "rev" ? 1 : -1;
  return 0;
}

/** A network V2 response is usable only for the request that caused it, right now. */
export function isFreshStatusResponse(stamp: Stamp, eh: string, nonce: string, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  return stamp.eh === eh && stamp.nonce === nonce && Math.abs(nowSeconds - stamp.ts) <= NETWORK_STAMP_TOLERANCE_SECONDS;
}

export async function emailHash(email: string): Promise<string> {
  const norm = normalizedEmail(email);
  return sha256Hex(new TextEncoder().encode(norm));
}

// Stamps observed in workspace shared-state files (fed by the observer — this
// is how a statement written on one device reaches the others via sync).
const seenSeeds = new Set<string>();

/** This device's copy, scoped to the vault by Obsidian (App.loadLocalStorage). */
function loadLocal(plugin: InventTasksPlugin, key: string): string | null {
  try {
    const value: unknown = plugin.app.loadLocalStorage(key);
    return typeof value === "string" ? value : null;
  } catch {
    return null; // storage unavailable
  }
}

function saveLocal(plugin: InventTasksPlugin, key: string, value: string): void {
  try { plugin.app.saveLocalStorage(key, value); } catch { /* storage unavailable */ }
}

function storedRaws(plugin: InventTasksPlugin): string[] {
  const out: string[] = [];
  const fromSettings = (plugin.settings as { seed?: string }).seed;
  if (fromSettings) out.push(fromSettings);
  const ls = loadLocal(plugin, LS_SEED);
  if (ls) out.push(ls);
  out.push(...seenSeeds);
  return out;
}

/** Newest valid statement for an email hash across every storage location. */
export function newestStamp(plugin: InventTasksPlugin, eh: string, verify?: (p: string, s: string) => boolean): Stamp | null {
  let best: Stamp | null = null;
  for (const raw of storedRaws(plugin)) {
    const st = parseStamp(raw, verify);
    if (!st || st.eh !== eh) continue;
    if (!best || compareStampOrder(st, best) > 0) best = st;
  }
  return best;
}

/** Persist a statement everywhere (self-healing copies; newest always wins). */
async function storeStamp(plugin: InventTasksPlugin, stamp: Stamp): Promise<void> {
  const raw = encodeStamp(stamp);
  seenSeeds.add(raw);
  (plugin.settings as { seed?: string }).seed = raw;
  saveLocal(plugin, LS_SEED, raw);
  setStateSeed(raw);
  try {
    await plugin.saveSettings();
    await plugin.persistAllWorkspaceSharedState();
  } catch { /* persisted on the next natural save */ }
}

/**
 * Derive the runtime hold from the newest stored statement for the ACTIVE
 * licence, and self-heal missing copies. Safe to call repeatedly.
 */
export async function applyLocalLicenseState(plugin: InventTasksPlugin): Promise<void> {
  const email = plugin.settings.account?.id;
  if (!email) {
    setRevoked(false);
    return;
  }
  const eh = await emailHash(email);
  const best = newestStamp(plugin, eh);
  const wasHeld = isRevoked();
  setRevoked(best?.st === "rev");
  if (best) await storeStamp(plugin, best);
  if (wasHeld !== isRevoked()) plugin.refreshViews();
}

/** Activation guard: true when the newest statement for this email says "rev". */
export async function isEmailRevoked(plugin: InventTasksPlugin, email: string): Promise<boolean> {
  const eh = await emailHash(email);
  return newestStamp(plugin, eh)?.st === "rev";
}

/**
 * One status round-trip: fetch + persist the fresh signed statement, returning
 * the resulting standing for `email` (newest-wins across storage). Returns
 * "offline" when the endpoint gives no usable answer — the caller then keeps
 * the local state. No UI side effects.
 */
export async function fetchStanding(plugin: InventTasksPlugin, email: string): Promise<"ok" | "rev" | "offline"> {
  const eh = await emailHash(email);
  const licenseKey = plugin.settings.account?.token;
  if (!licenseKey) return "offline";
  const auth = await makeStatusRequest(email, licenseKey);
  // The address is sealed to the vendor key — it never leaves the device in
  // readable form. Only the holder of the private half can open the envelope.
  const sealed = await sealEmail(normalizedEmail(email), auth.ts, auth.n);
  const payload = { ...sealed, ts: auth.ts, n: auth.n, p: auth.p };
  let body: { p?: string; s?: string } | null = null;
  try {
    const res = await requestUrl({
      url: LICENSE_STATUS_URL,
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify(payload),
      throw: false,
    });
    if (res.status !== 200) return "offline";
    body = res.json as { p?: string; s?: string };
  } catch {
    return "offline"; // offline / blocked / misconfigured endpoint
  }
  const stamp = parseStamp(body);
  if (!stamp || !isFreshStatusResponse(stamp, eh, auth.n)) return "offline";
  saveLocal(plugin, LS_CHECKED, String(Date.now()));
  const current = newestStamp(plugin, eh);
  if (!current || compareStampOrder(stamp, current) > 0) await storeStamp(plugin, stamp);
  return newestStamp(plugin, eh)?.st ?? "ok";
}

/** Daily background check: apply the fresh standing, with a notice on change. */
export async function checkLicenseNow(plugin: InventTasksPlugin): Promise<void> {
  const email = plugin.settings.account?.id;
  if (!email) return;
  const before = isRevoked();
  const standing = await fetchStanding(plugin, email);
  if (standing === "offline") return; // local state stands
  setRevoked(standing === "rev");
  if (isRevoked() !== before) {
    new Notice(isRevoked() ? t("license.revokedNotice") : t("license.restoredNotice"), isRevoked() ? 15000 : 10000);
    plugin.refreshViews();
  }
}

/**
 * Manual activation. The key is validated offline (authenticity is separate
 * from revocation); then, WHEN ONLINE, the vendor's fresh signed standing is
 * authoritative and can both apply AND immediately LIFT a hold — a re-activate
 * with the server saying active=1 clears a stale block without waiting for the
 * daily check. Offline falls back to the newest local statement.
 */
export async function activateAccount(
  plugin: InventTasksPlugin,
  email: string,
  key: string,
): Promise<"ok" | "invalid" | "revoked"> {
  if (!keyValid(email, key)) return "invalid";
  const prev = plugin.settings.account;
  // Adopt tentatively so the status check reads this account.
  plugin.settings.account = { id: email, token: key };
  setLicense(email, key);

  // Ask whatever navigator.onLine claims: fetchStanding() already answers
  // "offline" when no usable reply comes back, and that flag is not
  // trustworthy enough to skip the one authoritative question.
  const standing = await fetchStanding(plugin, email);
  // Server "rev" → refuse. Server unreachable → trust the newest local mark.
  const localRev = standing === "offline" && (await isEmailRevoked(plugin, email));
  if (standing === "rev" || localRev) {
    plugin.settings.account = prev;
    setLicense(prev?.id, prev?.token);
    await applyLocalLicenseState(plugin);
    return "revoked";
  }
  setRevoked(false); // server said ok (or offline + not locally revoked)
  await plugin.saveSettings();
  plugin.refreshViews();
  // An online activation IS the check — there is nothing left to ask. One
  // that never reached the endpoint activated on key validity alone, so
  // chase a real answer rather than wait for tomorrow.
  if (standing === "offline") scheduleConfirmation(plugin);
  else stopConfirmation();
  return "ok";
}

function lastCheckedAt(plugin: InventTasksPlugin): number {
  // Unreadable storage reads as "never checked", so a check is due.
  return parseInt(loadLocal(plugin, LS_CHECKED) || "0", 10) || 0;
}

let confirmTimer: number | null = null;

/** Cancel the confirmation chain — an answer got through, or we are unloading. */
function stopConfirmation(): void {
  if (confirmTimer !== null) {
    window.clearTimeout(confirmTimer);
    confirmTimer = null;
  }
}

/**
 * Chase a real answer for an activation that could NOT be verified at the time.
 * Such a device is running on key validity alone, so it asks again after a
 * minute and then every half hour; once one answer gets through, the ordinary
 * daily rhythm takes over.
 *
 * This adds nothing to steady-state request volume: with no connectivity the
 * attempt fails on the device and never reaches the endpoint, and the chain
 * stops on the first verified round trip — which is the only thing that moves
 * LS_CHECKED.
 */
function scheduleConfirmation(plugin: InventTasksPlugin, delay: number = FIRST_RETRY_MS): void {
  stopConfirmation();
  confirmTimer = window.setTimeout(() => {
    confirmTimer = null;
    if (!plugin.settings.account?.id) return; // account removed meanwhile
    const before = lastCheckedAt(plugin);
    // A check that throws is a check that did not confirm — swallow it and
    // re-arm, or one bad round trip would end the chain for good.
    void checkLicenseNow(plugin)
      .catch(() => undefined)
      .then(() => {
        if (lastCheckedAt(plugin) > before) return; // confirmed
        scheduleConfirmation(plugin, RETRY_EVERY_MS);
      });
  }, delay);
}

/** Once-a-day scheduler (per device). Returns a stop function. */
export function startLicenseCheck(plugin: InventTasksPlugin): () => void {
  observeStateSeed((raw) => {
    if (seenSeeds.has(raw)) return;
    seenSeeds.add(raw);
    // A statement synced in from another device — adopt it if it is news.
    void applyLocalLicenseState(plugin);
  });

  const due = (): boolean => Date.now() - lastCheckedAt(plugin) >= CHECK_EVERY_MS;
  // No navigator.onLine gate. That flag lies in both directions — a captive
  // portal reports online, a sleep/VPN transition reports offline while the
  // network works — and skipping the tick on it is exactly how a device
  // silently misses its daily check. The request is the reliable test:
  // fetchStanding() maps any failure to "offline" and local state stands.
  const tick = (): void => {
    if (!plugin.settings.account?.id) return;
    if (due()) void checkLicenseNow(plugin);
  };
  const interval = window.setInterval(tick, TICK_MS);
  const first = window.setTimeout(tick, FIRST_TICK_MS);
  const onOnline = (): void => tick();
  window.addEventListener("online", onOnline);
  return () => {
    window.clearInterval(interval);
    window.clearTimeout(first);
    stopConfirmation();
    window.removeEventListener("online", onOnline);
    observeStateSeed(null);
  };
}

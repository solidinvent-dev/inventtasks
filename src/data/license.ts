// Licence check and the free-tier limits it lifts.
//
// The free tier is a complete, working plugin with limits on how many spaces,
// lists and open tasks it manages; a valid licence key removes them. Activation
// is fully offline: a key is an Ed25519 signature, made with the vendor's private
// key, over the message "IT1|<lower-cased email>|L". The plugin carries only the
// PUBLIC key below, so it can verify keys but cannot create them — which is why
// publishing this source does not let anyone mint a key.
//
// Everything here is DERIVED from the key on each call (never a stored
// "is licensed" flag), so editing persisted settings cannot widen a limit.
import { ed25519, edwardsToMontgomeryPub, x25519 } from "@noble/curves/ed25519";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";

/** Public half of the vendor signing key (scripts/license/keygen.mjs). */
const VENDOR_PUBLIC_KEY = "acd7f01db5213ca05b2d5d8e6ee52675a31afec5e680fdb24dcedf2b3033d2c8";

// Build-time switch (esbuild `define`): `globalThis.__IT_WEB__` is the literal
// "true" ONLY in the browser app served by the self-hosted sync server, "false"
// in every other build. The browser app is always fully licensed, because access
// to it is already gated by the server's own login and workspace token
// (SYNC_SPECIFICATION §3.3). Read inline at each call site so the plugin build
// folds the comparison away. Test bundles without the define read `undefined`,
// which is falsy.
declare global {
  var __IT_WEB__: boolean | undefined;
}

/** Free-tier limits, indexed by scope: [spaces, lists, open tasks]. */
const FREE_LIMITS = [1, 5, 50];

/** The licence currently activated on this device. */
let license: { email?: string; key?: string } = {};
/** Memo of the last verification, keyed by email + key. */
let cacheId = "\0";
let cacheValue = 0;
/** Set while the vendor's signed status says this licence is revoked. */
let revoked = false;

/** Apply or lift a revocation reported by the daily status check. While
 *  revoked, every limit reads as the free tier. */
export function setRevoked(v: boolean): void {
  revoked = v;
  cacheId = "\0";
}

export function isRevoked(): boolean {
  return revoked;
}

/** Activate a licence (or clear it with two undefined arguments). */
export function setLicense(email?: string, key?: string): void {
  license = { email, key };
  cacheId = "\0";
}

const ENC = new TextEncoder();
/** Must match scripts/license/core.mjs: `IT1|${normEmail(email)}|${TIER}`. */
const KEY_PREFIX = "IT1|";
const KEY_SUFFIX = "|L";

/** The exact bytes a licence key signs for a given email. */
function keyMessage(email: string): Uint8Array {
  return ENC.encode(KEY_PREFIX + String(email).trim().toLowerCase() + KEY_SUFFIX);
}

/** Keys and signatures are base64url without padding. */
const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
function decodeBase64Url(s: string): Uint8Array {
  const lut: Record<string, number> = {};
  for (let i = 0; i < BASE64URL.length; i++) lut[BASE64URL[i]] = i;
  const c = String(s).replace(/[^A-Za-z0-9\-_]/g, "");
  const o: number[] = [];
  for (let i = 0; i < c.length; i += 4) {
    const n = (lut[c[i]] << 18) | (lut[c[i + 1]] << 12) | ((lut[c[i + 2]] ?? 0) << 6) | (lut[c[i + 3]] ?? 0);
    o.push((n >> 16) & 255);
    if (c[i + 2] !== undefined) o.push((n >> 8) & 255);
    if (c[i + 3] !== undefined) o.push(n & 255);
  }
  return Uint8Array.from(o);
}

// Returns a large positive number when the email + key verify, else 0.
// Deliberately a number rather than a boolean: the limits ADD it to the
// free-tier value, so there is no single flag whose flip unlocks Pro.
function licenseBonus(email?: string, key?: string): number {
  const id = (email || "") + "\x01" + (key || "");
  if (globalThis.__IT_WEB__ === true) return 0x40000000; // browser app: always licensed
  if (revoked) return 0;
  if (id === cacheId) return cacheValue;
  let v = 0;
  try {
    if (email && key) {
      const dot = key.indexOf(".");
      const sig = decodeBase64Url(dot >= 0 ? key.slice(dot + 1) : key);
      if (sig.length === 64 && ed25519.verify(sig, keyMessage(email), hexToBytes(VENDOR_PUBLIC_KEY))) {
        v = 0x40000000 + ((sig[0] << 8) | sig[1]);
      }
    }
  } catch {
    v = 0;
  }
  cacheId = id;
  cacheValue = v;
  return v;
}

/** Limit for a scope: 0 = spaces, 1 = lists, 2 = open tasks. */
export function limit(scope: number): number {
  return FREE_LIMITS[scope] + licenseBonus(license.email, license.key);
}

/** Free-tier limit for a scope — for messages shown to the user. */
export function freeLimit(scope: number): number {
  return FREE_LIMITS[scope];
}

/** True when a valid licence is active and not revoked. */
export function isLicensed(): boolean {
  return licenseBonus(license.email, license.key) > 0;
}

/** Verify a statement signed with the vendor key (used for the daily status). */
export function verifyVendorSignature(payload: string, sig: string): boolean {
  try {
    const b = decodeBase64Url(sig);
    return b.length === 64 && ed25519.verify(b, ENC.encode(payload), hexToBytes(VENDOR_PUBLIC_KEY));
  } catch {
    return false;
  }
}

// For call sites that must distinguish "no key" from "a key that does not
// verify": a key that is present but invalid (hand-edited settings) reports
// false, so callers fall back to the free-tier limits.
export function licenseConsistent(): boolean {
  if (!license.key) return true;
  return licenseBonus(license.email, license.key) > 0;
}

/**
 * True when the key's signature is genuine for this email — INDEPENDENT of any
 * runtime hold (revocation is separate from key authenticity). Used by manual
 * activation, which validates the key here and lets the server's fresh signed
 * standing decide whether a hold applies.
 */
export function keyValid(e?: string, k?: string): boolean {
  if (globalThis.__IT_WEB__ === true) return true;
  try {
    if (!e || !k) return false;
    const dot = k.indexOf(".");
    const sig = decodeBase64Url(dot >= 0 ? k.slice(dot + 1) : k);
    return sig.length === 64 && ed25519.verify(sig, keyMessage(e), hexToBytes(VENDOR_PUBLIC_KEY));
  } catch {
    return false;
  }
}
// ---------------------------------------------------------------------------
// Sealed email envelope for the daily standing check
// ---------------------------------------------------------------------------
//
// The check has to say WHICH licence is asking, but the address must not travel
// in the clear — not readable by a proxy, a TLS-terminating middlebox, or
// anyone with access to a request log. It is sealed to the vendor key so only
// the holder of the private half can open it.
//
// ECIES: an ephemeral X25519 key agrees a secret with the vendor key,
// HKDF-SHA256 derives an AES-256-GCM key, the address is encrypted under it.
// The vendor keypair is the SAME Ed25519 pair that signs licences, converted to
// Montgomery form — no second key to ship or back up, and VENDOR_PUBLIC_KEY
// above is already its public half. `ts` and the nonce are authenticated as additional data, so
// a captured envelope cannot be replayed under a different timestamp.
//
// Must stay byte-compatible with openSealedEmail() in scripts/license/core.mjs;
// tests/status-envelope.test.mjs seals here and opens there to prove it.
const ENVELOPE_INFO = "IT1E|v1";

export interface SealedEmail {
	/** Ephemeral X25519 public key (hex). */
	ek: string;
	/** AES-GCM nonce (hex). */
	iv: string;
	/** Ciphertext (hex). */
	c: string;
}

async function envelopeKey(shared: Uint8Array, nonceHex: string): Promise<CryptoKey> {
	const ikm = await crypto.subtle.importKey("raw", shared as BufferSource, "HKDF", false, [
		"deriveBits",
	]);
	const bits = await crypto.subtle.deriveBits(
		{
			name: "HKDF",
			hash: "SHA-256",
			salt: hexToBytes(nonceHex) as BufferSource,
			info: ENC.encode(ENVELOPE_INFO) as BufferSource,
		},
		ikm,
		256,
	);
	return crypto.subtle.importKey("raw", bits, { name: "AES-GCM" }, false, ["encrypt"]);
}

/** Seal the licence email to the vendor key for one status request. */
export async function sealEmail(email: string, ts: number, nonceHex: string): Promise<SealedEmail> {
	const ephPriv = x25519.utils.randomPrivateKey();
	const ephPub = x25519.getPublicKey(ephPriv);
	const shared = x25519.getSharedSecret(ephPriv, edwardsToMontgomeryPub(hexToBytes(VENDOR_PUBLIC_KEY)));
	const key = await envelopeKey(shared, nonceHex);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ct = await crypto.subtle.encrypt(
		{
			name: "AES-GCM",
			iv: iv as BufferSource,
			additionalData: ENC.encode(`${ENVELOPE_INFO}|${ts}|${nonceHex}`) as BufferSource,
		},
		key,
		ENC.encode(String(email || "").trim().toLowerCase()) as BufferSource,
	);
	return { ek: bytesToHex(ephPub), iv: bytesToHex(iv), c: bytesToHex(new Uint8Array(ct)) };
}

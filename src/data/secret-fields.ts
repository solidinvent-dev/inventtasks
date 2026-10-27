import type { SecretFieldsConfig, SecretFieldValue } from "../types";
import { scalarText } from "../utils/text";

const DEFAULT_ITERATIONS = 310_000;
const VERIFIER_TEXT = "InventTasks workspace secret fields v1";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function cryptoApi(): Crypto {
  const api = window.crypto;
  if (!api?.subtle) throw new Error("Web Crypto is not available");
  return api;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function deriveKey(password: string, config: Pick<SecretFieldsConfig, "salt" | "iterations">): Promise<CryptoKey> {
  const api = cryptoApi();
  const material = await api.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveKey"]);
  return api.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: fromBase64(config.salt), iterations: config.iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encryptWithKey(key: CryptoKey, plaintext: string): Promise<SecretFieldValue> {
  const api = cryptoApi();
  const iv = api.getRandomValues(new Uint8Array(12));
  const encrypted = await api.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(plaintext));
  return {
    __inventtasks_secret: 1,
    version: 1,
    algorithm: "AES-256-GCM",
    iv: toBase64(iv),
    ciphertext: toBase64(new Uint8Array(encrypted)),
  };
}

async function decryptWithKey(key: CryptoKey, value: SecretFieldValue): Promise<string> {
  const decrypted = await cryptoApi().subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(value.iv) },
    key,
    fromBase64(value.ciphertext),
  );
  return decoder.decode(decrypted);
}

export function isEncryptedSecretValue(value: unknown): value is SecretFieldValue {
  const v = value as Partial<SecretFieldValue> | null;
  return !!v && typeof v === "object" && v.__inventtasks_secret === 1 && v.version === 1 &&
    v.algorithm === "AES-256-GCM" && typeof v.iv === "string" && typeof v.ciphertext === "string";
}

export function isSecretFieldsConfig(value: unknown): value is SecretFieldsConfig {
  const config = value as Partial<SecretFieldsConfig> | null;
  return !!config && typeof config === "object" && config.version === 1 && config.kdf === "PBKDF2-SHA256" &&
    Number.isInteger(config.iterations) && config.iterations! >= 100_000 && config.iterations! <= 2_000_000 &&
    typeof config.salt === "string" && config.salt.length >= 20 && config.salt.length <= 128 &&
    isEncryptedSecretValue(config.verifier);
}

/** Visibility owned by one TaskModal. It never grants workspace visibility. */
export class SecretModalVisibility {
  private revealed = new Set<string>();
  private hidden = new Set<string>();
  private all = false;

  isVisible(fieldId: string, workspaceVisible = false): boolean {
    if (this.hidden.has(fieldId)) return false;
    return workspaceVisible || this.all || this.revealed.has(fieldId);
  }

  revealOne(fieldId: string): void {
    this.hidden.delete(fieldId);
    this.revealed.add(fieldId);
  }

  hideOne(fieldId: string): void {
    this.revealed.delete(fieldId);
    this.hidden.add(fieldId);
  }

  revealAll(): void {
    this.all = true;
    this.revealed.clear();
    this.hidden.clear();
  }

  hideAll(fieldIds: string[]): void {
    this.all = false;
    this.revealed.clear();
    this.hidden = new Set(fieldIds);
  }

  clearHidden(): void {
    this.hidden.clear();
  }
}

interface UnlockedWorkspace {
  fingerprint: string;
  key: CryptoKey;
  plaintext: Map<string, string>;
  workspaceVisible: boolean;
}

function valueKey(value: SecretFieldValue): string {
  return `${value.iv}:${value.ciphertext}`;
}

function fingerprint(config: SecretFieldsConfig): string {
  return `${config.version}:${config.salt}:${config.iterations}:${config.verifier.iv}:${config.verifier.ciphertext}`;
}

/** In-memory-only keyring. A session ends when the plugin/web page reloads. */
export class SecretFieldSession {
  private unlocked = new Map<string, UnlockedWorkspace>();

  async createConfig(workspaceId: string, password: string): Promise<SecretFieldsConfig> {
    const salt = cryptoApi().getRandomValues(new Uint8Array(16));
    const partial = { salt: toBase64(salt), iterations: DEFAULT_ITERATIONS };
    const key = await deriveKey(password, partial);
    const verifier = await encryptWithKey(key, `${VERIFIER_TEXT}:${workspaceId}`);
    const config: SecretFieldsConfig = {
      version: 1,
      kdf: "PBKDF2-SHA256",
      iterations: DEFAULT_ITERATIONS,
      salt: partial.salt,
      verifier,
    };
    this.unlocked.set(workspaceId, { fingerprint: fingerprint(config), key, plaintext: new Map(), workspaceVisible: false });
    return config;
  }

  async unlock(workspaceId: string, config: SecretFieldsConfig, password: string, values: unknown[] = []): Promise<void> {
    if (!isSecretFieldsConfig(config)) throw new Error("Unsupported secret-field format");
    const key = await deriveKey(password, config);
    let verified: string;
    try {
      verified = await decryptWithKey(key, config.verifier);
    } catch {
      throw new Error("INVALID_PASSWORD");
    }
    if (verified !== `${VERIFIER_TEXT}:${workspaceId}`) throw new Error("INVALID_PASSWORD");
    const session: UnlockedWorkspace = { fingerprint: fingerprint(config), key, plaintext: new Map(), workspaceVisible: false };
    this.unlocked.set(workspaceId, session);
    await Promise.all(values.filter(isEncryptedSecretValue).map(async (value) => {
      try { session.plaintext.set(valueKey(value), await decryptWithKey(key, value)); } catch { /* corrupt value stays unavailable */ }
    }));
  }

  isUnlocked(workspaceId: string, config: SecretFieldsConfig | undefined): boolean {
    if (!isSecretFieldsConfig(config)) {
      this.unlocked.delete(workspaceId);
      return false;
    }
    const session = this.unlocked.get(workspaceId);
    if (!session || !config || session.fingerprint !== fingerprint(config)) {
      if (session) this.unlocked.delete(workspaceId);
      return false;
    }
    return true;
  }

  lock(workspaceId: string): void {
    this.unlocked.delete(workspaceId);
  }

  lockAll(): void {
    this.unlocked.clear();
  }

  revealWorkspace(workspaceId: string): void {
    const session = this.unlocked.get(workspaceId);
    if (session) session.workspaceVisible = true;
  }

  isWorkspaceVisible(workspaceId: string, config: SecretFieldsConfig | undefined): boolean {
    return this.isUnlocked(workspaceId, config) && this.unlocked.get(workspaceId)!.workspaceVisible;
  }

  /** Decrypted value available to an explicitly revealed modal control. */
  plaintext(workspaceId: string, config: SecretFieldsConfig | undefined, value: unknown): string | null {
    if (!this.isUnlocked(workspaceId, config)) return null;
    const session = this.unlocked.get(workspaceId)!;
    // Legacy plaintext is intentionally visible only in an unlocked session;
    // the next edit/save upgrades it to encrypted storage.
    if (!isEncryptedSecretValue(value)) return scalarText(value);
    return session.plaintext.get(valueKey(value)) ?? null;
  }

  /** Decrypted value for shared views; unavailable until Unlock workspace. */
  workspacePlaintext(workspaceId: string, config: SecretFieldsConfig | undefined, value: unknown): string | null {
    if (!this.isWorkspaceVisible(workspaceId, config)) return null;
    return this.plaintext(workspaceId, config, value);
  }

  async decrypt(workspaceId: string, config: SecretFieldsConfig, value: unknown): Promise<string | null> {
    const session = this.unlocked.get(workspaceId);
    if (!session || session.fingerprint !== fingerprint(config)) return null;
    if (!isEncryptedSecretValue(value)) return scalarText(value);
    const cached = session.plaintext.get(valueKey(value));
    if (cached !== undefined) return cached;
    try {
      const plaintext = await decryptWithKey(session.key, value);
      session.plaintext.set(valueKey(value), plaintext);
      return plaintext;
    } catch {
      return null;
    }
  }

  async encrypt(workspaceId: string, config: SecretFieldsConfig, plaintext: string): Promise<SecretFieldValue> {
    const session = this.unlocked.get(workspaceId);
    if (!session || session.fingerprint !== fingerprint(config)) throw new Error("SECRET_FIELDS_LOCKED");
    const value = await encryptWithKey(session.key, plaintext);
    session.plaintext.set(valueKey(value), plaintext);
    return value;
  }
}

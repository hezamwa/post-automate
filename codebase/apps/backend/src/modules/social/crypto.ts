// NFR-11.8 (design §17): social tokens are sealed with AES-GCM under SOCIAL_TOKEN_KEY
// before they touch the database. Format: "v1:" + base64(12-byte IV ‖ ciphertext+tag).

const PREFIX = "v1:";

const b64 = {
  encode: (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)),
  decode: (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0)),
};

async function importKey(keyB64: string | undefined): Promise<CryptoKey> {
  if (!keyB64) throw new Error("SOCIAL_TOKEN_KEY is not set — social accounts cannot be stored (runbook §6).");
  const raw = b64.decode(keyB64);
  if (raw.length !== 32) throw new Error("SOCIAL_TOKEN_KEY must be 32 random bytes, base64-encoded (openssl rand -base64 32).");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function seal(keyB64: string | undefined, plaintext: string): Promise<string> {
  const key = await importKey(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)));
  const out = new Uint8Array(iv.length + cipher.length);
  out.set(iv);
  out.set(cipher, iv.length);
  return PREFIX + b64.encode(out);
}

export async function open(keyB64: string | undefined, sealed: string): Promise<string> {
  if (!sealed.startsWith(PREFIX)) throw new Error("unrecognised sealed-token format");
  const key = await importKey(keyB64);
  const bytes = b64.decode(sealed.slice(PREFIX.length));
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, key, bytes.slice(12));
  return new TextDecoder().decode(plain);
}

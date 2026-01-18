// public/js/crypto/crypto-core.js
// Phase 1: Browser-only encryption helpers (AES-GCM + PBKDF2)
// Output format is a portable "blob": { v, kdf, salt, iv, ciphertext, createdAt }

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------- Base64 helpers ----------
function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ---------- Random bytes ----------
function randomBytes(len) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return bytes;
}

// ---------- PBKDF2 -> AES-GCM Key ----------
async function deriveAesKeyFromPin(pin, saltBytes, iterations = 210000) {
  // pin: string
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(pin),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: saltBytes,
      iterations,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

// ---------- Encrypt/Decrypt JSON ----------
export async function encryptJSON({ pin, data, aad = "sunnys-resume-saas:v1" }) {
  if (!pin || typeof pin !== "string") throw new Error("PIN is required");
  if (pin.length !== 6 || !/^\d{6}$/.test(pin))
    throw new Error("PIN must be exactly 6 digits");
  if (data == null || typeof data !== "object")
    throw new Error("data must be an object");

  const salt = randomBytes(16); // 128-bit salt
  const iv = randomBytes(12); // 96-bit IV recommended for AES-GCM
  const iterations = 210000;

  const key = await deriveAesKeyFromPin(pin, salt, iterations);

  const plaintext = enc.encode(JSON.stringify(data));
  const additionalData = enc.encode(aad);

  const ciphertextBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData },
    key,
    plaintext
  );

  const ciphertext = new Uint8Array(ciphertextBuf);

  return {
    v: 1,
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations },
    alg: { name: "AES-GCM", length: 256 },
    aad, // not secret, used for integrity binding
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(ciphertext),
    createdAt: new Date().toISOString(),
  };
}

export async function decryptJSON({ pin, blob }) {
  if (!pin || typeof pin !== "string") throw new Error("PIN is required");
  if (pin.length !== 6 || !/^\d{6}$/.test(pin))
    throw new Error("PIN must be exactly 6 digits");
  if (!blob || typeof blob !== "object") throw new Error("blob is required");

  const salt = base64ToBytes(blob.salt);
  const iv = base64ToBytes(blob.iv);
  const ciphertext = base64ToBytes(blob.ciphertext);

  const iterations = blob?.kdf?.iterations ?? 210000;
  const aad = blob?.aad ?? "sunnys-resume-saas:v1";

  const key = await deriveAesKeyFromPin(pin, salt, iterations);

  const plaintextBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: enc.encode(aad) },
    key,
    ciphertext
  );

  const plaintext = dec.decode(plaintextBuf);
  return JSON.parse(plaintext);
}

import "server-only";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

// AES-256-GCM envelope for RTSP camera passwords.
//
// Storage shape: three base64 strings (ciphertext, iv, auth tag). The key
// material lives only in CAMERA_SECRET_KEY (env), so a DB-only leak cannot
// reveal credentials.

const ALGO = "aes-256-gcm";
const IV_LENGTH = 12; // GCM standard

function loadKey(): Buffer {
  const raw = process.env.CAMERA_SECRET_KEY;
  if (!raw) {
    throw new Error(
      "Missing CAMERA_SECRET_KEY. Add a long random string to .env.local."
    );
  }
  // Accept either a raw 32-byte base64/hex value or any-length string.
  // We always derive a deterministic 32-byte key via SHA-256 — that way
  // operators can paste any reasonably strong secret and we still get a
  // valid AES-256 key without bespoke decoding rules.
  return createHash("sha256").update(raw, "utf8").digest();
}

export interface EncryptedPassword {
  ciphertext: string;
  iv: string;
  tag: string;
}

export function encryptPassword(plaintext: string): EncryptedPassword {
  const key = loadKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: enc.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
  };
}

export function decryptPassword(payload: EncryptedPassword): string {
  const key = loadKey();
  const iv = Buffer.from(payload.iv, "base64");
  const tag = Buffer.from(payload.tag, "base64");
  const ciphertext = Buffer.from(payload.ciphertext, "base64");
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return dec.toString("utf8");
}

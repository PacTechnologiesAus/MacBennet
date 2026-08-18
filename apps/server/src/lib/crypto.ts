import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

/**
 * All credential handling in one place.
 *
 * scrypt from node:crypto is used rather than argon2 or bcrypt specifically
 * because it needs no native build step — the worker VM and the control plane
 * can both be provisioned with nothing but Node.
 *
 * Nothing here ever stores a plaintext credential. Passwords are salted and
 * stretched; session, worker and enrollment tokens are stored only as SHA-256
 * hashes, so a database dump yields no usable credential.
 */

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
) => Promise<Buffer>;

const SCRYPT_KEY_LENGTH = 64;
const SALT_BYTES = 16;

export async function hashPassword(password: string): Promise<{ hash: string; salt: string }> {
  const salt = randomBytes(SALT_BYTES).toString('hex');
  const derived = await scrypt(password, salt, SCRYPT_KEY_LENGTH);
  return { hash: derived.toString('hex'), salt };
}

export async function verifyPassword(password: string, hash: string, salt: string): Promise<boolean> {
  let expected: Buffer;
  try {
    expected = Buffer.from(hash, 'hex');
  } catch {
    return false;
  }
  if (expected.length !== SCRYPT_KEY_LENGTH) return false;

  const derived = await scrypt(password, salt, SCRYPT_KEY_LENGTH);
  return timingSafeEqual(derived, expected);
}

/**
 * Constant-time comparison of two strings of possibly different length.
 * Hashing both first makes the comparison length-independent, so the
 * timingSafeEqual precondition is always satisfied.
 */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** URL-safe random token. 32 bytes = 256 bits of entropy. */
export function generateToken(prefix = '', bytes = 32): string {
  return prefix + randomBytes(bytes).toString('base64url');
}

/**
 * Tokens are high-entropy random values, so a plain SHA-256 is the correct
 * storage transform: there is nothing to brute-force, and a slow KDF would
 * merely add latency to every authenticated request.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Non-secret display prefix, e.g. "mac_wk_A7f2…". */
export function tokenDisplayPrefix(token: string): string {
  return `${token.slice(0, 14)}…`;
}

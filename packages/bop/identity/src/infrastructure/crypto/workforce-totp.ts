import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * RFC 6238 time-based one-time password (HMAC-SHA-1, 30-second steps, 6 digits) used by the
 * WP-2423 Q5 pilot step-up (TEST-ONLY authenticator secrets held outside the repository). The
 * secret and the submitted code are never returned, logged or placed in an error.
 */
const stepSeconds = 30;
const digits = 6;
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const fail = (): never => {
  throw new Error("WORKFORCE_TOTP_INPUT_INVALID");
};

/** RFC 4648 base32 (upper case, optional padding), as authenticator apps expect. */
export function decodeTotpSecret(value: unknown): Uint8Array {
  if (typeof value !== "string" || !/^[A-Z2-7]{16,128}=*$/u.test(value)) return fail();
  const text = value.replace(/=+$/u, "");
  const bytes: number[] = [];
  let buffer = 0,
    bits = 0;
  for (const character of text) {
    buffer = (buffer << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 255);
    }
  }
  if (bytes.length < 10) return fail();
  return Uint8Array.from(bytes);
}

export function encodeTotpSecret(secret: Uint8Array): string {
  if (!(secret instanceof Uint8Array) || secret.byteLength < 10 || secret.byteLength > 64)
    return fail();
  let buffer = 0,
    bits = 0,
    text = "";
  for (const byte of secret) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      text += alphabet[(buffer >> bits) & 31];
    }
  }
  if (bits > 0) text += alphabet[(buffer << (5 - bits)) & 31];
  return text;
}

/** HOTP value (RFC 4226) for one counter; digits defaults to the pilot's 6. */
export function generateHotp(secret: Uint8Array, counter: number, length = digits): string {
  if (
    !(secret instanceof Uint8Array) ||
    secret.byteLength < 10 ||
    !Number.isSafeInteger(counter) ||
    counter < 0 ||
    ![6, 8].includes(length)
  )
    return fail();
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", secret).update(message).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 15;
  const binary =
    (((mac[offset] ?? 0) & 127) << 24) |
    ((mac[offset + 1] ?? 0) << 16) |
    ((mac[offset + 2] ?? 0) << 8) |
    (mac[offset + 3] ?? 0);
  return String(binary % 10 ** length).padStart(length, "0");
}

export function totpTimeStep(atMilliseconds: number): number {
  if (!Number.isSafeInteger(atMilliseconds) || atMilliseconds < 0) return fail();
  return Math.floor(atMilliseconds / 1000 / stepSeconds);
}

/**
 * Accepts the current step and one step either side (clock drift). Every candidate is compared in
 * constant time and all candidates are always computed, so timing does not reveal which matched.
 * Returns the matched time step (the caller refuses a step it has already accepted) or null.
 */
export function verifyTotp(input: {
  readonly secret: Uint8Array;
  readonly code: unknown;
  readonly atMilliseconds: number;
}): { readonly timeStep: number } | null {
  const current = totpTimeStep(input.atMilliseconds);
  if (typeof input.code !== "string" || !/^[0-9]{6}$/u.test(input.code)) return null;
  const submitted = Buffer.from(input.code, "utf8");
  let matched: number | null = null;
  for (const step of [current - 1, current, current + 1]) {
    if (step < 0) continue;
    const expected = Buffer.from(generateHotp(input.secret, step), "utf8");
    if (timingSafeEqual(expected, submitted) && matched === null) matched = step;
  }
  return matched === null ? null : Object.freeze({ timeStep: matched });
}

/** otpauth URI an authenticator app scans. Contains the secret: print only on explicit request. */
export function totpProvisioningUri(input: {
  readonly secret: Uint8Array;
  readonly issuer: string;
  readonly accountLabel: string;
}): string {
  const plain = /^[A-Za-z0-9 ._-]{1,64}$/u;
  if (!plain.test(input.issuer) || !plain.test(input.accountLabel)) return fail();
  const label = encodeURIComponent(input.issuer + ":" + input.accountLabel);
  return (
    "otpauth://totp/" +
    label +
    "?secret=" +
    encodeTotpSecret(input.secret) +
    "&issuer=" +
    encodeURIComponent(input.issuer) +
    "&algorithm=SHA1&digits=6&period=30"
  );
}

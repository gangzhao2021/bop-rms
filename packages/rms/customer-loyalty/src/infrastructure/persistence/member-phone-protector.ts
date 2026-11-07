import { Buffer } from "node:buffer";
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  randomInt,
} from "node:crypto";

/**
 * WP-2423 取舍 18: a member's phone number is personal data. Stored encrypted, found by a keyed hash
 * (a phone number's few digits can't be protected by a plain hash), and a code or session token is
 * only ever kept as a keyed hash. One managed key; each use has its own derived key.
 */
export function createMemberPhoneProtector(keyMaterial: Uint8Array) {
  if (keyMaterial.length < 32) throw new Error("MEMBER_PHONE_KEY_INVALID");
  const derive = (purpose: string) =>
    Buffer.from(hkdfSync("sha256", keyMaterial, Buffer.alloc(0), "bop-member:" + purpose, 32));
  const lookup = derive("phone-lookup"),
    sealing = derive("phone-seal"),
    codes = derive("code"),
    sessions = derive("session"),
    budgets = derive("budget");
  return Object.freeze({
    lookupHash: (brandReference: string, phone: string) =>
      createHmac("sha256", lookup).update(brandReference).update("\0").update(phone).digest(),
    seal(phone: string): Buffer {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", sealing, iv);
      const body = Buffer.concat([cipher.update(phone, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    open(sealed: Uint8Array): string {
      const value = Buffer.from(sealed);
      const decipher = createDecipheriv("aes-256-gcm", sealing, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString(
        "utf8",
      );
    },
    newCode: () => String(randomInt(0, 1_000_000)).padStart(6, "0"),
    codeHash: (challengeReference: string, code: string) =>
      createHmac("sha256", codes).update(challengeReference).update("\0").update(code).digest(),
    newSessionToken: () => randomBytes(32).toString("base64url"),
    sessionHash: (token: string) => createHmac("sha256", sessions).update(token).digest(),
    budgetKey: (purpose: string, value: string) =>
      createHmac("sha256", budgets).update(purpose).update("\0").update(value).digest(),
  });
}
export type MemberPhoneProtector = ReturnType<typeof createMemberPhoneProtector>;

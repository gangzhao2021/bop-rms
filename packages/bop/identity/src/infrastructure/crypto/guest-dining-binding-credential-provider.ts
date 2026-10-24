import { createHmac, createSecretKey, randomBytes, timingSafeEqual } from "node:crypto";
import {
  GuestSessionError,
  parseGuestRawCredential,
  parseGuestSelectorHash,
  type GuestRawCredential,
  type GuestSelectorHash,
} from "../../contracts/guest-session.js";

/** Dedicated proof purpose; this hash can never authenticate a Session or CSRF credential. */
export function createGuestDiningBindingCredentialProvider(selectorKey: Uint8Array) {
  if (!(selectorKey instanceof Uint8Array) || selectorKey.byteLength !== 32)
    throw new GuestSessionError("GUEST_SESSION_INPUT_INVALID");
  const copied = Buffer.from(selectorKey);
  const key = createSecretKey(copied);
  copied.fill(0);
  return Object.freeze({
    generate(): GuestRawCredential {
      return parseGuestRawCredential(randomBytes(32).toString("base64url"));
    },
    hash(credential: GuestRawCredential): GuestSelectorHash {
      const parsed = parseGuestRawCredential(credential);
      return parseGuestSelectorHash(
        createHmac("sha256", key)
          .update("bop-rms:guest-dining-binding:v1:recovery", "utf8")
          .update(Buffer.from([0]))
          .update(parsed, "utf8")
          .digest("hex"),
      );
    },
    equals(left: GuestSelectorHash, right: GuestSelectorHash) {
      if (!/^[0-9a-f]{64}$/u.test(left) || !/^[0-9a-f]{64}$/u.test(right)) return false;
      return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
    },
  });
}

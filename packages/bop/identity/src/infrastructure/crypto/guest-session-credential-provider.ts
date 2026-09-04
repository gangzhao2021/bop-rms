import { createHmac, createSecretKey, randomBytes, timingSafeEqual } from "node:crypto";
import { v7 as uuidV7 } from "uuid";
import {
  GuestSessionError,
  parseGuestRawCredential,
  parseGuestSelectorHash,
  parseGuestSessionReference,
  type GuestRawCredential,
  type GuestSelectorHash,
} from "../../contracts/guest-session.js";
import type { GuestSessionCredentialPort } from "../../application/ports/guest-session-ports.js";

const selectorKeyBytes = 32;
const maximumIntentBytes = 4096;
const domainPrefix = "bop-rms:guest-session:v1";

function invalid(): never {
  throw new GuestSessionError("GUEST_SESSION_INPUT_INVALID");
}

export function createGuestSessionCredentialProvider(
  selectorKey: Uint8Array,
): GuestSessionCredentialPort {
  if (!(selectorKey instanceof Uint8Array) || selectorKey.byteLength !== selectorKeyBytes)
    invalid();

  const copiedKey = Buffer.from(selectorKey);
  const key = createSecretKey(copiedKey);
  copiedKey.fill(0);

  const digest = (purpose: "session" | "csrf" | "intent", value: string) =>
    parseGuestSelectorHash(
      createHmac("sha256", key)
        .update(`${domainPrefix}:${purpose}`, "utf8")
        .update(Buffer.from([0]))
        .update(value, "utf8")
        .digest("hex"),
    );

  return Object.freeze({
    generateCredential() {
      return parseGuestRawCredential(randomBytes(32).toString("base64url"));
    },
    generateSessionReference() {
      return parseGuestSessionReference(uuidV7());
    },
    hashCredential(purpose: "Session" | "Csrf", credential: GuestRawCredential) {
      const parsed = parseGuestRawCredential(credential);
      return digest(purpose === "Session" ? "session" : "csrf", parsed);
    },
    hashOperationIntent(intent: string) {
      if (
        typeof intent !== "string" ||
        intent.length === 0 ||
        Buffer.byteLength(intent, "utf8") > maximumIntentBytes
      )
        invalid();
      return digest("intent", intent);
    },
    equals(left: GuestSelectorHash, right: GuestSelectorHash) {
      if (!/^[0-9a-f]{64}$/u.test(left) || !/^[0-9a-f]{64}$/u.test(right)) return false;
      return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
    },
  });
}

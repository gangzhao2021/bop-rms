import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createGuestSessionCredentialProvider,
  GuestSessionError,
  parseGuestRawCredential,
  parseGuestSelectorHash,
  parseGuestSessionReference,
  type GuestSelectorHash,
} from "../index.js";

const selectorKey = () => Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const credential = parseGuestRawCredential("A".repeat(43));

describe("WP-2214 Guest Session cryptographic credential provider", () => {
  it("generates 256-bit credentials and UUIDv7 session references", () => {
    const provider = createGuestSessionCredentialProvider(selectorKey());
    const credentials = Array.from({ length: 32 }, () => provider.generateCredential("Session"));

    expect(new Set(credentials).size).toBe(credentials.length);
    for (const value of credentials) {
      expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(Buffer.from(value, "base64url")).toHaveLength(32);
    }
    expect(parseGuestSessionReference(provider.generateSessionReference())).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
  });

  it("derives exact purpose-separated HMAC-SHA-256 selectors", () => {
    const key = selectorKey();
    const provider = createGuestSessionCredentialProvider(key);
    const expected = createHmac("sha256", key)
      .update("bop-rms:guest-session:v1:session", "utf8")
      .update(Buffer.from([0]))
      .update(credential, "utf8")
      .digest("hex");

    expect(provider.hashCredential("Session", credential)).toBe(expected);
    expect(
      new Set([
        provider.hashCredential("Session", credential),
        provider.hashCredential("Csrf", credential),
        provider.hashOperationIntent(credential),
      ]).size,
    ).toBe(3);
  });

  it("copies caller key material and validates an exact 256-bit key", () => {
    const key = selectorKey();
    const provider = createGuestSessionCredentialProvider(key);
    const before = provider.hashCredential("Session", credential);
    key.fill(0);

    expect(provider.hashCredential("Session", credential)).toBe(before);
    for (const length of [0, 31, 33])
      expect(() => createGuestSessionCredentialProvider(new Uint8Array(length))).toThrow(
        new GuestSessionError("GUEST_SESSION_INPUT_INVALID"),
      );
  });

  it("compares only canonical fixed-length selectors", () => {
    const provider = createGuestSessionCredentialProvider(selectorKey());
    const left = provider.hashCredential("Session", credential);
    const same = parseGuestSelectorHash(left);
    const other = provider.hashCredential("Csrf", credential);

    expect(provider.equals(left, same)).toBe(true);
    expect(provider.equals(left, other)).toBe(false);
    expect(provider.equals(left, "0" as GuestSelectorHash)).toBe(false);
  });

  it("bounds operation intent input without exposing it", () => {
    const provider = createGuestSessionCredentialProvider(selectorKey());
    for (const intent of ["", "x".repeat(4097)]) {
      let failure: unknown;
      try {
        provider.hashOperationIntent(intent);
      } catch (error) {
        failure = error;
      }
      expect(failure).toEqual(new GuestSessionError("GUEST_SESSION_INPUT_INVALID"));
      expect(failure).not.toHaveProperty("cause");
      if (intent.length > 0) expect(String(failure)).not.toContain(intent);
    }
  });
});

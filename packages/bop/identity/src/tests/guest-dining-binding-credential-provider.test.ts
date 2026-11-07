import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createGuestDiningBindingCredentialProvider } from "../infrastructure/crypto/guest-dining-binding-credential-provider.js";
import { createGuestSessionCredentialProvider } from "../infrastructure/crypto/guest-session-credential-provider.js";

import { createGuestBindingCredentialProvider } from "../infrastructure/crypto/guest-binding-credential-provider.js";

describe("WP-2296 binding proof crypto", () => {
  it("generates 256-bit proof and separates its purpose from Session and CSRF", () => {
    const key = new Uint8Array(32).fill(7);
    const provider = createGuestDiningBindingCredentialProvider(key);
    const session = createGuestSessionCredentialProvider(key);
    const proof = provider.generate();
    expect(proof).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(provider.generate()).not.toBe(proof);
    const expected = createHmac("sha256", key)
      .update("bop-rms:guest-dining-binding:v1:recovery")
      .update(Buffer.from([0]))
      .update(proof)
      .digest("hex");
    expect(provider.hash(proof)).toBe(expected);
    expect(
      new Set([
        expected,
        createGuestBindingCredentialProvider(key).hash(proof),
        session.hashCredential("Session", proof),
        session.hashCredential("Csrf", proof),
        session.hashOperationIntent(proof),
      ]).size,
    ).toBe(5);
    key.fill(0);
    expect(provider.hash(proof)).toBe(expected);
    expect(provider.equals(provider.hash(proof), provider.hash(proof))).toBe(true);
    expect(provider.equals(provider.hash(proof), session.hashCredential("Session", proof))).toBe(
      false,
    );
  });
  it.each([0, 31, 33])("rejects invalid key size %s", (size) => {
    expect(() => createGuestDiningBindingCredentialProvider(new Uint8Array(size))).toThrowError(
      "guest session request is invalid",
    );
  });
});

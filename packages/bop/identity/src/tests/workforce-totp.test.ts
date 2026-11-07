import { expect, it } from "vitest";
import {
  decodeTotpSecret,
  encodeTotpSecret,
  generateHotp,
  totpProvisioningUri,
  totpTimeStep,
  verifyTotp,
} from "../infrastructure/crypto/workforce-totp.js";

// RFC 6238 Appendix B (SHA-1 seed "12345678901234567890") and RFC 4226 Appendix D.
const seed = Uint8Array.from(Buffer.from("12345678901234567890", "ascii"));
it.each([
  [59, "94287082"],
  [1111111109, "07081804"],
  [1111111111, "14050471"],
  [1234567890, "89005924"],
  [2000000000, "69279037"],
  [20000000000, "65353130"],
])("matches the RFC 6238 SHA-1 vector at T=%d", (seconds, expected) => {
  expect(generateHotp(seed, totpTimeStep(seconds * 1000), 8)).toBe(expected);
});
it("matches the RFC 4226 six-digit vectors", () => {
  expect([0, 1, 2, 3, 9].map((counter) => generateHotp(seed, counter))).toEqual([
    "755224",
    "287082",
    "359152",
    "969429",
    "520489",
  ]);
});
it("round-trips base32 secrets and rejects malformed or short secrets", () => {
  const text = encodeTotpSecret(seed);
  expect(text).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  expect(Buffer.from(decodeTotpSecret(text)).toString("ascii")).toBe("12345678901234567890");
  for (const bad of ["", "gezdgnbvgy3tqojq", "GEZDGNBV1Y3TQOJQ", "GEZDGNBVGY3TQ", 7])
    expect(() => decodeTotpSecret(bad)).toThrow("WORKFORCE_TOTP_INPUT_INVALID");
});
it("accepts the current step and one step of drift either side, and nothing else", () => {
  const at = 1_760_000_000_000;
  const step = totpTimeStep(at);
  for (const offset of [-1, 0, 1])
    expect(
      verifyTotp({ secret: seed, code: generateHotp(seed, step + offset), atMilliseconds: at }),
    ).toEqual({ timeStep: step + offset });
  for (const offset of [-2, 2])
    expect(
      verifyTotp({ secret: seed, code: generateHotp(seed, step + offset), atMilliseconds: at }),
    ).toBeNull();
  for (const code of ["", "12345", "1234567", "abcdef", 123456, null])
    expect(verifyTotp({ secret: seed, code, atMilliseconds: at })).toBeNull();
});
it("builds an otpauth URI for an authenticator app only from plain labels", () => {
  expect(
    totpProvisioningUri({ secret: seed, issuer: "BOP RMS TEST", accountLabel: "DEMO staff" }),
  ).toBe(
    "otpauth://totp/BOP%20RMS%20TEST%3ADEMO%20staff?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=BOP%20RMS%20TEST&algorithm=SHA1&digits=6&period=30",
  );
  expect(() =>
    totpProvisioningUri({ secret: seed, issuer: "x&y", accountLabel: "DEMO staff" }),
  ).toThrow();
});

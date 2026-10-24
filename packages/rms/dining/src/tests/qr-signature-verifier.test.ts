import { createSecretKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createQrSignatureVerifier, type PublicKeyReference } from "../index.js";

const reference = "00000000-0000-7000-8000-000000000013" as PublicKeyReference;
const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const signingInput = "eyJhbGciOiJFUzI1NiJ9.eyJ0ZXN0Ijp0cnVlfQ";
function request() {
  return {
    algorithm: "ES256" as const,
    publicKeyReference: reference,
    signingInput,
    signature: sign("sha256", Buffer.from(signingInput), {
      key: keys.privateKey,
      dsaEncoding: "ieee-p1363" as const,
    }),
  };
}
describe("configured QR signature verifier", () => {
  it("verifies a genuine P-256 signature using the selected server key", async () => {
    const load = vi.fn(async () => keys.publicKey);
    expect(await createQrSignatureVerifier(load).verify(request())).toBe("Verified");
    expect(load).toHaveBeenCalledWith(reference);
  });
  it("rejects altered content, signature and a different P-256 key", async () => {
    const verifier = createQrSignatureVerifier(async () => keys.publicKey);
    const input = request();
    expect(await verifier.verify({ ...input, signingInput: signingInput + "A" })).toBe("Invalid");
    input.signature[0] = (input.signature[0] ?? 0) ^ 1;
    expect(await verifier.verify(input)).toBe("Invalid");
    const other = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    expect(await createQrSignatureVerifier(async () => other.publicKey).verify(request())).toBe(
      "Invalid",
    );
  });
  it("rejects wrong curve, private, symmetric and non-EC keys", async () => {
    const wrongCurve = generateKeyPairSync("ec", { namedCurve: "secp256k1" }).publicKey;
    const otherType = generateKeyPairSync("ed25519").publicKey;
    for (const key of [wrongCurve, keys.privateKey, createSecretKey(Buffer.alloc(32)), otherType])
      expect(await createQrSignatureVerifier(async () => key).verify(request())).toBe(
        "Unavailable",
      );
  });
  it("fails closed for missing or failed key lookup and does not cache keys", async () => {
    const load = vi
      .fn<() => Promise<KeyObject | null>>()
      .mockResolvedValueOnce(keys.publicKey)
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("private resolver detail"));
    const verifier = createQrSignatureVerifier(load);
    expect(await verifier.verify(request())).toBe("Verified");
    expect(await verifier.verify(request())).toBe("Unavailable");
    expect(await verifier.verify(request())).toBe("Unavailable");
  });
  it("rejects malformed inputs before resolving any key", async () => {
    const load = vi.fn(async () => keys.publicKey);
    const verifier = createQrSignatureVerifier(load);
    for (const input of [
      { ...request(), algorithm: "HS256" as "ES256" },
      { ...request(), publicKeyReference: "../key" as PublicKeyReference },
      { ...request(), signature: new Uint8Array(63) },
      { ...request(), signature: sign("sha256", Buffer.from(signingInput), keys.privateKey) },
      { ...request(), signingInput: "a".repeat(1962) + ".a" },
      { ...request(), signingInput: "a.b.c" },
      { ...request(), signingInput: "a.b=" },
    ])
      expect(await verifier.verify(input)).toBe("Invalid");
    expect(load).not.toHaveBeenCalled();
  });
  it("snapshots signature bytes before asynchronous key resolution", async () => {
    let release: (key: KeyObject) => void = () => {
      throw new Error("not pending");
    };
    const verifier = createQrSignatureVerifier(
      () =>
        new Promise<KeyObject>((resolve) => {
          release = resolve;
        }),
    );
    const input = request();
    const pending = verifier.verify(input);
    input.signature.fill(0);
    release(keys.publicKey);
    expect(await pending).toBe("Verified");
  });
});

import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  assessNewStaffPin,
  isTrivialStaffPin,
  parseStoreDeviceLabel,
  readSubmittedStaffPin,
  staffPinPolicy,
} from "../contracts/staff-pin.js";
import {
  createArgon2idStaffPinKdf,
  createStaffPinChoiceTokens,
  createStoreDeviceSecretHasher,
  generateStoreDeviceSecret,
  staffPinBinding,
  staffPinHashesEqual,
} from "../infrastructure/crypto/staff-pin-kdf.js";

/** WP-2423 Q18 option A: the staff PIN rules and key derivation (Owner 2026-10-14). */
describe("staff PIN rules", () => {
  it("uses the accepted parameters", () => {
    expect(staffPinPolicy).toMatchObject({
      digits: 6,
      failureLimit: 5,
      lockMinutes: 15,
      deviceFailureLimit: 10,
      deviceWindowMinutes: 15,
      elevationMinutes: 15,
    });
  });
  it("refuses PINs anyone would try first", () => {
    for (const pin of [
      "000000",
      "999999",
      "123456",
      "234567",
      "012345",
      "654321",
      "987654",
      "121212",
      "909090",
      "123123",
      "770770",
    ])
      expect(isTrivialStaffPin(pin), pin).toBe(true);
    for (const pin of ["482913", "730418", "135792", "112358", "120120"])
      expect(isTrivialStaffPin(pin), pin).toBe(pin === "120120");
  });
  it("checks format, then the confirmation, then simplicity", () => {
    expect(assessNewStaffPin("48291", "48291")).toBe("Format");
    expect(assessNewStaffPin("48291a", "48291a")).toBe("Format");
    expect(assessNewStaffPin(482913, 482913)).toBe("Format");
    expect(assessNewStaffPin("482913", "482914")).toBe("Mismatch");
    expect(assessNewStaffPin("123456", "123456")).toBe("TooSimple");
    expect(assessNewStaffPin("482913", "482913")).toBeNull();
  });
  it("treats any malformed submitted PIN as a mismatch, never echoing it", () => {
    expect(readSubmittedStaffPin("482913")).toBe("482913");
    for (const value of ["", "1234567", " 482913", 482913, null])
      expect(readSubmittedStaffPin(value)).toBeNull();
  });
  it("accepts plain tablet names only", () => {
    expect(parseStoreDeviceLabel("  Front counter ")).toBe("Front counter");
    expect(parseStoreDeviceLabel("")).toBeNull();
    expect(parseStoreDeviceLabel("a".repeat(41))).toBeNull();
    expect(parseStoreDeviceLabel("Bar\u0007")).toBeNull();
    expect(parseStoreDeviceLabel("Bar​")).toBeNull();
  });
});

describe("staff PIN key derivation (Argon2id)", () => {
  const pepper = Buffer.alloc(32, 7);
  const kdf = createArgon2idStaffPinKdf({
    peppers: new Map([[1, pepper]]),
    currentPepperVersion: 1,
  });
  const scope = {
    brandReference: "0190b3a0-0000-7000-8000-000000000001",
    storeReference: "0190b3a0-0000-7000-8000-000000000002",
    actorReference: "0190b3a0-0000-7000-8000-000000000003",
  };
  const salt = Buffer.alloc(16, 1);
  const derive = (pin: string, binding = staffPinBinding(scope), k = kdf) =>
    k.derive({ pin, salt, binding, parameters: k.current });
  it("uses the OWASP minimum Argon2id cost with a versioned pepper", () => {
    expect(kdf.current).toEqual({
      algorithm: "argon2id",
      memoryKib: 19456,
      passes: 2,
      parallelism: 1,
      pepperVersion: 1,
    });
    expect(kdf.newSalt()).toHaveLength(16);
    expect(() =>
      createArgon2idStaffPinKdf({
        peppers: new Map([[1, pepper]]),
        currentPepperVersion: 1,
        memoryKib: 4096,
      }),
    ).toThrow("STAFF_PIN_KDF_UNAVAILABLE");
    expect(() =>
      createArgon2idStaffPinKdf({ peppers: new Map(), currentPepperVersion: 1 }),
    ).toThrow();
  });
  it("is deterministic, and depends on the PIN, the person/Store binding and the pepper", async () => {
    const a = await derive("482913");
    expect(a).toHaveLength(32);
    expect(staffPinHashesEqual(a, await derive("482913"))).toBe(true);
    expect(staffPinHashesEqual(a, await derive("482914"))).toBe(false);
    expect(
      staffPinHashesEqual(
        a,
        await derive("482913", staffPinBinding({ ...scope, actorReference: scope.brandReference })),
      ),
    ).toBe(false);
    const other = createArgon2idStaffPinKdf({
      peppers: new Map([[1, Buffer.alloc(32, 8)]]),
      currentPepperVersion: 1,
    });
    expect(staffPinHashesEqual(a, await derive("482913", staffPinBinding(scope), other))).toBe(
      false,
    );
    await expect(derive("48291")).rejects.toThrow("STAFF_PIN_KDF_UNAVAILABLE");
  });
});

describe("store tablet secret", () => {
  it("is 32 random bytes; only a keyed hash leaves the cookie", () => {
    const secret = generateStoreDeviceSecret();
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(generateStoreDeviceSecret()).not.toBe(secret);
    const hasher = createStoreDeviceSecretHasher(Buffer.alloc(32, 3));
    expect(hasher.hash(secret)).toMatch(/^[0-9a-f]{64}$/u);
    expect(hasher.hash(secret)).toBe(hasher.hash(secret));
    expect(createStoreDeviceSecretHasher(Buffer.alloc(32, 4)).hash(secret)).not.toBe(
      hasher.hash(secret),
    );
    expect(() => hasher.hash("short")).toThrow();
  });
});

describe("lock-screen choice token", () => {
  const ref = (n: number) => "0190b3a0-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const front = { brandReference: ref(1), storeReference: ref(2), deviceReference: ref(3) };
  const patio = { ...front, deviceReference: ref(4) };
  const people = [ref(10), ref(11), ref(12)];
  const tokens = createStaffPinChoiceTokens(Buffer.alloc(32, 5));
  it("names a person on one tablet without carrying their reference", () => {
    const token = tokens.issue(front, ref(11));
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(token).not.toContain(ref(11));
    expect(tokens.issue(front, ref(11))).toBe(token);
    expect(tokens.resolve(front, token, people)).toBe(ref(11));
    expect(tokens.issue(front, ref(10))).not.toBe(token);
  });
  it("names nobody on another tablet, under another key, altered or outside the candidates", () => {
    const token = tokens.issue(front, ref(11));
    expect(tokens.resolve(patio, token, people)).toBeNull();
    expect(tokens.resolve({ ...front, storeReference: ref(9) }, token, people)).toBeNull();
    expect(
      createStaffPinChoiceTokens(Buffer.alloc(32, 6)).resolve(front, token, people),
    ).toBeNull();
    expect(tokens.resolve(front, token, [ref(10), ref(12)])).toBeNull();
    const last = token.at(-1) === "A" ? "B" : "A";
    expect(tokens.resolve(front, token.slice(0, 42) + last, people)).toBeNull();
    for (const value of [ref(11), "", null, 7, token + "A", token.slice(1)])
      expect(tokens.resolve(front, value, people)).toBeNull();
    expect(() => createStaffPinChoiceTokens(Buffer.alloc(16))).toThrow();
  });
});

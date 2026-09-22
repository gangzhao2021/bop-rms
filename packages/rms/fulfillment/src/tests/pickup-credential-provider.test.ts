import { expect, it } from "vitest";
import { createPickupCredentialProvider } from "../infrastructure/crypto/pickup-credential-provider.js";
const id = (n: number) => `01900000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const keys = () => [
  {
    version: 1,
    derivationKey: new Uint8Array(32).fill(11),
    selectorKey: new Uint8Array(32).fill(22),
  },
];
const input = {
  brandReference: id(1),
  storeReference: id(2),
  fulfillmentReference: id(3),
  capabilityReference: id(4),
  generation: 1,
  pepperVersion: 1,
};
function setup() {
  const provider = createPickupCredentialProvider(keys()),
    credential = provider.deriveOpaque(input);
  const selectorHash = provider.hashCredential({
    ...input,
    purpose: "PickupHandoff",
    kind: "Opaque",
    credential,
  });
  const capability = {
    capabilityReference: input.capabilityReference,
    purpose: "PickupHandoff",
    kind: "Opaque",
    storeReference: input.storeReference,
    fulfillmentReference: input.fulfillmentReference,
    publicOrderReference: "A".repeat(22),
    selectorHash,
    pepperVersion: 1,
    generation: 1,
    status: "Active",
    version: 1,
    readyAt: "2026-09-19T12:00:00.000Z",
    expiresAt: "2026-09-19T13:00:00.000Z",
    revokedAt: null,
  };
  return { provider, credential, capability };
}
it("recovers same128-bit credential after restart without raw persistence", () => {
  const f = setup(),
    restarted = createPickupCredentialProvider(keys());
  expect(f.credential).toMatch(/^[A-Za-z0-9_-]{21}[AQgw]$/);
  expect(
    restarted.recoverOpaque({
      brandReference: id(1),
      capability: f.capability,
      observedAt: "2026-09-19T12:30:00.000Z",
    }),
  ).toBe(f.credential);
  expect(JSON.stringify(f.capability)).not.toContain(f.credential);
});
it.each([
  "brandReference",
  "storeReference",
  "fulfillmentReference",
  "capabilityReference",
] as const)("separates %s and generation", (field) => {
  const f = setup();
  expect(f.provider.deriveOpaque({ ...input, [field]: id(99) })).not.toBe(f.credential);
  expect(f.provider.deriveOpaque({ ...input, generation: 2 })).not.toBe(f.credential);
});
it("rejects expired, mismatched, revoked or unknown-key recovery", () => {
  const f = setup(),
    recover = (capability: unknown, observedAt = "2026-09-19T12:30:00.000Z") =>
      f.provider.recoverOpaque({ brandReference: id(1), capability, observedAt });
  for (const change of [
    { generation: 2 },
    { pepperVersion: 2 },
    { selectorHash: "0".repeat(64) },
    { status: "Revoked", revokedAt: "2026-09-19T12:20:00.000Z" },
  ])
    expect(() => recover({ ...f.capability, ...change })).toThrow("pickup proof is unavailable");
  expect(() => recover(f.capability, f.capability.expiresAt)).toThrow();
  expect(() => recover(f.capability, "2026-09-19T11:59:59.000Z")).toThrow();
});
it("copies configured keys and retains explicit old versions during rotation", () => {
  const configured = keys(),
    provider = createPickupCredentialProvider(configured),
    credential = provider.deriveOpaque(input);
  configured[0]?.derivationKey.fill(0);
  configured[0]?.selectorKey.fill(0);
  expect(provider.deriveOpaque(input)).toBe(credential);
  const rotated = createPickupCredentialProvider([
    ...keys(),
    {
      version: 2,
      derivationKey: new Uint8Array(32).fill(33),
      selectorKey: new Uint8Array(32).fill(44),
    },
  ]);
  expect(rotated.deriveOpaque(input)).toBe(credential);
  expect(rotated.deriveOpaque({ ...input, pepperVersion: 2 })).not.toBe(credential);
});
it("rejects duplicate versions, shared keys and malformed credentials", () => {
  expect(() => createPickupCredentialProvider([...keys(), ...keys()])).toThrow();
  expect(() =>
    createPickupCredentialProvider([
      { version: 1, derivationKey: new Uint8Array(32), selectorKey: new Uint8Array(32) },
    ]),
  ).toThrow();
  const f = setup();
  expect(() =>
    f.provider.hashCredential({
      ...input,
      purpose: "PickupHandoff",
      kind: "Opaque",
      credential: "A".repeat(21) + "B",
    }),
  ).toThrow();
});

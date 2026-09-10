import { describe, expect, it, vi } from "vitest";
import {
  assertCurrentDiningGuestTableContext,
  createQrTableContextService,
  type QrTableContextPorts,
} from "../index.js";

const ids = {
  qr: "00000000-0000-7000-8000-000000000201",
  publicStore: "00000000-0000-7000-8000-000000000202",
  publicTable: "00000000-0000-7000-8000-000000000203",
  brand: "00000000-0000-7000-8000-000000000204",
  store: "00000000-0000-7000-8000-000000000205",
  table: "00000000-0000-7000-8000-000000000206",
  registryEvidence: "00000000-0000-7000-8000-000000000207",
  publicKey: "00000000-0000-7000-8000-000000000208",
  contextEvidence: "00000000-0000-7000-8000-000000000209",
} as const;

function payload(channel: "DineIn" | "Pickup" = "DineIn") {
  return {
    schemaVersion: 1,
    qrReference: ids.qr,
    publicStoreReference: ids.publicStore,
    publicTableReference: channel === "DineIn" ? ids.publicTable : null,
    channel,
    locale: "en-CA",
    issuedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-06-01T00:00:00.000Z",
    revocationVersion: 3,
  };
}
function token(
  value: unknown = payload(),
  header: unknown = { alg: "ES256", kid: "qr-key-1", typ: "BOP-QR" },
) {
  const encode = (input: unknown) => Buffer.from(JSON.stringify(input)).toString("base64url");
  return `${encode(header)}.${encode(value)}.${Buffer.alloc(64, 7).toString("base64url")}`;
}
const request = {
  qrToken: token(),
  evaluatedAt: "2026-01-15T12:00:00.000Z",
  purpose: "CustomerEntry",
};
function keySet() {
  return {
    registryVersion: 1,
    registryEvidenceReference: ids.registryEvidence,
    validUntil: "2026-07-01T00:00:00.000Z",
    keys: [
      {
        kid: "qr-key-1",
        algorithm: "ES256",
        state: "Current",
        publicKeyReference: ids.publicKey,
        validFrom: "2025-12-01T00:00:00.000Z",
        validUntil: "2026-07-01T00:00:00.000Z",
        compromisedAt: null,
      },
    ],
  };
}
function context(channel: "DineIn" | "Pickup" = "DineIn") {
  return {
    publicStoreReference: ids.publicStore,
    publicTableReference: channel === "DineIn" ? ids.publicTable : null,
    brandReference: ids.brand,
    storeReference: ids.store,
    tableReference: channel === "DineIn" ? ids.table : null,
    brandLifecycle: "Active",
    storeLifecycle: "Active",
    tableLifecycle: channel === "DineIn" ? "Active" : null,
    assignmentState: channel === "DineIn" ? "Active" : null,
    channel,
    qrState: "Enabled",
    revocationVersion: 3,
    contextEvidenceReference: ids.contextEvidence,
    validUntil: "2026-07-01T00:00:00.000Z",
  };
}
function harness(options?: {
  keys?: unknown;
  context?: unknown;
  verification?: "Verified" | "Invalid" | "Unavailable";
  keyFailure?: boolean;
  verifierFailure?: boolean;
  contextFailure?: boolean;
}) {
  const calls = { keys: 0, verifier: 0, contexts: 0 };
  const telemetry: unknown[] = [];
  const ports: QrTableContextPorts = {
    keys: {
      async load() {
        calls.keys += 1;
        if (options?.keyFailure) throw new Error("synthetic");
        return (options && "keys" in options ? options.keys : keySet()) as never;
      },
    },
    verifier: {
      async verify(input) {
        calls.verifier += 1;
        expect(input.algorithm).toBe("ES256");
        expect(input.signature).toHaveLength(64);
        if (options?.verifierFailure) throw new Error("synthetic");
        return options?.verification ?? "Verified";
      },
    },
    contexts: {
      async resolve() {
        calls.contexts += 1;
        if (options?.contextFailure) throw new Error("synthetic");
        return (options && "context" in options ? options.context : context()) as never;
      },
    },
    telemetry: { record: (labels) => void telemetry.push(labels) },
  };
  return {
    calls,
    telemetry,
    get: (input: unknown = request) =>
      createQrTableContextService(ports).resolveQrTableContext(input),
  };
}

describe("WP-1002 QR Token / Table Context Resolution", () => {
  it.each(["DineIn", "Pickup"] as const)(
    "verifies immutable %s context without authority",
    async (channel) => {
      const value = payload(channel);
      const result = await harness({ context: context(channel) }).get({
        ...request,
        qrToken: token(value),
      });
      expect(result).toEqual({
        status: "Verified",
        context: {
          qrReference: value.qrReference,
          publicStoreReference: value.publicStoreReference,
          publicTableReference: value.publicTableReference,
          channel: value.channel,
          locale: value.locale,
          issuedAt: value.issuedAt,
          expiresAt: value.expiresAt,
          revocationVersion: value.revocationVersion,
        },
      });
      expect(Object.isFrozen(result)).toBe(true);
      expect(result.status === "Verified" && Object.isFrozen(result.context)).toBe(true);
    },
  );

  it.each([
    ["bad token", { ...request, qrToken: "bad" }],
    ["too large", { ...request, qrToken: "a".repeat(2049) }],
    ["bad instant", { ...request, evaluatedAt: "2026-01-15" }],
    ["bad purpose", { ...request, purpose: "JoinDining" }],
    ["extra request", { ...request, storeId: ids.store }],
  ])("rejects malformed request before dependencies: %s", async (_name, input) => {
    const test = harness();
    await expect(test.get(input)).resolves.toEqual({ status: "InvalidRequest" });
    expect(test.calls).toEqual({ keys: 0, verifier: 0, contexts: 0 });
  });

  it("rejects noncanonical header, signature and payload bytes", async () => {
    const signature = Buffer.alloc(63).toString("base64url");
    const [header, encodedPayload] = token().split(".");
    await expect(
      harness().get({ ...request, qrToken: `${header}.${encodedPayload}.${signature}` }),
    ).resolves.toEqual({ status: "InvalidRequest" });
    const spacedHeader = Buffer.from('{"alg":"ES256", "kid":"qr-key-1","typ":"BOP-QR"}').toString(
      "base64url",
    );
    await expect(
      harness().get({
        ...request,
        qrToken: `${spacedHeader}.${encodedPayload}.${Buffer.alloc(64).toString("base64url")}`,
      }),
    ).resolves.toEqual({ status: "QrUnavailable" });
    const raw = payload() as Record<string, unknown>;
    const reordered = { qrReference: raw.qrReference, ...raw };
    await expect(harness().get({ ...request, qrToken: token(reordered) })).resolves.toEqual({
      status: "QrUnavailable",
    });
  });

  it.each([
    ["wrong algorithm", { alg: "none", kid: "qr-key-1", typ: "BOP-QR" }],
    ["unknown header field", { alg: "ES256", kid: "qr-key-1", typ: "BOP-QR", jku: "x" }],
    ["bad key reference", { alg: "ES256", kid: "../qr-key-1", typ: "BOP-QR" }],
  ])("uniformly rejects protected header semantics: %s", async (_name, header) => {
    const test = harness();
    await expect(test.get({ ...request, qrToken: token(payload(), header) })).resolves.toEqual({
      status: "QrUnavailable",
    });
    expect(test.calls).toEqual({ keys: 0, verifier: 0, contexts: 0 });
  });

  it.each(["Invalid", "Unavailable"] as const)(
    "does not resolve context after %s signature",
    async (verification) => {
      const test = harness({ verification });
      await expect(test.get()).resolves.toEqual({ status: "QrUnavailable" });
      expect(test.calls).toEqual({ keys: 1, verifier: 1, contexts: 0 });
    },
  );

  it("fails closed for missing, duplicate, expired and compromised key evidence", async () => {
    const missing = keySet();
    missing.keys = [];
    await expect(harness({ keys: missing }).get()).resolves.toEqual({ status: "QrUnavailable" });
    const duplicate = keySet();
    const duplicatedKey = duplicate.keys.at(0);
    expect(duplicatedKey).toBeDefined();
    duplicate.keys.push({ ...duplicatedKey } as (typeof duplicate.keys)[number]);
    await expect(harness({ keys: duplicate }).get()).resolves.toEqual({ status: "QrUnavailable" });
    const expired = keySet();
    expired.validUntil = request.evaluatedAt;
    await expect(harness({ keys: expired }).get()).resolves.toEqual({ status: "QrUnavailable" });
    const compromised = keySet();
    const compromisedKey = compromised.keys.at(0);
    expect(compromisedKey).toBeDefined();
    (compromisedKey as { compromisedAt: string | null }).compromisedAt = request.evaluatedAt;
    await expect(harness({ keys: compromised }).get()).resolves.toEqual({
      status: "QrUnavailable",
    });
  });

  it.each([
    ["future", { ...payload(), issuedAt: "2026-01-16T00:00:00.000Z" }],
    ["expired", { ...payload(), expiresAt: request.evaluatedAt }],
    ["over 180 days", { ...payload(), expiresAt: "2026-07-01T00:00:00.001Z" }],
    ["bad channel", { ...payload(), channel: "Delivery" }],
    ["dine-in without table", { ...payload(), publicTableReference: null }],
    ["unknown payload field", { ...payload(), internalStoreId: ids.store }],
  ])("uniformly rejects signed payload: %s", async (_name, value) => {
    await expect(harness().get({ ...request, qrToken: token(value) })).resolves.toEqual({
      status: "QrUnavailable",
    });
  });

  it("accepts the exact half-open 180-day timing boundary", async () => {
    const value = {
      ...payload(),
      issuedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-06-30T00:00:00.000Z",
    };
    await expect(harness().get({ ...request, qrToken: token(value) })).resolves.toMatchObject({
      status: "Verified",
    });
  });

  it.each([
    ["inactive Store", { ...context(), storeLifecycle: "Suspended" }],
    ["inactive Table", { ...context(), tableLifecycle: "Suspended" }],
    ["inactive assignment", { ...context(), assignmentState: "Inactive" }],
    ["revoked", { ...context(), qrState: "Revoked" }],
    ["revocation mismatch", { ...context(), revocationVersion: 4 }],
    ["cross Store", { ...context(), publicStoreReference: "00000000-0000-7000-8000-000000000210" }],
    ["expired evidence", { ...context(), validUntil: request.evaluatedAt }],
    ["unknown evidence", { ...context(), note: "hidden" }],
  ])("uniformly hides context evidence: %s", async (_name, value) => {
    await expect(harness({ context: value }).get()).resolves.toEqual({
      status: "QrUnavailable",
    });
  });

  it("normalizes dependency failures and malformed evidence", async () => {
    await expect(harness({ keyFailure: true }).get()).resolves.toEqual({ status: "QrUnavailable" });
    await expect(harness({ verifierFailure: true }).get()).resolves.toEqual({
      status: "QrUnavailable",
    });
    await expect(harness({ contextFailure: true }).get()).resolves.toEqual({
      status: "QrUnavailable",
    });
    await expect(harness({ keys: { values: [] } }).get()).resolves.toEqual({
      status: "QrUnavailable",
    });
  });

  it("emits bounded telemetry and exposes no internal authority", async () => {
    const test = harness();
    const result = await test.get();
    expect(test.telemetry).toEqual([
      { operation: "ResolveQrTableContext", outcome: "VERIFIED", reason: "CONTEXT_VERIFIED" },
    ]);
    const serialized = JSON.stringify({ telemetry: test.telemetry, result });
    expect(serialized).not.toContain(ids.brand);
    expect(serialized).not.toContain(ids.store);
    expect(serialized).not.toContain(ids.table);
    expect(serialized).not.toContain("qr-key-1");
    expect(serialized).not.toMatch(/guestSession|permission|host|participant|orderId|privateKey/iu);
  });

  it("ignores telemetry failure", async () => {
    const record = vi.fn(() => {
      throw new Error("synthetic");
    });
    const ports: QrTableContextPorts = {
      keys: { load: async () => keySet() as never },
      verifier: { verify: async () => "Verified" },
      contexts: { resolve: async () => context() as never },
      telemetry: { record },
    };
    await expect(
      createQrTableContextService(ports).resolveQrTableContext(request),
    ).resolves.toMatchObject({ status: "Verified" });
    expect(record).toHaveBeenCalledOnce();
  });
});

describe("WP-2298 current authenticated Guest table context", () => {
  const expected = () => ({
    brandReference: ids.brand,
    storeReference: ids.store,
    publicStoreReference: ids.publicStore,
    publicTableReference: ids.publicTable,
    channel: "DineIn",
    qrRevocationVersion: 3,
    observedAt: request.evaluatedAt,
  });
  it("preserves distinct public/internal IDs and finite owner validity", () => {
    const result = assertCurrentDiningGuestTableContext(expected(), context());
    expect(result.tableReference).toBe(ids.table);
    expect(result.publicTableReference).toBe(ids.publicTable);
    expect(Object.isFrozen(result)).toBe(true);
  });
  it.each([
    ["brandReference", ids.qr],
    ["storeReference", ids.qr],
    ["publicStoreReference", ids.qr],
    ["publicTableReference", ids.qr],
    ["channel", "Pickup"],
    ["revocationVersion", 4],
    ["brandLifecycle", "Suspended"],
    ["storeLifecycle", "Suspended"],
    ["tableLifecycle", "Suspended"],
    ["assignmentState", "Inactive"],
    ["qrState", "Revoked"],
    ["validUntil", request.evaluatedAt],
    ["tableReference", null],
  ])("rejects unavailable or mismatched %s", (field, value) => {
    expect(() =>
      assertCurrentDiningGuestTableContext(expected(), { ...context(), [field]: value }),
    ).toThrow("qr table context contract is invalid");
  });
  it.each([
    "brandReference",
    "storeReference",
    "publicStoreReference",
    "publicTableReference",
    "channel",
    "qrRevocationVersion",
    "observedAt",
  ])("closes and validates expected %s", (field) => {
    expect(() =>
      assertCurrentDiningGuestTableContext({ ...expected(), [field]: "invalid" }, context()),
    ).toThrow("qr table context contract is invalid");
    const getter = vi.fn(() => "invalid");
    expect(() =>
      assertCurrentDiningGuestTableContext(
        Object.defineProperty(expected(), field, { enumerable: true, get: getter }),
        context(),
      ),
    ).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
  it("rejects extra or inherited authority fields", () => {
    for (const input of [{ ...expected(), purpose: "invented" }, Object.create(expected())])
      expect(() => assertCurrentDiningGuestTableContext(input, context())).toThrow();
  });
});

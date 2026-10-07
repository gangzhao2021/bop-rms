import { describe, expect, it, vi } from "vitest";
import {
  buildSystemMediaImagePromotionAuthorizationDecision,
  parseSystemMediaImagePromotionAuthorizationDecision,
  parseSystemMediaImagePromotionAuthorizationRequest,
  systemMediaImagePromotionRequiredFields,
  type SystemMediaImagePromotionAuthorizationDecision,
  type SystemMediaImagePromotionAuthorizationRequest,
} from "../contracts/system-media-image-promotion-authorization.js";
import {
  createPostgresSystemMediaImagePromotionAuthorizationSource,
  type SystemMediaImagePromotionAuthorizationTransaction,
} from "../infrastructure/persistence/system-media-image-promotion-authorization-store.js";

const id = (n: number) => `018f4f8a-9c2d-7a11-8d01-${n.toString().padStart(12, "0")}`;
const at = "2026-10-03T12:00:00.000Z",
  until = "2026-10-03T12:00:05.000Z";
const before = "2026-10-03T11:59:00.000Z";
const configuration = `sha256:${"a".repeat(64)}`;
const identity = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  workloadReference: id(4),
  deploymentConfigurationDigest: configuration,
};
const request = (): SystemMediaImagePromotionAuthorizationRequest => ({
  actorKind: "System",
  action: "media.asset.promote",
  purposeCode: "MEDIA_IMAGE_PROMOTION",
  requiredFields: systemMediaImagePromotionRequiredFields,
  observedAt: at,
  validUntil: until,
});
function decision(
  overrides: Partial<Omit<SystemMediaImagePromotionAuthorizationDecision, "digest">> = {},
) {
  return buildSystemMediaImagePromotionAuthorizationDecision({
    profile: "MEDIA_IMAGE_PROMOTION_V1",
    decisionReference: id(5),
    ...identity,
    version: 1,
    action: "media.asset.promote",
    purposeCode: "MEDIA_IMAGE_PROMOTION",
    requiredFields: systemMediaImagePromotionRequiredFields,
    enabled: true,
    effectiveFrom: before,
    effectiveUntil: null,
    recordedAt: before,
    auditReference: id(6),
    ...overrides,
  });
}
function rootFor(d: SystemMediaImagePromotionAuthorizationDecision) {
  return {
    workload_id: d.workloadReference,
    tenant_id: d.tenantReference,
    brand_id: d.brandReference,
    store_id: d.storeReference,
    version: String(d.version),
    decision_id: d.decisionReference,
    updated_at: new Date(d.recordedAt),
  };
}
function harness(
  initial: SystemMediaImagePromotionAuthorizationDecision | null = decision(),
  storeReference: string | null = identity.storeReference,
) {
  let now = at;
  const state = {
    root: initial === null ? null : rootFor(initial),
    record:
      initial === null
        ? null
        : { snapshot_json: initial as unknown, digest: initial.digest, coherent: true },
    isolation: "read committed",
    beforeQuery: null as null | ((sql: string) => Promise<void>),
    onRegister: null as null | (() => Promise<void>),
  };
  const guards: { asyncGuard: () => Promise<void>; finalAssert: () => void }[] = [];
  const query = vi.fn(async (sql: string, values: readonly unknown[]): Promise<unknown> => {
    await state.beforeQuery?.(sql);
    if (sql.startsWith("SELECT set_config")) {
      expect(values).toEqual([
        identity.tenantReference,
        identity.brandReference,
        storeReference ?? "",
      ]);
      return { rows: [] };
    }
    if (sql.includes("transaction_isolation")) return { rows: [{ isolation: state.isolation }] };
    if (sql.includes("FROM bop_permission.system_media_image_promotion_authorization WHERE"))
      return { rows: state.root === null ? [] : [state.root] };
    if (sql.includes("FROM bop_permission.system_media_image_promotion_authorization_decision"))
      return { rows: state.record === null ? [] : [state.record] };
    throw new Error("unexpected synthetic query");
  });
  const tx: SystemMediaImagePromotionAuthorizationTransaction = { query };
  const clock = { now: () => now };
  const registerBeforeCommit = vi.fn(
    async (
      actualTx: SystemMediaImagePromotionAuthorizationTransaction,
      asyncGuard: () => Promise<void>,
      finalAssert: () => void,
    ) => {
      expect(actualTx).toBe(tx);
      guards.push({ asyncGuard, finalAssert });
      await state.onRegister?.();
    },
  );
  const options = { ...identity, storeReference, clock, registerBeforeCommit };
  const source = createPostgresSystemMediaImagePromotionAuthorizationSource(options);
  return {
    source,
    tx,
    query,
    options,
    clock,
    guards,
    state,
    registerBeforeCommit,
    setNow(value: string) {
      now = value;
    },
    hold(value: SystemMediaImagePromotionAuthorizationRequest = request()) {
      return source.holdUntilTransactionCompletes(tx, value);
    },
    async flush() {
      for (const g of guards) await g.asyncGuard();
      for (const g of guards) g.finalAssert();
    },
  };
}
const unavailable = { code: "SYSTEM_MEDIA_IMAGE_PROMOTION_SOURCE_UNAVAILABLE" };

describe("fixed System image promotion authorization contract", () => {
  it("binds the immutable complete grant body with a stable hash and freezes fields", () => {
    const d = decision();
    const reversed = Object.fromEntries(Object.entries(d).reverse());
    expect(parseSystemMediaImagePromotionAuthorizationDecision(reversed)).toEqual(d);
    expect(Object.isFrozen(d)).toBe(true);
    expect(Object.isFrozen(d.requiredFields)).toBe(true);
    expect(() =>
      parseSystemMediaImagePromotionAuthorizationDecision({ ...d, enabled: false }),
    ).toThrow();
    expect(() =>
      parseSystemMediaImagePromotionAuthorizationDecision({ ...d, auditReference: id(8) }),
    ).toThrow();
  });
  it.each([
    { actorKind: "User" },
    { action: "media.asset.read" },
    { purposeCode: "MEDIA_IMAGE_UPLOAD" },
    { requiredFields: ["asset"] },
    { requiredFields: [...systemMediaImagePromotionRequiredFields].reverse() },
    { validUntil: "2026-10-03T12:00:05.001Z" },
    { validUntil: at },
    { actorReference: id(9) },
  ])("rejects the request boundary %j", (change) => {
    expect(() =>
      parseSystemMediaImagePromotionAuthorizationRequest({ ...request(), ...change }),
    ).toThrow();
  });
  it("rejects accessor-bearing input without invoking its getter", () => {
    const getter = vi.fn(() => true),
      value = { ...decision() };
    Object.defineProperty(value, "enabled", { enumerable: true, get: getter });
    expect(() => parseSystemMediaImagePromotionAuthorizationDecision(value)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
  it("accepts disabled decisions and future effective intervals without pretending they allow now", () => {
    const d = decision({
      enabled: false,
      effectiveFrom: until,
      effectiveUntil: "2026-10-03T12:01:00.000Z",
    });
    expect(parseSystemMediaImagePromotionAuthorizationDecision(d)).toEqual(d);
  });
});

describe("actual current System promotion grant hold (controlled SQL, not deployed authorization)", () => {
  it("locks and joins the owning current decision, capturing exact scope and one original lease", async () => {
    const h = harness();
    expect(await h.hold()).toEqual({
      profile: "SystemMediaImagePromotionAuthorizationV1",
      ...identity,
      effect: "Allow",
      reason: "CURRENT_WORKLOAD_AUTHORIZATION",
      decisionReference: id(5),
      policyVersion: 1,
      decisionDigest: decision().digest,
      observedAt: at,
      validUntil: until,
    });
    h.setNow("2026-10-03T12:00:01.000Z");
    await h.hold();
    expect(h.registerBeforeCommit).toHaveBeenCalledTimes(1);
    const locks = h.query.mock.calls.filter(([sql]) => sql.includes("FOR SHARE"));
    expect(locks).toHaveLength(2);
    expect(locks[0]?.[1]).toEqual([id(4), id(1), id(2), id(3)]);
    expect(h.query.mock.calls.some(([sql]) => /\b(?:INSERT|UPDATE|DELETE)\b/u.test(sql))).toBe(
      false,
    );
    await h.flush();
  });
  it("holds exact Brand scope as null Store without broadening a Store decision", async () => {
    const h = harness(decision({ storeReference: null }), null);
    expect((await h.hold()).effect).toBe("Allow");
    await h.flush();
    const wrong = harness(decision({ storeReference: null }));
    await expect(wrong.hold()).rejects.toMatchObject(unavailable);
  });
  it.each([
    [null, "MISSING_WORKLOAD_AUTHORIZATION"],
    [decision({ enabled: false }), "WORKLOAD_DISABLED"],
    [
      decision({ deploymentConfigurationDigest: `sha256:${"b".repeat(64)}` }),
      "DEPLOYMENT_CONFIGURATION_MISMATCH",
    ],
    [decision({ effectiveFrom: until }), "OUTSIDE_EFFECTIVE_PERIOD"],
    [decision({ effectiveUntil: at }), "OUTSIDE_EFFECTIVE_PERIOD"],
  ] as const)(
    "denies non-current grant %s without bootstrapping or falling back",
    async (d, reason) => {
      const h = harness(d);
      expect(await h.hold()).toMatchObject({ effect: "Deny", reason });
      await expect(h.flush()).rejects.toMatchObject(unavailable);
      await expect(h.hold()).rejects.toMatchObject(unavailable);
    },
  );
  it("shortens the original deadline to grant expiry and never renews it", async () => {
    const expires = "2026-10-03T12:00:02.000Z",
      h = harness(decision({ effectiveUntil: expires }));
    expect((await h.hold()).validUntil).toBe(expires);
    h.setNow("2026-10-03T12:00:01.000Z");
    expect((await h.hold({ ...request(), validUntil: expires })).validUntil).toBe(expires);
    h.setNow(expires);
    await expect(h.flush()).rejects.toMatchObject(unavailable);
  });
  it("allows repeated kernel authorization before its single commit guard starts", async () => {
    const h = harness();
    // Media's guard is installed first and performs its last current hold.
    h.guards.push({
      asyncGuard: async () => {
        await h.hold();
      },
      finalAssert: () => {
        /* Media assertion is separate. */
      },
    });
    await h.hold();
    await h.flush();
    expect(h.registerBeforeCommit).toHaveBeenCalledTimes(1);
    expect(h.query.mock.calls.filter(([sql]) => sql.includes("FOR SHARE"))).toHaveLength(2);
  });
  it("preserves entry time while a slow guard registration consumes the deadline", async () => {
    const h = harness();
    h.state.onRegister = async () => {
      h.setNow(until);
    };
    await expect(h.hold()).rejects.toMatchObject(unavailable);
    expect(h.query).not.toHaveBeenCalled();
    h.setNow(at);
    await expect(h.flush()).rejects.toMatchObject(unavailable);
  });
  it.each(["tenant_id", "brand_id", "store_id", "workload_id", "decision_id", "version"] as const)(
    "rejects transplanted root %s before returning an Allow",
    async (field) => {
      const h = harness();
      if (!h.state.root) throw new Error("missing synthetic root");
      h.state.root[field] = field === "version" ? "2" : id(99);
      await expect(h.hold()).rejects.toMatchObject(unavailable);
      await expect(h.flush()).rejects.toMatchObject(unavailable);
    },
  );
  it("rejects broken decision linkage, dishonest index coherence and changed hashes", async () => {
    for (const change of ["missing", "coherent", "digest", "snapshot"] as const) {
      const h = harness();
      const record = h.state.record;
      if (!record) throw new Error("missing synthetic decision");
      if (change === "missing") h.state.record = null;
      if (change === "coherent") record.coherent = false;
      if (change === "digest") record.digest = `sha256:${"c".repeat(64)}`;
      if (change === "snapshot") record.snapshot_json = decision({ tenantReference: id(30) });
      await expect(h.hold()).rejects.toMatchObject(unavailable);
    }
  });
  it("captures configuration and ports before awaits", async () => {
    const h = harness();
    h.options.tenantReference = id(90);
    h.options.deploymentConfigurationDigest = `sha256:${"c".repeat(64)}`;
    h.clock.now = () => until;
    h.options.registerBeforeCommit = vi.fn(
      async (
        tx: SystemMediaImagePromotionAuthorizationTransaction,
        guard: () => Promise<void>,
        finalAssert: () => void,
      ) => {
        void tx;
        void guard;
        void finalAssert;
        throw new Error("replacement registrar");
      },
    );
    expect((await h.hold()).effect).toBe("Allow");
    expect(h.options.registerBeforeCommit).not.toHaveBeenCalled();
    await h.flush();
  });
  it("registers an early poison guard for malformed requests even when the caller catches it", async () => {
    const h = harness();
    await expect(
      h.source.holdUntilTransactionCompletes(h.tx, {
        ...request(),
        actorKind: "User",
      } as unknown as SystemMediaImagePromotionAuthorizationRequest),
    ).rejects.toMatchObject(unavailable);
    expect(h.guards).toHaveLength(1);
    await expect(h.flush()).rejects.toMatchObject(unavailable);
    expect(h.query).not.toHaveBeenCalled();
  });
  it("poisons caught reentry on the same actual transaction", async () => {
    const h = harness();
    h.state.beforeQuery = async () => {
      h.state.beforeQuery = null;
      await expect(h.hold()).rejects.toMatchObject(unavailable);
    };
    await expect(h.hold()).rejects.toMatchObject(unavailable);
    await expect(h.flush()).rejects.toMatchObject(unavailable);
  });
  it("poisons a query identity replacement even if restored afterward", async () => {
    const h = harness();
    h.state.beforeQuery = async () => {
      h.tx.query = async () => ({ rows: [] });
    };
    await expect(h.hold()).rejects.toMatchObject(unavailable);
    h.tx.query = h.query;
    await expect(h.flush()).rejects.toMatchObject(unavailable);
  });
  it.each(["2026-10-03T11:59:59.999Z", until])(
    "poisons observed backward/expired clock %s permanently",
    async (time) => {
      const h = harness();
      h.state.beforeQuery = async () => {
        h.setNow(time);
      };
      await expect(h.hold()).rejects.toMatchObject(unavailable);
      h.setNow(at);
      await expect(h.flush()).rejects.toMatchObject(unavailable);
    },
  );
  it("checks the original deadline after all later asynchronous host guards", async () => {
    const h = harness();
    await h.hold();
    h.guards.push({
      asyncGuard: async () => {
        h.setNow(until);
      },
      finalAssert: () => {
        /* No additional assertion. */
      },
    });
    await expect(h.flush()).rejects.toMatchObject(unavailable);
  });
  it("rejects final-before-async and repeated commit phases", async () => {
    const early = harness();
    await early.hold();
    expect(() => early.guards[0]?.finalAssert()).toThrow();
    const repeat = harness();
    await repeat.hold();
    await repeat.flush();
    await expect(repeat.flush()).rejects.toMatchObject(unavailable);
    await expect(repeat.hold()).rejects.toMatchObject(unavailable);
  });
  it("rejects stronger isolation, future root records and leaking database failures", async () => {
    const h = harness();
    h.state.isolation = "repeatable read";
    await expect(h.hold()).rejects.toMatchObject(unavailable);
    const future = harness(decision({ recordedAt: until }));
    await expect(future.hold()).rejects.toMatchObject(unavailable);
    const broken = harness();
    broken.state.beforeQuery = async () => {
      throw new Error("private database locator");
    };
    const error = await broken.hold().catch((caught: unknown) => caught);
    expect(error).toMatchObject(unavailable);
    expect(String(error)).not.toContain("private database locator");
    expect(error).not.toHaveProperty("cause");
  });
});

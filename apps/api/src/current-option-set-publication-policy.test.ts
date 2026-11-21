import { beforeEach, expect, it, vi } from "vitest";
import {
  publishingOptionSetPublicationPolicyDigest,
  optionSetPolicyScopeLevels,
} from "@bop/publishing";
import {
  createCurrentOptionSetPublicationPolicySource,
  currentOptionSetPolicyFields,
} from "./current-option-set-publication-policy.js";
const owner = vi.hoisted(() => ({ create: vi.fn(), read: vi.fn() }));
vi.mock("@bop/publishing", async (original) => ({
  ...(await original<object>()),
  createPostgresPublishingMutationStore: owner.create,
}));
const id = (n: number) => "01909998-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-11T10:00:00.000Z";
const instant = (milliseconds: number) => new Date(Date.parse(at) + milliseconds).toISOString();
const request = () => ({
  optionSetReference: id(10),
  policyReference: id(6),
  policyVersion: 1,
  observedAt: at,
});
function current(observedAt: string = at) {
  const content = {
    profile: "PublishingOptionSetPublicationPolicyV1",
    tenantReference: id(1),
    brandReference: id(2),
    familyReference: id(4),
    policyReference: id(6),
    policyVersion: 1,
    scopeOrder: optionSetPolicyScopeLevels,
    approvalPolicy: "Required",
    warningOverrideAllowed: false,
    requiredLocales: ["en-CA"],
    mediaRequirement: "Required",
    effectiveFrom: at,
    effectiveUntil: instant(20000),
  };
  const scope = { kind: "Brand", brandReference: id(2), storeReference: null },
    snapshotDigest = publishingOptionSetPublicationPolicyDigest(content);
  const validationEvidence = {
    evidenceReference: id(11),
    snapshotReference: id(6),
    snapshotDigest,
    scope,
    result: "Pass",
    checkedAt: at,
    validUntil: instant(60000),
    checkCodes: ["OPTION_POLICY_STRUCTURE"],
  };
  const approvalEvidence = {
    evidenceReference: id(12),
    reviewLifecycleId: id(8),
    reviewVersion: 2,
    snapshotReference: id(6),
    snapshotDigest,
    scope,
    decision: "Accepted",
    approvedActorReference: id(9),
    approvedAt: at,
    validUntil: instant(60000),
  };
  const lifecycle = {
    lifecycleId: id(8),
    familyReference: id(4),
    configurationType: "OPTION_SET_PUBLICATION_POLICY",
    purposeCode: "OPTION_SET_PUBLICATION_POLICY",
    snapshotReference: id(6),
    snapshotDigest,
    scope,
    version: 4,
    state: "Published",
    validationEvidenceReference: id(11),
    approvalEvidenceReference: id(12),
    createdAt: at,
    changedAt: at,
  };
  const release = {
    releaseId: id(13),
    familyReference: id(4),
    configurationType: lifecycle.configurationType,
    purposeCode: lifecycle.purposeCode,
    snapshotReference: id(6),
    snapshotDigest,
    scope,
    sequence: 1,
    sourceLifecycleId: id(8),
    kind: "Publish",
    previousReleaseId: null,
    createdAt: at,
  };
  return {
    content,
    current: {
      release,
      lifecycle,
      validationEvidence,
      approvalEvidence,
      auditReference: id(14),
      observedAt,
    },
    observedAt,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  owner.create.mockReturnValue({ resolveCurrentOptionSetPublicationPolicy: owner.read });
  owner.read.mockImplementation(async (q) => current(q.observedAt));
});
function fixture(
  qualificationAction?: Parameters<
    typeof createCurrentOptionSetPublicationPolicySource
  >[0]["qualificationAction"],
) {
  let time = at;
  const clock = { now: vi.fn(() => time) },
    authority = {
      holdUntilTransactionCompletes: vi.fn(async (_tx: unknown, q: { observedAt: string }) => ({
        observedAt: q.observedAt,
        validUntil: instant(30000),
      })),
    };
  const options = {
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    actorKind: "User" as "User" | "System",
    ...(qualificationAction === undefined ? {} : { qualificationAction }),
    clock,
    authority,
  };
  const source = createCurrentOptionSetPublicationPolicySource(options),
    tx = { query: vi.fn() };
  return {
    source,
    options,
    tx,
    clock,
    authority,
    time: (v: string) => {
      time = v;
    },
  };
}
it("binds actual public reader to captured caller SQL and returns only policy eligibility", async () => {
  const f = fixture(),
    value = request();
  const result = await f.source.withCurrentPolicy(f.tx, value, async (s) => {
    expect(s.validUntil).toBe(instant(20000));
    expect(s.eligibility).toBe("NotEvaluated");
    expect(s.publishValidation).toBe("Incomplete");
    expect(Object.isFrozen(s.content)).toBe(true);
    value.policyReference = id(66);
    return "ok";
  });
  expect(result).toBe("ok");
  expect(owner.read).toHaveBeenCalledTimes(2);
  expect(f.authority.holdUntilTransactionCompletes).toHaveBeenCalledTimes(2);
  expect(f.authority.holdUntilTransactionCompletes.mock.calls[0]?.[0]).toBe(f.tx);
  expect(f.authority.holdUntilTransactionCompletes.mock.calls[0]?.[1]).toMatchObject({
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    actorKind: "User",
    permission: "catalog.manage",
    action: "catalog.option_set.publish",
    purposeCode: "CATALOG_OPTION_SET_PUBLICATION",
    optionSetReference: id(10),
    policyReference: id(6),
    policyVersion: 1,
    requiredFields: currentOptionSetPolicyFields,
  });
  const runner = owner.create.mock.calls[0]?.[0];
  await runner.run(async (sql: { query: (...args: unknown[]) => unknown }) =>
    sql.query("probe", []),
  );
  expect(f.tx.query).toHaveBeenCalledWith("probe", []);
});
it.each([
  null,
  [],
  {},
  { ...request(), ready: true },
  { ...request(), policyReference: "bad" },
  { ...request(), policyVersion: 0 },
  { ...request(), policyVersion: 1.1 },
  { ...request(), policyVersion: 2147483648 },
  { ...request(), optionSetReference: "bad" },
  { ...request(), observedAt: "2026-09-11T10:00:00Z" },
])("refuses malformed request before authority/source/work (%#)", async (value) => {
  const f = fixture(),
    work = vi.fn();
  await expect(f.source.withCurrentPolicy(f.tx, value, work)).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.authority.holdUntilTransactionCompletes).not.toHaveBeenCalled();
  expect(owner.create).not.toHaveBeenCalled();
  expect(work).not.toHaveBeenCalled();
});
it("never evaluates input getters", async () => {
  const f = fixture(),
    get = vi.fn(),
    value = request();
  Object.defineProperty(value, "policyReference", { get, enumerable: true });
  await expect(f.source.withCurrentPolicy(f.tx, value, vi.fn())).rejects.toThrow();
  expect(get).not.toHaveBeenCalled();
});
it.each(["initial", "late"])("refuses %s current field/permission denial", async (phase) => {
  const f = fixture(),
    work = vi.fn(async () => "tentative");
  f.authority.holdUntilTransactionCompletes.mockImplementation(async (_tx, q) => {
    if (phase === "initial" || work.mock.calls.length) throw new Error("synthetic denial");
    return { observedAt: q.observedAt, validUntil: instant(30000) };
  });
  await expect(f.source.withCurrentPolicy(f.tx, request(), work)).rejects.toThrow();
  expect(work.mock.calls.length).toBe(phase === "initial" ? 0 : 1);
});
it.each(["missing", "getter", "future", "expired", "renewed", "shortened"])(
  "refuses %s authority lease",
  async (mode) => {
    const f = fixture(),
      get = vi.fn(),
      work = vi.fn();
    f.authority.holdUntilTransactionCompletes.mockImplementation(async (_tx, q) => {
      const lease = { observedAt: q.observedAt, validUntil: instant(30000) };
      if (mode === "missing") return {} as never;
      if (mode === "getter") Object.defineProperty(lease, "validUntil", { get, enumerable: true });
      if (mode === "future") lease.observedAt = instant(1);
      if (mode === "expired") lease.validUntil = at;
      if (mode === "renewed") lease.validUntil = instant(30001);
      if (mode === "shortened" && work.mock.calls.length) lease.validUntil = instant(10000);
      return lease;
    });
    await expect(f.source.withCurrentPolicy(f.tx, request(), work)).rejects.toThrow();
    expect(get).not.toHaveBeenCalled();
  },
);
it.each(["original-cap", "policy-end", "backward", "future-start"])(
  "refuses %s clock",
  async (mode) => {
    const f = fixture();
    if (mode === "original-cap")
      owner.read.mockImplementation(async (q) => {
        const r = current(q.observedAt);
        r.content.effectiveUntil = instant(60000);
        r.current.release.snapshotDigest = publishingOptionSetPublicationPolicyDigest(r.content);
        r.current.lifecycle.snapshotDigest = r.current.release.snapshotDigest;
        r.current.validationEvidence.snapshotDigest = r.current.release.snapshotDigest;
        r.current.approvalEvidence.snapshotDigest = r.current.release.snapshotDigest;
        return r;
      });
    const value = request();
    if (mode === "future-start") value.observedAt = instant(1);
    await expect(
      f.source.withCurrentPolicy(f.tx, value, async () => {
        f.time(
          mode === "original-cap"
            ? instant(30000)
            : mode === "policy-end"
              ? instant(20000)
              : instant(-1),
        );
      }),
    ).rejects.toThrow();
  },
);
it.each([
  "Tenant",
  "Brand",
  "Profile",
  "Digest",
  "Lifecycle",
  "ActorEvidence",
  "CurrentObservation",
  "Family",
  "Scope",
  "Approval",
])("refuses malformed owning %s", async (mode) => {
  const f = fixture(),
    work = vi.fn();
  owner.read.mockImplementation(async (q) => {
    const r = current(q.observedAt);
    if (mode === "Tenant") r.content.tenantReference = id(19);
    if (mode === "Brand") r.content.brandReference = id(19);
    if (mode === "Profile") r.content.profile = "PublishingProductPublicationPolicyV1";
    if (mode === "Digest") r.current.release.snapshotDigest = "sha256:" + "a".repeat(64);
    if (mode === "Lifecycle") r.current.lifecycle.state = "Archived";
    if (mode === "ActorEvidence") r.current.approvalEvidence.reviewLifecycleId = id(19);
    if (mode === "CurrentObservation") r.current.observedAt = instant(1);
    if (mode === "Family") r.current.release.familyReference = id(19);
    if (mode === "Scope") r.current.release.scope.brandReference = id(19);
    if (mode === "Approval") r.current.approvalEvidence.validUntil = at;
    return r;
  });
  await expect(f.source.withCurrentPolicy(f.tx, request(), work)).rejects.toThrow();
  expect(work).not.toHaveBeenCalled();
});
it("refuses current own-transaction head drift after work", async () => {
  const f = fixture();
  let n = 0;
  owner.read.mockImplementation(async (q) => {
    const r = current(q.observedAt);
    if (n++) r.current.release.releaseId = id(90);
    return r;
  });
  await expect(
    f.source.withCurrentPolicy(f.tx, request(), async () => "tentative"),
  ).rejects.toThrow();
});
it("captures authority/clock at construction", async () => {
  const f = fixture();
  f.options.clock = { now: vi.fn(() => instant(999999)) };
  f.options.authority = {
    holdUntilTransactionCompletes: vi.fn(async () => {
      throw Error();
    }),
  };
  await expect(f.source.withCurrentPolicy(f.tx, request(), async () => "ok")).resolves.toBe("ok");
  expect(f.clock.now).toHaveBeenCalled();
  expect(f.authority.holdUntilTransactionCompletes).toHaveBeenCalledTimes(2);
});
it("refuses changed query method and poisons further same-Tx admission", async () => {
  const f = fixture();
  await expect(
    f.source.withCurrentPolicy(f.tx, request(), async () => {
      f.tx.query = vi.fn();
    }),
  ).rejects.toThrow();
  await expect(f.source.withCurrentPolicy(f.tx, request(), vi.fn())).rejects.toThrow();
});
it("caught recursive failure poisons the original work", async () => {
  const f = fixture();
  await expect(
    f.source.withCurrentPolicy(f.tx, request(), async () => {
      await expect(f.source.withCurrentPolicy(f.tx, request(), vi.fn())).rejects.toThrow();
      return "caught";
    }),
  ).rejects.toThrow();
});
it("caught callback failure cannot re-admit on the same transaction", async () => {
  const f = fixture();
  await expect(
    f.source.withCurrentPolicy(f.tx, request(), async () => {
      throw new Error("synthetic callback");
    }),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  await expect(f.source.withCurrentPolicy(f.tx, request(), vi.fn())).rejects.toThrow();
});
it("supports a server System actor without inventing scheduler evidence", async () => {
  const f = fixture();
  const source = createCurrentOptionSetPublicationPolicySource({
    ...f.options,
    actorKind: "System",
  });
  await source.withCurrentPolicy(f.tx, request(), async () => "observed");
  expect(f.authority.holdUntilTransactionCompletes.mock.calls[0]?.[1]).toMatchObject({
    actorKind: "System",
  });
});

it("reports the actual source observation while retaining the original request cap", async () => {
  const f = fixture();
  f.time(instant(5000));
  await f.source.withCurrentPolicy(f.tx, request(), async (source) => {
    expect(source.originalObservedAt).toBe(at);
    expect(source.observedAt).toBe(instant(5000));
    expect(source.validUntil).toBe(instant(20000));
  });
});

it.each(["Read", "SubmitReview", "Publish"] as const)(
  "policy owner read holds the actual server-selected %s action",
  async (mode) => {
    const f = fixture(mode),
      action =
        mode === "Read"
          ? "catalog.option_set.read"
          : mode === "SubmitReview"
            ? "catalog.option_set.submit"
            : "catalog.option_set.publish";
    await f.source.withCurrentPolicy(f.tx, request(), async (value) => {
      expect(value.eligibility).toBe("NotEvaluated");
    });
    expect(f.authority.holdUntilTransactionCompletes).toHaveBeenCalledTimes(2);
    for (const call of f.authority.holdUntilTransactionCompletes.mock.calls)
      expect(call[1]).toMatchObject({
        action,
        permission: "catalog.manage",
        purposeCode: "CATALOG_OPTION_SET_PUBLICATION",
      });
  },
);
it("invalid server qualification action does not acquire a policy", () => {
  const f = fixture();
  Object.assign(f.options, { qualificationAction: "Allow" });
  expect(() => createCurrentOptionSetPublicationPolicySource(f.options)).toThrow();
  expect(owner.read).not.toHaveBeenCalled();
});
it("captures the original server action instead of retargeting it later", async () => {
  const f = fixture("Read");
  Object.assign(f.options, { qualificationAction: "Publish" });
  await f.source.withCurrentPolicy(f.tx, request(), async () => "ok");
  for (const call of f.authority.holdUntilTransactionCompletes.mock.calls)
    expect(call[1]).toMatchObject({ action: "catalog.option_set.read" });
});
it.each(["Read", "SubmitReview"] as const)("late %s field denial remains fatal", async (mode) => {
  const f = fixture(mode);
  let withdrawn = false;
  f.authority.holdUntilTransactionCompletes.mockImplementation(async (_tx, q) => {
    if (withdrawn) throw Error("synthetic actual field denial");
    return { observedAt: q.observedAt, validUntil: instant(30000) };
  });
  await expect(
    f.source.withCurrentPolicy(f.tx, request(), async () => {
      withdrawn = true;
      return "tentative";
    }),
  ).rejects.toThrow();
});

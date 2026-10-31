import { beforeEach, expect, it, vi } from "vitest";
import {
  CatalogError,
  parseProductPublicationCommand,
  parseProductPublicationValidation,
  productPublicationCheckCodes,
  productApprovalSourceFields,
  type createPostgresProductPublicationSourceStore,
} from "@rms/catalog";
import {
  currentProductPolicyFields,
  type createCurrentProductPublicationPolicySource,
} from "./current-product-publication-policy.js";
import { createMerchantProductCurrentApprovalFacts } from "./merchant-product-current-approval-facts.js";
import type { createCurrentProductApprovalSource } from "./current-product-approval.js";
type CompositionOptions = Parameters<typeof createCurrentProductApprovalSource>[0];
type ApprovalOptions = Parameters<typeof createPostgresProductPublicationSourceStore>[0];
type CapturedApprovalOptions = ApprovalOptions & {
  approvalAuthority: NonNullable<ApprovalOptions["approvalAuthority"]>;
};
type PolicyOptions = Parameters<typeof createCurrentProductPublicationPolicySource>[0];
const mock = vi.hoisted(() => ({
  approval: {} as CapturedApprovalOptions,
  policy: {} as PolicyOptions,
  composition: {} as CompositionOptions,
  run: vi.fn(),
  noRequired: vi.fn(),
}));
vi.mock("@rms/catalog", async (original) => ({
  ...(await original<object>()),
  parseProductPublicationVersion: (v: unknown) => v,
  createPostgresProductPublicationSourceStore: (options: unknown) => {
    mock.approval = options as CapturedApprovalOptions;
    return {};
  },
}));
vi.mock("./current-product-publication-policy.js", async (original) => ({
  ...(await original<object>()),
  createCurrentProductPublicationPolicySource: (options: PolicyOptions) => {
    mock.policy = options;
    return { withCurrentPolicy: (...args: unknown[]) => mock.noRequired(...args) };
  },
}));
vi.mock("./current-product-approval.js", () => ({
  createCurrentProductApprovalSource: (options: CompositionOptions) => {
    mock.composition = options;
    return { withCurrentApproval: (...args: unknown[]) => mock.run(...args) };
  },
}));
const id = (n: number) => "01909683-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-02T08:00:00.000Z",
  hash = "sha256:" + "a".repeat(64);
beforeEach(() => {
  mock.run.mockReset();
  mock.noRequired.mockReset();
});
function fixture(required = true) {
  let clock = at;
  const tx = { query: vi.fn() },
    admission = vi.fn(async (read: boolean) => {
      void read;
      return undefined;
    }),
    approvalHold = vi.fn(async () => undefined),
    policyHold = vi.fn(async () => undefined);
  const command = parseProductPublicationCommand({
    purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(4),
    actorKind: "User",
    operationReference: id(7),
    productReference: id(5),
    versionReference: id(6),
    expectedProductAggregateVersion: 4,
    expectedPublicationVersion: 3,
    action: "Publish",
    contentDigest: hash,
    configurationDigest: hash,
    scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
    effectivePeriod: {
      timeZone: "UTC",
      effectiveFrom: { instant: at, localDateTime: "2026-10-02T08:00:00.000", utcOffsetMinutes: 0 },
      effectiveUntil: null,
    },
    scheduleReference: null,
    replacementVersionReference: null,
    successorDraftVersionReference: id(10),
    occurredAt: at,
    reasonCode: "SYNTHETIC",
  });
  const originalApproval = {
    evidenceReference: id(11),
    approvedAt: at,
    validUntil: "2026-10-02T08:00:02.000Z",
  };
  const proof = {
    receipt: { approval: originalApproval },
    validUntil: originalApproval.validUntil,
  };
  const facts = {
    now: at,
    productAggregateVersion: 4,
    contentDigest: hash,
    configurationDigest: hash,
    scopeDigest: hash,
    periodDigest: hash,
    validation: {
      evidenceReference: id(12),
      productAggregateVersion: 4,
      contentDigest: hash,
      configurationDigest: hash,
      scopeDigest: hash,
      periodDigest: hash,
      policyReference: id(9),
      policyVersion: 1,
      approvalPolicy: required ? "Required" : "NotRequired",
      checks: productPublicationCheckCodes.map((code) => ({ code, outcome: "Pass" })),
      warningAcknowledgement: null,
      checkedAt: at,
      validUntil: "2026-10-02T09:00:00.000Z",
    },
    approval: null,
    reviewReference: id(8),
    replacement: null,
  };
  const remaining = vi.fn(async (_tx, _input, work) => work(facts));
  const configuration = {
    approvalAuthority: { holdUntilTransactionCompletes: approvalHold },
    policyAuthority: { holdUntilTransactionCompletes: policyHold },
  };
  const approvalPacket = () =>
    ({
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(4),
      actorKind: "User",
      productReference: id(5),
      purposeCode: "CATALOG_PRODUCT_APPROVAL_SOURCE",
      permission: "catalog.manage",
      owningAction: "catalog.product.approval.read",
      requiredFields: productApprovalSourceFields,
      observedAt: clock,
    }) as const;
  const policyPacket = () =>
    ({
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(4),
      actorKind: "User",
      purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
      policyReference: id(9),
      requiredFields: currentProductPolicyFields,
      observedAt: clock,
    }) as const;
  const policyContent = {
    profile: "PublishingProductPublicationPolicyV1",
    tenantReference: id(1),
    brandReference: id(2),
    familyReference: id(20),
    policyReference: id(9),
    policyVersion: 1,
    scopeOrder: ["Store", "StoreGroup", "Region", "Brand", "Channel", "OrderType"],
    approvalPolicy: required ? "Required" : "NotRequired",
    warningOverrideAllowed: false,
    requiredLocales: ["en-CA"],
    mediaRequirement: "Optional",
    effectiveFrom: at,
    effectiveUntil: null,
  };
  mock.run.mockImplementation(async (actual, _request, work) => {
    await mock.approval.approvalAuthority.holdUntilTransactionCompletes(actual, approvalPacket());
    const result = await mock.composition.policySource.withCurrentPolicy(
      actual,
      {
        policyReference: id(9),
        policyVersion: 1,
        observedAt: at,
      },
      async () => work(proof),
    );
    await mock.policy.authority.holdUntilTransactionCompletes(actual, policyPacket());
    await mock.approval.approvalAuthority.holdUntilTransactionCompletes(actual, approvalPacket());
    return result;
  });
  mock.noRequired.mockImplementation(async (actual, _request, work) => {
    await mock.policy.authority.holdUntilTransactionCompletes(actual, policyPacket());
    const result = await work({
      content: policyContent,
      currentPublicationReference: id(21),
      observedAt: at,
      validUntil: required ? "2026-10-02T08:00:30.000Z" : "2026-10-02T08:00:01.000Z",
    });
    await mock.policy.authority.holdUntilTransactionCompletes(actual, policyPacket());
    return result;
  });
  const adapter = createMerchantProductCurrentApprovalFacts({
    configuration,
    sources: { withHeldCurrentFacts: remaining },
    transaction: tx,
    command,
    clock: { now: () => clock },
    assertAdmission: admission,
  });
  return {
    tx,
    admission,
    approvalHold,
    policyHold,
    command,
    configuration,
    proof,
    facts,
    remaining,
    adapter,
    approvalPacket,
    policyPacket,
    policyContent,
    input: { command, aggregate: {} as never, current: null, content: null, observedAt: at },
    setClock: (v: string) => {
      clock = v;
    },
  };
}
it("uses actual original approval, captured collaborators and exact original intent/period/root request", async () => {
  const x = fixture();
  x.configuration.approvalAuthority.holdUntilTransactionCompletes = vi.fn(async () => {
    throw Error("rebound");
  });
  x.configuration.policyAuthority.holdUntilTransactionCompletes = vi.fn(async () => {
    throw Error("rebound");
  });
  const result = { answer: true },
    work = vi.fn(async (facts) => {
      expect(facts.approval).toBe(x.proof.receipt.approval);
      expect(facts.validation).toEqual(parseProductPublicationValidation(x.facts.validation));
      return result;
    });
  expect(await x.adapter.sources.withHeldCurrentFacts(x.tx, x.input, work)).toBe(result);
  expect(mock.run).toHaveBeenCalledWith(
    x.tx,
    expect.objectContaining({
      productReference: id(5),
      versionReference: id(6),
      expectedAggregateVersion: 4,
      expectedPublicationVersion: 3,
      policyReference: id(9),
      observedAt: at,
      validUntil: "2026-10-02T08:00:05.000Z",
      originalIntentDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    }),
    expect.any(Function),
  );
  expect(x.admission).toHaveBeenCalledWith(true);
  expect(x.approvalHold).toHaveBeenCalled();
});
it("NotRequired binds actual current policy with null approval and no approval-read acquisition", async () => {
  const x = fixture(false);
  expect(
    await x.adapter.sources.withHeldCurrentFacts(x.tx, x.input, async (facts) => facts.approval),
  ).toBeNull();
  expect(mock.run).not.toHaveBeenCalled();
  expect(x.approvalHold).not.toHaveBeenCalled();
  expect(x.admission.mock.calls.every(([read]) => !read)).toBe(true);
  x.setClock("2026-10-02T08:00:01.000Z");
  await expect(x.adapter.assertCurrent()).rejects.toHaveProperty(
    "code",
    "CATALOG_DEPENDENCY_UNAVAILABLE",
  );
});
it("actual Required policy cannot be replaced by supplied NotRequired validation", async () => {
  const x = fixture(false);
  x.policyContent.approvalPolicy = "Required";
  const work = vi.fn();
  await expect(x.adapter.sources.withHeldCurrentFacts(x.tx, x.input, work)).rejects.toHaveProperty(
    "code",
    "CATALOG_DEPENDENCY_UNAVAILABLE",
  );
  expect(work).not.toHaveBeenCalled();
});
it("original Required recovery checks current native read/full action without source acquisition", async () => {
  const x = fixture();
  await x.adapter.assertReceiptAdmission({ ...x.command, approvalPolicy: "Required" });
  expect(x.admission).toHaveBeenCalledWith(true);
  expect(mock.run).not.toHaveBeenCalled();
  expect(mock.noRequired).not.toHaveBeenCalled();
  expect(x.remaining).not.toHaveBeenCalled();
  expect(x.approvalHold).not.toHaveBeenCalled();
});
it("original NotRequired recovery keeps native admission without inventing approval-read requirement", async () => {
  const x = fixture(false);
  await x.adapter.assertReceiptAdmission({ ...x.command, approvalPolicy: "NotRequired" });
  expect(x.admission.mock.calls.every(([read]) => !read)).toBe(true);
  expect(mock.noRequired).not.toHaveBeenCalled();
});
it("retains original shorter expiry through final COMMIT", async () => {
  const x = fixture();
  await x.adapter.sources.withHeldCurrentFacts(x.tx, x.input, async () => undefined);
  x.setClock(x.proof.validUntil);
  await expect(x.adapter.assertCurrent()).rejects.toHaveProperty(
    "code",
    "CATALOG_DEPENDENCY_UNAVAILABLE",
  );
});
for (const mode of [
  "supplied",
  "getter",
  "zero-remaining",
  "twice-remaining",
  "wrong-remaining-result",
  "zero-source",
  "twice-source",
  "wrong-source-result",
  "wrong-tx",
  "wrong-command",
  "nested",
  "expiry",
  "reverse",
  "query",
  "native",
  "approval-field",
  "policy-field",
  "nonvoid",
] as const)
  it("refuses " + mode + " and latches reuse", async () => {
    const x = fixture();
    if (mode === "supplied") x.facts.approval = {} as never;
    if (mode === "getter")
      Object.defineProperty(x.facts, "approval", {
        get: () => {
          throw Error("getter must not run");
        },
      });
    if (mode === "zero-remaining") x.remaining.mockResolvedValue(undefined);
    if (mode === "twice-remaining")
      x.remaining.mockImplementation(async (_tx, _input, work) => {
        await work(x.facts);
        return work(x.facts);
      });
    if (mode === "wrong-remaining-result")
      x.remaining.mockImplementation(async (_tx, _input, work) => {
        await work(x.facts);
        return {};
      });
    if (mode === "zero-source") mock.run.mockResolvedValue(undefined);
    if (mode === "twice-source")
      mock.run.mockImplementation(async (_tx, _input, work) => {
        await work(x.proof);
        return work(x.proof);
      });
    if (mode === "wrong-source-result")
      mock.run.mockImplementation(async (_tx, _input, work) => {
        await work(x.proof);
        return {};
      });
    const work = vi.fn(async () => {
      if (mode === "nested") await x.adapter.sources.withHeldCurrentFacts(x.tx, x.input, vi.fn());
      if (mode === "expiry") x.setClock("2026-10-02T08:00:05.000Z");
      if (mode === "reverse") x.setClock("2026-10-02T07:59:59.999Z");
      if (mode === "query") x.tx.query = vi.fn();
      if (mode === "native")
        x.admission.mockRejectedValue(new CatalogError("CATALOG_PERMISSION_DENIED"));
      if (mode === "approval-field")
        x.approvalHold.mockRejectedValue(new CatalogError("CATALOG_PERMISSION_DENIED"));
      if (mode === "policy-field")
        x.policyHold.mockRejectedValue(new CatalogError("CATALOG_PERMISSION_DENIED"));
      if (mode === "nonvoid") x.policyHold.mockResolvedValue(true as never);
      return {};
    });
    const input =
      mode === "wrong-command"
        ? { ...x.input, command: { ...x.command, actorReference: id(99) } }
        : x.input;
    await expect(
      x.adapter.sources.withHeldCurrentFacts(
        mode === "wrong-tx" ? { query: vi.fn() } : x.tx,
        input,
        work,
      ),
    ).rejects.toHaveProperty(
      "code",
      mode === "getter"
        ? "CATALOG_INPUT_INVALID"
        : ["native", "approval-field", "policy-field"].includes(mode)
          ? "CATALOG_PERMISSION_DENIED"
          : "CATALOG_DEPENDENCY_UNAVAILABLE",
    );
    await expect(x.adapter.assertCurrent()).rejects.toHaveProperty(
      "code",
      "CATALOG_DEPENDENCY_UNAVAILABLE",
    );
  });
for (const field of [
  "tenantReference",
  "brandReference",
  "actorReference",
  "productReference",
  "actorKind",
  "requiredFields",
] as const)
  it("refuses foreign owning approval " + field + " before independent holder", async () => {
    const x = fixture();
    await expect(
      mock.approval.approvalAuthority.holdUntilTransactionCompletes(x.tx, {
        ...x.approvalPacket(),
        [field]: field === "actorKind" ? "System" : field === "requiredFields" ? [] : id(99),
      } as never),
    ).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
    expect(x.approvalHold).not.toHaveBeenCalled();
  });
for (const mode of ["conflict", "late-fields", "late-expiry"] as const)
  it("defers known lifecycle conflict through final owning guards: " + mode, async () => {
    const x = fixture();
    const work = async () => {
      if (mode === "late-fields")
        x.approvalHold.mockRejectedValue(new CatalogError("CATALOG_PERMISSION_DENIED"));
      if (mode === "late-expiry") x.setClock(x.proof.validUntil);
      throw new CatalogError("CATALOG_LIFECYCLE_CONFLICT");
    };
    await expect(
      x.adapter.sources.withHeldCurrentFacts(x.tx, x.input, work),
    ).rejects.toHaveProperty(
      "code",
      mode === "conflict"
        ? "CATALOG_LIFECYCLE_CONFLICT"
        : mode === "late-fields"
          ? "CATALOG_PERMISSION_DENIED"
          : "CATALOG_DEPENDENCY_UNAVAILABLE",
    );
  });
it("retains final independent receipt and policy fields after source callback returned", async () => {
  const x = fixture();
  await x.adapter.sources.withHeldCurrentFacts(x.tx, x.input, async () => undefined);
  x.policyHold.mockRejectedValue(new CatalogError("CATALOG_PERMISSION_DENIED"));
  await expect(x.adapter.assertCurrent()).rejects.toHaveProperty(
    "code",
    "CATALOG_PERMISSION_DENIED",
  );
});

for (const required of [true, false]) {
  it(`refuses forbidden Warning override before writer (${required})`, async () => {
    const x = fixture(required);
    x.facts.validation.checks = x.facts.validation.checks.map((c) => ({
      ...c,
      outcome: c.code === "MediaReady" ? "Warning" : "Pass",
    }));
    x.facts.validation.warningAcknowledgement = {
      actorReference: id(4),
      reasonCode: "SYNTHETIC_WARNING",
      warningCodes: ["MediaReady"],
    } as never;
    const work = vi.fn();
    await expect(
      x.adapter.sources.withHeldCurrentFacts(x.tx, x.input, work),
    ).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
    expect(work).not.toHaveBeenCalled();
  });
  it(`retains permitted Warning and exact acknowledgement (${required})`, async () => {
    const x = fixture(required);
    x.policyContent.warningOverrideAllowed = true;
    x.facts.validation.checks = x.facts.validation.checks.map((c) => ({
      ...c,
      outcome: c.code === "MediaReady" ? "Warning" : "Pass",
    }));
    x.facts.validation.warningAcknowledgement = {
      actorReference: id(4),
      reasonCode: "SYNTHETIC_WARNING",
      warningCodes: ["MediaReady"],
    } as never;
    const result = await x.adapter.sources.withHeldCurrentFacts(
      x.tx,
      x.input,
      async (f) => f.validation,
    );
    expect(result).toEqual(parseProductPublicationValidation(x.facts.validation));
  });
}
it("refuses an approval source that never visits actual current policy", async () => {
  const x = fixture(),
    work = vi.fn();
  mock.run.mockImplementation(async (_tx, _input, callback) => callback(x.proof));
  await expect(x.adapter.sources.withHeldCurrentFacts(x.tx, x.input, work)).rejects.toHaveProperty(
    "code",
    "CATALOG_DEPENDENCY_UNAVAILABLE",
  );
  expect(work).not.toHaveBeenCalled();
});

import { beforeEach, expect, it, vi } from "vitest";
import { CatalogError, parseProductPublicationCommand } from "@rms/catalog";
import {
  currentProductPolicyFields,
  type createCurrentProductPublicationPolicySource,
} from "./current-product-publication-policy.js";
import { createMerchantProductScopePolicy } from "./merchant-product-scope-policy.js";
type SourceOptions = Parameters<typeof createCurrentProductPublicationPolicySource>[0];
const mock = vi.hoisted(() => ({ source: {} as SourceOptions, run: vi.fn() }));
vi.mock("@rms/catalog", async (original) => ({
  ...(await original<object>()),
  parseProductPublicationVersion: (value: unknown) => value,
}));
vi.mock("./current-product-publication-policy.js", async (original) => ({
  ...(await original<object>()),
  createCurrentProductPublicationPolicySource: (options: SourceOptions) => {
    mock.source = options;
    return { withHeldScopePolicy: (...args: unknown[]) => mock.run(...args) };
  },
}));
const id = (n: number) => "01909682-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-02T08:00:00.000Z",
  hash = "sha256:" + "a".repeat(64);
beforeEach(() => {
  mock.run.mockReset();
});
function fixture() {
  let clock = at;
  const tx = { query: vi.fn() },
    admission = vi.fn(async () => undefined),
    holder = vi.fn(async () => undefined);
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
  const publication = { ...command, state: "Published", policyReference: id(9), policyVersion: 1 },
    configuration = { authority: { holdUntilTransactionCompletes: holder } },
    policy = {
      policyReference: id(9),
      policyVersion: 1,
      policyEvidenceReference: id(11),
      scopeOrder: [],
      observedAt: at,
      validUntil: "2026-10-02T08:00:30.000Z",
    };
  const packet = () =>
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
  mock.run.mockImplementation(async (actual, _input, work) => {
    await mock.source.authority.holdUntilTransactionCompletes(actual, packet());
    const result = await work(policy);
    await mock.source.authority.holdUntilTransactionCompletes(actual, packet());
    return result;
  });
  const adapter = createMerchantProductScopePolicy({
    configuration,
    transaction: tx,
    command,
    clock: { now: () => clock },
    assertAdmission: admission,
  });
  return {
    tx,
    admission,
    holder,
    command,
    publication,
    configuration,
    policy,
    packet,
    adapter,
    input: { publication: publication as never, observedAt: at },
    setClock: (x: string) => {
      clock = x;
    },
  };
}
it("captures configuration, holds actual owning policy in original transaction and copies before async admission", async () => {
  const x = fixture();
  x.configuration.authority.holdUntilTransactionCompletes = vi.fn(async () => {
    throw Error("rebound");
  });
  const result = { answer: true };
  const work = vi.fn(async (value) => {
    expect(value).toEqual(x.policy);
    expect(value).not.toBe(x.policy);
    return result;
  });
  expect(await x.adapter.withHeldScopePolicy(x.tx, x.input, work)).toBe(result);
  expect(x.holder).toHaveBeenCalledTimes(3);
  expect(mock.run).toHaveBeenCalledWith(x.tx, expect.anything(), expect.any(Function));
  expect(x.admission.mock.calls.length).toBeGreaterThan(4);
});
it("recovery final guard checks native admission with no policy acquisition", async () => {
  const x = fixture();
  await x.adapter.assertCurrent();
  expect(x.admission).toHaveBeenCalledOnce();
  expect(mock.run).not.toHaveBeenCalled();
  expect(x.holder).not.toHaveBeenCalled();
});
for (const field of [
  "tenantReference",
  "brandReference",
  "actorReference",
  "productReference",
  "versionReference",
  "operationReference",
  "state",
  "actorKind",
] as const)
  it("refuses mismatched publication " + field + " and latches", async () => {
    const x = fixture(),
      work = vi.fn();
    const changed = {
      ...x.publication,
      [field]: field === "state" ? "Scheduled" : field === "actorKind" ? "System" : id(99),
    };
    await expect(
      x.adapter.withHeldScopePolicy(x.tx, { publication: changed as never, observedAt: at }, work),
    ).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
    expect(work).not.toHaveBeenCalled();
    await expect(x.adapter.assertCurrent()).rejects.toHaveProperty(
      "code",
      "CATALOG_DEPENDENCY_UNAVAILABLE",
    );
  });
for (const mode of [
  "zero",
  "twice",
  "wrong-result",
  "wrong-tx",
  "nested",
  "query",
  "expiry",
  "reverse",
  "native",
  "fields",
  "nonvoid",
] as const)
  it("refuses " + mode + " and later reuse", async () => {
    const x = fixture();
    if (mode === "zero") mock.run.mockResolvedValue(undefined);
    if (mode === "twice")
      mock.run.mockImplementation(async (_tx, _input, work) => {
        await work(x.policy);
        return work(x.policy);
      });
    if (mode === "wrong-result")
      mock.run.mockImplementation(async (_tx, _input, work) => {
        await work(x.policy);
        return {};
      });
    const work = vi.fn(async () => {
      if (mode === "nested") await x.adapter.withHeldScopePolicy(x.tx, x.input, vi.fn());
      if (mode === "query") x.tx.query = vi.fn();
      if (mode === "expiry") x.setClock("2026-10-02T08:00:05.000Z");
      if (mode === "reverse") x.setClock("2026-10-02T07:59:59.999Z");
      if (mode === "native")
        x.admission.mockRejectedValue(new CatalogError("CATALOG_PERMISSION_DENIED"));
      if (mode === "fields")
        x.holder.mockRejectedValue(new CatalogError("CATALOG_PERMISSION_DENIED"));
      if (mode === "nonvoid") x.holder.mockResolvedValue(true as never);
      return {};
    });
    await expect(
      x.adapter.withHeldScopePolicy(mode === "wrong-tx" ? { query: vi.fn() } : x.tx, x.input, work),
    ).rejects.toHaveProperty(
      "code",
      ["native", "fields"].includes(mode)
        ? "CATALOG_PERMISSION_DENIED"
        : "CATALOG_DEPENDENCY_UNAVAILABLE",
    );
    await expect(x.adapter.assertCurrent()).rejects.toHaveProperty(
      "code",
      "CATALOG_DEPENDENCY_UNAVAILABLE",
    );
  });
it("rejects mismatched owning field packet before independent holder", async () => {
  const x = fixture();
  await expect(
    mock.source.authority.holdUntilTransactionCompletes(x.tx, {
      ...x.packet(),
      requiredFields: [] as never,
    }),
  ).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
  expect(x.holder).not.toHaveBeenCalled();
});

it("keeps source field authority through final beforeCOMMIT guard", async () => {
  const x = fixture();
  await x.adapter.withHeldScopePolicy(x.tx, x.input, async () => undefined);
  x.holder.mockRejectedValue(new CatalogError("CATALOG_PERMISSION_DENIED"));
  await expect(x.adapter.assertCurrent()).rejects.toHaveProperty(
    "code",
    "CATALOG_PERMISSION_DENIED",
  );
  await expect(x.adapter.assertCurrent()).rejects.toHaveProperty(
    "code",
    "CATALOG_DEPENDENCY_UNAVAILABLE",
  );
});
it("keeps shorter owning policy expiry after source callback returns", async () => {
  const x = fixture();
  x.policy.validUntil = "2026-10-02T08:00:01.000Z";
  await x.adapter.withHeldScopePolicy(x.tx, x.input, async () => undefined);
  x.setClock("2026-10-02T08:00:01.000Z");
  await expect(x.adapter.assertCurrent()).rejects.toHaveProperty(
    "code",
    "CATALOG_DEPENDENCY_UNAVAILABLE",
  );
});

vi.mock("./merchant-brand-scope.js", () => ({
  createMerchantBrandScope: () => () => {
    throw Error("scope must not run in decode tests");
  },
}));
import { expect, it, vi } from "vitest";
import { createMerchantProductPublicationCommand } from "./merchant-product-publication-command.js";
const id = "01900000-0000-7000-8000-000000000001";
function setup() {
  const run = vi.fn(async () => {
    throw Error("SQL must not run");
  });
  const authorize = vi.fn(async () => ({ sessionReference: id }));
  const execute = createMerchantProductPublicationCommand({
    merchant: { transactions: { run }, now: () => "2026-09-29T12:00:00.000Z" } as never,
    authentication: { authorize } as never,
    auditReference: () => id,
    authority: {} as never,
    sources: {} as never,
  });
  return {
    run,
    authorize,
    post: (command: unknown) =>
      execute({
        sessionCookie: "synthetic",
        csrf: "synthetic",
        expectedScope: { brandReference: id, storeReference: id },
        command,
      }),
  };
}
const command = {
  operationReference: id,
  productReference: id,
  versionReference: id,
  expectedProductAggregateVersion: 1,
  expectedPublicationVersion: 0,
  action: "Validate",
  contentDigest: "sha256:" + "a".repeat(64),
  configurationDigest: "sha256:" + "b".repeat(64),
  scopeSet: [],
  effectivePeriod: {},
  scheduleReference: null,
  replacementVersionReference: null,
  successorDraftVersionReference: null,
  occurredAt: "2026-09-29T12:00:00.000Z",
  reasonCode: "SYNTHETIC",
};
it("reserves scheduled activation for the System owner before authentication/SQL", async () => {
  const x = setup();
  await expect(x.post({ ...command, action: "ActivateScheduled" })).rejects.toHaveProperty(
    "code",
    "CATALOG_PERMISSION_DENIED",
  );
  expect(x.run).not.toHaveBeenCalled();
  expect(x.authorize).not.toHaveBeenCalled();
});
it.each([
  "actorReference",
  "tenantReference",
  "brandReference",
  "actorKind",
  "permission",
  "validation",
])("denies caller %s before any scope/private read", async (key) => {
  const x = setup();
  await expect(x.post({ ...command, [key]: id })).rejects.toHaveProperty(
    "code",
    "CATALOG_INPUT_INVALID",
  );
  expect(x.run).not.toHaveBeenCalled();
  expect(x.authorize).not.toHaveBeenCalled();
});
it("does not invoke a command accessor", async () => {
  const x = setup(),
    get = vi.fn(() => id);
  const c = Object.defineProperty({ ...command }, "operationReference", { get, enumerable: true });
  await expect(x.post(c)).rejects.toHaveProperty("code", "CATALOG_INPUT_INVALID");
  expect(get).not.toHaveBeenCalled();
});

it("requires explicit complete owning review/policy configuration and remaining facts", () => {
  const holder = { holdUntilTransactionCompletes: vi.fn() };
  const configuration = {
    maximumApprovalValiditySeconds: 12,
    reviewAuthority: holder,
    policyAuthority: holder,
  };
  const build = (approvalDecision: unknown, sources: unknown = { withHeldCurrentFacts: vi.fn() }) =>
    createMerchantProductPublicationCommand({
      merchant: { transactions: { run: vi.fn() }, now: () => "2026-09-29T12:00:00.000Z" },
      authentication: { authorize: vi.fn() },
      auditReference: () => id,
      authority: holder,
      sources,
      approvalDecision,
    } as never);
  expect(() => build(configuration)).not.toThrow();
  for (const value of [
    null,
    {},
    { ...configuration, maximumApprovalValiditySeconds: 0 },
    { ...configuration, reviewAuthority: {} },
    { ...configuration, policyAuthority: {} },
  ])
    expect(() => build(value)).toThrow();
  expect(() => build(configuration, {})).toThrow();
});

it("captures actual current scope policy config and refuses missing/competing owner", () => {
  const authority = { holdUntilTransactionCompletes: vi.fn() };
  const build = (
    currentScopePolicy: unknown,
    sources: unknown = { withHeldCurrentFacts: vi.fn() },
  ) =>
    createMerchantProductPublicationCommand({
      merchant: { transactions: { run: vi.fn() }, now: () => "2026-10-02T08:00:00.000Z" },
      authentication: { authorize: vi.fn() },
      auditReference: () => id,
      authority,
      sources,
      currentScopePolicy,
    } as never);
  expect(() => build({ authority })).not.toThrow();
  for (const value of [null, {}, { authority: {} }]) expect(() => build(value)).toThrow();
  expect(() => build({ authority }, {})).toThrow();
  expect(() =>
    build({ authority }, { withHeldCurrentFacts: vi.fn(), withHeldScopePolicy: vi.fn() }),
  ).toThrow();
});

it("requires complete current approval owner configuration and remaining facts", () => {
  const authority = { holdUntilTransactionCompletes: vi.fn() };
  const configuration = { approvalAuthority: authority, policyAuthority: authority };
  const build = (currentApproval: unknown, sources: unknown = { withHeldCurrentFacts: vi.fn() }) =>
    createMerchantProductPublicationCommand({
      merchant: { transactions: { run: vi.fn() }, now: () => "2026-10-02T08:00:00.000Z" },
      authentication: { authorize: vi.fn() },
      auditReference: () => id,
      authority,
      sources,
      currentApproval,
    } as never);
  expect(() => build(configuration)).not.toThrow();
  for (const value of [
    null,
    {},
    { ...configuration, approvalAuthority: {} },
    { ...configuration, policyAuthority: {} },
  ])
    expect(() => build(value)).toThrow();
  expect(() => build(configuration, {})).toThrow();
});

it("requires a callable independent complete publication content holder when configured", () => {
  const build = (editorContentAuthority: unknown) =>
    createMerchantProductPublicationCommand({
      merchant: { transactions: { run: vi.fn() }, now: () => "2026-10-02T08:00:00.000Z" },
      authentication: { authorize: vi.fn() },
      auditReference: () => id,
      authority: {},
      sources: {},
      editorContentAuthority,
    } as never);
  expect(() => build(undefined)).not.toThrow();
  expect(() => build(vi.fn())).not.toThrow();
  for (const value of [null, {}, true]) expect(() => build(value)).toThrow();
});

it("captures complete current UniqueScope configuration and refuses absent owners/remaining facts", () => {
  const authority = { holdUntilTransactionCompletes: vi.fn() },
    tenantAuthority = { withCurrentBrandReferenceRead: vi.fn(), isCurrent: vi.fn() };
  const configuration = {
    candidateAuthority: authority,
    historyAuthority: authority,
    policyAuthority: authority,
    tenantAuthority,
  };
  const build = (
    currentUniqueScope: unknown,
    sources: unknown = { withHeldCurrentFacts: vi.fn() },
  ) =>
    createMerchantProductPublicationCommand({
      merchant: { transactions: { run: vi.fn() }, now: () => "2026-10-02T11:00:00.000Z" },
      authentication: { authorize: vi.fn() },
      auditReference: () => id,
      authority,
      sources,
      currentUniqueScope,
    } as never);
  expect(() => build(configuration)).not.toThrow();
  for (const value of [
    null,
    {},
    { ...configuration, candidateAuthority: {} },
    { ...configuration, historyAuthority: {} },
    { ...configuration, policyAuthority: {} },
    { ...configuration, tenantAuthority: {} },
    { ...configuration, categoryAssignments: {} },
  ])
    expect(() => build(value)).toThrow();
  expect(() => build(configuration, {})).toThrow();
});

import { beforeEach, expect, it, vi } from "vitest";
import { createIdentityActor } from "@bop/identity";
const d = vi.hoisted(() => ({ bridge: vi.fn(), candidates: vi.fn(), eligible: vi.fn() }));
vi.mock("./merchant-reconciliation-follow-up-transactions.js", () => ({
  createMerchantReconciliationFollowUpTransactions: d.bridge,
}));
vi.mock("@bop/membership", () => ({
  createPostgresStoreAssigneeCandidates: () => d.candidates,
  createPostgresStoreAssigneeEligibility: () => d.eligible,
}));
import { createMerchantReconciliationAssigneeQuery } from "./merchant-reconciliation-assignee-query.js";
type Options = Parameters<typeof createMerchantReconciliationAssigneeQuery>[0];
const id = (n: number) => "0190fa82-0000-7000-8000-" + String(n).padStart(12, "0");
beforeEach(() => vi.resetAllMocks());
function fixture() {
  const tx = {},
    allowed = vi.fn(async () => true),
    auth = vi.fn(async () => ({ sessionReference: id(1) }));
  d.bridge.mockResolvedValue({
    transactions: { run: async (work: (tx: object) => Promise<unknown>) => work(tx) },
    resolveAuthority: async () => ({
      authorize: allowed,
      context: { resolvedAt: "2026-09-22T00:00:00.000Z" },
    }),
  });
  d.candidates.mockResolvedValue({ actorReferences: [id(2)], nextAfterActorReference: id(2) });
  d.eligible.mockResolvedValue(true);
  const target = vi.fn(async () => ({
    actor: createIdentityActor({
      actorType: "User",
      actorReference: id(2),
      accountKind: "Workforce",
      status: "Active",
      authenticationMethod: "Oidc",
      verificationLevel: "SingleFactor",
      authenticatedAt: "2026-09-21T00:00:00.000Z",
      recentMfaAt: null,
    }),
    label: "Demo colleague",
  }));
  const options = {
    persistence: {} as Options["persistence"],
    authentication: { authorize: auth } as unknown as Options["authentication"],
    target,
  };
  return {
    tx,
    allowed,
    auth,
    target,
    options,
    read: createMerchantReconciliationAssigneeQuery(options),
    input: {
      sessionCookie: "synthetic",
      csrf: "synthetic",
      query: { exceptionReference: id(3), afterActorReference: null },
    },
  };
}
it("returns minimal identity-confirmed scoped entries and preserves candidate pagination", async () => {
  const f = fixture();
  expect(await f.read(f.input)).toEqual({
    items: [{ actorReference: id(2), label: "Demo colleague" }],
    nextAfterActorReference: id(2),
  });
  expect(d.candidates.mock.calls[0]?.[1]).toMatchObject({ limit: 25, afterActorReference: null });
  expect(f.target).toHaveBeenCalledWith(f.tx, id(2), "2026-09-22T00:00:00.000Z");
  d.eligible.mockResolvedValue(false);
  expect((await f.read(f.input)).items).toEqual([]);
});
it("fails closed without Identity configuration or requester authorization", async () => {
  const f = fixture();
  const options = { persistence: f.options.persistence, authentication: f.options.authentication };
  await expect(createMerchantReconciliationAssigneeQuery(options)(f.input)).rejects.toThrow(
    "RECONCILIATION_ASSIGNEES_UNAVAILABLE",
  );
  expect(d.bridge).not.toHaveBeenCalled();
  f.allowed.mockResolvedValue(false);
  await expect(f.read(f.input)).rejects.toThrow();
  expect(d.candidates).not.toHaveBeenCalled();
});
it("rejects scope injection and labels containing email or control text", async () => {
  const f = fixture();
  await expect(
    f.read({ ...f.input, query: { ...f.input.query, storeReference: id(9) } }),
  ).rejects.toThrow();
  expect(d.candidates).not.toHaveBeenCalled();
  const profile = await f.target();
  f.target.mockResolvedValue({ ...profile, label: "private@example.invalid" });
  await expect(f.read(f.input)).rejects.toThrow();
});
it("does not return a directory after final authorization is revoked", async () => {
  const f = fixture();
  d.eligible.mockImplementation(async () => {
    f.allowed.mockResolvedValue(false);
    return true;
  });
  await expect(f.read(f.input)).rejects.toThrow("RECONCILIATION_ASSIGNEES_UNAVAILABLE");
});

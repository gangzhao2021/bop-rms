import { beforeEach, expect, it, vi } from "vitest";
import {
  createMerchantApprovalHolders,
  createMerchantSoleOperatorApproval,
} from "./merchant-sole-operator.js";
import { MerchantWorkforceNoAccessError } from "./merchant-workforce-authority-source.js";

// WP-2423 M07 (v15 2026-11-06): who counts as another approver at a Store. Only the owner reads
// (Membership members, Permission candidates and Brand holders, the setting) and the per-person
// evaluation are doubles.
const doubles = vi.hoisted(() => ({
  members: vi.fn(),
  candidates: vi.fn(),
  brandHolders: vi.fn(),
  evaluate: vi.fn(),
}));
vi.mock("@bop/membership", async (original) => ({
  ...(await original<object>()),
  listStoreMembers: doubles.members,
  activeBrandMemberActors: async (_tx: unknown, query: { actorReferences: readonly string[] }) =>
    query.actorReferences,
}));
vi.mock("@bop/permission", async (original) => ({
  ...(await original<object>()),
  storeActionCandidates: doubles.candidates,
  brandActionHolders: doubles.brandHolders,
}));
vi.mock("@bop/tenant", async (original) => ({
  ...(await original<object>()),
  createPostgresSoleOperatorSettingSource: () => async () => ({ state: "On", version: 2 }),
}));
vi.mock("./merchant-workforce-authority-source.js", async (original) => ({
  ...(await original<object>()),
  createMerchantWorkforcePermissionSource: () => doubles.evaluate,
}));

const id = (n: number) => "0190a7d2-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const tenant = id(1),
  brand = id(2),
  store = id(3),
  ana = id(4),
  sam = id(5),
  mia = id(6),
  leo = id(7),
  lee = id(8);
const observedAt = "2026-11-06T10:00:00.000Z";
const member = (actorReference: string) => ({
  actorReference,
  membershipLifecycle: "Active",
  assignmentLifecycle: "Active",
});
const tx = { query: vi.fn(async () => ({ rows: [] })) };
const query = {
  tenantReference: tenant,
  brandReference: brand,
  storeReference: store,
  permissionCode: "identity.role.approve",
  observedAt,
};
const resolveContext = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  doubles.members.mockResolvedValue([member(ana), member(sam), member(mia), member(leo)]);
  doubles.candidates.mockResolvedValue([ana, mia]);
  doubles.brandHolders.mockResolvedValue([]);
  doubles.evaluate.mockImplementation(async (_tx: unknown, q: { actorReference: string }) => {
    if (q.actorReference === ana) return { decision: { effect: "Allow" } };
    throw new Error("INTERNAL_MERCHANT_DENIED");
  });
});

it("never evaluates a member whose roles do not grant the permission", async () => {
  // Sam (new hire, no role) and Leo (nobody can sign in as him, no role) are not candidates.
  const holders = await createMerchantApprovalHolders({ resolveContext })(tx as never, query);
  expect(doubles.candidates).toHaveBeenCalledWith(tx, {
    brandReference: brand,
    storeReference: store,
    action: "identity.role.approve",
    at: observedAt,
  });
  expect(doubles.evaluate.mock.calls.map(([, q]) => q.actorReference)).toEqual([ana, mia]);
  // Mia does hold a granting role; her evaluation fails, so she still counts (fail closed).
  expect(holders).toEqual([ana, mia]);
});

it("skips a candidate with no workforce access or no active membership", async () => {
  doubles.members.mockResolvedValue([
    member(ana),
    member(mia),
    { ...member(leo), assignmentLifecycle: "Ended" },
  ]);
  doubles.candidates.mockResolvedValue([ana, mia, leo]);
  doubles.evaluate.mockImplementation(async (_tx: unknown, q: { actorReference: string }) => {
    if (q.actorReference === ana) return { decision: { effect: "Allow" } };
    throw new MerchantWorkforceNoAccessError();
  });
  expect(await createMerchantApprovalHolders({ resolveContext })(tx as never, query)).toEqual([
    ana,
  ]);
  expect(doubles.evaluate).toHaveBeenCalledTimes(2);
});

const approval = (excludeReferences?: readonly string[], includeBrandHolders = true) =>
  createMerchantSoleOperatorApproval({
    resolveContext,
    authorize: async () => true,
    includeBrandHolders,
    ...(excludeReferences === undefined ? {} : { excludeReferences }),
  });

it("leaves the excluded subject out of the Store, Brand and union holders", async () => {
  doubles.brandHolders.mockResolvedValue([mia, lee]);
  const asked = { ...query, actorReference: ana };
  expect(await approval()(tx as never, asked)).toMatchObject({
    status: "OtherApprovers",
    otherHolderReferences: [mia, lee].sort(),
  });
  expect(await approval([mia])(tx as never, asked)).toMatchObject({
    status: "OtherApprovers",
    otherHolderReferences: [lee],
  });
  expect(await approval([mia, lee])(tx as never, asked)).toMatchObject({
    status: "Effective",
    otherHolderReferences: [],
  });
  // Store holders only.
  expect(await approval([mia], false)(tx as never, asked)).toMatchObject({ status: "Effective" });
  // A Brand gate (no Store) reads the Brand holders, with the same exclusion.
  doubles.brandHolders.mockResolvedValue([ana, mia]);
  expect(await approval([mia])(tx as never, { ...asked, storeReference: null })).toMatchObject({
    status: "Effective",
    otherHolderReferences: [],
  });
  expect(await approval()(tx as never, { ...asked, storeReference: null })).toMatchObject({
    status: "OtherApprovers",
    otherHolderReferences: [mia],
  });
});

it("refuses to leave out the requester themselves", async () => {
  await expect(approval([ana])(tx as never, { ...query, actorReference: ana })).rejects.toThrow();
});

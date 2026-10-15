import { beforeEach, expect, it, vi } from "vitest";
import {
  createMerchantSoleOperator,
  MerchantSoleOperatorError,
} from "./merchant-sole-operator-setting.js";
const doubles = vi.hoisted(() => ({
  storeScope: vi.fn(),
  brandScope: vi.fn(),
  mfa: vi.fn(),
  latest: vi.fn(),
  settingSource: vi.fn(),
  settingStore: vi.fn(),
  holders: vi.fn(),
  members: vi.fn(),
}));
vi.mock("./merchant-store-scope.js", () => ({
  createMerchantStoreScope: () => doubles.storeScope,
}));
vi.mock("./merchant-brand-scope.js", () => ({
  createMerchantBrandScope: () => doubles.brandScope,
}));
vi.mock("./merchant-sole-operator.js", () => ({
  createMerchantApprovalHolders: () => doubles.holders,
}));
vi.mock("@bop/identity", async (original) => ({
  ...(await original<object>()),
  createPostgresCurrentWorkforceMfaSource: doubles.mfa,
  createPostgresLatestWorkforceStepUpSource: doubles.latest,
}));
vi.mock("@bop/membership", async (original) => ({
  ...(await original<object>()),
  listStoreMembers: doubles.members,
}));
vi.mock("@bop/tenant", async (original) => ({
  ...(await original<object>()),
  createPostgresSoleOperatorSettingSource: doubles.settingSource,
  createPostgresSoleOperatorSettingStore: doubles.settingStore,
}));
const id = (n: number) => "01909985-0000-7000-8000-" + n.toString(16).padStart(12, "0");
type Options = Parameters<typeof createMerchantSoleOperator>[0];
type Authorize = (t: unknown, query: Record<string, unknown>) => Promise<boolean>;
const observedAt = "2026-10-15T12:00:00.000Z";
function setup() {
  const authorize = vi.fn(async () => ({ sessionReference: id(1) })),
    allowed = vi.fn(async () => true),
    authorizeAction = vi.fn(async (): Promise<unknown> => ({ effect: "Allow" })),
    during: boolean[] = [];
  let rolledBack: unknown = null;
  const run = vi.fn(async (work: (tx: object) => Promise<unknown>) =>
    work({ query: vi.fn() }).catch((error: unknown) => {
      rolledBack = error;
      throw error;
    }),
  );
  doubles.storeScope.mockResolvedValue({
    actorReference: id(2),
    sessionReference: id(1),
    selected: { tenantReference: id(5) },
    context: { brand: { brandReference: id(3) }, resolvedAt: observedAt },
    store: { storeReference: id(4) },
    allowed,
  });
  doubles.brandScope.mockResolvedValue({ authorizeAction });
  // Every owner read asks its authorize callback (this run's guard) while the run is in progress.
  const asks =
    (query: Record<string, unknown>, result: unknown) =>
    (source: { authorize: Authorize }) =>
    async (tx: object) => {
      during.push(await source.authorize(tx, query));
      during.push(await source.authorize({ query: vi.fn() }, query));
      return result;
    };
  doubles.mfa.mockImplementation((source: { authorize: Authorize }) => async (tx: object) => {
    during.push(await source.authorize(tx, id(2) as unknown as Record<string, unknown>));
    return { status: "Enrolled", verifiedAt: observedAt, resetAt: null };
  });
  doubles.latest.mockImplementation(asks({ actorReference: id(2) }, null));
  doubles.settingSource.mockImplementation(
    asks({ brandReference: id(3) }, { state: "On", version: 2, history: [] }),
  );
  const query = { tenantReference: id(5), brandReference: id(3), actorReference: id(2) };
  doubles.settingStore.mockImplementation(
    asks(query, {
      status: "Applied",
      record: { state: "Off", version: 3, recordedAt: observedAt },
    }),
  );
  doubles.holders.mockResolvedValue([id(2)]);
  doubles.members.mockResolvedValue([{ actorReference: id(2), displayName: "Owner" }]);
  const resolveConfiguration = vi.fn(
    async (_tx: unknown, _scope: unknown, authority: { authorize(): Promise<boolean> }) => {
      during.push(await authority.authorize());
      return { workforce: { resolveContext: vi.fn() } };
    },
  );
  const soleOperator = createMerchantSoleOperator({
    persistence: { transactions: { run } } as unknown as Options["persistence"],
    authentication: { authorize } as unknown as Options["authentication"],
    resolveConfiguration: resolveConfiguration as unknown as Options["resolveConfiguration"],
    retentionPolicyCode: "TEST",
    retentionPolicyVersion: 1,
  });
  const input = {
    sessionCookie: "synthetic-cookie",
    csrf: "synthetic-csrf",
    command: {
      state: "Off",
      reasonCode: "SECOND_APPROVER_AVAILABLE",
      expectedVersion: 2,
      operationReference: id(9),
    },
  };
  return {
    soleOperator,
    input,
    allowed,
    authorizeAction,
    during,
    rolledBack: () => rolledBack,
  };
}
beforeEach(() => vi.resetAllMocks());
it("WP-2423: the read resolves the Owner in full once at the start and once before the reply", async () => {
  const f = setup();
  const result = await f.soleOperator.read({ sessionCookie: "synthetic-cookie" });
  expect(result).toMatchObject({ state: "On", version: 2 });
  // Setting source (this run, other), configuration, MFA, latest step-up (this run, other).
  expect(f.during).toEqual([true, false, true, true, true, false]);
  expect(doubles.storeScope).toHaveBeenCalledOnce();
  expect(doubles.brandScope).toHaveBeenCalledOnce();
  expect(f.allowed).toHaveBeenCalledTimes(2);
  expect(f.authorizeAction).toHaveBeenCalledTimes(2);
  // The guard ends with the run.
  const source = doubles.settingSource.mock.calls[0]?.[0] as { authorize: Authorize };
  expect(await source.authorize({}, { brandReference: id(3) })).toBe(false);
});
it("WP-2423: tells a Store member who is not the Brand Owner NotOwner and refuses a change", async () => {
  const f = setup();
  f.authorizeAction.mockResolvedValue(null);
  await expect(f.soleOperator.read({ sessionCookie: "synthetic-cookie" })).rejects.toMatchObject({
    code: "NotOwner",
  });
  await expect(f.soleOperator(f.input)).rejects.toMatchObject({ code: "Denied" });
  f.allowed.mockResolvedValue(false);
  await expect(f.soleOperator.read({ sessionCookie: "synthetic-cookie" })).rejects.toMatchObject({
    code: "Denied",
  });
  expect(doubles.settingSource).not.toHaveBeenCalled();
  expect(doubles.settingStore).not.toHaveBeenCalled();
});
it("WP-2423: a change resolves the Owner in full twice and owner callbacks end with the run", async () => {
  const f = setup();
  await expect(f.soleOperator(f.input)).resolves.toEqual({
    status: "Applied",
    state: "Off",
    version: 3,
    recordedAt: observedAt,
  });
  // MFA, latest step-up (this run, other), setting store (this run, other).
  expect(f.during).toEqual([true, true, false, true, false]);
  expect(f.allowed).toHaveBeenCalledTimes(2);
  expect(f.authorizeAction).toHaveBeenCalledTimes(2);
  const store = doubles.settingStore.mock.calls[0]?.[0] as { authorize: Authorize };
  expect(
    await store.authorize(
      {},
      { tenantReference: id(5), brandReference: id(3), actorReference: id(2) },
    ),
  ).toBe(false);
});
it.each([
  ["Session ended", "allowed"],
  ["Brand Owner role withdrawn", "authorizeAction"],
] as const)("WP-2423: %s during a change refuses it inside the transaction", async (_, check) => {
  const f = setup();
  if (check === "allowed") f.allowed.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  else f.authorizeAction.mockResolvedValueOnce({ effect: "Allow" }).mockResolvedValueOnce(null);
  const error = await f.soleOperator(f.input).catch((value: unknown) => value);
  expect(error).toBeInstanceOf(MerchantSoleOperatorError);
  expect(error).toMatchObject({ code: "Denied" });
  // Thrown inside the transaction callback: the setting change does not commit.
  expect(f.rolledBack()).toMatchObject({ code: "Denied" });
  expect(doubles.settingStore).toHaveBeenCalledOnce();
});

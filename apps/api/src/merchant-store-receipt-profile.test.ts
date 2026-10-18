import { beforeEach, expect, it, vi } from "vitest";
import { createMerchantStoreReceiptProfile } from "./merchant-store-receipt-profile.js";

const d = vi.hoisted(() => ({
  resolve: vi.fn(),
  readProfile: vi.fn(),
  storeOptions: vi.fn(),
  save: vi.fn(),
}));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => d.resolve }));
vi.mock("@rms/store", async (original) => ({
  ...(await original<object>()),
  readCurrentStoreReceiptProfile: d.readProfile,
  createPostgresStoreReceiptProfileStore: (options: unknown) => {
    d.storeOptions(options);
    return d.save;
  },
}));
const id = (n: number) => "01909974-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-10-15T12:00:00.000Z";
type Options = Parameters<typeof createMerchantStoreReceiptProfile>[0];
const profile = {
  version: 2,
  recordedAt: at,
  gstHstNumber: "123456789RT0001",
  qstNumber: null,
  pstNumber: null,
  privacyNoticeUrl: "https://example.invalid/privacy",
};
function setup() {
  const tx = { query: vi.fn() };
  const allowed = vi.fn(async () => true);
  const authorizeActions = vi.fn(
    async (actions: readonly string[]) =>
      new Map(actions.map((action) => [action, { effect: "Allow" as "Allow" | "Deny" }])),
  );
  const current = {
    context: { brand: { brandReference: id(2) }, resolvedAt: at },
    store: { storeReference: id(3) },
    actorReference: id(4),
    allowed,
    authorizeActions,
  };
  d.resolve.mockResolvedValue(current);
  const run = vi.fn(async (work: (t: object) => Promise<unknown>) => work(tx));
  const service = createMerchantStoreReceiptProfile({
    persistence: { transactions: { run } } as unknown as Options["persistence"],
    authentication: {
      authorize: async () => ({ sessionReference: id(5) }),
    } as unknown as Options["authentication"],
  });
  const command = {
    sessionCookie: "synthetic-cookie",
    csrf: "synthetic-csrf",
    command: { expectedVersion: 2, operationReference: id(6), details: {} },
  };
  return { tx, allowed, authorizeActions, current, service, command };
}
beforeEach(() => {
  vi.clearAllMocks();
  d.readProfile.mockResolvedValue(profile);
  d.save.mockImplementation(async (tx: unknown, input: Record<string, unknown>) => {
    const { authorize } = d.storeOptions.mock.calls[0]?.[0] as {
      authorize(tx: unknown, query: Record<string, unknown>): Promise<boolean>;
    };
    if (!(await authorize(tx, input))) throw new Error("denied");
    return { status: "Recorded", profile: { ...profile, version: 3 } };
  });
});

it("WP-2423: reads the profile with one start resolution (both permissions) and one recheck", async () => {
  const f = setup();
  const result = await f.service.read({ sessionCookie: "synthetic-cookie" });
  expect(result).toMatchObject({ observedAt: at, canChange: true, version: 2 });
  expect(d.resolve).toHaveBeenCalledOnce();
  expect(f.authorizeActions).toHaveBeenCalledOnce();
  expect(f.authorizeActions).toHaveBeenCalledWith([
    "organization.store.read",
    "organization.store.publish",
  ]);
  expect(f.allowed).toHaveBeenCalledOnce();
});
it("reports canChange false when only the read permission is allowed", async () => {
  const f = setup();
  f.authorizeActions.mockResolvedValue(
    new Map([
      ["organization.store.read", { effect: "Allow" }],
      ["organization.store.publish", { effect: "Deny" }],
    ]),
  );
  await expect(f.service.read({ sessionCookie: "synthetic-cookie" })).resolves.toMatchObject({
    canChange: false,
  });
});
it("refuses a caller without the read permission before reading the profile", async () => {
  const f = setup();
  f.authorizeActions.mockResolvedValue(
    new Map([
      ["organization.store.read", { effect: "Deny" }],
      ["organization.store.publish", { effect: "Allow" }],
    ]),
  );
  await expect(f.service.read({ sessionCookie: "synthetic-cookie" })).rejects.toMatchObject({
    code: "Denied",
  });
  expect(d.readProfile).not.toHaveBeenCalled();
});
it("WP-2423: a permission withdrawn during the read refuses the reply", async () => {
  const f = setup();
  f.allowed.mockResolvedValue(false);
  await expect(f.service.read({ sessionCookie: "synthetic-cookie" })).rejects.toMatchObject({
    code: "Denied",
  });
  expect(d.readProfile).toHaveBeenCalledOnce();
});
it("WP-2423: saves with the owner's authorize on the run's guard; two full resolutions", async () => {
  const f = setup();
  await expect(f.service(f.command)).resolves.toMatchObject({ status: "Recorded", version: 3 });
  expect(d.resolve).toHaveBeenCalledWith(
    f.tx,
    "synthetic-cookie",
    "organization.store.publish",
    id(5),
  );
  expect(f.allowed).toHaveBeenCalledTimes(2);
  const { authorize } = d.storeOptions.mock.calls[0]?.[0] as {
    authorize(tx: unknown, query: Record<string, unknown>): Promise<boolean>;
  };
  const ownerTx = d.save.mock.calls[0]?.[0];
  const query = { brandReference: id(2), storeReference: id(3), actorReference: id(4) };
  // The guard ends with the run.
  expect(await authorize(ownerTx, query)).toBe(false);
});
it("WP-2423: owner authorize is true during the run only for this run's transaction and scope", async () => {
  const f = setup();
  const during: boolean[] = [];
  d.save.mockImplementation(async (tx: unknown) => {
    const { authorize } = d.storeOptions.mock.calls[0]?.[0] as {
      authorize(tx: unknown, query: Record<string, unknown>): Promise<boolean>;
    };
    const query = { brandReference: id(2), storeReference: id(3), actorReference: id(4) };
    during.push(await authorize(tx, query));
    during.push(await authorize({ query: vi.fn() }, query));
    during.push(await authorize(tx, { ...query, storeReference: id(99) }));
    return { status: "Recorded", profile };
  });
  await f.service(f.command);
  expect(during).toEqual([true, false, false]);
});
it("WP-2423: a permission withdrawn or Session ended during the save refuses it inside the transaction", async () => {
  const f = setup();
  f.allowed.mockResolvedValueOnce(true).mockResolvedValue(false);
  await expect(f.service(f.command)).rejects.toMatchObject({ code: "Denied" });
  expect(d.save).toHaveBeenCalledOnce();
  expect(f.allowed).toHaveBeenCalledTimes(2);
});

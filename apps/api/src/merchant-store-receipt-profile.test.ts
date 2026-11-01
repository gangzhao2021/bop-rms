import { beforeEach, expect, it, vi } from "vitest";
import { createMerchantStoreReceiptProfile } from "./merchant-store-receipt-profile.js";

const d = vi.hoisted(() => ({
  resolve: vi.fn(),
  readProfile: vi.fn(),
  storeOptions: vi.fn(),
  save: vi.fn(),
  issuer: vi.fn(),
  recordIssuer: vi.fn(),
  audits: [] as Record<string, unknown>[],
}));
vi.mock("@bop/operating-entity", async (original) => ({
  ...(await original<object>()),
  createPostgresReceiptIssuerSource: () => ({ resolve: d.issuer }),
  createPostgresStoreReceiptIssuerRecorder: () => d.recordIssuer,
}));
vi.mock("@bop/audit", async (original) => ({
  ...(await original<object>()),
  appendAuditRecordInTransaction: async (_tx: unknown, record: Record<string, unknown>) => {
    d.audits.push(record);
  },
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
    context: { brand: { brandReference: id(2), displayName: "Synthetic Brand" }, resolvedAt: at },
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
  d.audits.length = 0;
  d.issuer.mockResolvedValue(null);
  d.recordIssuer.mockResolvedValue({ status: "Unchanged", legalName: "Synthetic Kitchen Inc." });
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

// v15 2026-11-01: store 2 had no receipt issuer and no way to get one; saving with every number
// empty answered no_change. The section now names the business (the Brand's name offered).
it("v15 2026-11-01: reads the business the receipts name, offering the Brand's name before any", async () => {
  const f = setup();
  expect((await f.service.read({ sessionCookie: "synthetic-cookie" })).issuer).toEqual({
    businessName: null,
    suggestedBusinessName: "Synthetic Brand",
  });
  d.issuer.mockResolvedValue({ legalName: "Synthetic Kitchen Inc." });
  expect((await f.service.read({ sessionCookie: "synthetic-cookie" })).issuer).toEqual({
    businessName: "Synthetic Kitchen Inc.",
    suggestedBusinessName: "Synthetic Brand",
  });
});
it("v15 2026-11-01: a save names the business; only the name changing is still recorded", async () => {
  const f = setup();
  const empty = { gstHstNumber: null, qstNumber: null, pstNumber: null, privacyNoticeUrl: null };
  const save = (businessName: string) =>
    f.service({
      ...f.command,
      command: { ...f.command.command, details: { ...empty, businessName: "  " + businessName } },
    });
  d.recordIssuer.mockResolvedValueOnce({ status: "Recorded", legalName: "Synthetic Kitchen Inc." });
  await expect(save("Synthetic Kitchen Inc.")).resolves.toMatchObject({ status: "Recorded" });
  // The details reach the profile without the name; the issuer gets the trimmed name.
  expect(d.save.mock.calls[0]?.[1]).toMatchObject({ details: empty });
  expect(d.recordIssuer.mock.calls[0]?.[0]).toMatchObject({
    legalName: "Synthetic Kitchen Inc.",
    recordedAt: at,
  });
  expect(d.audits.map((record) => record.actionCode)).toEqual(["STORE_RECEIPT_ISSUER_RECORDED"]);
  expect(JSON.stringify(d.audits)).not.toContain("Synthetic Kitchen");
  // Details unchanged, a new name: recorded. Neither changed: nothing changed.
  const { StoreReceiptProfileError } = await import("@rms/store");
  d.save.mockRejectedValue(new StoreReceiptProfileError("STORE_RECEIPT_PROFILE_NO_CHANGE"));
  d.recordIssuer.mockResolvedValueOnce({ status: "Recorded", legalName: "Other Kitchen Inc." });
  await expect(save("Other Kitchen Inc.")).resolves.toMatchObject({
    status: "Recorded",
    version: 2,
  });
  await expect(save("Other Kitchen Inc.")).rejects.toMatchObject({ code: "NoChange" });
  // An empty name is refused before anything is written.
  d.save.mockClear();
  await expect(save("")).rejects.toMatchObject({ code: "Invalid" });
  expect(d.save).not.toHaveBeenCalled();
});

import { beforeEach, expect, it, vi } from "vitest";
import { createMerchantDiningTableContext } from "./merchant-dining-table-context.js";
const mock = vi.hoisted(() => ({ session: vi.fn(), table: vi.fn() }));
vi.mock("@rms/dining", async (original) => ({
  ...(await original<typeof import("@rms/dining")>()),
  createPostgresDiningClosingStore: () => ({ load: mock.session }),
  createPostgresDiningTableStore: () => ({ loadTable: mock.table }),
}));
const id = (n: number) => "01909968-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const session = {
  phase: "Active",
  startedAt: "2026-09-20T10:00:00.000Z",
  tableReference: id(5),
  version: 2,
  tableAssignmentVersion: 1,
};
const table = {
  activeDiningSessionReference: id(4),
  lifecycle: "Published",
  operationalState: "Available",
  observedAt: "2026-09-20T10:00:00.000Z",
  aggregateVersion: 3,
  stableLabel: "T1",
};
beforeEach(() => {
  vi.clearAllMocks();
  mock.session.mockResolvedValue(session);
  mock.table.mockResolvedValue(table);
});
function setup(allowClosedSession = false, allowClosingSession = false) {
  const authorize = vi.fn(async () => true);
  return {
    authorize,
    read: () =>
      createMerchantDiningTableContext({
        scope: { tenantReference: id(1), brandReference: id(2), storeReference: id(3) },
        authorize,
        allowClosedSession,
        allowClosingSession,
      }).load({ query: vi.fn() }, id(4), "2026-09-20T11:00:00.000Z"),
  };
}
it("returns bound current table label and versions", async () => {
  expect(await setup().read()).toEqual({
    diningSessionReference: id(4),
    sessionPhase: "Active",
    tableReference: id(5),
    tableLabel: "T1",
    sessionVersion: 2,
    tableAssignmentVersion: 1,
    tableVersion: 3,
  });
});
it.each([
  { version: 3 },
  { tableReference: id(9) },
  { tableAssignmentVersion: 2 },
  { phase: "Closing" },
])("rejects session movement or lifecycle change %j", async (change) => {
  mock.session.mockResolvedValueOnce(session).mockResolvedValueOnce({ ...session, ...change });
  await expect(setup().read()).rejects.toThrow("UNAVAILABLE");
});
it("rejects table reassignment between reads", async () => {
  mock.table
    .mockResolvedValueOnce(table)
    .mockResolvedValueOnce({ ...table, activeDiningSessionReference: id(9) });
  await expect(setup().read()).rejects.toThrow();
});
it("denies before reads and after permission revocation", async () => {
  const f = setup();
  f.authorize.mockResolvedValue(false);
  await expect(f.read()).rejects.toThrow();
  expect(mock.session).not.toHaveBeenCalled();
  f.authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(f.read()).rejects.toThrow();
});

it.each([null, id(8)])(
  "allows explicitly historical Closed session after release or next-party occupancy %s",
  async (occupant) => {
    mock.session.mockResolvedValue({ ...session, phase: "Closed" });
    mock.table.mockResolvedValue({
      ...table,
      activeDiningSessionReference: occupant,
      operationalState: "Blocked",
    });
    expect((await setup(true).read()).tableLabel).toBe("T1");
  },
);
it.each(["Closing", "Closed", "Cancelled"])("serving default rejects %s session", async (phase) => {
  mock.session.mockResolvedValue({ ...session, phase });
  await expect(setup().read()).rejects.toThrow();
});
it("historical option does not admit a reassigned Active session", async () => {
  mock.table.mockResolvedValue({ ...table, activeDiningSessionReference: id(8) });
  await expect(setup(true).read()).rejects.toThrow();
});
it("historical read rejects concurrent new-party change", async () => {
  mock.session.mockResolvedValue({ ...session, phase: "Closed" });
  mock.table
    .mockResolvedValueOnce({ ...table, activeDiningSessionReference: null })
    .mockResolvedValueOnce({ ...table, activeDiningSessionReference: id(8) });
  await expect(setup(true).read()).rejects.toThrow();
});

it("exposes Closing only for explicit read-only context while retaining occupancy binding", async () => {
  mock.session.mockResolvedValue({ ...session, phase: "Closing" });
  expect(await setup(false, true).read()).toMatchObject({
    diningSessionReference: id(4),
    sessionPhase: "Closing",
  });
  mock.table.mockResolvedValue({ ...table, activeDiningSessionReference: id(8) });
  await expect(setup(false, true).read()).rejects.toThrow();
});

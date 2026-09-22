import { expect, it, vi } from "vitest";
import { createDiningSessionClient, type StaffDiningTable } from "./dining-session-client.js";
const id = (n: number) => "01909988-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const table: StaffDiningTable = {
  tableReference: id(1),
  stableLabel: "T1",
  areaCode: "MAIN",
  capacity: 4,
  lifecycle: "Published",
  operationalState: "Available",
  aggregateVersion: 2,
  currentDiningSessionReference: null,
};
const response = (r: unknown) =>
  new Response(JSON.stringify(r), {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
it("freezes start request across lost response and suppresses replayed credential", async () => {
  const f = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(
      response({
        status: "AlreadyApplied",
        tableReference: id(1),
        tableAssignmentVersion: 2,
        diningSessionReference: id(3),
        sessionVersion: 1,
        joinKind: "HumanCode",
        joinCredential: "123456",
      }),
    );
  const t = { ...table },
    op = createDiningSessionClient(f).prepareStart(t, id(4));
  t.aggregateVersion = 3;
  await expect(op.execute("A".repeat(43))).rejects.toMatchObject({ code: "Unknown" });
  expect((await op.execute("A".repeat(43))).joinCredential).toBeNull();
  expect(f.mock.calls[1]?.[1]?.body).toBe(f.mock.calls[0]?.[1]?.body);
  expect(JSON.parse(String(f.mock.calls[0]?.[1]?.body)).expectedAssignmentVersion).toBe(2);
});
it("rejects occupied table before transport", () => {
  expect(() =>
    createDiningSessionClient().prepareStart(
      { ...table, currentDiningSessionReference: id(3) },
      id(4),
    ),
  ).toThrow();
});
it("treats wrong session assignment result as unknown", async () => {
  const f = vi.fn(async () =>
    response({
      status: "Issued",
      tableReference: id(1),
      tableAssignmentVersion: 9,
      diningSessionReference: id(3),
      sessionVersion: 1,
      joinKind: "HumanCode",
      joinCredential: "123456",
    }),
  );
  await expect(
    createDiningSessionClient(f).prepareStart(table, id(4)).execute("A".repeat(43)),
  ).rejects.toMatchObject({ code: "Unknown" });
});
it("rejects duplicate table rows and mismatched next cursor", async () => {
  const f = vi.fn(async () => response({ items: [table, table], nextAfterTableReference: null }));
  await expect(createDiningSessionClient(f).tables("A".repeat(43))).rejects.toThrow();
});
it("binds replacement generation and kind", async () => {
  const f = vi.fn(async () =>
    response({
      status: "Issued",
      generation: 3,
      capabilityVersion: 1,
      joinKind: "HumanCode",
      joinCredential: "123456",
    }),
  );
  const op = createDiningSessionClient(f).prepareRegenerate(
    {
      diningSessionReference: id(3),
      tableReference: id(1),
      sessionVersion: 1,
      tableAssignmentVersion: 2,
      capabilityVersion: 1,
      generation: 1,
      joinKind: "HumanCode",
    },
    id(4),
  );
  await expect(op.execute("A".repeat(43))).rejects.toMatchObject({ code: "Unknown" });
});

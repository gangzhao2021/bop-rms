import { expect, it, vi } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  createPostgresReconciliationFollowUpQuery,
  createPostgresReconciliationFollowUpStore,
} from "../infrastructure/persistence/reconciliation-follow-up-store.js";
import {
  parseReconciliationFollowUpCommand,
  transitionReconciliationFollowUp,
} from "../application/reconciliation-follow-up.js";
const id = (n: number) => "018f0f58-767a-7f3b-a1d0-" + n.toString(16).padStart(12, "0");
const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };
const now = "2026-09-20T10:01:00.000Z";
const command = parseReconciliationFollowUpCommand({
  ...scope,
  exceptionReference: id(4),
  expectedVersion: 1,
  operationReference: id(5),
  actorReference: id(6),
  action: "Acknowledge" as const,
  assigneeReference: null,
  occurredAt: now,
});
function fixture() {
  const query = vi.fn(async (sql: string) => ({
    rows: sql.startsWith("SELECT candidate")
      ? [{ candidate_id: id(7), status: "Open", opened_at: new Date(now) }]
      : sql.startsWith("INSERT")
        ? [{ version: "2" }]
        : [],
  }));
  const tx = { query } as unknown as ConsumerTransaction,
    authorize = vi.fn(async () => true);
  return {
    query,
    tx,
    authorize,
    store: createPostgresReconciliationFollowUpStore({ scope, authorize }),
  };
}
it("reads original exception as initial state and appends a valid transition", async () => {
  const f = fixture(),
    before = await f.store.readCurrent(f.tx, command),
    after = transitionReconciliationFollowUp(before, command);
  await f.store.append(f.tx, {
    command,
    before: before as ReturnType<typeof transitionReconciliationFollowUp>,
    after,
  });
  expect(f.query.mock.calls.filter(([sql]) => sql.startsWith("INSERT"))).toHaveLength(1);
  expect(after).toMatchObject({ version: 2, status: "Acknowledged" });
});
it("rejects foreign scope before setting session scope or querying facts", async () => {
  const f = fixture();
  await expect(
    f.store.readCurrent(
      f.tx,
      parseReconciliationFollowUpCommand({ ...command, storeReference: id(99) }),
    ),
  ).rejects.toThrow("CONFLICT");
  expect(f.query).not.toHaveBeenCalled();
  expect(f.authorize).not.toHaveBeenCalled();
});
it("rejects missing owner exception and unavailable authorization", async () => {
  const f = fixture();
  f.query.mockResolvedValue({ rows: [] });
  await expect(f.store.readCurrent(f.tx, command)).rejects.toThrow("CONFLICT");
  f.authorize.mockResolvedValue(false);
  await expect(f.store.findOperation(f.tx, command)).rejects.toThrow("PERMISSION_DENIED");
});
it("takes scoped operation fence before exception fence", async () => {
  const f = fixture();
  await f.store.lock(f.tx, command);
  expect(f.query.mock.calls.map(([sql]) => sql)).toEqual([
    expect.stringContaining("set_config"),
    expect.stringContaining("pg_advisory_xact_lock"),
    expect.stringContaining("pg_advisory_xact_lock"),
  ]);
});
it("rejects a malformed replay record instead of returning a fabricated duplicate", async () => {
  const f = fixture();
  f.query.mockResolvedValue({ rows: [{ record: "{}" }] } as never);
  await expect(f.store.findOperation(f.tx, command)).rejects.toThrow();
});

it("reads owner version without creating a mutation identity or returning staff references", async () => {
  const f = fixture(),
    query = createPostgresReconciliationFollowUpQuery({ scope, authorize: f.authorize });
  expect(await query(f.tx, command.exceptionReference)).toEqual({
    version: 1,
    followUpStatus: "Open",
    acknowledged: false,
    assigned: false,
    updatedAt: now,
  });
  expect(f.query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(false);
  expect(f.authorize).toHaveBeenCalledTimes(2);
});
it("withholds read state when authorization is revoked after owner reads", async () => {
  const f = fixture();
  f.authorize.mockResolvedValueOnce(true).mockResolvedValue(false);
  await expect(
    createPostgresReconciliationFollowUpQuery({ scope, authorize: f.authorize })(
      f.tx,
      command.exceptionReference,
    ),
  ).rejects.toThrow("PERMISSION_DENIED");
});

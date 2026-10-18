import { afterEach, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createInternalCaptureJournalSource } from "./pilot-capture-journal.mjs";
const databases = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.unstubAllEnvs();
});
function fixture() {
  vi.stubEnv("NODE_ENV", "development");
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(
    "CREATE TABLE intent(reference TEXT,brand TEXT,store TEXT,operation TEXT,attempt TEXT,amount TEXT,created_at TEXT); CREATE TABLE outcome(reference TEXT,transaction_reference TEXT,status TEXT,occurred_at TEXT);",
  );
  const ref = (n) => "0190fa01-0000-7000-8000-" + String(n).padStart(12, "0"),
    scope = { brandReference: ref(1), storeReference: ref(2), environment: "Test" };
  for (const [n, store, time] of [
    [1, ref(2), "2026-01-01T00:00:01.000Z"],
    [2, ref(2), "2026-01-01T00:00:01.000Z"],
    [3, ref(3), "2026-01-01T00:00:01.000Z"],
    [4, ref(2), "2026-01-03T00:00:00.000Z"],
  ]) {
    db.prepare("INSERT INTO intent VALUES(?,?,?,?,?,?,?)").run(
      "pi_demo" + n,
      scope.brandReference,
      store,
      ref(10 + n),
      ref(20 + n),
      "2260",
      "2026-01-01T00:00:00.000Z",
    );
    db.prepare("INSERT INTO outcome VALUES(?,?,?,?)").run(
      "pi_demo" + n,
      "ch_demo" + n,
      "Captured",
      time,
    );
  }
  return {
    db,
    input: {
      ...scope,
      observedAt: "2026-01-02T00:00:00.000Z",
      afterProviderIntentReference: null,
      limit: 1,
    },
  };
}
it("pages only scoped captures before a fixed cutoff with original bindings", async () => {
  const f = fixture(),
    read = createInternalCaptureJournalSource(f.db, { authorize: async () => true });
  const first = await read(f.input);
  expect(first.records).toHaveLength(1);
  expect(first.records[0].amount.amountMinor).toBe(2260n);
  const last = await read({
    ...f.input,
    afterProviderIntentReference: first.nextAfterProviderIntentReference,
  });
  expect(last.records[0].providerIntentReference).toBe("pi_demo2");
  expect(last.nextAfterProviderIntentReference).toBeNull();
});
it("rejects revoked authorization and Live mode", async () => {
  const f = fixture(),
    authorize = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false),
    read = createInternalCaptureJournalSource(f.db, { authorize });
  await expect(read(f.input)).rejects.toThrow("SIMULATION_CAPTURE_JOURNAL_UNAVAILABLE");
  await expect(read({ ...f.input, environment: "Live" })).rejects.toThrow();
});
it("rejects malformed amount and unbounded page", async () => {
  const f = fixture(),
    read = createInternalCaptureJournalSource(f.db, { authorize: async () => true });
  await expect(read({ ...f.input, limit: 101 })).rejects.toThrow();
  f.db.exec("UPDATE intent SET amount='1.1' WHERE reference='pi_demo1'");
  await expect(read(f.input)).rejects.toThrow();
});

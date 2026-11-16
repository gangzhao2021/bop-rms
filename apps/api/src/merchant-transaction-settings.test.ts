import { expect, it } from "vitest";
import { createTransactionSettingsTracker } from "./merchant-transaction-settings.js";

const scope = "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)";
const limits = "SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$1,true)";
const identity =
  "SELECT set_config('bop.identity_session_id',$1,true),set_config('bop.identity_actor_id',$2,true)";
const prior =
  "SELECT current_setting('bop.identity_session_id',true) AS session_scope,current_setting('bop.identity_actor_id',true) AS actor_scope";
const shared = "SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))";
const exclusive = "SELECT pg_advisory_xact_lock(hashtextextended($1,0))";

/** Runs statements as the host does: answered ones send nothing, others send settings first. */
function host() {
  const tracker = createTransactionSettingsTracker();
  const sent: { sql: string; values: readonly unknown[] }[] = [];
  const run = (sql: string, values: readonly unknown[] = []) => {
    const planned = tracker.plan(sql, values);
    if (planned.kind === "Answer") return planned.result;
    if (planned.before !== null) {
      sent.push({ sql: planned.before.sql, values: planned.before.values });
      tracker.observe(planned.before.sql, planned.before.values);
    }
    sent.push({ sql, values });
    tracker.observe(sql, values);
    return { rows: [] };
  };
  return { tracker, sent, run };
}

it("sends the settings written since the last statement as one statement before the next one", () => {
  const h = host();
  h.run(limits, ["4930"]);
  h.run(scope, ["b", ""]);
  h.run(limits, ["4929"]);
  h.run(scope, ["b", "s"]);
  h.run("SELECT 1");
  expect(h.sent).toEqual([
    {
      sql: "SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$2,true),set_config('bop.brand_id',$3,true),set_config('bop.store_id',$4,true)",
      // The limit asked for last, rounded down to its 100 ms step (never longer than asked).
      values: ["4900", "4900", "b", "s"],
    },
    { sql: "SELECT 1", values: [] },
  ]);
});

it("leaves out a Scope setting already held and a limit no shorter than the one in force", () => {
  const h = host();
  h.run(scope, ["b", "s"]);
  h.run("SELECT 1");
  h.sent.length = 0;
  h.run(scope, ["b", "s"]);
  h.run("SELECT 2");
  expect(h.sent).toEqual([{ sql: "SELECT 2", values: [] }]);
  h.sent.length = 0;
  h.run(limits, ["4000"]);
  h.run("SELECT 3");
  h.run(limits, ["4000"]);
  h.run("SELECT 4");
  // 4,050 ms left: the 4,000 ms limit in force already ends the statement sooner.
  h.run(limits, ["4050"]);
  h.run("SELECT 5");
  expect(h.sent).toEqual([
    {
      sql: "SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$2,true)",
      values: ["4000", "4000"],
    },
    { sql: "SELECT 3", values: [] },
    { sql: "SELECT 4", values: [] },
    { sql: "SELECT 5", values: [] },
  ]);
  expect(h.tracker.pending()).toBeNull();
});

it("never leaves a limit longer than the one asked for in force", () => {
  const h = host();
  const sentLimits = () =>
    h.sent.filter((s) => s.sql.includes("statement_timeout")).map((s) => s.values);
  for (const asked of ["4987", "4950", "3999", "3901", "250", "199", "150", "0", "10s", "120"]) {
    h.run(limits, [asked]);
    h.run("SELECT 1");
  }
  expect(sentLimits()).toEqual([
    ["4900", "4900"],
    // 3,999 ms asked: 4,900 would be longer, so 3,900 is sent; 3,901 needs nothing more.
    ["3900", "3900"],
    ["200", "200"],
    // Exactly as asked once no more than 200 ms are asked for.
    ["199", "199"],
    ["150", "150"],
    // No limit and any other form are always sent as asked; the next limit is sent again.
    ["0", "0"],
    ["10s", "10s"],
    ["120", "120"],
  ]);
});

it("answers a Scope setting read only when it knows the value the next statement runs under", () => {
  const h = host();
  expect(h.tracker.plan(prior, []).kind).toBe("Run");
  h.run(identity, ["session", "actor"]);
  expect(h.tracker.plan(prior, [])).toEqual({
    kind: "Answer",
    result: { rows: [{ session_scope: "session", actor_scope: "actor" }], rowCount: 1 },
  });
  // Written but not yet sent: still the value the next statement would read.
  h.run(identity, ["", ""]);
  expect(h.tracker.plan(prior, [])).toMatchObject({
    result: { rows: [{ session_scope: "", actor_scope: "" }] },
  });
  // A statement or lock limit read is never answered.
  expect(
    h.tracker.plan("SELECT current_setting('statement_timeout',true) AS limit_ms", []).kind,
  ).toBe("Run");
});

it("answers a repeat of a lock this transaction holds; a shared lock never answers an exclusive one", () => {
  const h = host();
  h.run(shared, ["MembershipFence:b"]);
  expect(h.tracker.plan(shared, ["MembershipFence:b"]).kind).toBe("Answer");
  expect(h.tracker.plan(shared, ["MembershipFence:c"]).kind).toBe("Run");
  expect(h.tracker.plan(exclusive, ["MembershipFence:b"]).kind).toBe("Run");
  h.run(exclusive, ["Root:x"]);
  expect(h.tracker.plan(shared, ["Root:x"]).kind).toBe("Answer");
});

it.each([
  "ROLLBACK TO SAVEPOINT s",
  "SET LOCAL ROLE x",
  "RESET ALL",
  "SELECT set_config('bop.brand_id',$1,false)",
  "SELECT 1; SET ROLE y",
  "DO $$ BEGIN END $$",
])("forgets held settings and locks after %s", (statement) => {
  const h = host();
  h.run(scope, ["b", "s"]);
  h.run(shared, ["MembershipFence:b"]);
  h.run(statement, statement.includes("$1") ? ["b"] : []);
  expect(h.tracker.plan(shared, ["MembershipFence:b"]).kind).toBe("Run");
  h.run(scope, ["b", "s"]);
  expect(h.tracker.pending()).toEqual({
    sql: "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
    values: ["b", "s"],
  });
});

it("sends a setting it cannot reason about as written", () => {
  const h = host();
  for (const [sql, values] of [
    ["SELECT set_config('search_path',$1,true)", ["x"]],
    ["SELECT set_config('bop.brand_id',$1,true) AS brand", ["b"]],
    [scope, [1, "s"]],
  ] as const) {
    expect(h.tracker.plan(sql, values).kind).toBe("Run");
  }
});

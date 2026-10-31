/** Local simulated Provider state only, never a real Provider response. */
export function provisionInternalPaymentFailure(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS failed_outcome (
  reference TEXT PRIMARY KEY REFERENCES intent(reference),
  reason TEXT NOT NULL CHECK(reason='Declined'),
  occurred_at TEXT NOT NULL
 ) STRICT;
 CREATE TRIGGER IF NOT EXISTS failed_outcome_requires_intent BEFORE INSERT ON failed_outcome
 WHEN NOT EXISTS (SELECT 1 FROM intent WHERE reference=NEW.reference)
 BEGIN SELECT RAISE(ABORT,'SIMULATION_INTENT_UNAVAILABLE'); END;
 CREATE TRIGGER IF NOT EXISTS failed_outcome_excludes_capture BEFORE INSERT ON failed_outcome
 WHEN EXISTS (SELECT 1 FROM outcome WHERE reference=NEW.reference)
 BEGIN SELECT RAISE(ABORT,'SIMULATION_OUTCOME_CONFLICT'); END;
 CREATE TRIGGER IF NOT EXISTS capture_excludes_failed_outcome BEFORE INSERT ON outcome
 WHEN EXISTS (SELECT 1 FROM failed_outcome WHERE reference=NEW.reference)
 BEGIN SELECT RAISE(ABORT,'SIMULATION_OUTCOME_CONFLICT'); END;
 CREATE TRIGGER IF NOT EXISTS failed_outcome_no_update BEFORE UPDATE ON failed_outcome
 BEGIN SELECT RAISE(ABORT,'SIMULATION_OUTCOME_IMMUTABLE'); END;
 CREATE TRIGGER IF NOT EXISTS failed_outcome_no_delete BEFORE DELETE ON failed_outcome
 BEGIN SELECT RAISE(ABORT,'SIMULATION_OUTCOME_IMMUTABLE'); END;`);
}
export function createInternalPaymentFailure(db) {
  const read = db.prepare(
    "SELECT reference,reason,occurred_at FROM failed_outcome WHERE reference=?",
  );
  return Object.freeze({
    read(reference) {
      const row = read.get(reference);
      return row ? Object.freeze({ ...row }) : null;
    },
    record(reference, at) {
      if (
        typeof reference !== "string" ||
        !/^pi_DEMO[a-f0-9]{32}$/.test(reference) ||
        typeof at !== "string" ||
        !Number.isFinite(Date.parse(at)) ||
        new Date(at).toISOString() !== at
      )
        throw new Error("SIMULATION_FAILURE_INVALID");
      db.prepare(
        "INSERT INTO failed_outcome VALUES(?,'Declined',?) ON CONFLICT(reference) DO NOTHING",
      ).run(reference, at);
      const row = read.get(reference);
      if (!row || row.occurred_at > at) throw new Error("SIMULATION_FAILURE_INVALID");
      return Object.freeze({ ...row });
    },
  });
}

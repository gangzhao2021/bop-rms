import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { it } from "vitest";

import { createPostgresKdsOperatorShiftStore } from "../../rms/kitchen/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (n) => `0198a408-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const brand = id(2),
  store = id(3),
  otherStore = id(4);

function session(n, actor, at, until = "2026-08-11T23:00:00.000Z", storeId = store) {
  return {
    sessionReference: id(n),
    actorReference: id(actor),
    brandReference: brand,
    storeReference: storeId,
    sessionVersion: 1,
    sessionKind: "NamedKdsOperator",
    state: "Active",
    observedAt: at,
    validUntil: until,
  };
}

async function asRuntime(client, role, storeId, work) {
  await client.query("BEGIN");
  try {
    await client.query(`SET LOCAL ROLE ${role}`);
    let n = 1000;
    const shifts = createPostgresKdsOperatorShiftStore({
      brandReference: brand,
      storeReference: storeId,
      references: { next: () => id(n++ + Math.floor(Math.random() * 1e6) * 1000) },
    });
    const result = await work(shifts, client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function count(client, table) {
  return (await client.query(`SELECT count(*)::integer AS count FROM rms_kitchen.${table}`)).rows[0]
    .count;
}

async function prove(context) {
  const client = new Client(context.clientConfig);
  const role = `bop_wp2423_${context.runId}`;
  await client.connect();
  try {
    const security = await client.query(
      `SELECT relrowsecurity,relforcerowsecurity FROM pg_class
       WHERE oid='rms_kitchen.kds_operator_shift_event'::regclass`,
    );
    assert.deepEqual(security.rows, [{ relrowsecurity: true, relforcerowsecurity: true }]);

    // Exactly the runtime grants WP-2423 requests for the pilot API role.
    await client.query(`CREATE ROLE ${role} NOLOGIN`);
    await client.query(`GRANT USAGE ON SCHEMA rms_kitchen,platform_helpers TO ${role}`);
    await client.query(
      `GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),
       platform_helpers.current_store_id(),platform_helpers.is_uuid_v7(uuid) TO ${role}`,
    );
    await client.query(`GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO ${role}`);
    await client.query(
      `GRANT SELECT,INSERT ON rms_kitchen.kds_operator_shift_event,
       rms_kitchen.kds_operator_handover TO ${role}`,
    );

    const a = session(10, 20, "2026-08-11T14:00:00.000Z");
    assert.equal(
      await asRuntime(client, role, store, (s, tx) =>
        s.start({ transaction: tx, session: a, recordedAt: a.observedAt }),
      ),
      null,
      "first operator has no prior to hand over from",
    );
    await asRuntime(client, role, store, (s, tx) =>
      s.release({ transaction: tx, session: a, releasedAt: "2026-08-11T15:00:00.000Z" }),
    );

    const b = session(11, 21, "2026-08-11T15:01:00.000Z");
    const handover = await asRuntime(client, role, store, (s, tx) =>
      s.start({ transaction: tx, session: b, recordedAt: "2026-08-11T15:01:01.000Z" }),
    );
    assert.equal(handover.priorSessionReference, a.sessionReference);
    assert.equal(handover.priorActorReference, a.actorReference);
    assert.equal(handover.priorFinalState, "Ended");
    assert.equal(handover.priorFinalizedAt, "2026-08-11T15:00:00.000Z");
    assert.equal(handover.nextSessionReference, b.sessionReference);
    assert.equal(handover.nextActorReference, b.actorReference);
    assert.equal(handover.reasonCode, "ShiftHandover");

    assert.equal(
      await asRuntime(client, role, store, (s, tx) =>
        s.start({ transaction: tx, session: b, recordedAt: "2026-08-11T15:02:00.000Z" }),
      ),
      null,
      "a repeated Start is idempotent",
    );
    assert.equal(await count(client, "kds_operator_handover"), 1);
    assert.equal(await count(client, "kds_operator_shift_event"), 3);

    // B releases; A signs in again: one handover B -> A. The same person after their own
    // release, or after a never-released prior, never creates a handover.
    await asRuntime(client, role, store, (s, tx) =>
      s.release({ transaction: tx, session: b, releasedAt: "2026-08-11T16:00:00.000Z" }),
    );
    const sameActor = session(12, 21, "2026-08-11T16:05:00.000Z");
    assert.equal(
      await asRuntime(client, role, store, (s, tx) =>
        s.start({ transaction: tx, session: sameActor, recordedAt: sameActor.observedAt }),
      ),
      null,
    );
    const unreleasedNext = session(13, 22, "2026-08-11T16:10:00.000Z");
    const fromB = await asRuntime(client, role, store, (s, tx) =>
      s.start({ transaction: tx, session: unreleasedNext, recordedAt: unreleasedNext.observedAt }),
    );
    assert.equal(fromB.priorSessionReference, b.sessionReference, "latest released prior wins");
    const afterUnreleased = session(14, 20, "2026-08-11T16:20:00.000Z");
    assert.equal(
      await asRuntime(client, role, store, (s, tx) =>
        s.start({
          transaction: tx,
          session: afterUnreleased,
          recordedAt: afterUnreleased.observedAt,
        }),
      ),
      null,
      "an operator who never released is not handed over from",
    );

    // Store scope: another Store neither sees nor derives from these facts.
    const elsewhere = session(15, 23, "2026-08-11T16:30:00.000Z", undefined, otherStore);
    assert.equal(
      await asRuntime(client, role, otherStore, (s, tx) =>
        s.start({ transaction: tx, session: elsewhere, recordedAt: elsewhere.observedAt }),
      ),
      null,
    );
    await assert.rejects(
      asRuntime(client, role, store, (s, tx) =>
        s.start({ transaction: tx, session: elsewhere, recordedAt: elsewhere.observedAt }),
      ),
      (error) => error.code === "KDS_OPERATOR_SESSION_UNAVAILABLE",
      "evidence for another Store is refused before any write",
    );

    await assert.rejects(
      client.query(
        "UPDATE rms_kitchen.kds_operator_shift_event SET event_kind='Released' WHERE session_id=$1",
        [a.sessionReference],
      ),
      /append-only/u,
    );
    await client.query("DELETE FROM rms_kitchen.kds_operator_shift_event WHERE session_id=$1", [
      a.sessionReference,
    ]);
    assert.equal(await count(client, "kds_operator_shift_event"), 8);
    assert.equal(await count(client, "kds_operator_handover"), 2);
  } finally {
    await client.query("RESET ROLE").catch(() => undefined);
    await client.query(`DROP OWNED BY ${role}`).catch(() => undefined);
    await client.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

it("derives KDS operator handover from Kitchen-owned Start and Release facts", async () => {
  await withIsolatedDatabase({ caseId: "kds_operator_shift", root }, prove);
});

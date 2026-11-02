import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import pg from "pg";
import { it } from "vitest";
import {
  createMemberPhoneProtector,
  createMemberPointsStore,
  memberExpiryStep,
  memberPointsDefaultRule,
  memberPointsExpireAt,
} from "../../rms/customer-loyalty/src/index.ts";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

/**
 * WP-2423 取舍 18 DEC-MEMBER-POINTS: the ledger under the restricted API and worker roles holding
 * exactly the rendered pilot grants. Phones are from the fictitious 555-01xx range.
 */
const id = (n) => "018fb100-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const brandA = id(1),
  brandB = id(2),
  storeA1 = id(3),
  storeA2 = id(4),
  storeB = id(5);
const protector = createMemberPhoneProtector(Buffer.alloc(32, 7));

it("earns, spends one balance once, takes back after a refund, expires, leaves and stays in its Brand", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_points" }, async (context) => {
    const admin = new pg.Client(context.clientConfig);
    await admin.connect();
    const api = "wp2423_mp_" + context.runId,
      worker = "wp2423_mp_w_" + context.runId;
    let counter = 100;
    let clock = Date.parse("2026-11-02T12:00:00.000Z");
    const now = () => new Date(clock).toISOString();
    const nextReference = () => id((counter += 1));
    const store = (brandReference, storeReference) =>
      createMemberPointsStore({ brandReference, storeReference, nextReference, now, protector });
    const clients = [];
    const as = async (role, work) => {
      const client = new pg.Client(context.clientConfig);
      await client.connect();
      clients.push(client);
      await client.query("BEGIN");
      await client.query(`SET LOCAL ROLE ${role}`);
      await client.query("SET LOCAL statement_timeout='20s'");
      try {
        const result = await work(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    };
    try {
      for (const name of [api, worker])
        await admin.query(
          `CREATE ROLE ${name} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
        );
      const root = new URL("../../../docs/spec/", import.meta.url);
      const matrices = await Promise.all(
        ["pilot-acl-matrix.json", "pilot-acl-additions.json"].map(async (file) =>
          JSON.parse(await readFile(new URL(file, root), "utf8")),
        ),
      );
      await admin.query(renderPilotAclSql(matrices, { api, worker }));

      const a1 = store(brandA, storeA1),
        a2 = store(brandA, storeA2),
        b = store(brandB, storeB);
      const phone = "+16135550101";
      const rule = await as(api, (tx) => a1.currentRule(tx));
      assert.equal(rule.earnPointsPerDollar, 3);

      // A code: a wrong try counts, the fifth ends it, a right one is used once. No code at rest.
      const { code } = await as(api, (tx) => a1.createChallenge(tx, phone));
      assert.equal(
        await as(api, (tx) =>
          a1.checkChallenge(tx, phone, "000000" === code ? "111111" : "000000"),
        ),
        "Wrong",
      );
      assert.equal(await as(api, (tx) => a1.checkChallenge(tx, phone, code)), "Right");
      assert.equal(await as(api, (tx) => a1.checkChallenge(tx, phone, code)), "NoCode");
      await as(api, (tx) => a1.createChallenge(tx, phone));
      const wrong = [];
      for (let n = 0; n < 5; n += 1)
        wrong.push(await as(api, (tx) => a1.checkChallenge(tx, phone, "abcdef")));
      assert.deepEqual(wrong, ["Wrong", "Wrong", "Wrong", "Wrong", "NoCode"]);
      const stored = await admin.query(
        "SELECT count(*)::int n FROM rms_loyalty.loyalty_phone_challenge WHERE brand_id=$1",
        [brandA],
      );
      assert.equal(stored.rows[0].n, 0);

      // Joining: the phone is encrypted, consent is its own record, unticked stays no.
      const account = await as(api, (tx) => a1.join(tx, { phone, marketingConsent: false }));
      assert.equal(await as(api, (tx) => a1.findByPhone(tx, phone)), account);
      const raw = await admin.query(
        "SELECT phone_ciphertext,phone_last4 FROM rms_loyalty.loyalty_member_contact WHERE account_id=$1",
        [account],
      );
      assert.equal(raw.rows[0].phone_last4, "0101");
      assert.equal(Buffer.from(raw.rows[0].phone_ciphertext).includes(phone), false);
      assert.equal(protector.open(raw.rows[0].phone_ciphertext), phone);

      // $100.00 of dishes earns 300 points; the same payment never earns twice, by anyone.
      const order = id(10),
        payment = id(11);
      const earned = await as(api, (tx) =>
        a1.earn(tx, {
          accountReference: account,
          sourceReference: payment,
          orderReference: order,
          paidDishesMinor: 10_000n,
          rule,
        }),
      );
      assert.equal(earned.points, 300);
      await assert.rejects(
        as(api, (tx) =>
          a1.earn(tx, {
            accountReference: account,
            sourceReference: payment,
            orderReference: order,
            paidDishesMinor: 10_000n,
            rule,
          }),
        ),
        { code: "MEMBER_ALREADY_EARNED" },
      );
      await as(api, (tx) =>
        a2.earn(tx, {
          accountReference: account,
          sourceReference: id(12),
          orderReference: id(13),
          paidDishesMinor: 6_700n,
          rule,
        }),
      );
      // Usable across the Brand's Stores; another Brand sees nothing.
      assert.equal((await as(api, (tx) => a2.memberHome(tx, account))).availablePoints, 501);
      assert.equal(await as(api, (tx) => b.findByPhone(tx, phone)), null);
      await assert.rejects(
        as(api, (tx) => b.memberHome(tx, account)),
        { code: "MEMBER_NOT_FOUND" },
      );
      assert.deepEqual(await as(api, (tx) => b.listMembers(tx, 10)), []);

      // Two redemptions of one balance at once: the second waits for the lock and is refused.
      const redeem = (points, operation, orderReference = id(20)) =>
        as(api, (tx) =>
          a1.redeem(tx, {
            accountReference: account,
            operationReference: operation,
            orderReference,
            points,
            netMinor: BigInt(points),
            totalMinor: BigInt(points),
            rewardProductReference: null,
            rule,
          }),
        );
      const results = await Promise.allSettled([redeem(400, id(21)), redeem(400, id(22))]);
      assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
      assert.equal(
        results.find((r) => r.status === "rejected").reason.code,
        "MEMBER_NOT_ENOUGH_POINTS",
      );
      assert.equal((await as(api, (tx) => a1.memberHome(tx, account))).availablePoints, 101);

      // A refund after the points were spent: what's left goes, the rest is a debt; later points
      // pay the debt first. The background sweep runs as this same role.
      await as(api, (tx) =>
        a1.reverseEarned(tx, {
          accountReference: account,
          earnReference: id(1000),
          orderReference: order,
          points: 300,
        }),
      );
      let home = await as(api, (tx) => a1.memberHome(tx, account));
      assert.equal(home.availablePoints, 0);
      assert.equal(home.pointsDebt, 199);
      await as(api, (tx) =>
        a1.earn(tx, {
          accountReference: account,
          sourceReference: id(14),
          orderReference: id(15),
          paidDishesMinor: 10_000n,
          rule,
        }),
      );
      home = await as(api, (tx) => a1.memberHome(tx, account));
      assert.equal(home.availablePoints, 101);
      assert.equal(home.pointsDebt, 0);
      // Points spent on a refunded bill come back.
      await as(api, (tx) =>
        a1.returnRedeemed(tx, {
          accountReference: account,
          redemptionReference: id(1001),
          orderReference: id(20),
          points: 100,
          reasonCode: "ORDER_REFUNDED",
        }),
      );
      assert.equal((await as(api, (tx) => a1.memberHome(tx, account))).availablePoints, 201);

      // The ledger is append-only for everyone.
      for (const sql of [
        "UPDATE rms_loyalty.loyalty_points_transaction SET points=1",
        "DELETE FROM rms_loyalty.loyalty_points_transaction",
      ])
        await assert.rejects(admin.query(sql), { code: "55000" });

      // Expiry: never without a notice old enough. Activity before it wins.
      const held = (await as(api, (tx) => a1.expiryCandidates(tx, rule, 10))).length;
      assert.equal(held, 0, "nothing near expiry yet");
      const last = (await as(api, (tx) => a1.memberHome(tx, account))).lastActivityAt;
      const due = Date.parse(memberPointsExpireAt(last, rule));
      clock = due - 29 * 86_400_000;
      const [candidate] = await as(api, (tx) => a1.expiryCandidates(tx, rule, 10));
      assert.equal(candidate.accountReference, account);
      assert.equal(memberExpiryStep({ ...candidate, now: now(), rule }), "SendNotice");
      assert.equal(await as(api, (tx) => a1.phoneForMessage(tx, account)), phone);
      await as(api, (tx) =>
        a1.recordExpiryNotice(tx, {
          accountReference: account,
          lastActivityAt: candidate.lastActivityAt,
          expiresAt: new Date(due).toISOString(),
        }),
      );
      const [noticed] = await as(api, (tx) => a1.expiryCandidates(tx, rule, 10));
      assert.equal(memberExpiryStep({ ...noticed, now: now(), rule }), "None");
      clock = due + 2 * 86_400_000;
      const [ready] = await as(api, (tx) => a1.expiryCandidates(tx, rule, 10));
      assert.equal(memberExpiryStep({ ...ready, now: now(), rule }), "Expire");
      const expired = await as(api, (tx) =>
        a1.expire(tx, { accountReference: account, lastActivityAt: ready.lastActivityAt }),
      );
      assert.equal(expired.points, 201);

      // Leaving: the phone is gone; the ledger and the report still add up; rejoining starts at 0
      // and an order already earned can't earn again.
      const second = await as(api, (tx) =>
        a1.join(tx, { phone: "+16135550102", marketingConsent: true }),
      );
      await as(api, (tx) =>
        a1.earn(tx, {
          accountReference: second,
          sourceReference: id(16),
          orderReference: id(17),
          paidDishesMinor: 5_000n,
          rule,
        }),
      );
      const session = await as(api, (tx) => a1.openSession(tx, second));
      assert.equal(await as(api, (tx) => a1.memberOfSession(tx, session.token)), second);
      assert.deepEqual(
        (await as(api, (tx) => a1.listMembers(tx, 10))).map((row) => [
          row.phoneLast4,
          row.marketingConsent,
        ]),
        [
          ["0102", true],
          ["0101", false],
        ],
      );
      await as(api, (tx) => a1.leave(tx, second));
      assert.equal(await as(api, (tx) => a1.findByPhone(tx, "+16135550102")), null);
      assert.equal(await as(api, (tx) => a1.memberOfSession(tx, session.token)), null);
      const contact = await admin.query(
        "SELECT count(*)::int n FROM rms_loyalty.loyalty_member_contact WHERE account_id=$1",
        [second],
      );
      assert.equal(contact.rows[0].n, 0);
      const report = await as(api, (tx) => a1.report(tx));
      assert.equal(report.forfeitedPoints, 150);
      assert.equal(report.members, 1);
      assert.equal(
        report.issuedPoints + report.returnedPoints,
        report.usedPoints +
          report.reversedPoints +
          report.expiredPoints +
          report.forfeitedPoints +
          report.outstandingPoints -
          report.owedPoints,
      );
      const again = await as(api, (tx) =>
        a1.join(tx, { phone: "+16135550102", marketingConsent: false }),
      );
      assert.notEqual(again, second);
      assert.equal((await as(api, (tx) => a1.memberHome(tx, again))).availablePoints, 0);
      await assert.rejects(
        as(api, (tx) =>
          a1.earn(tx, {
            accountReference: again,
            sourceReference: id(16),
            orderReference: id(17),
            paidDishesMinor: 5_000n,
            rule,
          }),
        ),
        { code: "MEMBER_ALREADY_EARNED" },
      );

      // Rules: an older version is refused; the worker role holds nothing here.
      const changed = await as(api, (tx) =>
        a1.recordRule(tx, {
          expectedVersion: 0,
          operationReference: id(30),
          actorReference: id(31),
          change: { ...memberPointsDefaultRule, earnPointsPerDollar: 5 },
        }),
      );
      assert.equal(changed.version, 1);
      await assert.rejects(
        as(api, (tx) =>
          a1.recordRule(tx, {
            expectedVersion: 0,
            operationReference: id(32),
            actorReference: id(31),
            change: memberPointsDefaultRule,
          }),
        ),
        { code: "MEMBER_RULE_CHANGED" },
      );
      await assert.rejects(
        as(worker, (tx) => tx.query("SELECT * FROM rms_loyalty.loyalty_phone_challenge")),
        { code: "42501" },
      );
    } finally {
      await Promise.all(clients.map((client) => client.end().catch(() => undefined)));
      await admin.end();
    }
  });
});

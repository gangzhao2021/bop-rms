import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import pg from "pg";
import { changeDiningServiceSetting } from "../../rms/dining/src/index.ts";
import { createOrderNumberAllocation } from "../../rms/ordering/src/index.ts";
import {
  createKitchenWorkLifecycleService,
  createPostgresKitchenWorkLifecycleStore,
} from "../../rms/kitchen/src/index.ts";
import { createDiningGuestTableClose } from "../../../apps/api/src/dining-guest-table-close.ts";
import { seedAcceptanceOrderHistory } from "./acceptance-order-history.mjs";
import {
  journeyRound,
  seedJourneyAcceptance,
  seedJourneyDining,
  seedJourneyPayment,
  seedJourneyQuote,
} from "./dine-in-journey-seed.mjs";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { snapshotBegin, snapshotQuery } from "./snapshot-read-runner.mjs";

/** WP-2423 DEC-DINING-GUEST-TABLE-START: what the guest-started table acceptance suites share. */
const { Client } = pg;
export const id = (n) => "01a0ff10-0000-7000-8000-" + n.toString(16).padStart(12, "0");
export const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };
export const owner = { brandReference: scope.brandReference, storeReference: scope.storeReference };
export const digest = (value) => createHash("sha256").update(value).digest("hex");
let references = 0x9000;
/** Fresh UUIDv7 whose timestamp prefix is the current instant. */
export const fresh = () =>
  Date.now()
    .toString(16)
    .padStart(12, "0")
    .replace(/^(.{8})(.{4})$/u, "$1-$2") +
  "-7000-8000-" +
  (references++).toString(16).padStart(12, "0");

export async function setup(context) {
  const admin = new Client(context.clientConfig);
  await admin.connect();
  const api = "wp2423_gs_" + context.runId,
    worker = "wp2423_gs_w_" + context.runId;
  for (const name of [api, worker])
    await admin.query(
      "CREATE ROLE " + name + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
    );
  const root = new URL("../../../docs/spec/", import.meta.url);
  const matrices = await Promise.all(
    ["pilot-acl-matrix.json", "pilot-acl-additions.json"].map(async (file) =>
      JSON.parse(await readFile(new URL(file, root), "utf8")),
    ),
  );
  await admin.query(renderPilotAclSql(matrices, { api, worker }));
  await admin.query(
    "SELECT set_config('bop.brand_id',$1,false),set_config('bop.store_id',$2,false)",
    [scope.brandReference, scope.storeReference],
  );
  // `after` runs once a statement has answered, inside its transaction: a test can hold a lock there.
  const opened = { connections: 0, statements: 0, after: null };
  /** One restricted-role transaction on its own connection, under the pilot's lock timeout. */
  const transactions = (role = api) => ({
    async run(work) {
      const client = new Client(context.clientConfig);
      await client.connect();
      opened.connections += 1;
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE " + role);
        await client.query("SET LOCAL lock_timeout='2s'");
        await client.query("SET LOCAL statement_timeout='10s'");
        const result = await work({
          query: async (sql, values) => {
            opened.statements += 1;
            const answer = await client.query(sql, [...(values ?? [])]);
            await opened.after?.(sql);
            return answer;
          },
        });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        await client.end();
      }
    },
  });
  /** The pilot runner's snapshot read: same BEGIN and statement rules, no locks. */
  transactions.snapshot = (role = api) => ({
    async run(work) {
      const client = new Client(context.clientConfig);
      await client.connect();
      try {
        await client.query(snapshotBegin);
        await client.query("SET LOCAL ROLE " + role);
        const result = await work({
          query: snapshotQuery((sql, values) => client.query(sql, [...(values ?? [])])),
        });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        await client.end();
      }
    },
  });
  const pepper = randomBytes(32);
  const credentials = {
    generateReference: fresh,
    generateJoinCredential: () => String(100000 + Math.floor(Math.random() * 899999)),
    hashJoinCredential: (kind, value) =>
      createHmac("sha256", pepper).update(`DiningJoin:${kind}:${value}`).digest("hex"),
    hashOperationIntent: digest,
    equals: (a, b) => a === b,
  };
  /** Owner client transactions for test-only setup through real owner stores. */
  const ownerRunner = () => ({
    async run(work) {
      const client = new Client(context.clientConfig);
      await client.connect();
      try {
        await client.query("BEGIN");
        const result = await work({ query: (sql, values) => client.query(sql, values) });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        await client.end();
      }
    },
  });
  return { admin, api, worker, transactions, credentials, opened, ownerRunner, matrices };
}

export const minutes = (n) => n * 60_000;
export const provider = id(0x801);

/**
 * A guest-started table whose paid round the kitchen has: the Session, its guest-start row and one
 * paid, accepted round, owner-seeded (payment and acceptance are covered by their own suites). The
 * tenant scope of these rows is the journey fixture's. `guestStarted: false` is the same table
 * opened by staff, at a Store whose switch was never turned on.
 */
export async function seedPaidGuestTable(admin, transactions, input) {
  const base = input.base;
  const time = (offset) => new Date(base + offset).toISOString();
  const R1 = journeyRound({ at: time(-minutes(130)), prefix: input.prefix });
  const journeyScope = R1.f.scope;
  const tenant = journeyScope.brandReference.slice(0, 24) + "000000000900";
  const ownerScope = { tenantReference: tenant, ...journeyScope };
  await admin.query(
    "SELECT set_config('bop.brand_id',$1,false),set_config('bop.store_id',$2,false)",
    [journeyScope.brandReference, journeyScope.storeReference],
  );
  const guestStarted = input.guestStarted !== false;
  const version =
    guestStarted &&
    (await transactions().run(async (tx) => {
      await tx.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [journeyScope.brandReference, journeyScope.storeReference],
      );
      const current = (
        await tx.query(
          "SELECT coalesce(max(version),0)::int AS version FROM rms_dining.dining_service_setting WHERE brand_id=$1 AND store_id=$2",
          [journeyScope.brandReference, journeyScope.storeReference],
        )
      ).rows[0].version;
      return (
        await changeDiningServiceSetting(tx, ownerScope, {
          operationReference: fresh(),
          expectedVersion: current,
          staffCall: false,
          chaseDish: false,
          guestTableStart: true,
          actorReference: id(8),
          observedAt: time(-minutes(151)),
        })
      ).version;
    }));
  const dining = await seedJourneyDining({
    client: admin,
    scope: ownerScope,
    round: R1,
    startedAt: time(-minutes(150)),
    guestParticipant: id(0x901),
    tableVersion: 2,
  });
  const session = dining.session;
  if (guestStarted)
    await admin.query(
      "INSERT INTO rms_dining.dining_session_guest_start (tenant_id,brand_id,store_id,session_id,table_id,guest_session_id,operation_id,service_setting_version,started_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [
        tenant,
        journeyScope.brandReference,
        journeyScope.storeReference,
        session.diningSessionReference,
        session.tableReference,
        R1.f.request.record.guestSessionReference,
        fresh(),
        version,
        session.startedAt,
      ],
    );
  const r1 = R1.f.request.record,
    items1 = R1.items();
  await seedAcceptanceOrderHistory(admin, {
    ...r1,
    items: items1,
    orderNumberAllocation: createOrderNumberAllocation({
      orderReference: r1.order.orderReference,
      allocatedAt: r1.createdAt,
      sequence: 1n,
      businessDateResolution: R1.f.request.businessDateResolution,
    }),
  });
  await seedJourneyQuote({
    runner: input.ownerRunner,
    scope: ownerScope,
    snapshot: { items: items1, batch: R1.batch },
    prefix: "01a1" + input.prefix.slice(4),
  });
  const roundTotal = items1.reduce((sum, item) => sum + item.pricing.total.amountMinor, 0n);
  const n = input.refsAt;
  const refs = {
    paymentIntent: id(n + 1),
    attempt: id(n + 2),
    observation: id(n + 3),
    webhook: id(n + 4),
    transaction: id(n + 5),
    paymentEvent: id(n + 6),
    projection: id(n + 7),
    preparation: id(n + 8),
    commitment: id(n + 9),
    paymentOperation: id(n + 10),
    providerIntent: "pi_SYNTHETICGUEST" + n.toString(16),
    providerEvent: "evt_SYNTHETICGUEST" + n.toString(16),
    acceptance: id(n + 11),
    acceptanceOperation: id(n + 12),
    acceptanceWorkflow: id(n + 13),
    acceptanceTransition: id(n + 14),
    disposition: id(n + 15),
    correlation: id(n + 16),
    confirmation: id(n + 17),
    confirmedEvent: id(n + 18),
    ticket: id(n + 19),
    sourceEvidence: id(n + 20),
    workPlan: id(n + 21),
    station: id(n + 22),
    routing: id(n + 23),
    preparationStep: id(n + 24),
    workItems: [id(n + 30), id(n + 31)],
  };
  // "Unpaid": ordered, never paid. "Paying": the guest opened the payment and has no result yet.
  if (input.stage !== "Unpaid")
    await seedJourneyPayment(admin, {
      scope: journeyScope,
      providerAccountReference: provider,
      round: R1,
      refs,
      outcome: input.stage === "Paying" ? "Open" : "Succeeded",
      requestedAt: time(-minutes(129)),
      occurredAt: time(-minutes(128)),
      totalMinor: roundTotal,
    });
  if (input.stage === undefined)
    await seedJourneyAcceptance(admin, {
      scope: journeyScope,
      round: R1,
      items: items1,
      refs,
      staff: id(8),
      version: 1,
      previousRevision: r1.submissionReference,
      acceptedAt: time(-minutes(127)),
      kitchenAt: time(-minutes(126)),
    });
  return {
    ownerScope,
    session,
    refs,
    orderReference: r1.order.orderReference,
    roundTotal,
    host: dining.host,
    dining,
    round: R1,
    items: items1,
  };
}

export const closer = (transactions, ownerScope, now) =>
  createDiningGuestTableClose({
    scope: ownerScope,
    providerAccountReference: provider,
    environment: "Test",
    transactions: transactions(),
    // As the pilot composes it: decided from one snapshot of every owner, under the same statement
    // rules as a polled merchant read.
    readTransactions: transactions.snapshot(),
    authorize: async () => true,
    now,
    newReference: fresh,
    retentionPolicyCode: "AUDIT_DEFAULT",
    retentionPolicyVersion: 1,
    orderAudit: { retentionPolicyCode: "ORDER_AUDIT", retentionPolicyVersion: 1 },
  });
/** The kitchen finishes the round, through the real Kitchen commands under the API role. */
export async function finishKitchen({ admin, transactions, ownerScope, orderReference, at }) {
  const sha256 = (value) => "sha256:" + digest(value);
  const correlation = fresh();
  const cook = id(0x720);
  const references = {
    next: fresh,
    derive(purpose, identity) {
      const hex = digest(purpose + identity);
      return `0190abcf-${hex.slice(0, 4)}-7${hex.slice(4, 7)}-8${hex.slice(7, 10)}-${hex.slice(10, 22)}`;
    },
  };
  const kitchen = createKitchenWorkLifecycleService({
    trustedContext: {
      resolveAuthority: async () => ({
        actorReference: cook,
        brandReference: ownerScope.brandReference,
        storeReference: ownerScope.storeReference,
        observedAt: at,
      }),
    },
    correlationContext: { resolve: async () => ({ correlationReference: correlation }) },
    authorization: { authorize: async () => true },
    transactions: {
      withTransaction: (work) =>
        transactions().run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
            [ownerScope.tenantReference, ownerScope.brandReference, ownerScope.storeReference],
          );
          return work(tx);
        }),
    },
    tenantContext: { install: async () => undefined },
    idempotency: {
      acquireFence: async ({ transaction, idempotencyKey }) => {
        await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          ownerScope.storeReference + ":" + idempotencyKey,
        ]);
      },
    },
    repository: createPostgresKitchenWorkLifecycleStore({
      brandReference: ownerScope.brandReference,
      storeReference: ownerScope.storeReference,
      references,
      digests: { sha256 },
      authorize: async () => true,
      validateCurrentSource: async () => true,
    }),
    references,
    digests: { sha256 },
    clock: { now: () => at },
    admission: {
      resolve: async ({ command, acceptedOperationReference }) => ({
        decisionReference: fresh(),
        decisionVersion: 1,
        decisionDigest: sha256("synthetic admission"),
        producerContractVersion: 1,
        actorReference: command.actorReference,
        brandReference: ownerScope.brandReference,
        storeReference: ownerScope.storeReference,
        ticketReference: command.ticketReference,
        workItemReference: command.workItemReference,
        acceptedOperationReference,
        ticketVersion: BigInt(command.expectedTicketVersion),
        workItemVersion: BigInt(command.expectedWorkItemVersion),
        action: "StartKitchenWorkItem",
        purpose: "KitchenWorkExecution",
        outcome: "Allowed",
        evaluatedAt: at,
        validUntil: new Date(Date.parse(at) + minutes(60)).toISOString(),
      }),
    },
    expo: {
      resolve: async () => ({
        decisionReference: fresh(),
        decisionVersion: 1,
        decisionDigest: sha256("synthetic Expo"),
        producerContractVersion: 1,
        brandReference: ownerScope.brandReference,
        storeReference: ownerScope.storeReference,
        purpose: "KitchenReadiness",
        mode: "Disabled",
        evaluatedAt: at,
        validUntil: new Date(Date.parse(at) + minutes(60)).toISOString(),
      }),
    },
  });
  const work = (
    await admin.query(
      "SELECT w.kitchen_work_item_id::text AS id,w.order_item_id::text AS item,w.required_quantity AS quantity,w.kitchen_ticket_id::text AS ticket FROM rms_kitchen.kitchen_work_item w WHERE w.order_id=$1 ORDER BY w.source_item_ordinal",
      [orderReference],
    )
  ).rows;
  for (const row of work) {
    const step = async (action, extra = {}) => {
      const versions = (
        await admin.query(
          "SELECT t.aggregate_version::text AS ticket,w.version::text AS item FROM rms_kitchen.kitchen_ticket t JOIN rms_kitchen.kitchen_work_item w ON w.kitchen_ticket_id=t.kitchen_ticket_id WHERE w.kitchen_work_item_id=$1",
          [row.id],
        )
      ).rows[0];
      return kitchen.execute({
        action,
        idempotencyKey: "guest-table-" + row.id + "-" + action,
        actorReference: cook,
        brandReference: ownerScope.brandReference,
        storeReference: ownerScope.storeReference,
        ticketReference: row.ticket,
        workItemReference: row.id,
        orderItemReference: row.item,
        expectedTicketVersion: versions.ticket,
        expectedWorkItemVersion: versions.item,
        correlationReference: correlation,
        ...extra,
      });
    };
    assert.equal((await step("AcceptKitchenWorkItem")).outcome, "Accepted");
    assert.equal((await step("StartKitchenWorkItem")).outcome, "Started");
    assert.match(
      (await step("CompleteKitchenWorkItem", { quantityDelta: row.quantity })).outcome,
      /^Completed/u,
    );
  }
}

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { setTimeout } from "node:timers";
import { URL } from "node:url";
import pg from "pg";
import {
  chunkKitchenWorkStepLines,
  createKitchenTicketCreationService,
  createKitchenWorkLifecycleService,
  createKitchenWorkPlanDigestBinding,
  createPostgresKitchenQueueReadModel,
  createPostgresKitchenTicketStore,
  createPostgresKitchenWorkLifecycleStore,
  parseConfirmedOrderIntakeReceipt,
  parseKitchenWorkPlan,
  parseKitchenWorkStepBody,
  runKitchenWorkStepChunk,
} from "../../rms/kitchen/src/index.ts";
import {
  createOrderKitchenSourceEvidenceBinding,
  createOrderKitchenSourceLineBinding,
  parseConfirmedOrderKitchenSourceEvidence,
} from "../../rms/ordering/src/index.ts";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";

const { Client } = pg;

/**
 * DEC-KITCHEN-ONE-TAP: real Kitchen owner code under the rendered pilot API grants (NOBYPASSRLS).
 * Test-only stand-ins: the Ordering source evidence and the Kitchen work plan (synthetic,
 * digest-bound like the owners produce them), the Order header rows behind the fence, and the
 * authority decisions (Start admission allowed, Expo disabled, as the pilot composes them).
 */
export async function createKitchenStepFixture(context, prefix) {
  const id = (n) => prefix + "-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const sha256 = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");
  const admin = new Client(context.clientConfig);
  await admin.connect();
  const api = "wp2423_ks_" + context.runId;
  const worker = "wp2423_ks_w_" + context.runId;
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

  const tenant = id(1);
  const brand = id(2);
  const store = id(3);
  const scope = { brandReference: brand, storeReference: store };
  let sequence = 0x10000;
  const next = () => id(sequence++);
  const derive = (purpose, identity) => {
    const digest = sha256(purpose + ":" + identity).slice(7);
    return (
      prefix.slice(0, 7) +
      "1-" +
      digest.slice(0, 4) +
      "-7" +
      digest.slice(4, 7) +
      "-8" +
      digest.slice(7, 10) +
      "-" +
      digest.slice(10, 22)
    );
  };
  const references = { next, derive };
  const validation = { references, digests: { sha256 } };

  /** One restricted-role transaction, with the Store selected as a merchant request has it. */
  const as = async (work, { role = api, storeReference = store } = {}) => {
    const client = new Client(context.clientConfig);
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE " + role);
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query(
        "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
        [tenant, brand, storeReference],
      );
      const result = await work({
        query: (sql, values) => client.query(sql, values === undefined ? [] : [...values]),
      });
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  };

  const allowedAt = (observedAt) => new Date(Date.parse(observedAt) + 60_000).toISOString();
  const lifecycle = {
    references,
    digests: { sha256 },
    tenantContext: { install: async () => undefined },
    idempotency: {
      acquireFence: async ({ transaction, idempotencyKey }) => {
        await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          brand + ":" + store + ":" + idempotencyKey,
        ]);
      },
    },
    admission: {
      resolve: async ({ command, acceptedOperationReference, observedAt }) => ({
        decisionReference: next(),
        decisionVersion: 1,
        decisionDigest: sha256("TEST start allowed"),
        producerContractVersion: 1,
        actorReference: command.actorReference,
        ...scope,
        ticketReference: command.ticketReference,
        workItemReference: command.workItemReference,
        acceptedOperationReference,
        ticketVersion: BigInt(command.expectedTicketVersion),
        workItemVersion: BigInt(command.expectedWorkItemVersion),
        action: "StartKitchenWorkItem",
        purpose: "KitchenWorkExecution",
        outcome: "Allowed",
        evaluatedAt: observedAt,
        validUntil: allowedAt(observedAt),
      }),
    },
    expo: {
      resolve: async (input) => ({
        decisionReference: next(),
        decisionVersion: 1,
        decisionDigest: sha256("TEST expo disabled"),
        producerContractVersion: 1,
        ...scope,
        purpose: "KitchenReadiness",
        mode: "Disabled",
        evaluatedAt: input.observedAt,
        validUntil: allowedAt(input.observedAt),
      }),
    },
  };

  /** A confirmed round becomes one Kitchen ticket (one Order, by the given or a new reference). */
  const createTicket = async ({
    lines,
    quantity = 1,
    order = next(),
    createdAgoMs = 600_000,
    options = () => [],
    name = (index) => "TEST dish " + (index + 1),
  }) => {
    const at = (offset) => new Date(Date.now() - createdAgoMs - offset).toISOString();
    const receipt = parseConfirmedOrderIntakeReceipt({
      consumerName: "kitchen.confirmed-order:v1",
      consumerVersion: 1,
      sourceEventReference: next(),
      ...scope,
      orderReference: order,
      orderBatchReference: next(),
      confirmationReference: next(),
      sourceAggregateVersion: 3n,
      sourceSnapshotDigest: sha256("order-snapshot"),
      confirmedAt: at(2_000),
      correlationReference: next(),
      semanticEventBindingDigest: sha256("semantic-order-confirmed"),
    });
    const items = Array.from({ length: lines }, (_, index) => {
      const draft = {
        orderItemReference: next(),
        orderBatchReference: receipt.orderBatchReference,
        ordinal: index + 1,
        quantity,
        productReference: id(0x500),
        productVersionReference: id(0x501),
        skuReference: id(0x502),
        menuVersionReference: id(0x503),
        localizedDisplayNames: { "en-CA": name(index) },
        selectedOptions: options(index),
        customerNote: null,
        lineDigest: sha256("placeholder-line"),
      };
      return { ...draft, lineDigest: sha256(createOrderKitchenSourceLineBinding(draft)) };
    });
    const evidenceDraft = {
      evidenceReference: next(),
      ...scope,
      orderReference: receipt.orderReference,
      orderBatchReference: receipt.orderBatchReference,
      confirmationReference: receipt.confirmationReference,
      sourceEventReference: receipt.sourceEventReference,
      sourceAggregateVersion: receipt.sourceAggregateVersion,
      sourceSnapshotDigest: receipt.sourceSnapshotDigest,
      capturedAt: at(3_000),
      evidenceVersion: 1,
      items,
      evidenceDigest: sha256("placeholder-evidence"),
    };
    const evidence = parseConfirmedOrderKitchenSourceEvidence({
      ...evidenceDraft,
      evidenceDigest: sha256(createOrderKitchenSourceEvidenceBinding(evidenceDraft)),
    });
    const creation = createKitchenTicketCreationService({
      orderingSource: { resolve: async () => evidence },
      plans: {
        resolve: async ({ source }) => {
          const draftPlan = parseKitchenWorkPlan({
            planReference: next(),
            ...scope,
            orderReference: receipt.orderReference,
            orderBatchReference: receipt.orderBatchReference,
            confirmationReference: receipt.confirmationReference,
            sourceEvidenceDigest: source.sourceEvidenceDigest,
            planVersion: 1,
            generatedAt: at(1_000),
            items: source.items.map((item) => ({
              orderItemReference: item.orderItemReference,
              splitOrdinal: 1,
              stationRouting: {
                stationReference: id(0x510),
                routingRuleReference: id(0x511),
                routingRuleVersion: 1,
                routingRuleDigest: sha256("routing-rule"),
              },
              preparation: {
                preparationReference: id(0x512),
                preparationVersion: 1,
                preparationDigest: sha256("preparation"),
                instructions: ["Prepare the TEST dish"],
              },
            })),
            planDigest: sha256("placeholder-plan"),
          });
          return parseKitchenWorkPlan({
            ...draftPlan,
            planDigest: sha256(createKitchenWorkPlanDigestBinding(draftPlan)),
          });
        },
      },
      clock: { now: async () => at(0) },
      references: { derive },
      digests: { sha256 },
      repository: createPostgresKitchenTicketStore({
        ...scope,
        ...validation,
        authorize: async () => true,
        validateCurrentSource: async () => true,
      }),
    });
    const created = await as((transaction) => creation.create({ receipt, transaction }));
    if (created.status !== "Created") throw new Error("TEST_TICKET_NOT_CREATED");
    const ticket = (
      await admin.query(
        "SELECT kitchen_ticket_id::text AS id FROM rms_kitchen.kitchen_ticket WHERE order_batch_id=$1",
        [receipt.orderBatchReference],
      )
    ).rows[0].id;
    const workItems = (
      await admin.query(
        "SELECT kitchen_work_item_id::text AS id,order_item_id::text AS line FROM rms_kitchen.kitchen_work_item WHERE kitchen_ticket_id=$1 ORDER BY source_item_ordinal",
        [ticket],
      )
    ).rows;
    return {
      order,
      batch: receipt.orderBatchReference,
      ticket,
      items: workItems.map((row) => ({ workItem: row.id, orderItem: row.line })),
    };
  };

  /** Today's route: one lifecycle command, with the versions the board read, as this operator. */
  const lifecycleCommand = (command) => {
    const observedAt = new Date().toISOString();
    return as((transaction) =>
      createKitchenWorkLifecycleService({
        ...lifecycle,
        trustedContext: {
          resolveAuthority: async () => ({
            actorReference: command.actorReference,
            ...scope,
            observedAt,
          }),
        },
        correlationContext: {
          resolve: async () => ({ correlationReference: command.correlationReference }),
        },
        authorization: { authorize: async () => true },
        transactions: { withTransaction: (work) => work(transaction) },
        clock: { now: () => observedAt },
        repository: createPostgresKitchenWorkLifecycleStore({
          ...lifecycle,
          ...scope,
          authorize: async () => true,
          validateCurrentSource: async () => true,
        }),
      }).execute(command),
    );
  };

  /**
   * One tap as apps/api composes it: the closed body, its chunks, each chunk its own restricted-role
   * transaction. `onQuery` sees every statement of a chunk (for hold-time measurements).
   */
  const tap = async ({
    step,
    lines,
    actor,
    correlationReference = next(),
    validateTicketSource = async () => true,
    comboChoices = async () => new Map(),
    onChunk,
    now = () => new Date().toISOString(),
  }) => {
    const body = parseKitchenWorkStepBody({
      step,
      storeReference: store,
      correlationReference,
      lines: lines.map((line) => ({
        idempotencyKey: line.key ?? next(),
        ticketReference: line.ticket,
        workItemReference: line.workItem,
        orderItemReference: line.orderItem,
        optionReferences: line.options ?? null,
      })),
    });
    const results = [];
    let occurredAt = null;
    const tapTickets = [...new Set(body.lines.map((line) => line.ticketReference))];
    for (const chunk of chunkKitchenWorkStepLines(body.lines)) {
      const startedAt = performance.now();
      let firstAuditAt = null;
      const out = await as((raw) => {
        const transaction = {
          query: (sql, values) => {
            if (firstAuditAt === null && sql.includes("audit_chain_head"))
              firstAuditAt = performance.now();
            return raw.query(sql, values);
          },
        };
        return runKitchenWorkStepChunk(
          {
            ...lifecycle,
            ...scope,
            actorReference: actor,
            now,
            guard: async () => true,
            validateTicketSource,
            comboChoices,
          },
          { transaction, step, correlationReference, tapTickets, lines: chunk },
        );
      });
      onChunk?.({
        lines: chunk.length,
        totalMs: performance.now() - startedAt,
        auditHeadHeldMs: firstAuditAt === null ? 0 : performance.now() - firstAuditAt,
      });
      occurredAt = out.occurredAt;
      results.push(...out.lines);
    }
    return { occurredAt, lines: results };
  };

  const lock = (transaction) =>
    transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      brand + ":" + store + ":kitchen_work_queue_v1",
    ]);
  /**
   * The instant the trusted context answers for a board read. A read sends the same instant it
   * was asked at, so a test sets it once instead of two clocks racing to the same millisecond.
   */
  const query = { observedAt: null };
  /** The queue read model with the pilot composition's bounds. */
  const board = (source = {}) =>
    createPostgresKitchenQueueReadModel({
      source: {
        ...scope,
        maxTickets: 100,
        maxItemsPerTicket: 100,
        maxOperationsPerTicket: 1000,
        retireFinishedAfterMs: 24 * 3_600_000,
        creationValidation: validation,
        lifecycleValidation: validation,
        nextSnapshotReference: next,
        authorize: async () => true,
        ...source,
      },
      maxRows: 10000,
      nextRebuildReference: next,
      authorizeProjection: async () => true,
      authorizeQuery: async () => true,
      ports: {
        authorization: { authorize: async () => true },
        trustedContext: {
          resolveQueryAuthority: async () => ({
            ...scope,
            actorReference: id(0x600),
            observedAt: query.observedAt ?? new Date().toISOString(),
          }),
        },
        transactions: {
          withTransaction: (work) =>
            as(async (transaction) => {
              await lock(transaction);
              return work(transaction);
            }),
        },
        tenantContext: { install: async () => undefined },
        locks: { acquireStoreProjection: ({ transaction }) => lock(transaction) },
        references: { nextGenerationReference: next },
        clock: { now: () => new Date().toISOString() },
      },
    });

  const rows = async (sql, values = []) => (await admin.query(sql, values)).rows;
  /** Whether some session waits for a lock (a deterministic barrier, never a sleep). */
  const someoneWaits = async (test = () => true) => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const waiting = await rows(
        "SELECT a.query FROM pg_stat_activity a WHERE a.datname=current_database() AND a.wait_event_type='Lock' AND a.pid<>pg_backend_pid()",
      );
      if (waiting.some(test)) return true;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return false;
  };
  const close = async () => {
    await admin.query("RESET ROLE").catch(() => undefined);
    for (const name of [api, worker]) {
      await admin.query("DROP OWNED BY " + name).catch(() => undefined);
      await admin.query("DROP ROLE IF EXISTS " + name).catch(() => undefined);
    }
    await admin.end().catch(() => undefined);
  };
  const connect = async () => {
    const client = new Client(context.clientConfig);
    await client.connect();
    return client;
  };
  return {
    admin,
    api,
    as,
    board,
    query,
    brand,
    close,
    connect,
    createTicket,
    id,
    lifecycle,
    lifecycleCommand,
    next,
    references,
    rows,
    scope,
    sha256,
    someoneWaits,
    store,
    tap,
    tenant,
    validation,
  };
}

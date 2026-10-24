import {
  createDiningTable,
  parseDiningSession,
  parseDiningParticipant,
  prepareDiningCheckoutCommitment,
  createPostgresDiningCheckoutCommitmentStore,
} from "../../rms/dining/src/index.ts";
import { diningOrderCapacityLinkFromHistory } from "../../../apps/api/src/customer-dining-checkout-composition.ts";

// Synthetic occupied table/session; commitment is written through the real owner.
export async function seedAdditionalDiningCommitment(client, f, scope) {
  const id = (n) => "01909993-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const r = f.request.record,
    b = r.order.batches[0],
    e = f.request.checkoutValidationEvidence;
  const at = e.fulfillment.checkedAt;
  const session = parseDiningSession({
    diningSessionReference: r.order.diningSessionReference,
    ...f.scope,
    tableReference: id(1),
    tableAssignmentVersion: 1,
    phase: "Active",
    version: 2,
    startedByActorReference: r.guestSessionReference,
    startedAt: new Date(Date.parse(at) - 60000).toISOString(),
    hostParticipantReference: f.cart.items[0].addedByParticipantReference,
  });
  const participant = parseDiningParticipant({
    participantReference: session.hostParticipantReference,
    diningSessionReference: session.diningSessionReference,
    status: "Active",
    version: 1,
    joinedAt: session.startedAt,
    leftAt: null,
  });
  const table = createDiningTable({
    ...scope,
    tableReference: id(1),
    stableLabel: "SYNTHETIC-ADDITIONAL",
    areaReference: id(2),
    areaCode: "ROOM",
    capacity: 4,
    accessibilityAttributes: [],
    lifecycle: "Published",
    qrStatus: "Active",
    qrVersion: 1,
    operationalState: "Available",
    blockReasonCode: null,
    activeDiningSessionReference: session.diningSessionReference,
    aggregateVersion: 1,
    createdAt: session.startedAt,
    observedAt: session.startedAt,
  });
  await client.query(
    "INSERT INTO rms_dining.dining_table (table_id,tenant_id,brand_id,store_id,version,table_snapshot,created_at,observed_at) VALUES ($1,$2,$3,$4,1,$5::jsonb,$6,$6)",
    [
      table.tableReference,
      scope.tenantReference,
      scope.brandReference,
      scope.storeReference,
      JSON.stringify(table),
      table.createdAt,
    ],
  );
  await client.query(
    "INSERT INTO rms_dining.dining_session (session_id,tenant_id,brand_id,store_id,table_id,version,phase,session_snapshot,started_at) VALUES ($1,$2,$3,$4,$5,2,'Active',$6::jsonb,$7)",
    [
      session.diningSessionReference,
      scope.tenantReference,
      scope.brandReference,
      scope.storeReference,
      table.tableReference,
      JSON.stringify(session),
      session.startedAt,
    ],
  );
  await client.query(
    "INSERT INTO rms_dining.dining_participant (participant_id,tenant_id,brand_id,store_id,session_id,version,status,participant_snapshot) VALUES ($1,$2,$3,$4,$5,1,'Active',$6::jsonb)",
    [
      participant.participantReference,
      scope.tenantReference,
      scope.brandReference,
      scope.storeReference,
      session.diningSessionReference,
      JSON.stringify(participant),
    ],
  );
  const prepared = prepareDiningCheckoutCommitment(
    {
      commitmentReference: e.fulfillment.evidenceReference,
      ...f.scope,
      diningSessionReference: session.diningSessionReference,
      sessionVersion: 2,
      tableReference: table.tableReference,
      tableAssignmentVersion: 1,
      participantReference: participant.participantReference,
      participantVersion: 1,
      guestSessionReference: r.guestSessionReference,
      cartReference: b.sourceCartReference,
      cartVersion: b.sourceCartVersion,
      quoteReference: b.quoteReference,
      submissionReference: b.submissionReference,
      orderReference: r.order.orderReference,
      orderBatchReference: b.orderBatchReference,
      paymentOperationReference: r.order.orderReference.slice(0, -12) + "000000000700",
      intentHash: "a".repeat(64),
      preparedAt: at,
      preparationValidUntil: e.fulfillment.validUntil,
    },
    { session, participant },
  );
  let sequence = 100;
  const audit = (record) => ({
    auditId: id(++sequence),
    brandId: scope.brandReference,
    storeId: scope.storeReference,
    actor: { type: "System" },
    actionCode: record.state === "Prepared" ? "DINING_CHECKOUT_PREPARE" : "DINING_CHECKOUT_SEAL",
    targetType: "DiningCheckoutCommitment",
    targetId: record.commitmentReference,
    reasonCode: "AUTHORIZED_DINING_CHECKOUT",
    correlationId: id(3),
    occurredAt: record.orderingLinkedAt ?? record.preparedAt,
    sourceChannel: "CUSTOMER_PWA",
    dataClassification: "Restricted",
    retentionPolicyCode: "AUDIT_DEFAULT",
    retentionPolicyVersion: 1,
  });
  const runner = {
    async run(work) {
      await client.query("BEGIN");
      try {
        const result = await work({ query: (sql, values) => client.query(sql, values) });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    },
  };
  const owner = createPostgresDiningCheckoutCommitmentStore(runner, scope, { now: () => at });
  await owner.append({ record: prepared, expectedVersion: 0, audit: audit(prepared) });
  return { link: diningOrderCapacityLinkFromHistory(prepared), audit, session, participant, table };
}

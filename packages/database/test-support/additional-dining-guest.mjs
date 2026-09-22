import assert from "node:assert/strict";
import {
  createGuestSessionCredentialProvider,
  createGuestSessionRecord,
  createPostgresGuestSessionEntryStore,
} from "../../bop/identity/src/index.ts";
import {
  createPostgresDiningGuestBindingStore,
  createDiningGuestBindingQuery,
  parseDiningIdentityAdmission,
  parseQrTableContextEvidence,
} from "../../rms/dining/src/index.ts";
import {
  createPostgresPaymentTipSelectionStore,
  parsePaymentTipSelection,
} from "../../rms/payment/src/index.ts";

export async function seedAdditionalDiningGuest({ client, runner, f, dining, at }) {
  const id = (n) => "01909992-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const credentials = createGuestSessionCredentialProvider(new Uint8Array(32).fill(9));
  const sessionCredential = credentials.generateCredential("Session");
  const csrfCredential = credentials.generateCredential("Csrf");
  const parentCredential = credentials.generateCredential("Session");
  const parentCsrf = credentials.generateCredential("Csrf");
  const before = new Date(Date.parse(at) - 30000).toISOString();
  const base = {
    sessionReference: id(1),
    status: "Active",
    version: 1,
    ...f.scope,
    publicStoreReference: id(2),
    publicTableReference: id(3),
    channel: "DineIn",
    locale: "en-CA",
    qrReference: id(4),
    qrRevocationVersion: 1,
    diningState: "ContextOnly",
    diningSessionReference: null,
    diningParticipantReference: null,
    createdAt: before,
    lastSeenAt: before,
    idleExpiresAt: new Date(Date.parse(before) + 14400000).toISOString(),
    absoluteExpiresAt: new Date(Date.parse(before) + 86400000).toISOString(),
    orderClosedAt: null,
    closureExpiresAt: null,
    rotatedFromGuestSessionReference: null,
    revocationReason: null,
    revokedAt: null,
  };
  const parent = createGuestSessionRecord({
    session: base,
    sessionSelectorHash: credentials.hashCredential("Session", parentCredential),
    csrfSelectorHash: credentials.hashCredential("Csrf", parentCsrf),
    operationReference: id(5),
    operationIntentHash: credentials.hashOperationIntent("synthetic parent"),
  });
  const owner = createPostgresGuestSessionEntryStore(runner(), f.scope);
  await owner.create({ record: parent });
  const bound = createGuestSessionRecord({
    session: {
      ...base,
      sessionReference: f.request.record.guestSessionReference,
      diningState: "DiningBound",
      diningSessionReference: dining.session.diningSessionReference,
      diningParticipantReference: dining.participant.participantReference,
      rotatedFromGuestSessionReference: base.sessionReference,
      createdAt: at,
      lastSeenAt: at,
      idleExpiresAt: new Date(Date.parse(at) + 14400000).toISOString(),
      absoluteExpiresAt: new Date(Date.parse(at) + 86400000).toISOString(),
    },
    sessionSelectorHash: credentials.hashCredential("Session", sessionCredential),
    csrfSelectorHash: credentials.hashCredential("Csrf", csrfCredential),
    operationReference: id(6),
    operationIntentHash: credentials.hashOperationIntent("synthetic bound"),
  });
  await owner.rotate({
    currentSelectorHash: parent.sessionSelectorHash,
    expectedVersion: 1,
    nextRecord: bound,
    reason: "BindingChanged",
    observedAt: at,
  });
  const admission = parseDiningIdentityAdmission({
    admissionReference: id(7),
    diningSessionReference: dining.session.diningSessionReference,
    participantReference: dining.participant.participantReference,
    storeReference: f.scope.storeReference,
    tableReference: dining.table.tableReference,
    tableAssignmentVersion: 1,
    operationReference: id(8),
    operationIntentHash: "a".repeat(64),
    status: "Consumed",
    version: 2,
    issuedAt: dining.participant.joinedAt,
    consumedAt: before,
  });
  await client.query(
    "INSERT INTO rms_dining.dining_identity_admission (admission_id,tenant_id,brand_id,store_id,session_id,participant_id,version,status,admission_snapshot) VALUES ($1,$2,$3,$4,$5,$6,2,'Consumed',$7::jsonb)",
    [
      admission.admissionReference,
      dining.table.tenantReference,
      f.scope.brandReference,
      f.scope.storeReference,
      admission.diningSessionReference,
      admission.participantReference,
      JSON.stringify(admission),
    ],
  );
  const context = parseQrTableContextEvidence({
    publicStoreReference: base.publicStoreReference,
    publicTableReference: base.publicTableReference,
    ...f.scope,
    tableReference: dining.table.tableReference,
    brandLifecycle: "Active",
    storeLifecycle: "Active",
    tableLifecycle: "Active",
    assignmentState: "Active",
    channel: "DineIn",
    qrState: "Enabled",
    revocationVersion: 1,
    contextEvidenceReference: id(9),
    validUntil: base.idleExpiresAt,
  });
  assert(await owner.resolve(bound.sessionSelectorHash), "bound guest must be persisted");
  const binding = createDiningGuestBindingQuery({
    scope: f.scope,
    now: () => new Date().toISOString(),
    repository: createPostgresDiningGuestBindingStore(runner(), {
      ...f.scope,
      tenantReference: dining.table.tenantReference,
    }),
  });
  assert(
    await binding.resolve({
      purpose: "GuestSessionBinding",
      diningSessionReference: dining.session.diningSessionReference,
      participantReference: dining.participant.participantReference,
      tableReference: dining.table.tableReference,
    }),
    "persisted Dining binding must resolve",
  );
  const b = f.request.record.order.batches[0];
  const selection = parsePaymentTipSelection({
    selectionReference: id(10),
    paymentOperationReference: dining.link.paymentOperationReference,
    submissionReference: b.submissionReference,
    cartReference: b.sourceCartReference,
    cartVersion: b.sourceCartVersion,
    quoteReference: b.quoteReference,
    guestSessionReference: bound.session.sessionReference,
    ...f.scope,
    tip: { amountMinor: 0n, currencyCode: "CAD" },
    selectedAt: at,
  });
  await createPostgresPaymentTipSelectionStore(runner(), f.scope, { now: () => at }).append({
    record: selection,
    audit: {
      auditId: id(11),
      brandId: f.scope.brandReference,
      storeId: f.scope.storeReference,
      actor: { type: "System" },
      actionCode: "PAYMENT_TIP_SELECT",
      targetType: "PaymentTipSelection",
      targetId: selection.selectionReference,
      reasonCode: "AUTHORIZED_PAYMENT_TIP_SELECT",
      correlationId: id(12),
      occurredAt: at,
      sourceChannel: "CUSTOMER_PWA",
      dataClassification: "Restricted",
      retentionPolicyCode: "AUDIT_DEFAULT",
      retentionPolicyVersion: 1,
    },
  });
  return {
    sessionCredential,
    csrfCredential,
    wrongCsrf: parentCsrf,
    tipSelectionReference: selection.selectionReference,
    identity: {
      scope: f.scope,
      now: () => new Date().toISOString(),
      session: { credentials, binding: { validate: async () => "Current" } },
      contexts: { resolve: async () => context },
      dining: {},
    },
  };
}

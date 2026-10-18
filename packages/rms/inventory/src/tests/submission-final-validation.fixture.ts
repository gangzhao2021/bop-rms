import { createInventoryReservation } from "../index.js";
const id = (n: number) => "01909997-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-11T10:00:00.000Z";
const unit = {
  unitCode: "KG",
  dimension: "Mass",
  displayPrecision: 2,
  ledgerPrecision: 6,
  roundingMode: "HalfEven",
};
export function finalValidationFixture() {
  const binding = {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    stockSiteReference: id(4),
    locationReference: id(5),
    itemReference: id(6),
    lotReference: null,
    submissionReference: id(7),
    cartReference: id(8),
    cartVersion: 2,
    quoteReference: id(9),
    demandReference: id(10),
    demandDigest: "sha256:" + "a".repeat(64),
  };
  const entry = (n: number, quantity: string) => ({
    accountReference: id(n),
    operationReference: id(n + 1),
    movementReference: id(n + 2),
    auditReference: id(n + 3),
    reservation: createInventoryReservation({
      reservationReference: id(n + 4),
      binding,
      unit,
      quantity,
      occurredAt: at,
    }),
  });
  return {
    schemaVersion: 1,
    validationReference: id(30),
    operationReference: id(31),
    actorReference: id(22),
    auditReference: id(32),
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    orderReference: id(33),
    submissionReference: id(7),
    cartReference: id(8),
    cartVersion: 2,
    quoteReference: id(9),
    demandReference: id(10),
    demandDigest: binding.demandDigest,
    workflowReference: id(23),
    workflowVersionReference: id(34),
    workflowVersion: 1,
    transitionReference: id(35),
    observedAt: at,
    items: [
      {
        itemReference: id(6),
        currentItemVersion: 1,
        configurationOperationReferences: [id(36)],
        unit,
        quantity: "0.3",
        stockTrackingEnabled: true,
        disposition: "Reserved",
        deferredActionCode: null,
      },
    ],
    reservationSet: {
      schemaVersion: 1,
      setReference: id(20),
      operationReference: id(21),
      actorReference: id(22),
      auditReference: id(24),
      workflowReference: id(23),
      workflowVersion: 1,
      requestDigest: "sha256:" + "b".repeat(64),
      entries: [entry(100, "0.1"), entry(200, "0.2")],
    },
  };
}

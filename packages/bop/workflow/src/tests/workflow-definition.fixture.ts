export const id = (n: number) => "01909998-0000-7000-8000-" + n.toString(16).padStart(12, "0");
export const at = "2026-09-11T10:00:00.000Z";
export const definition = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  workflowReference: id(1),
  versionReference: id(2),
  versionNumber: 1,
  tenantReference: id(3),
  brandReference: id(4),
  storeReference: null,
  purposeCode: "OrderFulfillment",
  applicabilityCode: "Pickup",
  lifecycle: "Published",
  baseVersionReference: null,
  overrideAuthorizationReference: null,
  effectiveFrom: at,
  effectiveUntil: null,
  publicationReference: id(5),
  approvalEvidenceReference: id(6),
  authoredByReference: id(7),
  createdAt: at,
  transitions: [
    {
      transitionReference: id(8),
      currentState: "CartReady",
      action: "SubmitOrder",
      nextState: "Submitted",
      permissionCode: "order.submit",
      ruleReferences: [id(9)],
      effects: [{ ownerModule: "inventory", commandCode: "ReserveInventory" }],
    },
  ],
  ...overrides,
});

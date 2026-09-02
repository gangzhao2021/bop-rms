import { describe, expect, it } from "vitest";
import {
  createAmendmentChange,
  createOrderAmendmentService,
  parseAmendmentCode,
  parseAmendmentDigest,
  parseAmendmentReference,
  type OrderAmendmentOperationRecord,
  type OrderAmendmentPorts,
} from "../index.js";
const raw = (n: number) => `018f9b00-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const id = (n: number) => parseAmendmentReference(raw(n));
const refs = {
  operation: id(1),
  amendment: id(2),
  order: id(3),
  tenant: id(4),
  brand: id(5),
  store: id(6),
  actor: id(7),
  quote: id(8),
};
const at = "2026-08-13T21:00:00.000Z";
const hash = (value: string) => {
  let state = 2166136261;
  for (const character of value) state = Math.imul(state ^ character.charCodeAt(0), 16777619);
  return `sha256:${(state >>> 0).toString(16).padStart(8, "0").repeat(8)}`;
};
const change = createAmendmentChange({
  kind: "AddItem",
  targetOrderItemReference: null,
  replacementSnapshotDigest: parseAmendmentDigest(`sha256:${"a".repeat(64)}`),
  quantityDelta: 1,
  noteCode: null,
});
const command = (overrides: Record<string, unknown> = {}) => ({
  action: "Submit" as const,
  operationReference: refs.operation,
  amendmentReference: refs.amendment,
  orderReference: refs.order,
  expectedOrderVersion: 4,
  expectedAmendmentVersion: null,
  reasonCode: "GUEST_REQUEST",
  change,
  occurredAt: at,
  ...overrides,
});
function fixture(options: { denied?: boolean; stale?: boolean; closed?: boolean } = {}) {
  const operations = new Map<string, OrderAmendmentOperationRecord>();
  const records = new Map();
  const events: unknown[] = [];
  const ports: OrderAmendmentPorts = {
    authorization: {
      async authorize(input) {
        if (options.denied) return null;
        return {
          tenantReference: refs.tenant,
          brandReference: refs.brand,
          storeReference: refs.store,
          actorReference: refs.actor,
          purpose: "order-amendment" as const,
          permission: {
            effect: "Allow" as const,
            action: "ordering.order.amend" as const,
            scopeKind: "Store" as const,
          },
          audit: {
            auditId: raw(20),
            brandId: refs.brand,
            storeId: refs.store,
            actor: { type: "User" as const, reference: refs.actor },
            actionCode: `ORDER_AMENDMENT_${input.action.toUpperCase()}`,
            targetType: "OrderAmendment",
            targetId: refs.amendment,
            reasonCode: "AUTHORIZED",
            correlationId: raw(21),
            occurredAt: at,
            sourceChannel: "OPERATIONS_WEB",
            dataClassification: "Internal" as const,
            retentionPolicyCode: "AUDIT_STANDARD",
            retentionPolicyVersion: 1,
          },
        };
      },
    },
    source: {
      async load() {
        return {
          aggregateVersion: options.stale ? 5 : 4,
          canonicalPhase: options.closed ? ("Closed" as const) : ("Accepted" as const),
          closureStatus: options.closed ? ("Closed" as const) : ("Open" as const),
          currencyCode: "CAD",
          totalMinor: "1000",
          targetEligible: true,
        };
      },
    },
    impact: {
      async assess() {
        return {
          kitchenStatus: "NotStarted" as const,
          fulfillmentStatus: "NotStarted" as const,
          approvalRequired: false,
          customerNoticeCode: parseAmendmentCode("NOTICE_REQUIRED"),
        };
      },
    },
    pricing: {
      async reprice() {
        return {
          quoteReference: refs.quote,
          quoteVersion: 2,
          quoteInputDigest: parseAmendmentDigest(`sha256:${"b".repeat(64)}`),
          originalTotalMinor: "1000",
          revisedTotalMinor: "1250",
          currencyCode: "CAD",
        };
      },
    },
    references: { hashIntent: hash, equals: (left, right) => left === right },
    repository: {
      async resolveOperation(reference) {
        return operations.get(reference) ?? null;
      },
      async load(reference) {
        return records.get(reference) ?? null;
      },
      async commit(record) {
        operations.set(record.operationReference, record);
        records.set(record.amendment.amendmentReference, record.amendment);
        if (record.event) events.push(record.event);
      },
    },
  };
  return { service: createOrderAmendmentService(ports), events };
}
describe("Order Amendment service", () => {
  it("reprices and atomically records an immediately applied amendment", async () => {
    const value = fixture();
    const result = await value.service.execute(command());
    expect(result.amendment).toMatchObject({
      status: "Applied",
      deltaMinor: "250",
      currencyCode: "CAD",
    });
    expect(value.events).toEqual([
      expect.objectContaining({ eventType: "OrderAmended", amendmentKind: "AddItem" }),
    ]);
    await expect(value.service.execute(command())).resolves.toMatchObject({
      status: "AlreadyApplied",
    });
  });
  it("fails closed on scope denial, stale version and closed Order", async () => {
    await expect(fixture({ denied: true }).service.execute(command())).rejects.toMatchObject({
      code: "ORDER_AMENDMENT_PERMISSION_DENIED",
    });
    await expect(fixture({ stale: true }).service.execute(command())).rejects.toMatchObject({
      code: "ORDER_AMENDMENT_VERSION_CONFLICT",
    });
    await expect(fixture({ closed: true }).service.execute(command())).rejects.toMatchObject({
      code: "ORDER_AMENDMENT_ORDER_INELIGIBLE",
    });
  });
});

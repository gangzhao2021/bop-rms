import { validateAuditRecord } from "@bop/audit";
import {
  createAmendmentChange,
  createOrderAmendment,
  initialAmendmentStatus,
  parseAmendmentCode,
  parseAmendmentDigest,
  parseAmendmentReference,
  transitionOrderAmendment,
  type AmendmentChange,
  type AmendmentReference,
  type OrderAmendment,
} from "../domain/order-amendment.js";
import type {
  OrderAmendedEvent,
  OrderAmendmentAction,
  OrderAmendmentOperationRecord,
  OrderAmendmentPorts,
} from "./ports/order-amendment-ports.js";

export type OrderAmendmentWorkflowErrorCode =
  | "ORDER_AMENDMENT_INPUT_INVALID"
  | "ORDER_AMENDMENT_PERMISSION_DENIED"
  | "ORDER_AMENDMENT_VERSION_CONFLICT"
  | "ORDER_AMENDMENT_IDEMPOTENCY_CONFLICT"
  | "ORDER_AMENDMENT_ORDER_INELIGIBLE"
  | "ORDER_AMENDMENT_QUOTE_INVALID"
  | "ORDER_AMENDMENT_DEPENDENCY_UNAVAILABLE";
export class OrderAmendmentWorkflowError extends Error {
  constructor(readonly code: OrderAmendmentWorkflowErrorCode) {
    super("Order Amendment operation is unavailable");
    this.name = "OrderAmendmentWorkflowError";
  }
}
const invalid = (): never => {
  throw new OrderAmendmentWorkflowError("ORDER_AMENDMENT_INPUT_INVALID");
};
const positive = (value: unknown) => {
  if (!Number.isSafeInteger(value) || (value as number) < 1) return invalid();
  return value as number;
};
const instant = (value: unknown) => {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    return invalid();
  return value;
};
function dependency(error: unknown): never {
  if (error instanceof OrderAmendmentWorkflowError) throw error;
  throw new OrderAmendmentWorkflowError("ORDER_AMENDMENT_DEPENDENCY_UNAVAILABLE");
}
const expectedPermission = (action: OrderAmendmentAction) =>
  action === "Approve"
    ? "ordering.order.amend.approve"
    : action === "ConfirmKitchen" || action === "RejectKitchen"
      ? "kitchen.amendment.resolve"
      : "ordering.order.amend";

async function authorize(
  ports: OrderAmendmentPorts,
  action: OrderAmendmentAction,
  amendmentReference: AmendmentReference,
  orderReference: AmendmentReference,
  occurredAt: string,
) {
  const evidence = await ports.authorization
    .authorize({ action, amendmentReference, orderReference, observedAt: occurredAt })
    .catch(dependency);
  if (evidence === null) throw new OrderAmendmentWorkflowError("ORDER_AMENDMENT_PERMISSION_DENIED");
  try {
    const audit = validateAuditRecord(evidence.audit, Date.parse(occurredAt));
    if (
      evidence.purpose !== "order-amendment" ||
      evidence.permission.effect !== "Allow" ||
      evidence.permission.action !== expectedPermission(action) ||
      evidence.permission.scopeKind !== "Store" ||
      audit.brandId !== evidence.brandReference ||
      audit.storeId !== evidence.storeReference ||
      audit.actor.type === "System" ||
      audit.actor.reference !== evidence.actorReference ||
      audit.actionCode !== `ORDER_AMENDMENT_${action.toUpperCase()}` ||
      audit.targetType !== "OrderAmendment" ||
      audit.targetId !== amendmentReference ||
      audit.occurredAt !== occurredAt
    )
      throw new Error("denied");
    return { ...evidence, audit };
  } catch {
    throw new OrderAmendmentWorkflowError("ORDER_AMENDMENT_PERMISSION_DENIED");
  }
}
function appliedEvent(amendment: OrderAmendment, occurredAt: string): OrderAmendedEvent | null {
  return amendment.status === "Applied"
    ? Object.freeze({
        eventType: "OrderAmended" as const,
        amendmentReference: amendment.amendmentReference,
        orderReference: amendment.orderReference,
        brandReference: amendment.brandReference,
        storeReference: amendment.storeReference,
        aggregateVersion: amendment.aggregateVersion.toString(),
        amendmentKind: amendment.change.kind,
        quoteReference: amendment.quoteReference,
        quoteVersion: amendment.quoteVersion.toString(),
        deltaMinor: amendment.deltaMinor,
        currencyCode: amendment.currencyCode,
        occurredAt,
      })
    : null;
}
export interface ExecuteOrderAmendmentInput {
  readonly action: OrderAmendmentAction;
  readonly operationReference: AmendmentReference;
  readonly amendmentReference: AmendmentReference;
  readonly orderReference: AmendmentReference;
  readonly expectedOrderVersion: number;
  readonly expectedAmendmentVersion: number | null;
  readonly reasonCode: string | null;
  readonly change: AmendmentChange | null;
  readonly occurredAt: string;
}
export function createOrderAmendmentService(ports: OrderAmendmentPorts) {
  return Object.freeze({
    async execute(input: ExecuteOrderAmendmentInput) {
      if (
        input === null ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.getPrototypeOf(input) !== Object.prototype ||
        Reflect.ownKeys(input).length !== 9 ||
        !["Submit", "ConfirmKitchen", "RejectKitchen", "Approve", "Abort"].includes(input.action)
      )
        invalid();
      const occurredAt = instant(input.occurredAt);
      const operationReference = parseAmendmentReference(input.operationReference);
      const amendmentReference = parseAmendmentReference(input.amendmentReference);
      const orderReference = parseAmendmentReference(input.orderReference);
      const expectedOrderVersion = positive(input.expectedOrderVersion);
      const intent = parseAmendmentDigest(ports.references.hashIntent(JSON.stringify(input)));
      const prior = await ports.repository.resolveOperation(operationReference).catch(dependency);
      if (prior !== null) {
        if (!ports.references.equals(prior.operationIntentHash, intent))
          throw new OrderAmendmentWorkflowError("ORDER_AMENDMENT_IDEMPOTENCY_CONFLICT");
        return Object.freeze({ status: "AlreadyApplied" as const, amendment: prior.amendment });
      }
      const auth = await authorize(
        ports,
        input.action,
        amendmentReference,
        orderReference,
        occurredAt,
      );
      let amendment: OrderAmendment;
      if (input.action === "Submit") {
        if (
          input.expectedAmendmentVersion !== null ||
          input.reasonCode === null ||
          input.change === null
        )
          invalid();
        const reasonCode = parseAmendmentCode(input.reasonCode);
        const change = createAmendmentChange(input.change);
        const source = await ports.source
          .load({
            orderReference,
            brandReference: auth.brandReference,
            storeReference: auth.storeReference,
            change,
          })
          .catch(dependency);
        if (
          source.aggregateVersion !== expectedOrderVersion ||
          source.closureStatus === "Closed" ||
          ["Fulfilled", "Closed"].includes(source.canonicalPhase) ||
          !source.targetEligible
        )
          throw new OrderAmendmentWorkflowError(
            source.aggregateVersion === expectedOrderVersion
              ? "ORDER_AMENDMENT_ORDER_INELIGIBLE"
              : "ORDER_AMENDMENT_VERSION_CONFLICT",
          );
        const [impact, quote] = await Promise.all([
          ports.impact.assess({ orderReference, change, expectedOrderVersion }).catch(dependency),
          ports.pricing
            .reprice({
              orderReference,
              expectedOrderVersion,
              change,
              originalTotalMinor: source.totalMinor,
              currencyCode: source.currencyCode,
            })
            .catch(dependency),
        ]);
        if (
          quote.originalTotalMinor !== source.totalMinor ||
          quote.currencyCode !== source.currencyCode ||
          !/^(?:0|[1-9][0-9]{0,29})$/u.test(source.totalMinor) ||
          !/^(?:0|[1-9][0-9]{0,29})$/u.test(quote.revisedTotalMinor) ||
          !/^[A-Z]{3}$/u.test(source.currencyCode) ||
          !Number.isSafeInteger(quote.quoteVersion) ||
          quote.quoteVersion < 1
        )
          throw new OrderAmendmentWorkflowError("ORDER_AMENDMENT_QUOTE_INVALID");
        const status = initialAmendmentStatus({
          kind: change.kind,
          kitchenStatus: impact.kitchenStatus,
          approvalRequired: impact.approvalRequired,
        });
        amendment = createOrderAmendment({
          amendmentReference,
          orderReference,
          tenantReference: auth.tenantReference,
          brandReference: auth.brandReference,
          storeReference: auth.storeReference,
          requestedByActorReference: auth.actorReference,
          reasonCode,
          change,
          expectedOrderVersion,
          quoteReference: quote.quoteReference,
          quoteVersion: quote.quoteVersion,
          quoteInputDigest: quote.quoteInputDigest,
          currencyCode: quote.currencyCode,
          originalTotalMinor: quote.originalTotalMinor,
          revisedTotalMinor: quote.revisedTotalMinor,
          deltaMinor: (
            BigInt(quote.revisedTotalMinor) - BigInt(quote.originalTotalMinor)
          ).toString(),
          kitchenStatus: impact.kitchenStatus,
          fulfillmentStatus: impact.fulfillmentStatus,
          approvalRequired: impact.approvalRequired,
          customerNoticeCode: impact.customerNoticeCode,
          status,
          aggregateVersion: 1,
          decidedByActorReference: status === "Applied" ? auth.actorReference : null,
          requestedAt: occurredAt,
          decidedAt: status === "Applied" ? occurredAt : null,
        });
      } else {
        if (
          input.reasonCode !== null ||
          input.change !== null ||
          input.expectedAmendmentVersion === null
        )
          invalid();
        const current = await ports.repository.load(amendmentReference).catch(dependency);
        if (
          current === null ||
          current.orderReference !== orderReference ||
          current.expectedOrderVersion !== expectedOrderVersion ||
          current.aggregateVersion !== positive(input.expectedAmendmentVersion)
        )
          throw new OrderAmendmentWorkflowError("ORDER_AMENDMENT_VERSION_CONFLICT");
        if (
          current.tenantReference !== auth.tenantReference ||
          current.brandReference !== auth.brandReference ||
          current.storeReference !== auth.storeReference
        )
          throw new OrderAmendmentWorkflowError("ORDER_AMENDMENT_PERMISSION_DENIED");
        amendment = transitionOrderAmendment(
          current,
          input.action,
          auth.actorReference,
          occurredAt,
        );
      }
      const record: OrderAmendmentOperationRecord = Object.freeze({
        operationReference,
        operationIntentHash: intent,
        amendment,
        audit: auth.audit,
        event: appliedEvent(amendment, occurredAt),
      });
      await ports.repository.commit(record).catch(dependency);
      return Object.freeze({ status: "Applied" as const, amendment });
    },
  });
}

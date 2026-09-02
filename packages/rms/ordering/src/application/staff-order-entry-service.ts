import {
  StaffOrderEntryError,
  type StaffOrderEntryAction,
  type StaffOrderEntryCommand,
  type StaffOrderEntryReceipt,
} from "../contracts/staff-order-entry.js";
import {
  parseOrderingHash,
  parseOrderingInstant,
  parseOrderingReference,
  type OrderingReference,
} from "../domain/cart.js";
import type { StaffOrderEntryPorts } from "./ports/staff-order-entry-ports.js";

const actions = [
  "CreateCart",
  "ConfigureItem",
  "Requote",
  "AttachDiningSession",
  "RecordAllergenReview",
  "Submit",
  "StartTerminalPayment",
] as const;
const contracts = [
  "Ordering.Cart.v1",
  "Pricing.Quote.v1",
  "Dining.SessionEligibility.v1",
  "FoodSafety.AllergenReview.v1",
  "Ordering.Submit.v1",
  "Payment.TerminalStart.v1",
] as const;

function fail(code: StaffOrderEntryError["code"]): never {
  throw new StaffOrderEntryError(code);
}

function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== fields.length ||
      Reflect.ownKeys(value).some((key) => typeof key !== "string" || !fields.includes(key))
    )
      return fail("STAFF_ORDER_ENTRY_INVALID");
    const output: Record<string, unknown> = {};
    for (const field of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
        return fail("STAFF_ORDER_ENTRY_INVALID");
      output[field] = descriptor.value;
    }
    return output;
  } catch (error) {
    if (error instanceof StaffOrderEntryError) throw error;
    return fail("STAFF_ORDER_ENTRY_INVALID");
  }
}

function reference(value: unknown): OrderingReference {
  try {
    return parseOrderingReference(value);
  } catch {
    return fail("STAFF_ORDER_ENTRY_INVALID");
  }
}

function positive(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    return fail("STAFF_ORDER_ENTRY_INVALID");
  return value as number;
}

function payload(action: StaffOrderEntryAction, value: unknown): Readonly<Record<string, unknown>> {
  const fields: Record<StaffOrderEntryAction, readonly string[]> = {
    CreateCart: ["serviceMode"],
    ConfigureItem: [
      "cartReference",
      "expectedCartVersion",
      "sellableReference",
      "configurationReference",
      "quantity",
    ],
    Requote: ["cartReference", "expectedCartVersion", "menuSnapshotReference"],
    AttachDiningSession: ["cartReference", "expectedCartVersion", "diningSessionReference"],
    RecordAllergenReview: [
      "cartReference",
      "expectedCartVersion",
      "configurationDigest",
      "reviewEvidenceReference",
    ],
    Submit: [
      "cartReference",
      "expectedCartVersion",
      "quoteReference",
      "checkoutEvidenceReference",
      "submissionReference",
    ],
    StartTerminalPayment: [
      "orderReference",
      "batchReference",
      "quoteReference",
      "paymentOperationReference",
    ],
  };
  const parsed = exact(value, fields[action]);
  if (action === "CreateCart") {
    if (!["DineIn", "Pickup"].includes(String(parsed.serviceMode)))
      return fail("STAFF_ORDER_ENTRY_INVALID");
  } else {
    for (const [key, item] of Object.entries(parsed)) {
      if (key === "expectedCartVersion" || key === "quantity") positive(item);
      else if (key === "configurationDigest") {
        try {
          parseOrderingHash(item);
        } catch {
          return fail("STAFF_ORDER_ENTRY_INVALID");
        }
      } else reference(item);
    }
  }
  return Object.freeze(parsed);
}

export function parseStaffOrderEntryCommand(value: unknown): StaffOrderEntryCommand {
  const input = exact(value, [
    "tenantReference",
    "brandReference",
    "storeReference",
    "actorReference",
    "purpose",
    "operationReference",
    "observedAt",
    "action",
    "sourceChannel",
    "payload",
  ]);
  if (
    input.purpose !== "StaffOrderEntry" ||
    input.sourceChannel !== "Pos" ||
    typeof input.action !== "string" ||
    !actions.includes(input.action as StaffOrderEntryAction)
  )
    return fail("STAFF_ORDER_ENTRY_INVALID");
  let observedAt;
  try {
    observedAt = parseOrderingInstant(input.observedAt);
  } catch {
    return fail("STAFF_ORDER_ENTRY_INVALID");
  }
  const action = input.action as StaffOrderEntryAction;
  return Object.freeze({
    tenantReference: reference(input.tenantReference),
    brandReference: reference(input.brandReference),
    storeReference: reference(input.storeReference),
    actorReference: reference(input.actorReference),
    purpose: "StaffOrderEntry",
    operationReference: reference(input.operationReference),
    observedAt,
    action,
    sourceChannel: "Pos",
    payload: payload(action, input.payload),
  });
}

function canonicalIntent(command: StaffOrderEntryCommand): string {
  return `StaffOrderEntry:v1:${JSON.stringify(command)}`;
}

function validateReceipt(
  raw: Omit<StaffOrderEntryReceipt, "intentHash" | "auditReference">,
  command: StaffOrderEntryCommand,
): void {
  try {
    if (
      raw.operationReference !== command.operationReference ||
      raw.action !== command.action ||
      !["Applied", "AlreadyApplied"].includes(raw.outcome) ||
      !contracts.includes(raw.sharedContract) ||
      raw.sourceChannel !== "Pos" ||
      raw.createdActorReference !== command.actorReference ||
      (raw.cartVersion !== null && (!Number.isSafeInteger(raw.cartVersion) || raw.cartVersion < 1))
    )
      return fail("STAFF_ORDER_ENTRY_SHARED_CONTRACT_REJECTED");
    for (const value of [
      raw.cartReference,
      raw.quoteReference,
      raw.orderReference,
      raw.batchReference,
      raw.paymentAttemptReference,
      raw.submittedActorReference,
    ])
      if (value !== null) reference(value);
    if (command.action === "Submit") {
      if (
        raw.sharedContract !== "Ordering.Submit.v1" ||
        raw.orderReference === null ||
        raw.batchReference === null ||
        raw.quoteReference === null ||
        raw.submittedActorReference !== command.actorReference ||
        !["ReadyNoReviewRequired", "ReviewCurrent"].includes(raw.allergenReadiness) ||
        raw.terminalStatus !== "NotStarted"
      )
        return fail(
          !["ReadyNoReviewRequired", "ReviewCurrent"].includes(raw.allergenReadiness)
            ? "STAFF_ORDER_ENTRY_ALLERGEN_REVIEW_REQUIRED"
            : "STAFF_ORDER_ENTRY_SHARED_CONTRACT_REJECTED",
        );
    } else if (command.action === "StartTerminalPayment") {
      if (
        raw.sharedContract !== "Payment.TerminalStart.v1" ||
        raw.paymentAttemptReference === null ||
        raw.terminalStatus !== "Pending" ||
        raw.submittedActorReference !== null
      )
        return fail("STAFF_ORDER_ENTRY_SHARED_CONTRACT_REJECTED");
    } else if (raw.terminalStatus !== "NotStarted" || raw.submittedActorReference !== null) {
      return fail("STAFF_ORDER_ENTRY_SHARED_CONTRACT_REJECTED");
    }
  } catch (error) {
    if (error instanceof StaffOrderEntryError) throw error;
    return fail("STAFF_ORDER_ENTRY_SHARED_CONTRACT_REJECTED");
  }
}

export async function executeStaffOrderEntry(
  value: unknown,
  ports: StaffOrderEntryPorts,
): Promise<StaffOrderEntryReceipt> {
  const command = parseStaffOrderEntryCommand(value);
  let authorization;
  try {
    authorization = await ports.authorization.authorize({
      tenantReference: command.tenantReference,
      brandReference: command.brandReference,
      storeReference: command.storeReference,
      actorReference: command.actorReference,
      purpose: "StaffOrderEntry",
      action: command.action,
      requiredPermissions: ["ordering.operate", "ordering.order.create_staff"],
    });
  } catch {
    return fail("STAFF_ORDER_ENTRY_DEPENDENCY_UNAVAILABLE");
  }
  if (!authorization?.authorized) return fail("STAFF_ORDER_ENTRY_PERMISSION_DENIED");
  try {
    reference(authorization.auditReference);
    const intentHash = parseOrderingHash(ports.references.hashIntent(canonicalIntent(command)));
    const prior = await ports.idempotency.resolve(command.operationReference);
    if (prior) {
      validateReceipt(prior, command);
      reference(prior.auditReference);
      parseOrderingHash(prior.intentHash);
      if (!ports.references.equals(prior.intentHash, intentHash))
        return fail("STAFF_ORDER_ENTRY_IDEMPOTENCY_CONFLICT");
      return prior;
    }
    const shared = await ports.sharedContracts.execute(command);
    validateReceipt(shared, command);
    return await ports.idempotency.commit(
      Object.freeze({ ...shared, intentHash, auditReference: authorization.auditReference }),
    );
  } catch (error) {
    if (error instanceof StaffOrderEntryError) throw error;
    return fail("STAFF_ORDER_ENTRY_DEPENDENCY_UNAVAILABLE");
  }
}

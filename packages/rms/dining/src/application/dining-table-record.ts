import { validateAuditRecord } from "@bop/audit";
import { parseDiningReference, type DiningReference } from "../contracts/dining-session.js";
import { createDiningTable, type DiningTable } from "../domain/dining-table.js";
import type {
  DiningTableAction,
  DiningTableEvent,
  DiningTableOperationRecord,
} from "./ports/dining-table-ports.js";

export type DiningTableWorkflowErrorCode =
  | "DINING_TABLE_INPUT_INVALID"
  | "DINING_TABLE_PERMISSION_DENIED"
  | "DINING_TABLE_VERSION_CONFLICT"
  | "DINING_TABLE_IDEMPOTENCY_CONFLICT"
  | "DINING_TABLE_LIFECYCLE_CONFLICT"
  | "DINING_TABLE_DEPENDENCY_UNAVAILABLE";

export class DiningTableWorkflowError extends Error {
  constructor(readonly code: DiningTableWorkflowErrorCode) {
    super("Dining Table operation is unavailable");
    this.name = "DiningTableWorkflowError";
  }
}

export const dependency = (): never => {
  throw new DiningTableWorkflowError("DINING_TABLE_DEPENDENCY_UNAVAILABLE");
};
export const actions = new Set<DiningTableAction>([
  "CreateDraft",
  "ReplaceDraft",
  "Publish",
  "IssueQr",
  "RevokeQr",
  "SetBlock",
  "ClearBlock",
]);
const eventType: Record<DiningTableAction, DiningTableEvent["eventType"]> = {
  CreateDraft: "DiningTableDrafted",
  ReplaceDraft: "DiningTableDrafted",
  Publish: "DiningTableConfigurationPublished",
  IssueQr: "DiningTableQrLifecycleChanged",
  RevokeQr: "DiningTableQrLifecycleChanged",
  SetBlock: "DiningTableOperationalStateChanged",
  ClearBlock: "DiningTableOperationalStateChanged",
};

export function closed(value: unknown, keys: readonly string[]) {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== keys.length ||
      Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key))
    )
      throw new Error("invalid");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
        throw new Error("invalid");
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    throw new DiningTableWorkflowError("DINING_TABLE_INPUT_INVALID");
  }
}

export function parseState<T>(parse: () => T): T {
  try {
    return parse();
  } catch {
    return dependency();
  }
}

export function event(action: DiningTableAction, table: DiningTable): DiningTableEvent {
  return Object.freeze({
    eventType: eventType[action],
    tableReference: table.tableReference,
    aggregateVersion: table.aggregateVersion.toString(),
    lifecycle: table.lifecycle,
    qrStatus: table.qrStatus,
    operationalState: table.operationalState,
    occurredAt: table.observedAt,
  });
}

// Snapshot dependency data before invoking any later port. Descriptors never execute accessors.
export function snapshot(value: unknown): unknown {
  let nodes = 0;
  const copy = (input: unknown, depth: number): unknown => {
    if (++nodes > 20_000 || depth > 12) return dependency();
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "string" && input.length <= 65_536) return input;
    if (typeof input === "number" && Number.isFinite(input)) return input;
    if (typeof input !== "object" || input === null) return dependency();
    const array = Array.isArray(input);
    if (Object.getPrototypeOf(input) !== (array ? Array.prototype : Object.prototype))
      return dependency();
    const keys = Reflect.ownKeys(input);
    if (keys.length > 10_000) return dependency();
    if (array) {
      const length = Object.getOwnPropertyDescriptor(input, "length")?.value;
      if (!Number.isSafeInteger(length) || length < 0 || keys.length !== length + 1)
        return dependency();
      const result: unknown[] = [];
      for (let index = 0; index < length; index++) {
        const field = Object.getOwnPropertyDescriptor(input, String(index));
        if (!field?.enumerable || !("value" in field)) return dependency();
        result.push(copy(field.value, depth + 1));
      }
      return Object.freeze(result);
    }
    return Object.freeze(
      Object.fromEntries(
        keys.map((key) => {
          const field = Object.getOwnPropertyDescriptor(input, key);
          if (typeof key !== "string" || !field?.enumerable || !("value" in field))
            return dependency();
          return [key, copy(field.value, depth + 1)];
        }),
      ),
    );
  };
  return copy(value, 0);
}

export function recordInput(
  value: unknown,
  keys: readonly string[],
  operationReference: DiningReference,
): Record<string, unknown> & { operationReference: DiningReference; intentDigest: string } {
  const raw = closed(snapshot(value), keys);
  if (
    parseDiningReference(raw.operationReference) !== operationReference ||
    typeof raw.intentDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(raw.intentDigest)
  )
    return dependency();
  return { ...raw, operationReference, intentDigest: raw.intentDigest };
}

export function diningTableAction(record: DiningTableOperationRecord): DiningTableAction {
  const action = [...actions].find(
    (value) => record.audit.actionCode === `DINING_TABLE_${value.toUpperCase()}`,
  );
  if (!action) return dependency();
  return action;
}

export function diningTableCommandIntent(
  action: DiningTableAction,
  operationReference: DiningReference,
  expectedAggregateVersion: number | null,
  candidate: DiningTable,
  observedAt: string,
): string {
  return JSON.stringify({
    action,
    operationReference,
    expectedAggregateVersion,
    candidate,
    observedAt,
  });
}

export function parseDiningTableOperationRecord(value: unknown): DiningTableOperationRecord {
  return parseState(() => {
    const input = closed(snapshot(value), [
      "operationReference",
      "intentDigest",
      "table",
      "audit",
      "event",
    ]);
    const raw = recordInput(
      input,
      Object.keys(input),
      parseDiningReference(input.operationReference),
    );
    const table = createDiningTable(raw.table);
    const audit = validateAuditRecord(raw.audit, Date.parse(table.observedAt));
    const action = [...actions].find(
      (value) => audit.actionCode === `DINING_TABLE_${value.toUpperCase()}`,
    );
    if (
      !action ||
      table.observedAt < table.createdAt ||
      audit.brandId !== table.brandReference ||
      audit.storeId !== table.storeReference ||
      audit.targetType !== "DiningTable" ||
      audit.targetId !== table.tableReference ||
      audit.occurredAt !== table.observedAt ||
      audit.actor.type !== "User"
    )
      return dependency();
    parseDiningReference(audit.actor.reference);
    const expectedEvent = event(action, table);
    const suppliedEvent = closed(raw.event, Object.keys(expectedEvent));
    if (
      JSON.stringify(suppliedEvent) !== JSON.stringify(expectedEvent) ||
      (action === "CreateDraft" && (table.aggregateVersion !== 1 || table.lifecycle !== "Draft")) ||
      (action !== "CreateDraft" && table.aggregateVersion < 2) ||
      (action === "ReplaceDraft" && table.lifecycle !== "Draft") ||
      (action === "Publish" &&
        (table.lifecycle !== "Published" || table.qrStatus !== "Inactive")) ||
      (action === "IssueQr" && table.qrStatus !== "Active") ||
      (action === "RevokeQr" && table.qrStatus !== "Revoked") ||
      (action === "SetBlock" && table.operationalState !== "TemporarilyBlocked") ||
      (action === "ClearBlock" && table.operationalState !== "Available")
    )
      return dependency();
    return Object.freeze({
      operationReference: raw.operationReference,
      intentDigest: raw.intentDigest,
      table,
      audit,
      event: expectedEvent,
    });
  });
}

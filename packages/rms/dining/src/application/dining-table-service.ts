import { validateAuditRecord } from "@bop/audit";
import {
  parseDiningInstant,
  parseDiningReference,
  parseDiningSession,
  type DiningReference,
} from "../contracts/dining-session.js";
import {
  createDiningTable,
  moveActiveDiningSession,
  replaceDiningTableDraft,
  transitionDiningTable,
  type DiningTable,
  type DiningTableCode,
} from "../domain/dining-table.js";
import type {
  DiningSessionMoveRecord,
  DiningTableAction,
  DiningTableAuthorizationEvidence,
  DiningTableEvent,
  DiningTableOperationRecord,
  DiningTablePorts,
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

const dependency = (): never => {
  throw new DiningTableWorkflowError("DINING_TABLE_DEPENDENCY_UNAVAILABLE");
};
const actions = new Set<DiningTableAction>([
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

function closed(value: unknown, keys: readonly string[]) {
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

function parseInput<T>(parse: () => T): T {
  try {
    return parse();
  } catch {
    throw new DiningTableWorkflowError("DINING_TABLE_INPUT_INVALID");
  }
}

function parseState<T>(parse: () => T): T {
  try {
    return parse();
  } catch {
    return dependency();
  }
}

function authorize(
  evidence: DiningTableAuthorizationEvidence | null,
  expected: {
    readonly action: DiningTableAction | "MoveSession";
    readonly targetReference: DiningReference;
    readonly tenantReference?: DiningReference;
    readonly brandReference?: DiningReference;
    readonly storeReference?: DiningReference;
    readonly observedAt: string;
    readonly targetType: "DiningTable" | "DiningSession";
  },
) {
  try {
    if (evidence === null) throw new Error("denied");
    const audit = validateAuditRecord(evidence.audit, Date.parse(expected.observedAt));
    const permission = "dining.operate";
    if (
      evidence.purpose !== "dining-table" ||
      evidence.permission.effect !== "Allow" ||
      evidence.permission.action !== permission ||
      evidence.permission.scopeKind !== "Store" ||
      (expected.tenantReference !== undefined &&
        evidence.tenantReference !== expected.tenantReference) ||
      (expected.brandReference !== undefined &&
        (evidence.brandReference !== expected.brandReference ||
          audit.brandId !== expected.brandReference)) ||
      (expected.storeReference !== undefined &&
        (evidence.storeReference !== expected.storeReference ||
          audit.storeId !== expected.storeReference)) ||
      audit.actor.type !== "User" ||
      audit.actor.reference !== evidence.actorReference ||
      audit.actionCode !==
        (expected.action === "MoveSession"
          ? "DINING_SESSION_MOVE_TABLE"
          : `DINING_TABLE_${expected.action.toUpperCase()}`) ||
      audit.targetType !== expected.targetType ||
      audit.targetId !== expected.targetReference ||
      audit.occurredAt !== expected.observedAt
    )
      throw new Error("denied");
    return audit;
  } catch {
    throw new DiningTableWorkflowError("DINING_TABLE_PERMISSION_DENIED");
  }
}

function event(action: DiningTableAction, table: DiningTable): DiningTableEvent {
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

function same(value: unknown, expected: unknown) {
  return JSON.stringify(value) === JSON.stringify(expected);
}

export function createDiningTableService(ports: DiningTablePorts) {
  return Object.freeze({
    async executeTable(input: unknown) {
      const raw = closed(input, [
        "action",
        "operationReference",
        "expectedAggregateVersion",
        "candidate",
        "observedAt",
      ]);
      if (typeof raw.action !== "string" || !actions.has(raw.action as DiningTableAction))
        throw new DiningTableWorkflowError("DINING_TABLE_INPUT_INVALID");
      const action = raw.action as DiningTableAction;
      const operationReference = parseInput(() => parseDiningReference(raw.operationReference));
      const candidate = parseInput(() => createDiningTable(raw.candidate));
      const observedAt = parseInput(() => parseDiningInstant(raw.observedAt));
      if (candidate.observedAt !== observedAt)
        throw new DiningTableWorkflowError("DINING_TABLE_INPUT_INVALID");
      if (
        (action === "CreateDraft" && raw.expectedAggregateVersion !== null) ||
        (action !== "CreateDraft" &&
          (!Number.isSafeInteger(raw.expectedAggregateVersion) ||
            (raw.expectedAggregateVersion as number) < 1))
      )
        throw new DiningTableWorkflowError("DINING_TABLE_INPUT_INVALID");
      let intentDigest: string;
      try {
        intentDigest = ports.references.hashIntent(JSON.stringify(raw));
      } catch {
        return dependency();
      }
      if (!/^sha256:[0-9a-f]{64}$/u.test(intentDigest)) return dependency();
      const evidence = await ports.authorization
        .authorize({ action, targetReference: candidate.tableReference, observedAt })
        .catch(dependency);
      const audit = authorize(evidence, {
        action,
        targetReference: candidate.tableReference,
        tenantReference: candidate.tenantReference,
        brandReference: candidate.brandReference,
        storeReference: candidate.storeReference,
        observedAt,
        targetType: "DiningTable",
      });
      const prior = await ports.repository
        .resolveTableOperation(operationReference)
        .catch(dependency);
      if (prior !== null) {
        if (!ports.references.equals(prior.intentDigest, intentDigest))
          throw new DiningTableWorkflowError("DINING_TABLE_IDEMPOTENCY_CONFLICT");
        return Object.freeze({ status: "AlreadyApplied" as const, table: prior.table });
      }
      const loaded = await ports.repository.loadTable(candidate.tableReference).catch(dependency);
      const current = loaded === null ? null : parseState(() => createDiningTable(loaded));
      if (action === "CreateDraft") {
        if (
          raw.expectedAggregateVersion !== null ||
          current !== null ||
          candidate.lifecycle !== "Draft" ||
          candidate.aggregateVersion !== 1
        )
          throw new DiningTableWorkflowError("DINING_TABLE_LIFECYCLE_CONFLICT");
      } else {
        if (
          current === null ||
          !Number.isSafeInteger(raw.expectedAggregateVersion) ||
          raw.expectedAggregateVersion !== current.aggregateVersion
        )
          throw new DiningTableWorkflowError("DINING_TABLE_VERSION_CONFLICT");
        let expected: DiningTable;
        try {
          expected =
            action === "ReplaceDraft"
              ? replaceDiningTableDraft(current, {
                  stableLabel: candidate.stableLabel,
                  areaReference: candidate.areaReference,
                  areaCode: candidate.areaCode,
                  capacity: candidate.capacity,
                  accessibilityAttributes: candidate.accessibilityAttributes,
                  observedAt,
                })
              : transitionDiningTable(
                  current,
                  action,
                  observedAt,
                  action === "SetBlock" ? (candidate.blockReasonCode as DiningTableCode) : null,
                );
        } catch {
          throw new DiningTableWorkflowError("DINING_TABLE_LIFECYCLE_CONFLICT");
        }
        if (!same(candidate, expected))
          throw new DiningTableWorkflowError("DINING_TABLE_LIFECYCLE_CONFLICT");
      }
      const record: DiningTableOperationRecord = Object.freeze({
        operationReference,
        intentDigest,
        table: candidate,
        audit,
        event: event(action, candidate),
      });
      await ports.repository.commitTable(record).catch(dependency);
      return Object.freeze({ status: "Applied" as const, table: candidate });
    },

    async moveSession(input: unknown) {
      const raw = closed(input, [
        "operationReference",
        "diningSessionReference",
        "sourceTableReference",
        "targetTableReference",
        "expectedSessionVersion",
        "expectedSourceTableVersion",
        "expectedTargetTableVersion",
        "partySize",
        "observedAt",
      ]);
      const operationReference = parseInput(() => parseDiningReference(raw.operationReference));
      const sessionReference = parseInput(() => parseDiningReference(raw.diningSessionReference));
      const sourceReference = parseInput(() => parseDiningReference(raw.sourceTableReference));
      const targetReference = parseInput(() => parseDiningReference(raw.targetTableReference));
      const observedAt = parseInput(() => parseDiningInstant(raw.observedAt));
      for (const value of [
        raw.expectedSessionVersion,
        raw.expectedSourceTableVersion,
        raw.expectedTargetTableVersion,
        raw.partySize,
      ])
        if (!Number.isSafeInteger(value) || (value as number) < 1)
          throw new DiningTableWorkflowError("DINING_TABLE_INPUT_INVALID");
      let intentDigest: string;
      try {
        intentDigest = ports.references.hashIntent(JSON.stringify(raw));
      } catch {
        return dependency();
      }
      if (!/^sha256:[0-9a-f]{64}$/u.test(intentDigest)) return dependency();
      const evidence = await ports.authorization
        .authorize({ action: "MoveSession", targetReference: sessionReference, observedAt })
        .catch(dependency);
      authorize(evidence, {
        action: "MoveSession",
        targetReference: sessionReference,
        observedAt,
        targetType: "DiningSession",
      });
      const [sessionInput, sourceInput, targetInput] = await Promise.all([
        ports.repository.loadSession(sessionReference).catch(dependency),
        ports.repository.loadTable(sourceReference).catch(dependency),
        ports.repository.loadTable(targetReference).catch(dependency),
      ]);
      if (sessionInput === null || sourceInput === null || targetInput === null)
        throw new DiningTableWorkflowError("DINING_TABLE_VERSION_CONFLICT");
      const session = parseState(() => parseDiningSession(sessionInput));
      const source = parseState(() => createDiningTable(sourceInput));
      const target = parseState(() => createDiningTable(targetInput));
      const audit = authorize(evidence, {
        action: "MoveSession",
        targetReference: sessionReference,
        tenantReference: source.tenantReference,
        brandReference: source.brandReference,
        storeReference: source.storeReference,
        observedAt,
        targetType: "DiningSession",
      });
      const prior = await ports.repository
        .resolveMoveOperation(operationReference)
        .catch(dependency);
      if (prior !== null) {
        if (!ports.references.equals(prior.intentDigest, intentDigest))
          throw new DiningTableWorkflowError("DINING_TABLE_IDEMPOTENCY_CONFLICT");
        return Object.freeze({ status: "AlreadyApplied" as const, result: prior });
      }
      if (
        raw.expectedSessionVersion !== session.version ||
        raw.expectedSourceTableVersion !== source.aggregateVersion ||
        raw.expectedTargetTableVersion !== target.aggregateVersion
      )
        throw new DiningTableWorkflowError("DINING_TABLE_VERSION_CONFLICT");
      let moved;
      try {
        moved = moveActiveDiningSession(
          session,
          source,
          target,
          raw.partySize as number,
          observedAt,
        );
      } catch {
        throw new DiningTableWorkflowError("DINING_TABLE_LIFECYCLE_CONFLICT");
      }
      const record: DiningSessionMoveRecord = Object.freeze({
        operationReference,
        intentDigest,
        ...moved,
        audit,
        event: Object.freeze({
          eventType: "DiningSessionTableMoved",
          diningSessionReference: moved.session.diningSessionReference,
          sourceTableReference: source.tableReference,
          targetTableReference: target.tableReference,
          aggregateVersion: moved.session.version.toString(),
          occurredAt: observedAt,
        }),
      });
      await ports.repository.commitMove(record).catch(dependency);
      return Object.freeze({ status: "Applied" as const, result: record });
    },
  });
}

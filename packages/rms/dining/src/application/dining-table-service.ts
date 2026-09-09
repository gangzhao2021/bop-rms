import { validateAuditRecord, type AppendAuditRecordInput } from "@bop/audit";
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

// Snapshot dependency data before invoking any later port. Descriptors never execute accessors.
function snapshot(value: unknown): unknown {
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

function authorizationSnapshot(value: DiningTableAuthorizationEvidence | null) {
  if (value === null) return null;
  try {
    const raw = closed(snapshot(value), [
      "tenantReference",
      "brandReference",
      "storeReference",
      "actorReference",
      "purpose",
      "permission",
      "audit",
    ]);
    for (const key of ["tenantReference", "brandReference", "storeReference", "actorReference"])
      parseDiningReference(raw[key]);
    closed(raw.permission, ["effect", "action", "scopeKind"]);
    return Object.freeze(raw) as unknown as DiningTableAuthorizationEvidence;
  } catch {
    throw new DiningTableWorkflowError("DINING_TABLE_PERMISSION_DENIED");
  }
}

function historicalAudit(value: unknown, current: AppendAuditRecordInput, at: string) {
  const result = validateAuditRecord(value, Date.parse(at));
  if (
    result.brandId !== current.brandId ||
    result.storeId !== current.storeId ||
    result.actionCode !== current.actionCode ||
    result.targetType !== current.targetType ||
    result.targetId !== current.targetId ||
    result.occurredAt !== at ||
    result.actor.type !== "User" ||
    current.actor.type !== "User" ||
    result.actor.reference !== current.actor.reference
  )
    return dependency();
  return result;
}

function recordInput(
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

export function createDiningTableService(ports: DiningTablePorts) {
  const replayInput = (
    prior: unknown,
    keys: readonly string[],
    operationReference: DiningReference,
    intentDigest: string,
  ) => {
    const record = parseState(() => recordInput(prior, keys, operationReference));
    if (parseState(() => ports.references.equals(record.intentDigest, intentDigest)) !== true)
      throw new DiningTableWorkflowError("DINING_TABLE_IDEMPOTENCY_CONFLICT");
    return record;
  };
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
      const evidence = authorizationSnapshot(
        await ports.authorization
          .authorize({ action, targetReference: candidate.tableReference, observedAt })
          .catch(dependency),
      );
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
        const captured = replayInput(
          prior,
          ["operationReference", "intentDigest", "table", "audit", "event"],
          operationReference,
          intentDigest,
        );
        const record = parseState(() => {
          const raw = captured;
          const table = createDiningTable(raw.table);
          const recordedEvent = closed(raw.event, [
            "eventType",
            "tableReference",
            "aggregateVersion",
            "lifecycle",
            "qrStatus",
            "operationalState",
            "occurredAt",
          ]);
          historicalAudit(raw.audit, audit, table.observedAt);
          if (
            table.tableReference !== candidate.tableReference ||
            table.tenantReference !== candidate.tenantReference ||
            table.brandReference !== candidate.brandReference ||
            table.storeReference !== candidate.storeReference ||
            !same(recordedEvent, event(action, table))
          )
            return dependency();
          return { table, intentDigest: raw.intentDigest };
        });
        if (!same(record.table, candidate)) return dependency();
        return Object.freeze({ status: "AlreadyApplied" as const, table: record.table });
      }
      const loaded = await ports.repository.loadTable(candidate.tableReference).catch(dependency);
      const current =
        loaded === null ? null : parseState(() => createDiningTable(snapshot(loaded)));
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
      const evidence = authorizationSnapshot(
        await ports.authorization
          .authorize({ action: "MoveSession", targetReference: sessionReference, observedAt })
          .catch(dependency),
      );
      authorize(evidence, {
        action: "MoveSession",
        targetReference: sessionReference,
        observedAt,
        targetType: "DiningSession",
      });
      const [sessionInput, sourceInput, targetInput] = await Promise.all([
        ports.repository
          .loadSession(sessionReference)
          .then((value) =>
            value === null ? null : parseState(() => parseDiningSession(snapshot(value))),
          )
          .catch(dependency),
        ports.repository
          .loadTable(sourceReference)
          .then((value) =>
            value === null ? null : parseState(() => createDiningTable(snapshot(value))),
          )
          .catch(dependency),
        ports.repository
          .loadTable(targetReference)
          .then((value) =>
            value === null ? null : parseState(() => createDiningTable(snapshot(value))),
          )
          .catch(dependency),
      ]);
      if (sessionInput === null || sourceInput === null || targetInput === null)
        throw new DiningTableWorkflowError("DINING_TABLE_VERSION_CONFLICT");
      const session = parseState(() => parseDiningSession(sessionInput));
      const source = parseState(() => createDiningTable(sourceInput));
      const target = parseState(() => createDiningTable(targetInput));
      if (
        session.diningSessionReference !== sessionReference ||
        source.tableReference !== sourceReference ||
        target.tableReference !== targetReference ||
        sourceReference === targetReference
      )
        return dependency();
      const audit = authorize(evidence, {
        action: "MoveSession",
        targetReference: sessionReference,
        tenantReference: source.tenantReference,
        brandReference: source.brandReference,
        storeReference: source.storeReference,
        observedAt,
        targetType: "DiningSession",
      });
      const rawInput = raw;
      const prior = await ports.repository
        .resolveMoveOperation(operationReference)
        .catch(dependency);
      if (prior !== null) {
        const captured = replayInput(
          prior,
          [
            "operationReference",
            "intentDigest",
            "session",
            "sourceTable",
            "targetTable",
            "audit",
            "event",
          ],
          operationReference,
          intentDigest,
        );
        const record = parseState((): DiningSessionMoveRecord => {
          const raw = captured;
          const movedSession = parseDiningSession(raw.session);
          const movedSource = createDiningTable(raw.sourceTable);
          const movedTarget = createDiningTable(raw.targetTable);
          const recordedEvent = closed(raw.event, [
            "eventType",
            "diningSessionReference",
            "sourceTableReference",
            "targetTableReference",
            "aggregateVersion",
            "occurredAt",
          ]);
          const expectedEvent = Object.freeze({
            eventType: "DiningSessionTableMoved" as const,
            diningSessionReference: sessionReference,
            sourceTableReference: sourceReference,
            targetTableReference: targetReference,
            aggregateVersion: movedSession.version.toString(),
            occurredAt: observedAt,
          });
          if (
            movedSession.diningSessionReference !== sessionReference ||
            movedSession.tableReference !== targetReference ||
            movedSession.startedAt !== session.startedAt ||
            movedSession.startedByActorReference !== session.startedByActorReference ||
            movedSession.brandReference !== source.brandReference ||
            movedSession.storeReference !== source.storeReference ||
            movedSession.version !== (rawInput.expectedSessionVersion as number) + 1 ||
            movedSession.phase !== "Active" ||
            movedSource.tableReference !== sourceReference ||
            movedTarget.tableReference !== targetReference ||
            [movedSource, movedTarget].some(
              (table) =>
                table.tenantReference !== source.tenantReference ||
                table.brandReference !== source.brandReference ||
                table.storeReference !== source.storeReference ||
                table.observedAt !== observedAt,
            ) ||
            movedSource.aggregateVersion !== (rawInput.expectedSourceTableVersion as number) + 1 ||
            movedTarget.aggregateVersion !== (rawInput.expectedTargetTableVersion as number) + 1 ||
            movedSession.tableAssignmentVersion !== movedTarget.aggregateVersion ||
            movedSource.activeDiningSessionReference !== null ||
            movedTarget.activeDiningSessionReference !== sessionReference ||
            movedTarget.lifecycle !== "Published" ||
            movedTarget.operationalState !== "Available" ||
            movedTarget.capacity < (rawInput.partySize as number) ||
            !same(recordedEvent, expectedEvent)
          )
            return dependency();
          return Object.freeze({
            operationReference,
            intentDigest: raw.intentDigest,
            session: movedSession,
            sourceTable: movedSource,
            targetTable: movedTarget,
            audit: historicalAudit(raw.audit, audit, observedAt),
            event: expectedEvent,
          });
        });
        return Object.freeze({ status: "AlreadyApplied" as const, result: record });
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

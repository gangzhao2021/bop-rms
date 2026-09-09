import {
  parseDiningMoveCommand,
  diningMoveCommandIntent,
  parseDiningSessionMoveRecord,
} from "./dining-move-record.js";
import {
  DiningTableWorkflowError,
  actions,
  closed,
  dependency,
  event,
  parseState,
  recordInput,
  snapshot,
  diningTableCommandIntent,
  parseDiningTableOperationRecord,
} from "./dining-table-record.js";
export { DiningTableWorkflowError } from "./dining-table-record.js";
export type { DiningTableWorkflowErrorCode } from "./dining-table-record.js";
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
  DiningTableOperationRecord,
  DiningTablePorts,
} from "./ports/dining-table-ports.js";

function parseInput<T>(parse: () => T): T {
  try {
    return parse();
  } catch {
    throw new DiningTableWorkflowError("DINING_TABLE_INPUT_INVALID");
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

function same(value: unknown, expected: unknown) {
  return JSON.stringify(value) === JSON.stringify(expected);
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
        intentDigest = ports.references.hashIntent(
          diningTableCommandIntent(
            action,
            operationReference,
            raw.expectedAggregateVersion as number | null,
            candidate,
            observedAt,
          ),
        );
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
        const record = parseDiningTableOperationRecord(captured);
        parseState(() => historicalAudit(record.audit, audit, record.table.observedAt));
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
      await ports.repository.commitTable(record).catch((error: unknown) => {
        if (
          error instanceof DiningTableWorkflowError &&
          ["DINING_TABLE_VERSION_CONFLICT", "DINING_TABLE_IDEMPOTENCY_CONFLICT"].includes(
            error.code,
          )
        )
          throw new DiningTableWorkflowError(error.code);
        return dependency();
      });
      return Object.freeze({ status: "Applied" as const, table: candidate });
    },

    async moveSession(input: unknown) {
      const raw = parseDiningMoveCommand(input);
      const operationReference = raw.operationReference;
      const sessionReference = raw.diningSessionReference;
      const sourceReference = raw.sourceTableReference;
      const targetReference = raw.targetTableReference;
      const observedAt = raw.observedAt;
      const intentDigest = diningMoveCommandIntent(ports.references, raw);
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
      const prior = await ports.repository
        .resolveMoveOperation(operationReference)
        .catch(dependency);
      if (prior !== null) {
        const captured = replayInput(
          prior,
          [
            "command",
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
        const record = parseDiningSessionMoveRecord(captured, ports.references);
        if (
          !same(record.command, raw) ||
          record.session.startedAt !== session.startedAt ||
          record.session.startedByActorReference !== session.startedByActorReference ||
          record.sourceTable.tenantReference !== source.tenantReference ||
          record.sourceTable.brandReference !== source.brandReference ||
          record.sourceTable.storeReference !== source.storeReference
        )
          return dependency();
        parseState(() => historicalAudit(record.audit, audit, observedAt));
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
      const record: DiningSessionMoveRecord = parseDiningSessionMoveRecord(
        {
          command: raw,
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
        },
        ports.references,
      );
      await ports.repository.commitMove(record).catch(dependency);
      return Object.freeze({ status: "Applied" as const, result: record });
    },
  });
}

import { validateAuditRecord } from "@bop/audit";
import {
  parseDiningInstant,
  parseDiningReference,
  parseDiningSession,
} from "../contracts/dining-session.js";
import { createDiningTable } from "../domain/dining-table.js";
import {
  closed,
  dependency,
  DiningTableWorkflowError,
  parseState,
  snapshot,
} from "./dining-table-record.js";
import type {
  DiningSessionMoveCommand,
  DiningSessionMoveRecord,
  DiningTablePorts,
} from "./ports/dining-table-ports.js";

/** Key order preserves the original Move command digest contract. */
export function parseDiningMoveCommand(value: unknown): DiningSessionMoveCommand {
  try {
    const raw = closed(value, [
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
    for (const field of [
      "expectedSessionVersion",
      "expectedSourceTableVersion",
      "expectedTargetTableVersion",
      "partySize",
    ])
      if (!Number.isSafeInteger(raw[field]) || (raw[field] as number) < 1)
        throw new Error("invalid");
    return Object.freeze({
      operationReference: parseDiningReference(raw.operationReference),
      diningSessionReference: parseDiningReference(raw.diningSessionReference),
      sourceTableReference: parseDiningReference(raw.sourceTableReference),
      targetTableReference: parseDiningReference(raw.targetTableReference),
      expectedSessionVersion: raw.expectedSessionVersion as number,
      expectedSourceTableVersion: raw.expectedSourceTableVersion as number,
      expectedTargetTableVersion: raw.expectedTargetTableVersion as number,
      partySize: raw.partySize as number,
      observedAt: parseDiningInstant(raw.observedAt),
    });
  } catch {
    throw new DiningTableWorkflowError("DINING_TABLE_INPUT_INVALID");
  }
}
export function diningMoveCommandIntent(
  hashes: DiningTablePorts["references"],
  value: DiningSessionMoveCommand,
): string {
  return parseState(() => {
    const digest = hashes.hashIntent(JSON.stringify(parseDiningMoveCommand(value)));
    if (typeof digest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(digest)) return dependency();
    return digest;
  });
}

/** Internal complete history parser; callers must still establish current actor/scope authority. */
export function parseDiningSessionMoveRecord(
  value: unknown,
  hashes: DiningTablePorts["references"],
): DiningSessionMoveRecord {
  return parseState(() => {
    const raw = closed(snapshot(value), [
      "command",
      "operationReference",
      "intentDigest",
      "session",
      "sourceTable",
      "targetTable",
      "audit",
      "event",
    ]);
    const command = parseDiningMoveCommand(raw.command);
    const operationReference = parseDiningReference(raw.operationReference);
    const session = parseDiningSession(raw.session);
    const sourceTable = createDiningTable(raw.sourceTable);
    const targetTable = createDiningTable(raw.targetTable);
    const audit = validateAuditRecord(raw.audit, Date.parse(command.observedAt));
    const recordedEvent = closed(raw.event, [
      "eventType",
      "diningSessionReference",
      "sourceTableReference",
      "targetTableReference",
      "aggregateVersion",
      "occurredAt",
    ]);
    const event = Object.freeze({
      eventType: "DiningSessionTableMoved" as const,
      diningSessionReference: command.diningSessionReference,
      sourceTableReference: command.sourceTableReference,
      targetTableReference: command.targetTableReference,
      aggregateVersion: session.version.toString(),
      occurredAt: command.observedAt,
    });
    if (
      typeof raw.intentDigest !== "string" ||
      !/^sha256:[0-9a-f]{64}$/u.test(raw.intentDigest) ||
      hashes.equals(raw.intentDigest, diningMoveCommandIntent(hashes, command)) !== true ||
      operationReference !== command.operationReference ||
      command.sourceTableReference === command.targetTableReference ||
      session.diningSessionReference !== command.diningSessionReference ||
      session.tableReference !== command.targetTableReference ||
      session.phase !== "Active" ||
      session.version !== command.expectedSessionVersion + 1 ||
      session.startedAt > command.observedAt ||
      sourceTable.tableReference !== command.sourceTableReference ||
      targetTable.tableReference !== command.targetTableReference ||
      sourceTable.tenantReference !== targetTable.tenantReference ||
      sourceTable.brandReference !== targetTable.brandReference ||
      sourceTable.storeReference !== targetTable.storeReference ||
      session.brandReference !== sourceTable.brandReference ||
      session.storeReference !== sourceTable.storeReference ||
      sourceTable.aggregateVersion !== command.expectedSourceTableVersion + 1 ||
      targetTable.aggregateVersion !== command.expectedTargetTableVersion + 1 ||
      session.tableAssignmentVersion !== targetTable.aggregateVersion ||
      sourceTable.activeDiningSessionReference !== null ||
      targetTable.activeDiningSessionReference !== session.diningSessionReference ||
      sourceTable.lifecycle !== "Published" ||
      targetTable.lifecycle !== "Published" ||
      targetTable.operationalState !== "Available" ||
      sourceTable.observedAt !== command.observedAt ||
      targetTable.observedAt !== command.observedAt ||
      command.partySize > 1000 ||
      targetTable.capacity < command.partySize ||
      audit.actor.type !== "User" ||
      audit.brandId !== sourceTable.brandReference ||
      audit.storeId !== sourceTable.storeReference ||
      audit.actionCode !== "DINING_SESSION_MOVE_TABLE" ||
      audit.targetType !== "DiningSession" ||
      audit.targetId !== session.diningSessionReference ||
      audit.occurredAt !== command.observedAt ||
      JSON.stringify(recordedEvent) !== JSON.stringify(event)
    )
      return dependency();
    return Object.freeze({
      command,
      operationReference,
      intentDigest: raw.intentDigest,
      session,
      sourceTable,
      targetTable,
      audit,
      event,
    });
  });
}

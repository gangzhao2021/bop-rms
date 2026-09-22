import { canonicalizeRfc8785, validateAuditRecord } from "@bop/audit";
import { createDiningTable, releaseClosedDiningSession } from "../domain/dining-table.js";
import {
  parseDiningReference,
  parseDiningInstant,
  parseDiningSession,
} from "../contracts/dining-session.js";
import {
  exactObject,
  parsePositiveDiningVersion,
  DiningClosingError,
} from "../contracts/dining-closing.js";
import { captureSessionData } from "./dining-session-snapshot.js";
interface Hashes {
  hashIntent(value: string): string;
  equals(left: string, right: string): boolean;
}
const fail = (): never => {
  throw new DiningClosingError("DINING_CLOSING_INPUT_INVALID");
};
export function parseDiningTableReleaseCommand(value: unknown) {
  try {
    const raw = exactObject(captureSessionData(value), [
      "operationReference",
      "diningSessionReference",
      "tableReference",
      "expectedSessionVersion",
      "expectedTableVersion",
      "observedAt",
    ]);
    return Object.freeze({
      operationReference: parseDiningReference(raw.operationReference),
      diningSessionReference: parseDiningReference(raw.diningSessionReference),
      tableReference: parseDiningReference(raw.tableReference),
      expectedSessionVersion: parsePositiveDiningVersion(raw.expectedSessionVersion),
      expectedTableVersion: parsePositiveDiningVersion(raw.expectedTableVersion),
      observedAt: parseDiningInstant(raw.observedAt),
    });
  } catch {
    return fail();
  }
}
/** Exact versioned release history; persisted only with current staff authority. */
export function parseDiningTableReleaseRecord(value: unknown, hashes: Hashes) {
  try {
    const raw = exactObject(captureSessionData(value), [
      "command",
      "intentDigest",
      "session",
      "beforeTable",
      "afterTable",
      "audit",
    ]);
    const command = parseDiningTableReleaseCommand(raw.command),
      session = parseDiningSession(raw.session),
      beforeTable = createDiningTable(raw.beforeTable),
      afterTable = createDiningTable(raw.afterTable),
      audit = validateAuditRecord(raw.audit, Date.parse(command.observedAt));
    const expected = releaseClosedDiningSession(session, beforeTable, command.observedAt);
    const intent = hashes.hashIntent(
      canonicalizeRfc8785({
        tenantReference: beforeTable.tenantReference,
        brandReference: beforeTable.brandReference,
        storeReference: beforeTable.storeReference,
        ...command,
      }),
    );
    if (
      typeof raw.intentDigest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(raw.intentDigest) ||
      !/^sha256:[a-f0-9]{64}$/u.test(intent) ||
      hashes.equals(raw.intentDigest, intent) !== true ||
      session.diningSessionReference !== command.diningSessionReference ||
      session.tableReference !== command.tableReference ||
      session.version !== command.expectedSessionVersion ||
      beforeTable.aggregateVersion !== command.expectedTableVersion ||
      canonicalizeRfc8785(expected) !== canonicalizeRfc8785(afterTable) ||
      audit.actor.type !== "User" ||
      audit.brandId !== beforeTable.brandReference ||
      audit.storeId !== beforeTable.storeReference ||
      audit.targetType !== "DiningTable" ||
      audit.targetId !== command.tableReference ||
      audit.actionCode !== "DINING_TABLE_RELEASED" ||
      audit.correlationId !== command.operationReference ||
      audit.occurredAt !== command.observedAt ||
      audit.sourceChannel !== "MERCHANT_WEB" ||
      audit.dataClassification !== "Restricted"
    )
      return fail();
    return Object.freeze({
      command,
      intentDigest: raw.intentDigest,
      session,
      beforeTable,
      afterTable,
      audit,
    });
  } catch {
    return fail();
  }
}
export type DiningTableReleaseRecord = ReturnType<typeof parseDiningTableReleaseRecord>;

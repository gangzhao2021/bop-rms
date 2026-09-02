import {
  type LotExpiryProjection,
  type LotExpiryQuery,
  type LotHoldCommand,
  type LotHoldCommandRecord,
} from "../contracts/lot-expiry.js";
import {
  InventoryItemError,
  parseInventoryDecimal,
  parseInventoryInstant,
  parseInventoryReference,
  type InventoryReference,
} from "../domain/inventory-item.js";
import {
  createLotHold,
  LotHoldError,
  quarantineLot,
  releaseLot,
  type LotHoldAggregate,
} from "../domain/lot-hold.js";
import type { MovementStockScope } from "../domain/stock-movement.js";
import type { LotExpiryPorts } from "./ports/lot-expiry-ports.js";

const codePattern = /^[A-Z][A-Z0-9_]{0,63}$/u;
const unitPattern = /^[A-Z0-9][A-Z0-9_-]{0,31}$/u;
const safeText = /^[^\p{Cc}\p{Cf}<>{}$]{1,120}$/u;
const cursorPattern = /^[A-Za-z0-9_-]{1,200}$/u;
const datePattern = /^\d{4}-\d{2}-\d{2}$/u;

function fail(code: LotHoldError["code"]): never {
  throw new LotHoldError(code);
}

function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !fields.includes(key))
  )
    return fail("LOT_HOLD_INVALID");
  return value as Record<string, unknown>;
}

function reference(value: unknown): InventoryReference {
  try {
    return parseInventoryReference(value);
  } catch (error) {
    if (error instanceof InventoryItemError) return fail("LOT_HOLD_INVALID");
    throw error;
  }
}

function nullableReference(value: unknown): InventoryReference | null {
  return value === null ? null : reference(value);
}

function instant(value: unknown) {
  try {
    return parseInventoryInstant(value);
  } catch (error) {
    if (error instanceof InventoryItemError) return fail("LOT_HOLD_INVALID");
    throw error;
  }
}

function decimal(value: unknown) {
  try {
    return parseInventoryDecimal(value);
  } catch (error) {
    if (error instanceof InventoryItemError) return fail("LOT_HOLD_INVALID");
    throw error;
  }
}

function oneOf<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) return fail("LOT_HOLD_INVALID");
  return value as T;
}

function controlled(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) return fail("LOT_HOLD_INVALID");
  return value;
}

function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return fail("LOT_HOLD_INVALID");
  return value as number;
}

function date(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    !datePattern.test(value) ||
    Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)) ||
    new Date(Date.parse(`${value}T00:00:00.000Z`)).toISOString().slice(0, 10) !== value
  )
    return fail("LOT_HOLD_INVALID");
  return value;
}

function scope(value: unknown): MovementStockScope {
  const raw = exact(value, ["scopeType", "scopeReference"]);
  return Object.freeze({
    scopeType: oneOf(raw.scopeType, ["Store", "StockSite", "Location"]),
    scopeReference: reference(raw.scopeReference),
  });
}

function sameScope(left: MovementStockScope, right: MovementStockScope): boolean {
  return left.scopeType === right.scopeType && left.scopeReference === right.scopeReference;
}

function command(value: unknown): LotHoldCommand {
  const raw = exact(value, [
    "tenantReference",
    "brandReference",
    "actorReference",
    "purpose",
    "permission",
    "operationReference",
    "occurredAt",
    "action",
    "payload",
  ]);
  if (raw.purpose !== "LotHoldManagement" || raw.permission !== "inventory.manage")
    return fail("LOT_HOLD_INVALID");
  const action = oneOf(raw.action, ["Quarantine", "Release"]);
  const payload = exact(raw.payload, [
    "stockScope",
    "locationReference",
    "itemReference",
    "lotReference",
    "expectedVersion",
    "reasonCode",
    "complianceDecisionReference",
  ]);
  const parsedPayload = Object.freeze({
    stockScope: scope(payload.stockScope),
    locationReference: reference(payload.locationReference),
    itemReference: reference(payload.itemReference),
    lotReference: reference(payload.lotReference),
    expectedVersion: version(payload.expectedVersion),
    reasonCode: controlled(payload.reasonCode, codePattern),
    complianceDecisionReference: reference(payload.complianceDecisionReference),
  });
  return Object.freeze({
    tenantReference: reference(raw.tenantReference),
    brandReference: reference(raw.brandReference),
    actorReference: reference(raw.actorReference),
    purpose: "LotHoldManagement",
    permission: "inventory.manage",
    operationReference: reference(raw.operationReference),
    occurredAt: instant(raw.occurredAt),
    action,
    payload: parsedPayload,
  });
}

function query(value: unknown): LotExpiryQuery {
  const raw = exact(value, [
    "tenantReference",
    "brandReference",
    "actorReference",
    "purpose",
    "permission",
    "stockScope",
    "search",
    "expiryWindow",
    "locationReference",
    "holdStatus",
    "supplierReference",
    "fefoExceptionOnly",
    "selectedLotReference",
    "cursor",
  ]);
  if (
    raw.purpose !== "LotExpiryRead" ||
    raw.permission !== "inventory.manage" ||
    (raw.search !== null &&
      (typeof raw.search !== "string" ||
        raw.search.trim() !== raw.search ||
        raw.search.length > 100 ||
        (raw.search.length > 0 && !safeText.test(raw.search)))) ||
    typeof raw.fefoExceptionOnly !== "boolean" ||
    (raw.selectedLotReference !== null && raw.locationReference === null) ||
    (raw.cursor !== null && (typeof raw.cursor !== "string" || !cursorPattern.test(raw.cursor)))
  )
    return fail("LOT_HOLD_INVALID");
  return Object.freeze({
    tenantReference: reference(raw.tenantReference),
    brandReference: reference(raw.brandReference),
    actorReference: reference(raw.actorReference),
    purpose: "LotExpiryRead",
    permission: "inventory.manage",
    stockScope: scope(raw.stockScope),
    search: raw.search as string | null,
    expiryWindow: oneOf(raw.expiryWindow, ["All", "Expired", "Due7", "Due30", "Due90", "NoExpiry"]),
    locationReference: nullableReference(raw.locationReference),
    holdStatus: oneOf(raw.holdStatus, ["All", "Held", "NotHeld"]),
    supplierReference: nullableReference(raw.supplierReference),
    fefoExceptionOnly: raw.fefoExceptionOnly,
    selectedLotReference: nullableReference(raw.selectedLotReference),
    cursor: raw.cursor as string | null,
  });
}

function validateProjection(
  projection: LotExpiryProjection,
  input: LotExpiryQuery,
  access: {
    readonly mayViewSupplierTrace?: boolean;
    readonly mayOpenComplianceTrace?: boolean;
  },
): void {
  try {
    if (
      projection.projectionName !== "inventory_lot_expiry_v1" ||
      projection.projectionVersion !== 1 ||
      projection.tenantReference !== input.tenantReference ||
      projection.brandReference !== input.brandReference ||
      !sameScope(projection.stockScope, input.stockScope) ||
      !["Current", "Stale", "Rebuilding"].includes(projection.freshness) ||
      typeof projection.partial !== "boolean" ||
      !Array.isArray(projection.rows) ||
      projection.rows.length > 200 ||
      (projection.nextCursor !== null && !cursorPattern.test(projection.nextCursor))
    )
      return fail("LOT_HOLD_INVALID");
    instant(projection.asOfUtc);
    const lots = new Set<string>();
    for (const row of projection.rows) {
      const lotReference = reference(row.lotReference);
      const locationReference = reference(row.locationReference);
      const rowKey = `${lotReference}:${locationReference}`;
      if (lots.has(rowKey)) return fail("LOT_HOLD_INVALID");
      lots.add(rowKey);
      reference(row.itemReference);
      if (
        typeof row.itemName !== "string" ||
        !safeText.test(row.itemName) ||
        typeof row.internalCode !== "string" ||
        !safeText.test(row.internalCode) ||
        (row.barcode !== null &&
          (typeof row.barcode !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(row.barcode))) ||
        typeof row.lotCode !== "string" ||
        !safeText.test(row.lotCode) ||
        typeof row.locationLabel !== "string" ||
        !safeText.test(row.locationLabel) ||
        !unitPattern.test(row.unitCode) ||
        typeof row.fefoException !== "boolean"
      )
        return fail("LOT_HOLD_INVALID");
      date(row.expiryDate);
      instant(row.receivedAt);
      decimal(row.onHand);
      decimal(row.reserved);
      oneOf(row.status, ["Available", "Expired", "Depleted", "Quarantined"]);
      const holdReference = nullableReference(row.holdReference);
      const holdVersion = version(row.holdVersion);
      if (
        (row.status === "Quarantined") !== (holdReference !== null) ||
        (holdReference === null && holdVersion !== 0) ||
        (holdReference !== null && holdVersion < 1)
      )
        return fail("LOT_HOLD_INVALID");
      const supplierReference = nullableReference(row.supplierReference);
      const receiptReference = nullableReference(row.receiptReference);
      if (
        (!access.mayViewSupplierTrace &&
          (supplierReference !== null ||
            row.supplierLabel !== null ||
            receiptReference !== null)) ||
        (supplierReference === null) !== (row.supplierLabel === null) ||
        (row.supplierLabel !== null && !safeText.test(row.supplierLabel))
      )
        return fail("LOT_HOLD_INVALID");
    }
    if (
      (input.selectedLotReference === null) !== (projection.trace === null) ||
      (input.selectedLotReference !== null && input.locationReference === null)
    )
      return fail("LOT_HOLD_INVALID");
    if (projection.trace) {
      if (
        projection.trace.lotReference !== input.selectedLotReference ||
        projection.trace.locationReference !== input.locationReference ||
        !Array.isArray(projection.trace.movementReferences) ||
        projection.trace.movementReferences.length > 500 ||
        (!access.mayOpenComplianceTrace && projection.trace.complianceTraceReference !== null) ||
        (!access.mayViewSupplierTrace &&
          (projection.trace.receiptReference !== null ||
            projection.trace.supplierReference !== null))
      )
        return fail("LOT_HOLD_INVALID");
      reference(projection.trace.locationReference);
      nullableReference(projection.trace.receiptReference);
      nullableReference(projection.trace.supplierReference);
      nullableReference(projection.trace.complianceTraceReference);
      projection.trace.movementReferences.forEach(reference);
      for (const [href, route] of [
        [projection.trace.wasteHref, "/operations/inventory/waste/new"],
        [projection.trace.transferHref, "/operations/inventory/transfers"],
        [projection.trace.countHref, "/operations/inventory/counts"],
      ] as const) {
        if (typeof href !== "string" || !href.startsWith(`${route}?`) || href.includes("#"))
          return fail("LOT_HOLD_INVALID");
      }
    }
  } catch (error) {
    if (error instanceof LotHoldError) throw error;
    return fail("LOT_HOLD_INVALID");
  }
}

export async function queryLotExpiry(value: unknown, ports: LotExpiryPorts) {
  const input = query(value);
  let access;
  try {
    access = await ports.authorization.authorize({
      tenantReference: input.tenantReference,
      brandReference: input.brandReference,
      actorReference: input.actorReference,
      purpose: "LotExpiryRead",
      permission: "inventory.manage",
      action: input.selectedLotReference === null ? "List" : "Trace",
      stockScope: input.stockScope,
    });
  } catch {
    return fail("LOT_HOLD_DEPENDENCY_UNAVAILABLE");
  }
  if (!access?.authorized) return fail("LOT_HOLD_PERMISSION_DENIED");
  if (input.supplierReference !== null && !access.mayViewSupplierTrace)
    return fail("LOT_HOLD_PERMISSION_DENIED");
  try {
    const projection = await ports.projection.query(input);
    validateProjection(projection, input, access);
    return projection;
  } catch (error) {
    if (error instanceof LotHoldError) throw error;
    return fail("LOT_HOLD_DEPENDENCY_UNAVAILABLE");
  }
}

function intent(command: LotHoldCommand): string {
  return JSON.stringify(command);
}

function sameCommand(left: LotHoldCommand, right: LotHoldCommand): boolean {
  return intent(left) === intent(right);
}

function validateSnapshot(
  value: unknown,
  input: LotHoldCommand,
  before: LotHoldAggregate | null,
): {
  readonly stockScope: MovementStockScope;
  readonly locationReference: InventoryReference;
  readonly itemReference: InventoryReference;
  readonly lotReference: InventoryReference;
  readonly expiryDate: string | null;
  readonly onHand: ReturnType<typeof decimal>;
  readonly reserved: ReturnType<typeof decimal>;
  readonly balanceVersion: number;
} {
  const raw = exact(value, [
    "tenantReference",
    "brandReference",
    "stockScope",
    "locationReference",
    "itemReference",
    "lotReference",
    "expiryDate",
    "onHand",
    "reserved",
    "balanceVersion",
    "holdReference",
    "holdVersion",
    "holdStatus",
  ]);
  const payload = input.payload as {
    readonly stockScope: MovementStockScope;
    readonly locationReference: InventoryReference;
    readonly itemReference: InventoryReference;
    readonly lotReference: InventoryReference;
    readonly expectedVersion: number;
  };
  const parsed = {
    stockScope: scope(raw.stockScope),
    locationReference: reference(raw.locationReference),
    itemReference: reference(raw.itemReference),
    lotReference: reference(raw.lotReference),
    expiryDate: date(raw.expiryDate),
    onHand: decimal(raw.onHand),
    reserved: decimal(raw.reserved),
    balanceVersion: version(raw.balanceVersion),
  };
  const holdReference = nullableReference(raw.holdReference);
  const holdVersion = version(raw.holdVersion);
  const holdStatus = oneOf(raw.holdStatus, ["Available", "Quarantined"]);
  if (
    raw.tenantReference !== input.tenantReference ||
    raw.brandReference !== input.brandReference ||
    !sameScope(parsed.stockScope, payload.stockScope) ||
    parsed.locationReference !== payload.locationReference ||
    parsed.itemReference !== payload.itemReference ||
    parsed.lotReference !== payload.lotReference ||
    (before === null &&
      (holdReference !== null || holdVersion !== 0 || holdStatus !== "Available")) ||
    (before !== null &&
      (holdReference !== before.holdReference ||
        holdVersion !== before.aggregateVersion ||
        holdStatus !== before.status ||
        payload.expectedVersion !== before.aggregateVersion))
  )
    return fail("LOT_HOLD_INVALID");
  return parsed;
}

function validateCompliance(value: unknown, input: LotHoldCommand): void {
  const raw = exact(value, [
    "tenantReference",
    "brandReference",
    "stockScope",
    "locationReference",
    "lotReference",
    "decisionReference",
    "decision",
    "status",
    "effectiveAt",
  ]);
  const payload = input.payload as {
    readonly stockScope: MovementStockScope;
    readonly locationReference: InventoryReference;
    readonly lotReference: InventoryReference;
    readonly complianceDecisionReference: InventoryReference;
  };
  if (
    raw.tenantReference !== input.tenantReference ||
    raw.brandReference !== input.brandReference ||
    !sameScope(scope(raw.stockScope), payload.stockScope) ||
    reference(raw.locationReference) !== payload.locationReference ||
    reference(raw.lotReference) !== payload.lotReference ||
    reference(raw.decisionReference) !== payload.complianceDecisionReference ||
    raw.decision !== (input.action === "Quarantine" ? "QuarantineApproved" : "ReleaseApproved") ||
    raw.status !== "Active"
  )
    return fail("LOT_HOLD_INVALID");
  const effectiveAt = instant(raw.effectiveAt);
  if (effectiveAt > input.occurredAt) return fail("LOT_HOLD_INVALID");
}

function validateReplay(
  replay: LotHoldCommandRecord,
  input: LotHoldCommand,
  intentHash: string,
): LotHoldCommandRecord {
  const payload = input.payload as {
    readonly stockScope: MovementStockScope;
    readonly locationReference: InventoryReference;
    readonly itemReference: InventoryReference;
    readonly lotReference: InventoryReference;
  };
  if (
    replay.operationReference !== input.operationReference ||
    replay.intentHash !== intentHash ||
    replay.action !== input.action ||
    !sameCommand(replay.command, input) ||
    replay.hold.tenantReference !== input.tenantReference ||
    replay.hold.brandReference !== input.brandReference ||
    !sameScope(replay.hold.stockScope, payload.stockScope) ||
    replay.hold.locationReference !== payload.locationReference ||
    replay.hold.itemReference !== payload.itemReference ||
    replay.hold.lotReference !== payload.lotReference ||
    !["Applied", "AlreadyApplied"].includes(replay.outcome)
  )
    return fail("LOT_HOLD_DEPENDENCY_UNAVAILABLE");
  return Object.freeze({ ...replay, outcome: "AlreadyApplied" as const });
}

function validateRecord(
  record: LotHoldCommandRecord,
  command: LotHoldCommand,
  intentHash: string,
  hold: LotHoldAggregate,
  audit: LotHoldCommandRecord["audit"],
): LotHoldCommandRecord {
  if (
    record.operationReference !== command.operationReference ||
    record.intentHash !== intentHash ||
    record.action !== command.action ||
    !sameCommand(record.command, command) ||
    record.hold.holdReference !== hold.holdReference ||
    record.hold.aggregateVersion !== hold.aggregateVersion ||
    record.hold.status !== hold.status ||
    record.audit !== audit ||
    !["Applied", "AlreadyApplied"].includes(record.outcome)
  )
    return fail("LOT_HOLD_DEPENDENCY_UNAVAILABLE");
  return record;
}

export async function executeLotHold(value: unknown, ports: LotExpiryPorts) {
  const input = command(value);
  const payload = input.payload as {
    readonly stockScope: MovementStockScope;
    readonly locationReference: InventoryReference;
    readonly itemReference: InventoryReference;
    readonly lotReference: InventoryReference;
    readonly expectedVersion: number;
    readonly reasonCode: string;
    readonly complianceDecisionReference: InventoryReference;
  };
  const intentHash = ports.references.hashIntent(intent(input));
  let access;
  try {
    access = await ports.authorization.authorize({
      tenantReference: input.tenantReference,
      brandReference: input.brandReference,
      actorReference: input.actorReference,
      purpose: "LotHoldManagement",
      permission: "inventory.manage",
      action: input.action,
      stockScope: payload.stockScope,
    });
  } catch {
    return fail("LOT_HOLD_DEPENDENCY_UNAVAILABLE");
  }
  if (!access?.authorized || !access.mayManageHold) return fail("LOT_HOLD_PERMISSION_DENIED");
  try {
    const replay = await ports.repository.resolveOperation(input.operationReference);
    if (replay) {
      if (
        !ports.references.equals(replay.intentHash, intentHash) ||
        !sameCommand(replay.command, input)
      )
        return fail("LOT_HOLD_IDEMPOTENCY_CONFLICT");
      return validateReplay(replay, input, intentHash);
    }
    const before = await ports.repository.load({
      tenantReference: input.tenantReference,
      brandReference: input.brandReference,
      stockScope: payload.stockScope,
      lotReference: payload.lotReference,
      locationReference: payload.locationReference,
    });
    if (input.action === "Release" && before === null) return fail("LOT_HOLD_NOT_FOUND");
    if (
      before &&
      (before.tenantReference !== input.tenantReference ||
        before.brandReference !== input.brandReference ||
        !sameScope(before.stockScope, payload.stockScope) ||
        before.locationReference !== payload.locationReference ||
        before.itemReference !== payload.itemReference ||
        before.lotReference !== payload.lotReference)
    )
      return fail("LOT_HOLD_NOT_FOUND");
    if (before === null && payload.expectedVersion !== 0) return fail("LOT_HOLD_CONFLICT");
    const [snapshotRaw, complianceRaw] = await Promise.all([
      ports.snapshot.inspect(input),
      ports.compliance.resolveDecision(input),
    ]);
    const snapshot = validateSnapshot(snapshotRaw, input, before);
    validateCompliance(complianceRaw, input);
    let after: LotHoldAggregate;
    if (input.action === "Quarantine") {
      after = before
        ? quarantineLot(before, {
            expectedVersion: payload.expectedVersion,
            reasonCode: payload.reasonCode,
            complianceDecisionReference: payload.complianceDecisionReference,
            onHand: snapshot.onHand,
            reserved: snapshot.reserved,
            balanceVersion: snapshot.balanceVersion,
            actorReference: input.actorReference,
            occurredAt: input.occurredAt,
          })
        : createLotHold({
            holdReference: ports.references.generate("LotHold"),
            tenantReference: input.tenantReference,
            brandReference: input.brandReference,
            stockScope: snapshot.stockScope,
            locationReference: snapshot.locationReference,
            itemReference: snapshot.itemReference,
            lotReference: snapshot.lotReference,
            expiryDate: snapshot.expiryDate,
            onHand: snapshot.onHand,
            reserved: snapshot.reserved,
            balanceVersion: snapshot.balanceVersion,
            reasonCode: payload.reasonCode,
            complianceDecisionReference: payload.complianceDecisionReference,
            actorReference: input.actorReference,
            occurredAt: input.occurredAt,
          });
    } else {
      after = releaseLot(before as LotHoldAggregate, {
        expectedVersion: payload.expectedVersion,
        reasonCode: payload.reasonCode,
        complianceDecisionReference: payload.complianceDecisionReference,
        onHand: snapshot.onHand,
        reserved: snapshot.reserved,
        balanceVersion: snapshot.balanceVersion,
        actorReference: input.actorReference,
        occurredAt: input.occurredAt,
      });
    }
    const audit = await ports.audit.create({ command: input, before, after });
    const record: LotHoldCommandRecord = Object.freeze({
      operationReference: input.operationReference,
      intentHash,
      action: input.action,
      command: input,
      hold: after,
      audit,
      outcome: "Applied",
    });
    return validateRecord(await ports.repository.commit(record), input, intentHash, after, audit);
  } catch (error) {
    if (error instanceof LotHoldError) throw error;
    return fail("LOT_HOLD_DEPENDENCY_UNAVAILABLE");
  }
}

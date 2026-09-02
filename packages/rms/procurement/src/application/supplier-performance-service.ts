import type {
  ExactRate,
  SupplierPerformanceCommand,
  SupplierPerformanceProjection,
  SupplierPerformanceQuery,
  SupplierPerformanceRecord,
  SupplierPerformanceRow,
} from "../contracts/supplier-performance.js";
import { offeringReference, type OfferingReference } from "../domain/aggregates/offering.js";
import type { SupplierPerformancePorts } from "./ports/supplier-performance-ports.js";

export class SupplierPerformanceError extends Error {
  constructor(
    readonly code:
      | "SUPPLIER_PERFORMANCE_INVALID"
      | "SUPPLIER_PERFORMANCE_PERMISSION_DENIED"
      | "SUPPLIER_PERFORMANCE_REPLAY_CONFLICT",
  ) {
    super(code);
    this.name = "SupplierPerformanceError";
  }
}
const fail = (code: SupplierPerformanceError["code"]): never => {
  throw new SupplierPerformanceError(code);
};
const exact = (value: unknown, fields: readonly string[]) => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !fields.includes(key))
  )
    return fail("SUPPLIER_PERFORMANCE_INVALID");
  return value as Record<string, unknown>;
};
const ref = (value: unknown) => {
  try {
    return offeringReference(value);
  } catch {
    return fail("SUPPLIER_PERFORMANCE_INVALID");
  }
};
const nullableRef = (value: unknown) => (value === null ? null : ref(value));
const instant = (value: unknown) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
  new Date(Date.parse(value)).toISOString() === value
    ? value
    : fail("SUPPLIER_PERFORMANCE_INVALID");
const text = (value: unknown, max = 200) =>
  typeof value === "string" &&
  value.trim() === value &&
  value.length <= max &&
  /^[^\p{Cc}\p{Cf}<>{}$]+$/u.test(value)
    ? value
    : fail("SUPPLIER_PERFORMANCE_INVALID");
const code = (value: unknown) =>
  typeof value === "string" && /^[A-Z0-9][A-Z0-9_-]{0,63}$/u.test(value)
    ? value
    : fail("SUPPLIER_PERFORMANCE_INVALID");
const decimalPattern = /^-?(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u;
const decimal = (value: unknown) =>
  typeof value === "string" && decimalPattern.test(value)
    ? value
    : fail("SUPPLIER_PERFORMANCE_INVALID");
const nonnegative = (value: unknown) => {
  const parsed = decimal(value);
  return parsed.startsWith("-") ? fail("SUPPLIER_PERFORMANCE_INVALID") : parsed;
};
const SCALE = 1_000_000n;
function units(value: string): bigint {
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = (negative ? value.slice(1) : value).split(".");
  const result =
    BigInt(whole ?? fail("SUPPLIER_PERFORMANCE_INVALID")) * SCALE + BigInt(fraction.padEnd(6, "0"));
  return negative ? -result : result;
}
function render(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / SCALE;
  const fraction = (absolute % SCALE).toString().padStart(6, "0").replace(/0+$/u, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}
function rate(numerator: bigint, denominator: bigint): ExactRate {
  return Object.freeze({
    numerator: render(numerator),
    denominator: render(denominator),
    percent: denominator === 0n ? null : render((numerator * 100n * SCALE) / denominator),
  });
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  return value;
}
export function parseSupplierPerformanceQuery(value: unknown): SupplierPerformanceQuery {
  const raw = exact(value, [
    "tenantReference",
    "brandReference",
    "stockSiteReference",
    "actorReference",
    "purpose",
    "permission",
    "supplierReference",
    "offeringReference",
    "itemCategoryCode",
    "periodFromUtc",
    "periodToUtc",
    "metricThreshold",
  ]);
  if (raw.purpose !== "SupplierPerformanceRead" || raw.permission !== "procurement.manage")
    return fail("SUPPLIER_PERFORMANCE_INVALID");
  const periodFromUtc = instant(raw.periodFromUtc);
  const periodToUtc = instant(raw.periodToUtc);
  if (periodFromUtc >= periodToUtc) return fail("SUPPLIER_PERFORMANCE_INVALID");
  const metricThreshold = raw.metricThreshold === null ? null : nonnegative(raw.metricThreshold);
  if (metricThreshold !== null && units(metricThreshold) > 100n * SCALE)
    return fail("SUPPLIER_PERFORMANCE_INVALID");
  return Object.freeze({
    tenantReference: ref(raw.tenantReference),
    brandReference: ref(raw.brandReference),
    stockSiteReference: nullableRef(raw.stockSiteReference),
    actorReference: ref(raw.actorReference),
    purpose: "SupplierPerformanceRead",
    permission: "procurement.manage",
    supplierReference: nullableRef(raw.supplierReference),
    offeringReference: nullableRef(raw.offeringReference),
    itemCategoryCode: raw.itemCategoryCode === null ? null : code(raw.itemCategoryCode),
    periodFromUtc,
    periodToUtc,
    metricThreshold,
  });
}
interface Fact {
  tenantReference: OfferingReference;
  brandReference: OfferingReference;
  stockSiteReference: OfferingReference;
  supplierReference: OfferingReference;
  supplierSummary: string;
  offeringReference: OfferingReference | null;
  itemCategoryCode: string;
  sourceFactReference: OfferingReference;
  occurredAt: string;
  orderedQuantity: string;
  acceptedQuantity: string;
  receivedQuantity: string;
  onTime: boolean | null;
  acknowledgementResponseSeconds: number | null;
  supplierOutcome: "Accepted" | "Declined" | "Cancelled" | null;
  discrepancyTypes: readonly ("Over" | "Short" | "Rejected" | "Damaged")[];
  priceVarianceAmount: string | null;
  currency: string | null;
  complete: boolean;
}
interface Assessment {
  tenantReference: OfferingReference;
  brandReference: OfferingReference;
  stockSiteReference: OfferingReference;
  supplierReference: OfferingReference;
  assessmentReference: OfferingReference;
  ratingCode: string;
  occurredAt: string;
}
function sourceFact(value: unknown, query: SupplierPerformanceQuery): Fact {
  const raw = exact(value, [
    "tenantReference",
    "brandReference",
    "stockSiteReference",
    "supplierReference",
    "supplierSummary",
    "offeringReference",
    "itemCategoryCode",
    "sourceFactReference",
    "occurredAt",
    "orderedQuantity",
    "acceptedQuantity",
    "receivedQuantity",
    "onTime",
    "acknowledgementResponseSeconds",
    "supplierOutcome",
    "discrepancyTypes",
    "priceVarianceAmount",
    "currency",
    "complete",
  ]);
  if (typeof raw.complete !== "boolean") return fail("SUPPLIER_PERFORMANCE_INVALID");
  const fact = {
    tenantReference: ref(raw.tenantReference),
    brandReference: ref(raw.brandReference),
    stockSiteReference: ref(raw.stockSiteReference),
    supplierReference: ref(raw.supplierReference),
    supplierSummary: text(raw.supplierSummary),
    offeringReference: nullableRef(raw.offeringReference),
    itemCategoryCode: code(raw.itemCategoryCode),
    sourceFactReference: ref(raw.sourceFactReference),
    occurredAt: instant(raw.occurredAt),
    orderedQuantity: nonnegative(raw.orderedQuantity),
    acceptedQuantity: nonnegative(raw.acceptedQuantity),
    receivedQuantity: nonnegative(raw.receivedQuantity),
    onTime:
      raw.onTime === null || typeof raw.onTime === "boolean"
        ? raw.onTime
        : fail("SUPPLIER_PERFORMANCE_INVALID"),
    acknowledgementResponseSeconds:
      raw.acknowledgementResponseSeconds === null ||
      (Number.isSafeInteger(raw.acknowledgementResponseSeconds) &&
        (raw.acknowledgementResponseSeconds as number) >= 0)
        ? (raw.acknowledgementResponseSeconds as number | null)
        : fail("SUPPLIER_PERFORMANCE_INVALID"),
    supplierOutcome:
      raw.supplierOutcome === null ||
      ["Accepted", "Declined", "Cancelled"].includes(raw.supplierOutcome as string)
        ? (raw.supplierOutcome as Fact["supplierOutcome"])
        : fail("SUPPLIER_PERFORMANCE_INVALID"),
    discrepancyTypes:
      Array.isArray(raw.discrepancyTypes) &&
      raw.discrepancyTypes.length <= 4 &&
      raw.discrepancyTypes.every((item) =>
        ["Over", "Short", "Rejected", "Damaged"].includes(item as string),
      )
        ? Object.freeze([...new Set(raw.discrepancyTypes)] as Fact["discrepancyTypes"])
        : fail("SUPPLIER_PERFORMANCE_INVALID"),
    priceVarianceAmount: raw.priceVarianceAmount === null ? null : decimal(raw.priceVarianceAmount),
    currency: raw.currency === null ? null : code(raw.currency),
    complete: raw.complete,
  } satisfies Fact;
  if (
    fact.tenantReference !== query.tenantReference ||
    fact.brandReference !== query.brandReference ||
    (query.stockSiteReference !== null && fact.stockSiteReference !== query.stockSiteReference) ||
    (query.supplierReference !== null && fact.supplierReference !== query.supplierReference) ||
    (query.offeringReference !== null && fact.offeringReference !== query.offeringReference) ||
    (query.itemCategoryCode !== null && fact.itemCategoryCode !== query.itemCategoryCode) ||
    fact.occurredAt < query.periodFromUtc ||
    fact.occurredAt >= query.periodToUtc ||
    (fact.priceVarianceAmount === null) !== (fact.currency === null)
  )
    return fail("SUPPLIER_PERFORMANCE_INVALID");
  return Object.freeze(fact);
}
function sourceAssessment(value: unknown, query: SupplierPerformanceQuery): Assessment {
  const raw = exact(value, [
    "tenantReference",
    "brandReference",
    "stockSiteReference",
    "supplierReference",
    "assessmentReference",
    "ratingCode",
    "occurredAt",
  ]);
  const assessment = Object.freeze({
    tenantReference: ref(raw.tenantReference),
    brandReference: ref(raw.brandReference),
    stockSiteReference: ref(raw.stockSiteReference),
    supplierReference: ref(raw.supplierReference),
    assessmentReference: ref(raw.assessmentReference),
    ratingCode: code(raw.ratingCode),
    occurredAt: instant(raw.occurredAt),
  });
  if (
    assessment.tenantReference !== query.tenantReference ||
    assessment.brandReference !== query.brandReference ||
    (query.stockSiteReference !== null &&
      assessment.stockSiteReference !== query.stockSiteReference) ||
    (query.supplierReference !== null &&
      assessment.supplierReference !== query.supplierReference) ||
    assessment.occurredAt >= query.periodToUtc
  )
    return fail("SUPPLIER_PERFORMANCE_INVALID");
  return assessment;
}
function buildRow(
  facts: readonly Fact[],
  assessments: readonly Assessment[],
  access: NonNullable<Awaited<ReturnType<SupplierPerformancePorts["authorization"]["authorize"]>>>,
): SupplierPerformanceRow {
  let ordered = 0n,
    filled = 0n,
    received = 0n,
    accepted = 0n,
    onTime = 0n,
    onTimeTotal = 0n;
  let ackSeconds = 0n,
    ackCount = 0n,
    declined = 0n,
    outcomeCount = 0n,
    variance = 0n;
  const discrepancy = { Over: 0n, Short: 0n, Rejected: 0n, Damaged: 0n };
  const currencies = new Set<string>();
  let incomplete = 0;
  for (const fact of facts) {
    const orderedUnits = units(fact.orderedQuantity);
    const acceptedUnits = units(fact.acceptedQuantity);
    ordered += orderedUnits;
    filled += acceptedUnits > orderedUnits ? orderedUnits : acceptedUnits;
    received += units(fact.receivedQuantity);
    accepted += acceptedUnits;
    if (fact.onTime !== null) {
      onTimeTotal += SCALE;
      if (fact.onTime) onTime += SCALE;
    }
    if (fact.acknowledgementResponseSeconds !== null) {
      ackSeconds += BigInt(fact.acknowledgementResponseSeconds) * SCALE;
      ackCount += SCALE;
    }
    if (fact.supplierOutcome !== null) {
      outcomeCount += SCALE;
      if (["Declined", "Cancelled"].includes(fact.supplierOutcome)) declined += SCALE;
    }
    for (const type of fact.discrepancyTypes) discrepancy[type] += SCALE;
    if (fact.priceVarianceAmount !== null) {
      variance += units(fact.priceVarianceAmount);
      if (fact.currency === null) return fail("SUPPLIER_PERFORMANCE_INVALID");
      currencies.add(fact.currency);
    }
    if (!fact.complete) incomplete += 1;
  }
  const first = facts[0];
  if (!first) return fail("SUPPLIER_PERFORMANCE_INVALID");
  const singleCurrency = currencies.size === 1 ? [...currencies][0] : null;
  const base = BigInt(facts.length) * SCALE;
  return Object.freeze({
    supplierReference: first.supplierReference,
    supplierSummary: first.supplierSummary,
    offeringReference: first.offeringReference,
    stockSiteReference: first.stockSiteReference,
    onTimeDelivery: rate(onTime, onTimeTotal),
    fillRate: rate(filled, ordered),
    acceptedQuality: rate(accepted, received),
    overFrequency: rate(discrepancy.Over, base),
    shortFrequency: rate(discrepancy.Short, base),
    rejectedFrequency: rate(discrepancy.Rejected, base),
    damagedFrequency: rate(discrepancy.Damaged, base),
    acknowledgementResponseSeconds:
      ackCount === 0n ? null : render(ackSeconds / (ackCount / SCALE)),
    declineCancellationRate: rate(declined, outcomeCount),
    purchasePriceVarianceAmount:
      access.mayViewPriceVariance && currencies.size === 1 ? render(variance) : null,
    currency: access.mayViewPriceVariance ? (singleCurrency ?? null) : null,
    sourceFactCount: facts.length,
    incompleteFactCount: incomplete,
    factReferences: access.mayDrillFacts
      ? Object.freeze(facts.map((fact) => fact.sourceFactReference))
      : null,
    manualAssessments: access.mayViewManualAssessments
      ? Object.freeze(
          assessments.map((item) =>
            Object.freeze({
              assessmentReference: item.assessmentReference,
              ratingCode: item.ratingCode,
              occurredAt: item.occurredAt,
            }),
          ),
        )
      : null,
  });
}
export async function querySupplierPerformance(
  value: unknown,
  ports: SupplierPerformancePorts,
): Promise<SupplierPerformanceProjection> {
  const query = parseSupplierPerformanceQuery(value);
  const access = await ports.authorization.authorize(query);
  if (!access?.authorized) return fail("SUPPLIER_PERFORMANCE_PERMISSION_DENIED");
  const raw = exact(await ports.source.read(query), [
    "asOfUtc",
    "freshness",
    "partial",
    "facts",
    "manualAssessments",
  ]);
  if (
    !["Current", "Stale", "Rebuilding"].includes(raw.freshness as string) ||
    typeof raw.partial !== "boolean" ||
    !Array.isArray(raw.facts) ||
    !Array.isArray(raw.manualAssessments) ||
    raw.facts.length > 10_000
  )
    return fail("SUPPLIER_PERFORMANCE_INVALID");
  const grouped = new Map<string, Fact[]>();
  for (const entry of raw.facts) {
    const fact = sourceFact(entry, query);
    const key = `${fact.supplierReference}:${fact.offeringReference ?? "all"}:${fact.stockSiteReference}`;
    grouped.set(key, [...(grouped.get(key) ?? []), fact]);
  }
  const assessments = (raw.manualAssessments as unknown[]).map((entry) =>
    sourceAssessment(entry, query),
  );
  let rows = [...grouped.values()].map((facts) => {
    const first = facts[0];
    if (!first) return fail("SUPPLIER_PERFORMANCE_INVALID");
    return buildRow(
      facts,
      assessments.filter(
        (item) =>
          item.supplierReference === first.supplierReference &&
          item.stockSiteReference === first.stockSiteReference,
      ),
      access,
    );
  });
  if (query.metricThreshold !== null) {
    const threshold = units(query.metricThreshold);
    rows = rows.filter((row) =>
      [row.onTimeDelivery, row.fillRate, row.acceptedQuality].some(
        (item) => item.percent !== null && units(item.percent) <= threshold,
      ),
    );
  }
  return Object.freeze({
    projectionName: "procurement_supplier_performance_v1",
    projectionVersion: 1,
    definitionVersion: 1,
    tenantReference: query.tenantReference,
    brandReference: query.brandReference,
    periodFromUtc: query.periodFromUtc,
    periodToUtc: query.periodToUtc,
    asOfUtc: instant(raw.asOfUtc),
    freshness: raw.freshness as SupplierPerformanceProjection["freshness"],
    partial: raw.partial,
    mayDrillFacts: access.mayDrillFacts === true,
    mayViewPriceVariance: access.mayViewPriceVariance === true,
    mayViewManualAssessments: access.mayViewManualAssessments === true,
    mayExport: access.mayExport === true,
    mayOpenReviewTask: access.mayOpenReviewTask === true,
    rows: Object.freeze(rows),
  });
}
function parseCommand(value: unknown): SupplierPerformanceCommand {
  const raw = exact(value, [
    "tenantReference",
    "brandReference",
    "stockSiteReference",
    "actorReference",
    "purpose",
    "permission",
    "operationReference",
    "occurredAt",
    "action",
    "payload",
  ]);
  if (
    raw.purpose !== "SupplierPerformanceReview" ||
    raw.permission !== "procurement.manage" ||
    !["OpenReviewTask", "AddManualAssessment"].includes(raw.action as string)
  )
    return fail("SUPPLIER_PERFORMANCE_INVALID");
  const action = raw.action as SupplierPerformanceCommand["action"];
  const payload = exact(
    raw.payload,
    action === "OpenReviewTask"
      ? ["supplierReference", "periodFromUtc", "periodToUtc", "reasonCode"]
      : ["supplierReference", "assessmentReference", "ratingCode", "note"],
  );
  ref(payload.supplierReference);
  if (action === "OpenReviewTask") {
    instant(payload.periodFromUtc);
    instant(payload.periodToUtc);
    code(payload.reasonCode);
  } else {
    ref(payload.assessmentReference);
    code(payload.ratingCode);
    text(payload.note, 500);
  }
  return Object.freeze({
    tenantReference: ref(raw.tenantReference),
    brandReference: ref(raw.brandReference),
    stockSiteReference: ref(raw.stockSiteReference),
    actorReference: ref(raw.actorReference),
    purpose: "SupplierPerformanceReview",
    permission: "procurement.manage",
    operationReference: ref(raw.operationReference),
    occurredAt: instant(raw.occurredAt),
    action,
    payload: Object.freeze(payload),
  });
}
export async function executeSupplierPerformanceReview(
  value: unknown,
  ports: SupplierPerformancePorts,
): Promise<SupplierPerformanceRecord> {
  const command = parseCommand(value);
  const access = await ports.authorization.authorize(command);
  if (!access?.authorized || (command.action === "OpenReviewTask" && !access.mayOpenReviewTask))
    return fail("SUPPLIER_PERFORMANCE_PERMISSION_DENIED");
  const intentHash = ports.references.hashIntent(JSON.stringify(canonical(command)));
  const replay = await ports.repository.resolveOperation(command.operationReference);
  if (replay) {
    if (
      !ports.references.equals(replay.intentHash, intentHash) ||
      replay.command.actorReference !== command.actorReference
    )
      return fail("SUPPLIER_PERFORMANCE_REPLAY_CONFLICT");
    return Object.freeze({ ...replay, outcome: "AlreadyApplied" });
  }
  let collaborationReference: OfferingReference | null = null;
  let assessment: SupplierPerformanceRecord["assessment"] = null;
  if (command.action === "OpenReviewTask") {
    const result = exact(await ports.collaboration.openReviewTask(command), [
      "tenantReference",
      "brandReference",
      "stockSiteReference",
      "supplierReference",
      "taskReference",
    ]);
    if (
      result.tenantReference !== command.tenantReference ||
      result.brandReference !== command.brandReference ||
      result.stockSiteReference !== command.stockSiteReference ||
      result.supplierReference !== command.payload.supplierReference
    )
      return fail("SUPPLIER_PERFORMANCE_INVALID");
    collaborationReference = ref(result.taskReference);
  } else {
    assessment = Object.freeze({
      assessmentReference: ref(command.payload.assessmentReference),
      supplierReference: ref(command.payload.supplierReference),
      ratingCode: code(command.payload.ratingCode),
      note: text(command.payload.note, 500),
      occurredAt: command.occurredAt,
    });
  }
  return ports.repository.commit(
    Object.freeze({
      operationReference: command.operationReference,
      intentHash,
      command,
      collaborationReference,
      assessment,
      audit: await ports.audit.create(command),
      outcome: "Applied",
    }),
  );
}

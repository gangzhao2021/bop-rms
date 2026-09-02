import {
  parseComplianceInstant,
  parseComplianceReference,
  parseComplianceScope,
  type ComplianceReference,
  type ComplianceScope,
} from "./compliance-dashboard.js";

export const traceNodeKinds = [
  "Supplier",
  "PurchaseOrder",
  "GoodsReceipt",
  "Lot",
  "InventoryMovement",
  "RecipeVersion",
  "ProductionBatch",
  "OrderItem",
  "Customer",
  "Fulfillment",
] as const;
export type TraceNodeKind = (typeof traceNodeKinds)[number];
export const traceRelationships = [
  "SuppliedOn",
  "ReceivedAs",
  "IdentifiedAsLot",
  "MovedThrough",
  "ConsumedByRecipe",
  "ProducedInBatch",
  "SoldAsOrderItem",
  "OrderedByCustomer",
  "CompletedByFulfillment",
] as const;
export type TraceRelationship = (typeof traceRelationships)[number];
export type TraceDirection = "Forward" | "Backward";
export type TraceCompleteness = "Complete" | "Partial";
export type TraceGapReason =
  "MissingSource" | "StaleSource" | "PermissionTrimmed" | "ProjectionUnavailable";

export interface TraceCriteria {
  readonly direction: TraceDirection;
  readonly seedKind: TraceNodeKind;
  readonly seedReference: ComplianceReference;
  readonly periodFrom: string;
  readonly periodTo: string;
}
export interface TraceNode {
  readonly nodeReference: ComplianceReference;
  readonly kind: TraceNodeKind;
  readonly sourceReference: ComplianceReference;
  readonly ownerDomain:
    "Procurement" | "Inventory" | "Recipe" | "Kitchen" | "Ordering" | "Customer" | "Fulfillment";
  readonly scope: ComplianceScope;
  readonly occurredAt: string;
  readonly snapshotDigest: string;
  readonly accessClass: "Internal" | "Restricted";
}
export interface TraceEdge {
  readonly edgeReference: ComplianceReference;
  readonly fromNodeReference: ComplianceReference;
  readonly toNodeReference: ComplianceReference;
  readonly relationship: TraceRelationship;
  readonly occurredAt: string;
}
export interface TraceGap {
  readonly gapReference: ComplianceReference;
  readonly adjacentNodeReference: ComplianceReference;
  readonly expectedKind: TraceNodeKind;
  readonly direction: TraceDirection;
  readonly reason: TraceGapReason;
  readonly detectedAt: string;
}
export interface TraceRun {
  readonly runReference: ComplianceReference;
  readonly scope: ComplianceScope;
  readonly criteria: TraceCriteria;
  readonly requestedAt: string;
  readonly completedAt: string;
  readonly sourceAsOf: string;
  readonly projectionVersionReference: ComplianceReference;
  readonly completeness: TraceCompleteness;
  readonly nodes: readonly TraceNode[];
  readonly edges: readonly TraceEdge[];
  readonly gaps: readonly TraceGap[];
}
export interface TraceEvidenceSet {
  readonly evidenceSetReference: ComplianceReference;
  readonly revision: number;
  readonly scope: ComplianceScope;
  readonly caseReference: ComplianceReference;
  readonly runReference: ComplianceReference;
  readonly nodeReferences: readonly ComplianceReference[];
  readonly edgeReferences: readonly ComplianceReference[];
  readonly gapReferences: readonly ComplianceReference[];
  readonly retentionPolicyReference: ComplianceReference;
  readonly legalHold: boolean;
  readonly accessClass: "Restricted";
  readonly createdBy: ComplianceReference;
  readonly createdAt: string;
}
export interface TraceExportReceipt {
  readonly exportOperationReference: ComplianceReference;
  readonly evidenceSetReference: ComplianceReference;
  readonly caseReference: ComplianceReference;
  readonly artifactReference: ComplianceReference;
  readonly artifactDigest: string;
  readonly recordedAt: string;
  readonly accessClass: "Restricted";
}
export interface TraceRecallOutcome {
  readonly requestReference: ComplianceReference;
  readonly runReference: ComplianceReference;
  readonly recallReference: ComplianceReference;
  readonly recordedAt: string;
}

export type TraceContractErrorCode = "TRACE_INPUT_INVALID" | "TRACE_SCOPE_INVALID";
export class TraceContractError extends Error {
  constructor(readonly code: TraceContractErrorCode) {
    super("Traceability input is invalid");
    this.name = "TraceContractError";
  }
}
const fail = (code: TraceContractErrorCode = "TRACE_INPUT_INVALID"): never => {
  throw new TraceContractError(code);
};
function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return fail();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    return fail();
  return value as Record<string, unknown>;
}
const oneOf = <T extends string>(value: unknown, values: readonly T[]): T =>
  typeof value === "string" && values.includes(value as T) ? (value as T) : fail();
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const digest = (value: unknown) =>
  typeof value === "string" && digestPattern.test(value) ? value : fail();
const positive = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fail();
function references(value: unknown, maximum: number): readonly ComplianceReference[] {
  if (!Array.isArray(value) || value.length > maximum) return fail();
  const parsed = Object.freeze(value.map(parseComplianceReference));
  return new Set(parsed).size === parsed.length ? parsed : fail();
}
const sameScope = (left: ComplianceScope, right: ComplianceScope) =>
  left.tenantReference === right.tenantReference &&
  left.brandReference === right.brandReference &&
  left.storeReference === right.storeReference;
const ownerByKind: Record<TraceNodeKind, TraceNode["ownerDomain"]> = {
  Supplier: "Procurement",
  PurchaseOrder: "Procurement",
  GoodsReceipt: "Inventory",
  Lot: "Inventory",
  InventoryMovement: "Inventory",
  RecipeVersion: "Recipe",
  ProductionBatch: "Kitchen",
  OrderItem: "Ordering",
  Customer: "Customer",
  Fulfillment: "Fulfillment",
};
const relationshipKinds: Record<TraceRelationship, readonly [TraceNodeKind, TraceNodeKind]> = {
  SuppliedOn: ["Supplier", "PurchaseOrder"],
  ReceivedAs: ["PurchaseOrder", "GoodsReceipt"],
  IdentifiedAsLot: ["GoodsReceipt", "Lot"],
  MovedThrough: ["Lot", "InventoryMovement"],
  ConsumedByRecipe: ["InventoryMovement", "RecipeVersion"],
  ProducedInBatch: ["RecipeVersion", "ProductionBatch"],
  SoldAsOrderItem: ["ProductionBatch", "OrderItem"],
  OrderedByCustomer: ["OrderItem", "Customer"],
  CompletedByFulfillment: ["OrderItem", "Fulfillment"],
};

export function parseTraceCriteria(value: unknown): TraceCriteria {
  const raw = exact(value, ["direction", "seedKind", "seedReference", "periodFrom", "periodTo"]);
  const periodFrom = parseComplianceInstant(raw.periodFrom);
  const periodTo = parseComplianceInstant(raw.periodTo);
  if (Date.parse(periodFrom) > Date.parse(periodTo)) return fail();
  return Object.freeze({
    direction: oneOf(raw.direction, ["Forward", "Backward"] as const),
    seedKind: oneOf(raw.seedKind, traceNodeKinds),
    seedReference: parseComplianceReference(raw.seedReference),
    periodFrom,
    periodTo,
  });
}
export function createTraceNode(value: unknown): TraceNode {
  const raw = exact(value, [
    "nodeReference",
    "kind",
    "sourceReference",
    "ownerDomain",
    "scope",
    "occurredAt",
    "snapshotDigest",
    "accessClass",
  ]);
  const kind = oneOf(raw.kind, traceNodeKinds);
  const ownerDomain = oneOf(raw.ownerDomain, [
    "Procurement",
    "Inventory",
    "Recipe",
    "Kitchen",
    "Ordering",
    "Customer",
    "Fulfillment",
  ] as const);
  const accessClass = oneOf(raw.accessClass, ["Internal", "Restricted"] as const);
  if (ownerByKind[kind] !== ownerDomain || (kind === "Customer") !== (accessClass === "Restricted"))
    return fail();
  return Object.freeze({
    nodeReference: parseComplianceReference(raw.nodeReference),
    kind,
    sourceReference: parseComplianceReference(raw.sourceReference),
    ownerDomain,
    scope: parseComplianceScope(raw.scope),
    occurredAt: parseComplianceInstant(raw.occurredAt),
    snapshotDigest: digest(raw.snapshotDigest),
    accessClass,
  });
}
export function createTraceEdge(value: unknown): TraceEdge {
  const raw = exact(value, [
    "edgeReference",
    "fromNodeReference",
    "toNodeReference",
    "relationship",
    "occurredAt",
  ]);
  const fromNodeReference = parseComplianceReference(raw.fromNodeReference);
  const toNodeReference = parseComplianceReference(raw.toNodeReference);
  if (fromNodeReference === toNodeReference) return fail();
  return Object.freeze({
    edgeReference: parseComplianceReference(raw.edgeReference),
    fromNodeReference,
    toNodeReference,
    relationship: oneOf(raw.relationship, traceRelationships),
    occurredAt: parseComplianceInstant(raw.occurredAt),
  });
}
export function createTraceGap(value: unknown): TraceGap {
  const raw = exact(value, [
    "gapReference",
    "adjacentNodeReference",
    "expectedKind",
    "direction",
    "reason",
    "detectedAt",
  ]);
  return Object.freeze({
    gapReference: parseComplianceReference(raw.gapReference),
    adjacentNodeReference: parseComplianceReference(raw.adjacentNodeReference),
    expectedKind: oneOf(raw.expectedKind, traceNodeKinds),
    direction: oneOf(raw.direction, ["Forward", "Backward"] as const),
    reason: oneOf(raw.reason, [
      "MissingSource",
      "StaleSource",
      "PermissionTrimmed",
      "ProjectionUnavailable",
    ] as const),
    detectedAt: parseComplianceInstant(raw.detectedAt),
  });
}
export function createTraceRun(value: unknown): TraceRun {
  const raw = exact(value, [
    "runReference",
    "scope",
    "criteria",
    "requestedAt",
    "completedAt",
    "sourceAsOf",
    "projectionVersionReference",
    "completeness",
    "nodes",
    "edges",
    "gaps",
  ]);
  if (
    !Array.isArray(raw.nodes) ||
    !Array.isArray(raw.edges) ||
    !Array.isArray(raw.gaps) ||
    raw.nodes.length < 1 ||
    raw.nodes.length > 500 ||
    raw.edges.length > 1000 ||
    raw.gaps.length > 500
  )
    return fail();
  const scope = parseComplianceScope(raw.scope);
  const criteria = parseTraceCriteria(raw.criteria);
  const requestedAt = parseComplianceInstant(raw.requestedAt);
  const completedAt = parseComplianceInstant(raw.completedAt);
  const sourceAsOf = parseComplianceInstant(raw.sourceAsOf);
  const completeness = oneOf(raw.completeness, ["Complete", "Partial"] as const);
  const nodes = Object.freeze(raw.nodes.map(createTraceNode));
  const edges = Object.freeze(raw.edges.map(createTraceEdge));
  const gaps = Object.freeze(raw.gaps.map(createTraceGap));
  const nodeMap = new Map(nodes.map((node) => [node.nodeReference, node]));
  if (
    nodeMap.size !== nodes.length ||
    new Set(edges.map((edge) => edge.edgeReference)).size !== edges.length ||
    new Set(gaps.map((gap) => gap.gapReference)).size !== gaps.length ||
    !nodes.some(
      (node) => node.kind === criteria.seedKind && node.sourceReference === criteria.seedReference,
    ) ||
    nodes.some(
      (node) =>
        !sameScope(node.scope, scope) ||
        Date.parse(node.occurredAt) < Date.parse(criteria.periodFrom) ||
        Date.parse(node.occurredAt) > Date.parse(criteria.periodTo) ||
        Date.parse(node.occurredAt) > Date.parse(sourceAsOf),
    ) ||
    edges.some((edge) => {
      const from = nodeMap.get(edge.fromNodeReference);
      const to = nodeMap.get(edge.toNodeReference);
      const expected = relationshipKinds[edge.relationship];
      return (
        from === undefined ||
        to === undefined ||
        from.kind !== expected[0] ||
        to.kind !== expected[1] ||
        Date.parse(edge.occurredAt) > Date.parse(sourceAsOf)
      );
    }) ||
    gaps.some(
      (gap) =>
        !nodeMap.has(gap.adjacentNodeReference) ||
        Date.parse(gap.detectedAt) > Date.parse(completedAt),
    ) ||
    (completeness === "Complete") !== (gaps.length === 0) ||
    Date.parse(criteria.periodTo) > Date.parse(requestedAt) ||
    Date.parse(requestedAt) > Date.parse(completedAt) ||
    Date.parse(sourceAsOf) > Date.parse(completedAt)
  )
    return fail("TRACE_SCOPE_INVALID");
  return Object.freeze({
    runReference: parseComplianceReference(raw.runReference),
    scope,
    criteria,
    requestedAt,
    completedAt,
    sourceAsOf,
    projectionVersionReference: parseComplianceReference(raw.projectionVersionReference),
    completeness,
    nodes,
    edges,
    gaps,
  });
}
export function createTraceEvidenceSet(value: unknown): TraceEvidenceSet {
  const raw = exact(value, [
    "evidenceSetReference",
    "revision",
    "scope",
    "caseReference",
    "runReference",
    "nodeReferences",
    "edgeReferences",
    "gapReferences",
    "retentionPolicyReference",
    "legalHold",
    "accessClass",
    "createdBy",
    "createdAt",
  ]);
  const nodeReferences = references(raw.nodeReferences, 500);
  const edgeReferences = references(raw.edgeReferences, 1000);
  const gapReferences = references(raw.gapReferences, 500);
  if (
    nodeReferences.length + edgeReferences.length + gapReferences.length < 1 ||
    typeof raw.legalHold !== "boolean" ||
    raw.accessClass !== "Restricted"
  )
    return fail();
  return Object.freeze({
    evidenceSetReference: parseComplianceReference(raw.evidenceSetReference),
    revision: positive(raw.revision),
    scope: parseComplianceScope(raw.scope),
    caseReference: parseComplianceReference(raw.caseReference),
    runReference: parseComplianceReference(raw.runReference),
    nodeReferences,
    edgeReferences,
    gapReferences,
    retentionPolicyReference: parseComplianceReference(raw.retentionPolicyReference),
    legalHold: raw.legalHold,
    accessClass: "Restricted",
    createdBy: parseComplianceReference(raw.createdBy),
    createdAt: parseComplianceInstant(raw.createdAt),
  });
}
export function createTraceExportReceipt(value: unknown): TraceExportReceipt {
  const raw = exact(value, [
    "exportOperationReference",
    "evidenceSetReference",
    "caseReference",
    "artifactReference",
    "artifactDigest",
    "recordedAt",
    "accessClass",
  ]);
  if (raw.accessClass !== "Restricted") return fail();
  return Object.freeze({
    exportOperationReference: parseComplianceReference(raw.exportOperationReference),
    evidenceSetReference: parseComplianceReference(raw.evidenceSetReference),
    caseReference: parseComplianceReference(raw.caseReference),
    artifactReference: parseComplianceReference(raw.artifactReference),
    artifactDigest: digest(raw.artifactDigest),
    recordedAt: parseComplianceInstant(raw.recordedAt),
    accessClass: "Restricted",
  });
}
export function createTraceRecallOutcome(value: unknown): TraceRecallOutcome {
  const raw = exact(value, ["requestReference", "runReference", "recallReference", "recordedAt"]);
  return Object.freeze({
    requestReference: parseComplianceReference(raw.requestReference),
    runReference: parseComplianceReference(raw.runReference),
    recallReference: parseComplianceReference(raw.recallReference),
    recordedAt: parseComplianceInstant(raw.recordedAt),
  });
}

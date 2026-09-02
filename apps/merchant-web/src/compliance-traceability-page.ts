export type ComplianceTraceabilityPageErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "FeatureDisabled"
  | "Stale"
  | "Conflict"
  | "CommandFailed"
  | "Offline"
  | "Unavailable";
export class ComplianceTraceabilityPageError extends Error {
  constructor(readonly code: ComplianceTraceabilityPageErrorCode) {
    super("Compliance traceability page unavailable");
    this.name = "ComplianceTraceabilityPageError";
  }
}
export interface ComplianceTraceabilityClient {
  load(): Promise<unknown>;
}
const nodeKinds = [
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
type NodeKind = (typeof nodeKinds)[number];
type Direction = "Forward" | "Backward";
export interface ComplianceTraceabilityView {
  readonly screenId: "TRACE-EXPLORER";
  readonly queryName: "compliance_traceability_v1";
  readonly queryVersion: 1;
  readonly generatedAt: string;
  readonly sourceAsOf: string;
  readonly freshness: "Current" | "Stale";
  readonly completeness: "Complete" | "Partial";
  readonly projectionVersionReference: string;
  readonly permissions: {
    readonly mayPinEvidenceSet: boolean;
    readonly mayExportRestrictedArtifact: boolean;
    readonly mayOpenRecall: boolean;
  };
  readonly filters: {
    readonly direction: Direction;
    readonly seedKind: NodeKind;
    readonly seedReference: string;
    readonly periodFrom: string;
    readonly periodTo: string;
    readonly storeReference: string | null;
  };
  readonly result: null | {
    readonly runReference: string;
    readonly requestedAt: string;
    readonly completedAt: string;
    readonly nodes: readonly {
      readonly nodeReference: string;
      readonly kind: NodeKind;
      readonly sourceReference: string | null;
      readonly ownerDomain:
        | "Procurement"
        | "Inventory"
        | "Recipe"
        | "Kitchen"
        | "Ordering"
        | "Customer"
        | "Fulfillment";
      readonly occurredAt: string;
      readonly snapshotDigest: string;
      readonly accessClass: "Internal" | "Restricted";
    }[];
    readonly edges: readonly {
      readonly edgeReference: string;
      readonly fromNodeReference: string;
      readonly toNodeReference: string;
      readonly relationship:
        | "SuppliedOn"
        | "ReceivedAs"
        | "IdentifiedAsLot"
        | "MovedThrough"
        | "ConsumedByRecipe"
        | "ProducedInBatch"
        | "SoldAsOrderItem"
        | "OrderedByCustomer"
        | "CompletedByFulfillment";
      readonly occurredAt: string;
    }[];
    readonly gaps: readonly {
      readonly gapReference: string;
      readonly adjacentNodeReference: string;
      readonly expectedKind: NodeKind;
      readonly direction: Direction;
      readonly reason:
        "MissingSource" | "StaleSource" | "PermissionTrimmed" | "ProjectionUnavailable";
      readonly detectedAt: string;
    }[];
    readonly evidenceSet: null | {
      readonly evidenceSetReference: string;
      readonly revision: number;
      readonly caseReference: string;
      readonly selectedNodeCount: string;
      readonly selectedEdgeCount: string;
      readonly selectedGapCount: string;
      readonly retentionPolicyReference: string;
      readonly legalHold: boolean;
      readonly accessClass: "Restricted";
    };
    readonly exportReceipt: null | {
      readonly artifactReference: string;
      readonly artifactDigest: string;
      readonly recordedAt: string;
      readonly accessClass: "Restricted";
    };
    readonly recallOutcome: null | {
      readonly recallReference: string;
      readonly recordedAt: string;
    };
  };
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const countPattern = /^(?:0|[1-9][0-9]{0,29})$/u;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const fail = (): never => {
  throw new ComplianceTraceabilityPageError("Unavailable");
};
function object(value: unknown, fields: readonly string[]) {
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
const reference = (value: unknown) =>
  typeof value === "string" && uuid.test(value) ? value : fail();
const nullableReference = (value: unknown) => (value === null ? null : reference(value));
const instant = (value: unknown) =>
  typeof value === "string" &&
  instantPattern.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(Date.parse(value)).toISOString() === value
    ? value
    : fail();
const digest = (value: unknown) =>
  typeof value === "string" && digestPattern.test(value) ? value : fail();
const count = (value: unknown) =>
  typeof value === "string" && countPattern.test(value) ? value : fail();
const bool = (value: unknown) => (typeof value === "boolean" ? value : fail());
const positive = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fail();
const ownerDomains = [
  "Procurement",
  "Inventory",
  "Recipe",
  "Kitchen",
  "Ordering",
  "Customer",
  "Fulfillment",
] as const;
const ownerByKind: Record<NodeKind, (typeof ownerDomains)[number]> = {
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
const relationships = [
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
const relationshipKinds: Record<(typeof relationships)[number], readonly [NodeKind, NodeKind]> = {
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
function node(value: unknown): NonNullable<ComplianceTraceabilityView["result"]>["nodes"][number] {
  const raw = object(value, [
    "nodeReference",
    "kind",
    "sourceReference",
    "ownerDomain",
    "occurredAt",
    "snapshotDigest",
    "accessClass",
  ]);
  const kind = oneOf(raw.kind, nodeKinds);
  const ownerDomain = oneOf(raw.ownerDomain, ownerDomains);
  const sourceReference = nullableReference(raw.sourceReference);
  const accessClass = oneOf(raw.accessClass, ["Internal", "Restricted"] as const);
  if (
    ownerByKind[kind] !== ownerDomain ||
    (kind === "Customer"
      ? sourceReference !== null || accessClass !== "Restricted"
      : sourceReference === null || accessClass !== "Internal")
  )
    return fail();
  return Object.freeze({
    nodeReference: reference(raw.nodeReference),
    kind,
    sourceReference,
    ownerDomain,
    occurredAt: instant(raw.occurredAt),
    snapshotDigest: digest(raw.snapshotDigest),
    accessClass,
  });
}
function edge(value: unknown): NonNullable<ComplianceTraceabilityView["result"]>["edges"][number] {
  const raw = object(value, [
    "edgeReference",
    "fromNodeReference",
    "toNodeReference",
    "relationship",
    "occurredAt",
  ]);
  const fromNodeReference = reference(raw.fromNodeReference);
  const toNodeReference = reference(raw.toNodeReference);
  if (fromNodeReference === toNodeReference) return fail();
  return Object.freeze({
    edgeReference: reference(raw.edgeReference),
    fromNodeReference,
    toNodeReference,
    relationship: oneOf(raw.relationship, relationships),
    occurredAt: instant(raw.occurredAt),
  });
}
function gap(value: unknown): NonNullable<ComplianceTraceabilityView["result"]>["gaps"][number] {
  const raw = object(value, [
    "gapReference",
    "adjacentNodeReference",
    "expectedKind",
    "direction",
    "reason",
    "detectedAt",
  ]);
  return Object.freeze({
    gapReference: reference(raw.gapReference),
    adjacentNodeReference: reference(raw.adjacentNodeReference),
    expectedKind: oneOf(raw.expectedKind, nodeKinds),
    direction: oneOf(raw.direction, ["Forward", "Backward"] as const),
    reason: oneOf(raw.reason, [
      "MissingSource",
      "StaleSource",
      "PermissionTrimmed",
      "ProjectionUnavailable",
    ] as const),
    detectedAt: instant(raw.detectedAt),
  });
}
function evidenceSet(value: unknown) {
  if (value === null) return null;
  const raw = object(value, [
    "evidenceSetReference",
    "revision",
    "caseReference",
    "selectedNodeCount",
    "selectedEdgeCount",
    "selectedGapCount",
    "retentionPolicyReference",
    "legalHold",
    "accessClass",
  ]);
  if (raw.accessClass !== "Restricted") return fail();
  return Object.freeze({
    evidenceSetReference: reference(raw.evidenceSetReference),
    revision: positive(raw.revision),
    caseReference: reference(raw.caseReference),
    selectedNodeCount: count(raw.selectedNodeCount),
    selectedEdgeCount: count(raw.selectedEdgeCount),
    selectedGapCount: count(raw.selectedGapCount),
    retentionPolicyReference: reference(raw.retentionPolicyReference),
    legalHold: bool(raw.legalHold),
    accessClass: "Restricted" as const,
  });
}
function exportReceipt(value: unknown) {
  if (value === null) return null;
  const raw = object(value, ["artifactReference", "artifactDigest", "recordedAt", "accessClass"]);
  if (raw.accessClass !== "Restricted") return fail();
  return Object.freeze({
    artifactReference: reference(raw.artifactReference),
    artifactDigest: digest(raw.artifactDigest),
    recordedAt: instant(raw.recordedAt),
    accessClass: "Restricted" as const,
  });
}
function recallOutcome(value: unknown) {
  if (value === null) return null;
  const raw = object(value, ["recallReference", "recordedAt"]);
  return Object.freeze({
    recallReference: reference(raw.recallReference),
    recordedAt: instant(raw.recordedAt),
  });
}
function result(value: unknown, completeness: "Complete" | "Partial") {
  if (value === null) return null;
  const raw = object(value, [
    "runReference",
    "requestedAt",
    "completedAt",
    "nodes",
    "edges",
    "gaps",
    "evidenceSet",
    "exportReceipt",
    "recallOutcome",
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
  const nodes = Object.freeze(raw.nodes.map(node));
  const edges = Object.freeze(raw.edges.map(edge));
  const gaps = Object.freeze(raw.gaps.map(gap));
  const nodeReferences = new Set(nodes.map((item) => item.nodeReference));
  const nodeByReference = new Map(nodes.map((item) => [item.nodeReference, item]));
  if (
    nodeReferences.size !== nodes.length ||
    new Set(edges.map((item) => item.edgeReference)).size !== edges.length ||
    new Set(gaps.map((item) => item.gapReference)).size !== gaps.length ||
    edges.some((item) => {
      const from = nodeByReference.get(item.fromNodeReference);
      const to = nodeByReference.get(item.toNodeReference);
      const expected = relationshipKinds[item.relationship];
      return (
        from === undefined ||
        to === undefined ||
        from.kind !== expected[0] ||
        to.kind !== expected[1]
      );
    }) ||
    gaps.some((item) => !nodeReferences.has(item.adjacentNodeReference)) ||
    (completeness === "Complete") !== (gaps.length === 0)
  )
    return fail();
  const requestedAt = instant(raw.requestedAt);
  const completedAt = instant(raw.completedAt);
  if (Date.parse(requestedAt) > Date.parse(completedAt)) return fail();
  return Object.freeze({
    runReference: reference(raw.runReference),
    requestedAt,
    completedAt,
    nodes,
    edges,
    gaps,
    evidenceSet: evidenceSet(raw.evidenceSet),
    exportReceipt: exportReceipt(raw.exportReceipt),
    recallOutcome: recallOutcome(raw.recallOutcome),
  });
}
export function parseComplianceTraceabilityView(value: unknown): ComplianceTraceabilityView {
  const raw = object(value, [
    "screenId",
    "queryName",
    "queryVersion",
    "generatedAt",
    "sourceAsOf",
    "freshness",
    "completeness",
    "projectionVersionReference",
    "permissions",
    "filters",
    "result",
  ]);
  if (
    raw.screenId !== "TRACE-EXPLORER" ||
    raw.queryName !== "compliance_traceability_v1" ||
    raw.queryVersion !== 1
  )
    return fail();
  const generatedAt = instant(raw.generatedAt);
  const sourceAsOf = instant(raw.sourceAsOf);
  if (Date.parse(sourceAsOf) > Date.parse(generatedAt)) return fail();
  const completeness = oneOf(raw.completeness, ["Complete", "Partial"] as const);
  const permissions = object(raw.permissions, [
    "mayPinEvidenceSet",
    "mayExportRestrictedArtifact",
    "mayOpenRecall",
  ]);
  const filters = object(raw.filters, [
    "direction",
    "seedKind",
    "seedReference",
    "periodFrom",
    "periodTo",
    "storeReference",
  ]);
  const periodFrom = instant(filters.periodFrom);
  const periodTo = instant(filters.periodTo);
  if (Date.parse(periodFrom) > Date.parse(periodTo)) return fail();
  return Object.freeze({
    screenId: "TRACE-EXPLORER",
    queryName: "compliance_traceability_v1",
    queryVersion: 1,
    generatedAt,
    sourceAsOf,
    freshness: oneOf(raw.freshness, ["Current", "Stale"] as const),
    completeness,
    projectionVersionReference: reference(raw.projectionVersionReference),
    permissions: Object.freeze({
      mayPinEvidenceSet: bool(permissions.mayPinEvidenceSet),
      mayExportRestrictedArtifact: bool(permissions.mayExportRestrictedArtifact),
      mayOpenRecall: bool(permissions.mayOpenRecall),
    }),
    filters: Object.freeze({
      direction: oneOf(filters.direction, ["Forward", "Backward"] as const),
      seedKind: oneOf(filters.seedKind, nodeKinds),
      seedReference: reference(filters.seedReference),
      periodFrom,
      periodTo,
      storeReference: nullableReference(filters.storeReference),
    }),
    result: result(raw.result, completeness),
  });
}
export const unavailableComplianceTraceabilityClient: ComplianceTraceabilityClient = {
  async load() {
    throw new ComplianceTraceabilityPageError("Unavailable");
  },
};

import { revalidateTenantContext } from "@bop/permission";
import {
  createComplianceDashboardSourceSnapshot,
  parseComplianceCode,
  parseComplianceDashboardFilter,
  parseComplianceInstant,
  parseComplianceReference,
  parseComplianceScope,
  type ComplianceDashboardSignalView,
  type ComplianceDashboardView,
  type ComplianceScope,
  type FindingSeverity,
} from "../contracts/compliance-dashboard.js";
import type { ComplianceDashboardPorts } from "./ports/compliance-dashboard-ports.js";

export type ComplianceDashboardErrorCode =
  | "COMPLIANCE_DASHBOARD_INPUT_INVALID"
  | "COMPLIANCE_DASHBOARD_PERMISSION_DENIED"
  | "COMPLIANCE_DASHBOARD_UNAVAILABLE";
export class ComplianceDashboardError extends Error {
  constructor(readonly code: ComplianceDashboardErrorCode) {
    super("Compliance dashboard is unavailable");
    this.name = "ComplianceDashboardError";
  }
}
const invalid = (): never => {
  throw new ComplianceDashboardError("COMPLIANCE_DASHBOARD_INPUT_INVALID");
};
function exact(value: unknown, fields: readonly string[]) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return invalid();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    return invalid();
  return value as Record<string, unknown>;
}
function unavailable(error?: unknown): never {
  if (error instanceof ComplianceDashboardError) throw error;
  throw new ComplianceDashboardError("COMPLIANCE_DASHBOARD_UNAVAILABLE");
}
const sameScope = (left: ComplianceScope, right: ComplianceScope) =>
  left.tenantReference === right.tenantReference &&
  left.brandReference === right.brandReference &&
  left.storeReference === right.storeReference;
const severityRank: Record<FindingSeverity, number> = {
  ImmediateDanger: 0,
  Critical: 1,
  Major: 2,
  Minor: 3,
  Observation: 4,
};
function signalView(
  signal: ReturnType<typeof createComplianceDashboardSourceSnapshot>["signals"][number],
  observedAt: string,
): ComplianceDashboardSignalView {
  const dueDisposition =
    signal.dueAt === null
      ? "NoDueDate"
      : Date.parse(signal.dueAt) < Date.parse(observedAt)
        ? "Overdue"
        : Date.parse(signal.dueAt) === Date.parse(observedAt)
          ? "Due"
          : "NotDue";
  return Object.freeze({
    ...signal,
    dueDisposition,
    evidenceComplete: BigInt(signal.evidencePresentCount) === BigInt(signal.evidenceRequiredCount),
  });
}

export function createComplianceDashboardService(ports: ComplianceDashboardPorts) {
  return Object.freeze({
    async query(input: {
      readonly operationReference: string;
      readonly purposeCode: string;
      readonly scope: unknown;
      readonly filter: unknown;
      readonly observedAt: string;
    }): Promise<ComplianceDashboardView> {
      exact(input, ["operationReference", "purposeCode", "scope", "filter", "observedAt"]);
      let operationReference;
      let purposeCode;
      let scope;
      let filter;
      let observedAt;
      try {
        operationReference = parseComplianceReference(input.operationReference);
        purposeCode = parseComplianceCode(input.purposeCode);
        scope = parseComplianceScope(input.scope);
        filter = parseComplianceDashboardFilter(input.filter);
        observedAt = parseComplianceInstant(input.observedAt);
      } catch {
        return invalid();
      }
      const evidence = await ports.authorization
        .authorize({ operationReference, purposeCode, scope, observedAt })
        .catch(unavailable);
      if (evidence === null)
        throw new ComplianceDashboardError("COMPLIANCE_DASHBOARD_PERMISSION_DENIED");
      try {
        const context = revalidateTenantContext(evidence.tenantContext);
        if (
          context.actor.actorReference === null ||
          evidence.tenantReference !== scope.tenantReference ||
          String(context.brand.brandReference) !== scope.brandReference ||
          (context.store === null ? null : String(context.store.storeReference)) !==
            scope.storeReference ||
          context.scopeKind !== evidence.permission.scopeKind ||
          evidence.permission.effect !== "Allow" ||
          evidence.permission.action !== "compliance.dashboard.view"
        )
          throw new Error("denied");
      } catch {
        throw new ComplianceDashboardError("COMPLIANCE_DASHBOARD_PERMISSION_DENIED");
      }
      const raw = await ports.source.load({ scope, filter, observedAt }).catch(unavailable);
      if (raw === null) return unavailable();
      let source;
      try {
        source = createComplianceDashboardSourceSnapshot(raw);
      } catch {
        return unavailable();
      }
      if (!sameScope(source.scope, scope) || Date.parse(source.sourceAsOf) > Date.parse(observedAt))
        return unavailable();
      const signals = Object.freeze(
        source.signals
          .map((item) => signalView(item, observedAt))
          .filter(
            (item) =>
              (filter.caseTypeCode === null || item.caseTypeCode === filter.caseTypeCode) &&
              (filter.severity === null || item.severity === filter.severity) &&
              (filter.dueDisposition === null || item.dueDisposition === filter.dueDisposition),
          )
          .sort(
            (left, right) =>
              severityRank[left.severity] - severityRank[right.severity] ||
              (left.dueAt === null
                ? 1
                : right.dueAt === null
                  ? -1
                  : left.dueAt.localeCompare(right.dueAt)) ||
              left.signalReference.localeCompare(right.signalReference),
          ),
      );
      return Object.freeze({
        screenId: "CMP-DASHBOARD",
        queryName: "compliance_dashboard_v1",
        queryVersion: 1,
        scope,
        generatedAt: observedAt,
        sourceAsOf: source.sourceAsOf,
        projectionVersionReference: source.projectionVersionReference,
        freshness:
          Date.parse(observedAt) - Date.parse(source.sourceAsOf) <= 15 * 60 * 1000
            ? "Current"
            : "Stale",
        completeness: source.completeness,
        filter,
        signals,
      });
    },
  });
}

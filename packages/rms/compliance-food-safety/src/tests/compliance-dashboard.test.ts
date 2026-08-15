import { createBrand, createTenantContext } from "@bop/tenant";
import { describe, expect, it } from "vitest";
import {
  ComplianceDashboardError,
  createComplianceDashboardService,
  type ComplianceDashboardPorts,
} from "../index.js";

const id = (n: number) => `018f9920-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const ids = {
  tenant: id(1),
  brand: id(2),
  actor: id(3),
  policy: id(4),
  operation: id(5),
  projection: id(6),
  critical: id(7),
  minor: id(8),
  case: id(9),
  record: id(10),
};
const at = "2026-08-14T18:00:00.000Z";
const before = "2026-08-14T17:00:00.000Z";
const scope = { tenantReference: ids.tenant, brandReference: ids.brand, storeReference: null };
function tenant(observedAt = at) {
  return createTenantContext(
    {
      actorType: "User",
      actorReference: ids.actor,
      accountKind: "Workforce",
      status: "Active",
      authenticationMethod: "Oidc",
      verificationLevel: "SingleFactor",
      authenticatedAt: observedAt,
      recentMfaAt: null,
    } as never,
    createBrand({
      brandReference: ids.brand,
      code: "COMPLIANCE",
      displayName: "Synthetic Compliance Brand",
      defaultLocale: "en-CA",
      currencyCode: "CAD",
      lifecycle: "Active",
      version: 1,
      createdAt: before,
      updatedAt: before,
    }),
    null,
    observedAt,
  );
}
function source() {
  return {
    scope,
    projectionVersionReference: ids.projection,
    sourceAsOf: "2026-08-14T17:55:00.000Z",
    completeness: "Complete" as const,
    signals: [
      {
        signalReference: ids.minor,
        owningReference: ids.record,
        owningKind: "ComplianceRecord" as const,
        scope,
        kind: "MissingCleaningRecord" as const,
        caseTypeCode: "CLEANING",
        severity: "Minor" as const,
        dueAt: null,
        occurredAt: before,
        evidenceRequiredCount: "1",
        evidencePresentCount: "1",
      },
      {
        signalReference: ids.critical,
        owningReference: ids.case,
        owningKind: "ComplianceCase" as const,
        scope,
        kind: "TemperatureExcursion" as const,
        caseTypeCode: "TEMPERATURE",
        severity: "Critical" as const,
        dueAt: "2026-08-14T17:30:00.000Z",
        occurredAt: before,
        evidenceRequiredCount: "2",
        evidencePresentCount: "1",
      },
    ],
  };
}
function first<T>(values: T[]): T {
  const value = values[0];
  if (value === undefined) throw new Error("synthetic compliance signal missing");
  return value;
}
function fixture(options: { deny?: boolean; raw?: ReturnType<typeof source> | null } = {}) {
  const ports: ComplianceDashboardPorts = {
    authorization: {
      async authorize() {
        if (options.deny) return null;
        return {
          tenantReference: ids.tenant,
          tenantContext: tenant(),
          permission: {
            effect: "Allow",
            reason: "ROLE_PERMISSION",
            source: "RolePermission",
            action: "compliance.dashboard.view",
            scopeKind: "Brand",
            policySnapshotReference: ids.policy,
            policyVersion: 1,
            audit: { effect: "Allow", reason: "ROLE_PERMISSION", source: "RolePermission" },
          },
        } as never;
      },
    },
    source: {
      async load() {
        return (options.raw === undefined ? source() : options.raw) as never;
      },
    },
  };
  return createComplianceDashboardService(ports);
}
const input = (
  filter: {
    caseTypeCode: string | null;
    severity: string | null;
    dueDisposition: string | null;
  } = { caseTypeCode: null, severity: null, dueDisposition: null },
) => ({
  operationReference: ids.operation,
  purposeCode: "STORE_COMPLIANCE_OVERSIGHT",
  scope,
  filter,
  observedAt: at,
});

describe("WP-2170 compliance dashboard", () => {
  it("returns a bounded, rebuildable summary sorted by severity and due time", async () => {
    const view = await fixture().query(input());
    expect(view.queryName).toBe("compliance_dashboard_v1");
    expect(view.freshness).toBe("Current");
    expect(view.signals.map((item) => item.signalReference)).toEqual([ids.critical, ids.minor]);
    expect(view.signals[0]).toMatchObject({ dueDisposition: "Overdue", evidenceComplete: false });
    expect(JSON.stringify(view)).not.toMatch(/allergy|contact|health|evidenceContent|raw/i);
  });

  it("applies case, severity and due filters after deriving due state", async () => {
    const view = await fixture().query(
      input({ caseTypeCode: "TEMPERATURE", severity: "Critical", dueDisposition: "Overdue" }),
    );
    expect(view.signals).toHaveLength(1);
    expect(view.signals[0]?.kind).toBe("TemperatureExcursion");
  });

  it("fails closed for denied access, unavailable sources and restricted extra fields", async () => {
    await expect(fixture({ deny: true }).query(input())).rejects.toMatchObject({
      code: "COMPLIANCE_DASHBOARD_PERMISSION_DENIED",
    });
    await expect(fixture({ raw: null }).query(input())).rejects.toMatchObject({
      code: "COMPLIANCE_DASHBOARD_UNAVAILABLE",
    });
    const restricted = source() as ReturnType<typeof source> & { incidentNarrative: string };
    restricted.incidentNarrative = "must not cross the query contract";
    await expect(fixture({ raw: restricted }).query(input())).rejects.toBeInstanceOf(
      ComplianceDashboardError,
    );
  });

  it("rejects cross-scope signals and impossible evidence counts", async () => {
    const crossed = source();
    crossed.signals[0] = {
      ...first(crossed.signals),
      scope: { ...scope, brandReference: id(99) },
    };
    await expect(fixture({ raw: crossed }).query(input())).rejects.toMatchObject({
      code: "COMPLIANCE_DASHBOARD_UNAVAILABLE",
    });
    const impossible = source();
    impossible.signals[0] = {
      ...first(impossible.signals),
      evidenceRequiredCount: "1",
      evidencePresentCount: "2",
    };
    await expect(fixture({ raw: impossible }).query(input())).rejects.toMatchObject({
      code: "COMPLIANCE_DASHBOARD_UNAVAILABLE",
    });
  });
});

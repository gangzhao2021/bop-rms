const ref = (suffix: string) => `018f9921-0000-7000-8000-${suffix.padStart(12, "0")}`;

export function complianceDashboardFixture() {
  const scope = { tenantReference: ref("1"), brandReference: ref("2"), storeReference: null };
  return {
    screenId: "CMP-DASHBOARD",
    queryName: "compliance_dashboard_v1",
    queryVersion: 1,
    scope,
    generatedAt: "2026-08-14T18:00:00.000Z",
    sourceAsOf: "2026-08-14T17:55:00.000Z",
    projectionVersionReference: ref("3"),
    freshness: "Current",
    completeness: "Complete",
    filter: { caseTypeCode: null, severity: null, dueDisposition: null },
    signals: [
      {
        signalReference: ref("4"),
        owningReference: ref("5"),
        owningKind: "ComplianceCase",
        scope,
        kind: "TemperatureExcursion",
        caseTypeCode: "TEMPERATURE",
        severity: "ImmediateDanger",
        dueAt: "2026-08-14T17:30:00.000Z",
        occurredAt: "2026-08-14T17:00:00.000Z",
        evidenceRequiredCount: "2",
        evidencePresentCount: "1",
        dueDisposition: "Overdue",
        evidenceComplete: false,
      },
    ],
  };
}

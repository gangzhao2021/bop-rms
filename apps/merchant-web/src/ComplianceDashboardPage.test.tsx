import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ComplianceDashboardList, ComplianceDashboardState } from "./ComplianceDashboardPage.js";
import { complianceDashboardFixture } from "./compliance-dashboard.fixtures.js";
import { parseComplianceDashboardView } from "./compliance-dashboard-page.js";
const first = <T,>(values: T[]): T => {
  const value = values[0];
  if (value === undefined) throw new Error("synthetic compliance signal missing");
  return value;
};
const view = complianceDashboardFixture;
describe("WP-2170 Compliance Dashboard", () => {
  it("renders bounded summaries and navigation-only actions", () => {
    const html = renderToStaticMarkup(
      <ComplianceDashboardList view={parseComplianceDashboardView(view())} />,
    );
    expect(html).toContain("Immediate Danger");
    expect(html).toContain("Evidence 1 / 2");
    expect(html).toContain("Open owning case");
    expect(html).toContain("Acknowledge navigation alert");
    expect(html).not.toMatch(/incidentNarrative|allergyFact|healthFact|evidenceContent/);
  });
  it("rejects extra fields, cross-scope signals and impossible evidence counts", () => {
    expect(() => parseComplianceDashboardView({ ...view(), rawEvidence: [] })).toThrow();
    const crossed = view();
    crossed.signals[0] = {
      ...first(crossed.signals),
      scope: {
        ...crossed.scope,
        brandReference: "018f9921-0000-7000-8000-000000000009",
      },
    };
    expect(() => parseComplianceDashboardView(crossed)).toThrow();
    const impossible = view();
    impossible.signals[0] = { ...first(impossible.signals), evidencePresentCount: "3" };
    expect(() => parseComplianceDashboardView(impossible)).toThrow();
    const falseComplete = view();
    falseComplete.signals[0] = { ...first(falseComplete.signals), evidenceComplete: true };
    expect(() => parseComplianceDashboardView(falseComplete)).toThrow();
    const falseDue = view();
    falseDue.signals[0] = { ...first(falseDue.signals), dueDisposition: "NotDue" };
    expect(() => parseComplianceDashboardView(falseDue)).toThrow();
  });
  it("renders partial and stale state explicitly", () => {
    const partial = view();
    partial.completeness = "Partial";
    expect(
      renderToStaticMarkup(
        <ComplianceDashboardList view={parseComplianceDashboardView(partial)} />,
      ),
    ).toContain("Partial source coverage");
    expect(renderToStaticMarkup(<ComplianceDashboardState state="Stale" />)).toContain(
      "Projection stale",
    );
  });
  it.each(["Loading", "PermissionDenied", "Stale", "Offline", "Unavailable"] as const)(
    "renders the %s state",
    (state) => {
      expect(renderToStaticMarkup(<ComplianceDashboardState state={state} />)).toContain(
        'role="status"',
      );
    },
  );
});

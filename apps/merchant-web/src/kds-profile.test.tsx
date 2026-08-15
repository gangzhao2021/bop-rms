import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { KdsProfileScreen, KdsProfileState } from "./KdsProfilePage.js";
import { parseKdsProfileView } from "./kds-profile.js";
const ref = (n: number) => `018f0f59-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-15T16:00:00.000Z";
const checks = () =>
  [
    "ACCESSIBILITY",
    "AUTO_LOCK",
    "MANAGED_BROWSER",
    "NAMED_SESSION_HANDOVER",
    "NETWORK_LOSS",
    "NOTIFICATION",
    "REPLACEMENT",
    "RESOLUTION",
    "VISIBILITY_LOCK",
    "WAKE_POWER",
  ].map((checkCode) => ({ checkCode, outcome: "NotRun", safeResultCode: null }));
const fixture = () => ({
  screenId: "DEV-KDS-PROFILE",
  queryName: "kds_profile_management_v1",
  queryVersion: 1,
  generatedAt: at,
  sourceAsOf: at,
  freshness: "Current",
  completeness: "Complete",
  profileReference: ref(1),
  profileVersionReference: ref(2),
  profileVersion: 1,
  profileLabelCode: "HOT_KDS",
  storeReference: ref(3),
  storeLabel: "Synthetic Training Store",
  stationReference: ref(4),
  stationLabel: "Hot line",
  lifecycle: "Draft",
  browserFamily: "ChromiumManaged",
  minimumLogicalWidth: 1024,
  minimumLogicalHeight: 768,
  wakePolicyCode: "STORE_HOURS",
  powerPolicyCode: "MANAGED_AC",
  autoLockSeconds: 120,
  visibilityLossLocks: true,
  handoverPolicy: "LockThenRotateNamedSession",
  notificationMode: "VisualAndAudible",
  networkProcedureCode: "KDS-NETWORK-RECOVERY-V1",
  replacementProcedureCode: "KDS-REPLACEMENT-V1",
  assignmentReference: ref(5),
  assignedDeviceReference: ref(6),
  operatorSessionStatus: "NamedLocked",
  uat: {
    runReference: null,
    checklistVersionCode: "KDS_UAT_V1",
    browserVersionCode: null,
    logicalWidth: null,
    logicalHeight: null,
    status: "NotRun",
    dueAt: "2026-08-20T16:00:00.000Z",
    completedAt: null,
    evidenceReference: null,
    checks: checks(),
  },
  filters: { storeReference: null, stationReference: null, lifecycle: null, uatDue: "Due" },
  permissions: {
    mayCreate: true,
    mayAssign: true,
    mayRunUat: true,
    mayPublish: true,
    mayRevoke: true,
  },
});
describe("WP-2181 managed KDS Profile and Store UAT", () => {
  it("renders managed profile, continuity and complete checklist", () => {
    const html = renderToStaticMarkup(<KdsProfileScreen view={parseKdsProfileView(fixture())} />);
    for (const value of [
      "DEV-KDS-PROFILE",
      "minimum 1024×768",
      "120 seconds",
      "Browser commands are never queued offline",
      "Store UAT",
      "ACCESSIBILITY",
      "Real Store device UAT remains unavailable",
    ])
      expect(html).toContain(value);
  });
  it("keeps publish disabled without accepted Passed UAT", () => {
    const html = renderToStaticMarkup(<KdsProfileScreen view={parseKdsProfileView(fixture())} />);
    expect(html).toMatch(/<button disabled="">Publish Profile<\/button>/u);
  });
  it("accepts only complete evidence-backed Passed UAT", () => {
    expect(() =>
      parseKdsProfileView({ ...fixture(), uat: { ...fixture().uat, status: "Passed" } }),
    ).toThrow("KDS_PROFILE_INVALID");
    const passed = {
      ...fixture(),
      uat: {
        ...fixture().uat,
        runReference: ref(7),
        browserVersionCode: "CHROME_140",
        logicalWidth: 1024,
        logicalHeight: 768,
        status: "Passed",
        completedAt: at,
        evidenceReference: ref(8),
        checks: checks().map((item) => ({
          ...item,
          outcome: "Passed",
          safeResultCode: "PASSED",
        })),
      },
    };
    expect(parseKdsProfileView(passed).uat.status).toBe("Passed");
  });
  it("rejects unsafe resolution, lock, cardinality and restricted extras", () => {
    expect(() => parseKdsProfileView({ ...fixture(), minimumLogicalWidth: 800 })).toThrow();
    expect(() => parseKdsProfileView({ ...fixture(), autoLockSeconds: 10 })).toThrow();
    expect(() =>
      parseKdsProfileView({ ...fixture(), uat: { ...fixture().uat, checks: [] } }),
    ).toThrow();
    expect(() => parseKdsProfileView({ ...fixture(), operatorName: "someone" })).toThrow();
  });
  it("shows only authorized actions", () => {
    const denied = fixture();
    denied.permissions = {
      mayCreate: false,
      mayAssign: false,
      mayRunUat: false,
      mayPublish: false,
      mayRevoke: false,
    };
    expect(
      renderToStaticMarkup(<KdsProfileScreen view={parseKdsProfileView(denied)} />),
    ).not.toContain("<button");
  });
  it.each([
    "Loading",
    "PermissionDenied",
    "NotFound",
    "FeatureDisabled",
    "Offline",
    "Stale",
    "Conflict",
    "CommandFailed",
    "Unavailable",
  ] as const)("renders %s", (state) =>
    expect(renderToStaticMarkup(<KdsProfileState state={state} />)).toContain('role="status"'),
  );
});

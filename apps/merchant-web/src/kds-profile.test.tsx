import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { KdsProfileScreen, KdsProfileState } from "./KdsProfilePage.js";
import { parseKdsProfileView } from "./kds-profile.js";
const fixture = () => ({
  screenId: "DEV-KDS-PROFILE",
  profileReference: "018f0f58-767a-7f3b-a1d0-000000000801",
  profileLabel: "Synthetic KDS Profile",
  storeLabel: "Synthetic Training Store",
  stationLabel: "Hot line",
  browserFamily: "ChromiumManaged",
  resolution: "1920x1080",
  autoLockSeconds: 120,
  visibilityLossLocks: true,
  handoverPolicy: "LockThenRotateNamedSession",
  notificationMode: "VisualAndAudible",
  networkProcedureCode: "KDS-NETWORK-RECOVERY-V1",
  replacementProcedureCode: "KDS-REPLACEMENT-V1",
  operatorSessionStatus: "NamedLocked",
  uatStatus: "NotRun",
  uatEvidenceReference: null,
  freshnessStatus: "Fresh",
  projectedAt: "2026-08-12T16:00:00.000Z",
});
describe("WP-1808 managed KDS profile", () => {
  it("parses and renders lock, handover and unclaimed UAT", () => {
    const html = renderToStaticMarkup(<KdsProfileScreen view={parseKdsProfileView(fixture())} />);
    for (const value of [
      "DEV-KDS-PROFILE",
      "120 seconds",
      "Locks board",
      "rotate named Session",
      "Real Store device UAT is unavailable",
      "No shared username",
    ])
      expect(html).toContain(value);
  });
  it("rejects a passed UAT without exact evidence and unsafe timeout", () => {
    expect(() => parseKdsProfileView({ ...fixture(), uatStatus: "Passed" })).toThrow(
      "KDS_PROFILE_INVALID",
    );
    expect(() => parseKdsProfileView({ ...fixture(), autoLockSeconds: 10 })).toThrow(
      "KDS_PROFILE_INVALID",
    );
  });
  it("renders safe offline recovery", () => {
    expect(renderToStaticMarkup(<KdsProfileState state="Offline" />)).toContain("Lock the board");
  });
});

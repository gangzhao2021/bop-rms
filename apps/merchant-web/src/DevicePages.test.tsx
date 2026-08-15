import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DevicePageState, Devices } from "./DevicePages.js";
import { parseDeviceView } from "./device-pages.js";
const ref = (value: string) => `018f9993-0000-7000-8000-${value.padStart(12, "0")}`;
const at = "2026-08-15T10:00:00.000Z";
const first = <T,>(items: readonly T[]): T => {
  const item = items[0];
  if (item === undefined) throw new Error("synthetic Device missing");
  return item;
};
const view = () => ({
  screenId: "DEV-DEVICE-DETAIL",
  queryName: "device_management_v1",
  queryVersion: 1,
  generatedAt: at,
  sourceAsOf: at,
  freshness: "Current",
  completeness: "Complete",
  permissions: {
    mayRegister: true,
    mayAssign: true,
    mayDisable: true,
    mayOpenIncident: true,
    mayRevokeCredential: true,
    mayQuarantine: true,
    mayRetire: true,
  },
  filters: {
    labelCode: null,
    safeSerialSuffix: null,
    deviceType: null,
    storeReference: null,
    lifecycle: null,
    stationReference: null,
    offlineOnly: false,
    outdatedOnly: false,
  },
  devices: [
    {
      deviceReference: ref("1"),
      displayLabelCode: "HOT_KDS",
      safeSerialSuffix: "ABCD1234",
      deviceType: "KitchenDisplay",
      storeReference: ref("2"),
      stationReference: ref("3"),
      assignmentReference: ref("4"),
      lifecycle: "Active",
      health: "Healthy",
      connectivity: "Online",
      softwareVersionCode: "CHROME_140",
      profileVersionCode: "KDS_V1",
      lastSeenAt: at,
      capabilityCodes: ["TOUCH_INPUT"],
      configurationSourceReference: ref("5"),
      namedOperatorSessionSummaryReference: ref("6"),
      openIncidentReference: null,
      auditSummaryReference: ref("7"),
      pilotEligibility: "BrowserKds",
    },
  ],
});
describe("WP-2180 Device screens", () => {
  it("renders safe health, assignment and Pilot boundary", () => {
    const html = renderToStaticMarkup(<Devices view={parseDeviceView(view())} />);
    expect(html).toContain("DEV-DEVICE-DETAIL");
    expect(html).toContain("Pilot browser KDS eligible");
    expect(html).toContain("Quarantine");
    expect(html).not.toMatch(/Bearer |BEGIN CERTIFICATE|secret-value/u);
  });
  it("enforces detail cardinality and unique bounded Devices", () => {
    const none = view();
    none.devices = [];
    expect(() => parseDeviceView(none)).toThrow();
    const duplicate = view();
    duplicate.screenId = "DEV-DEVICE-LIST";
    duplicate.devices = [first(view().devices), first(view().devices)];
    expect(() => parseDeviceView(duplicate)).toThrow();
    const huge = view();
    huge.screenId = "DEV-DEVICE-LIST";
    huge.devices = Array.from({ length: 501 }, () => first(view().devices));
    expect(() => parseDeviceView(huge)).toThrow();
  });
  it("rejects impossible health and restricted extras", () => {
    const bad = view();
    bad.devices[0] = { ...first(bad.devices), connectivity: "Offline", health: "Healthy" };
    expect(() => parseDeviceView(bad)).toThrow();
    expect(() => parseDeviceView({ ...view(), credentialSecret: "secret" })).toThrow();
  });
  it("enforces the Pilot and Payment ownership boundaries", () => {
    const physical = view();
    physical.devices[0] = {
      ...first(physical.devices),
      deviceType: "ReceiptPrinter",
      pilotEligibility: "BrowserKds",
    };
    expect(() => parseDeviceView(physical)).toThrow();
    const payment = view();
    payment.devices[0] = {
      ...first(payment.devices),
      deviceType: "PaymentTerminalReference",
      pilotEligibility: "FutureTriggerDisabled",
    };
    expect(() => parseDeviceView(payment)).toThrow();
  });
  it("hides actions without permission", () => {
    const denied = view();
    denied.permissions = {
      mayRegister: false,
      mayAssign: false,
      mayDisable: false,
      mayOpenIncident: false,
      mayRevokeCredential: false,
      mayQuarantine: false,
      mayRetire: false,
    };
    expect(renderToStaticMarkup(<Devices view={parseDeviceView(denied)} />)).not.toContain(
      "<button",
    );
  });
  it("renders the list empty state", () => {
    const empty = view();
    empty.screenId = "DEV-DEVICE-LIST";
    empty.devices = [];
    expect(renderToStaticMarkup(<Devices view={parseDeviceView(empty)} />)).toContain("No Devices");
  });
  it.each([
    "Loading",
    "PermissionDenied",
    "NotFound",
    "FeatureDisabled",
    "Stale",
    "Conflict",
    "CommandFailed",
    "Offline",
    "Unavailable",
  ] as const)("renders %s", (state) => {
    expect(renderToStaticMarkup(<DevicePageState state={state} />)).toContain('role="status"');
  });
});

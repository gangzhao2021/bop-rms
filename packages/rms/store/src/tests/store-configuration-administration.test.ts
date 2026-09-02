import { describe, expect, it } from "vitest";
import {
  StoreConfigurationAdministrationError,
  createStoreConfigurationVersion,
  validateStoreConfigurationForPublication,
} from "../contracts/store-configuration-administration.js";

const id = (n: number) => `018f9f20-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-15T14:00:00.000Z";
const weeklySchedule = () =>
  Array.from({ length: 7 }, (_, index) => ({
    isoWeekday: index + 1,
    intervals:
      index < 5
        ? [
            {
              startLocalTime: "09:00:00",
              endLocalTime: "22:00:00",
              endsNextDay: false,
              serviceModes: ["Pickup", "DineIn"],
              orderCutoffSeconds: 900,
              leadTimeSeconds: 1200,
            },
          ]
        : [],
  }));
const published = () => ({
  configurationReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  configurationVersion: 1,
  lifecycle: "Published",
  source: "StoreOverride",
  brandBaseVersionReference: id(4),
  defaultLocale: "en-CA",
  currencyCode: "CAD",
  timeZone: "America/Toronto",
  businessDayStartLocalTime: "04:00:00",
  addressReference: id(5),
  contactReference: id(6),
  receiptReference: id(7),
  taxConfigurationReference: id(8),
  paymentConfigurationReference: id(9),
  capacityConfigurationReference: null,
  enabledServiceModes: ["DineIn", "Pickup"],
  weeklySchedule: weeklySchedule(),
  exceptions: [
    { localDate: "2026-12-25", kind: "Holiday", intervals: [] },
    {
      localDate: "2026-12-31",
      kind: "Override",
      intervals: [
        {
          startLocalTime: "10:00:00",
          endLocalTime: "18:00:00",
          endsNextDay: false,
          serviceModes: ["Pickup"],
          orderCutoffSeconds: 600,
          leadTimeSeconds: 900,
        },
      ],
    },
  ],
  effectiveFrom: at,
  effectiveUntil: null,
  supersedesConfigurationReference: null,
  reasonCode: "PILOT_CONFIGURATION",
  authoredByReference: id(10),
  approvedByReference: id(11),
  approvalEvidenceReference: id(12),
  publicationReference: id(13),
  liveGateEvidenceReference: id(14),
  createdAt: at,
  updatedAt: at,
  dataClassification: "ConfigurationMetadata",
});

describe("WP-2192 Store configuration administration", () => {
  it("accepts a closed published version, canonicalizes modes and validates publication gates", () => {
    const configuration = createStoreConfigurationVersion(published());
    expect(configuration.businessDayStartLocalTime).toBe("04:00:00");
    expect(configuration.weeklySchedule[0]?.intervals[0]?.serviceModes).toEqual([
      "DineIn",
      "Pickup",
    ]);
    expect(() => validateStoreConfigurationForPublication(configuration)).not.toThrow();
  });

  it("rejects unknown fields, invalid timezone and duplicate exception dates", () => {
    expect(() => createStoreConfigurationVersion({ ...published(), injected: true })).toThrow(
      "Store configuration administration input is invalid",
    );
    expect(() => createStoreConfigurationVersion({ ...published(), timeZone: "Toronto" })).toThrow(
      StoreConfigurationAdministrationError,
    );
    const exception = published().exceptions[0];
    expect(() =>
      createStoreConfigurationVersion({ ...published(), exceptions: [exception, exception] }),
    ).toThrow(StoreConfigurationAdministrationError);
  });

  it("rejects overlapping hours and service modes outside the enabled set", () => {
    const weekly = weeklySchedule();
    const monday = weekly[0];
    if (monday === undefined) throw new Error("fixture is invalid");
    weekly[0] = {
      isoWeekday: 1,
      intervals: [
        ...monday.intervals,
        {
          startLocalTime: "21:00:00",
          endLocalTime: "23:00:00",
          endsNextDay: false,
          serviceModes: ["Pickup"],
          orderCutoffSeconds: 0,
          leadTimeSeconds: 0,
        },
      ],
    };
    expect(() =>
      createStoreConfigurationVersion({ ...published(), weeklySchedule: weekly }),
    ).toThrow(StoreConfigurationAdministrationError);
    const value = published();
    const firstDay = value.weeklySchedule[0],
      firstInterval = firstDay?.intervals[0];
    if (firstInterval === undefined) throw new Error("fixture is invalid");
    firstInterval.serviceModes = ["Delivery"];
    const configuration = createStoreConfigurationVersion(value);
    expect(() => validateStoreConfigurationForPublication(configuration)).toThrow(
      StoreConfigurationAdministrationError,
    );
  });

  it("requires independent approval plus Publishing and Live Gate evidence", () => {
    expect(() =>
      createStoreConfigurationVersion({ ...published(), approvedByReference: id(10) }),
    ).toThrow(StoreConfigurationAdministrationError);
    expect(() =>
      createStoreConfigurationVersion({ ...published(), liveGateEvidenceReference: null }),
    ).toThrow(StoreConfigurationAdministrationError);
  });
});

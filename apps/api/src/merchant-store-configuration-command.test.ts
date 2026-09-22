import { expect, it } from "vitest";
import { bindMerchantStoreConfigurationCommand } from "./merchant-store-configuration-command.js";
const id = (n: number) => `018f9f40-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-15T14:00:00.000Z";
const configuration = (lifecycle: "Draft" | "PendingApproval" | "Approved" | "Published") => ({
  configurationReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  configurationVersion: 1,
  lifecycle,
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
  enabledServiceModes: ["Pickup"],
  weeklySchedule: Array.from({ length: 7 }, (_, index) => ({
    isoWeekday: index + 1,
    intervals:
      index === 0
        ? [
            {
              startLocalTime: "09:00:00",
              endLocalTime: "17:00:00",
              endsNextDay: false,
              serviceModes: ["Pickup"],
              orderCutoffSeconds: 0,
              leadTimeSeconds: 600,
            },
          ]
        : [],
  })),
  exceptions: [],
  effectiveFrom: at,
  effectiveUntil: null,
  supersedesConfigurationReference: null,
  reasonCode: "PILOT_CONFIGURATION",
  authoredByReference: id(10),
  approvedByReference: lifecycle === "Approved" || lifecycle === "Published" ? id(11) : null,
  approvalEvidenceReference: lifecycle === "Approved" || lifecycle === "Published" ? id(12) : null,
  publicationReference: lifecycle === "Published" ? id(13) : null,
  liveGateEvidenceReference: lifecycle === "Published" ? id(14) : null,
  createdAt: at,
  updatedAt: at,
  dataClassification: "ConfigurationMetadata",
});

const context = {
  brandReference: id(2),
  storeReference: id(3),
  actorReference: id(10),
  observedAt: at,
};
const body = {
  command: "SaveDraft",
  operationReference: id(20),
  auditReference: id(21),
  expectedVersion: 0,
  configuration: configuration("Draft"),
};
it("binds stable intent to server actor, scope, purpose and current time", () => {
  const result = bindMerchantStoreConfigurationCommand(body, context);
  expect(result.method).toBe("saveDraft");
  expect(result.input.actorReference).toBe(id(10));
  expect(result.input.purposeCode).toBe("STORE_CONFIGURATION");
  expect(result.input.occurredAt).toBe(at);
  expect(Object.isFrozen(result.input)).toBe(true);
});
it.each(["actorReference", "brandReference", "storeReference", "purposeCode", "occurredAt"])(
  "rejects injected server field %s",
  (field) => {
    expect(() =>
      bindMerchantStoreConfigurationCommand({ ...body, [field]: "injected" }, context),
    ).toThrow("STORE_CONFIGURATION_COMMAND_INVALID");
  },
);
it.each([
  { ...body, command: "toString" },
  { ...body, expectedVersion: -1 },
  { ...body, configuration: { ...body.configuration, storeReference: id(99) } },
  { ...body, configuration: { ...body.configuration, brandReference: id(99) } },
  { ...body, configuration: { ...body.configuration, updatedAt: "2026-08-16T14:00:00.000Z" } },
])("rejects invalid command or foreign/future configuration", (value) => {
  expect(() => bindMerchantStoreConfigurationCommand(value, context)).toThrow(
    "STORE_CONFIGURATION_COMMAND_INVALID",
  );
});
it("rejects an accessor without evaluating it", () => {
  let read = false;
  const value = { ...body };
  Object.defineProperty(value, "configuration", {
    enumerable: true,
    get() {
      read = true;
      return body.configuration;
    },
  });
  expect(() => bindMerchantStoreConfigurationCommand(value, context)).toThrow(
    "STORE_CONFIGURATION_COMMAND_INVALID",
  );
  expect(read).toBe(false);
});

it("binds draft authorship to current server actor", () => {
  const result = bindMerchantStoreConfigurationCommand(body, {
    ...context,
    actorReference: id(99),
  });
  expect(result.input.configuration.authoredByReference).toBe(id(99));
});

it("binds a pending approval to the current independent actor and stable operation reference", () => {
  const result = bindMerchantStoreConfigurationCommand(
    {
      ...body,
      command: "Approve",
      expectedVersion: 1,
      configuration: configuration("PendingApproval"),
    },
    { ...context, actorReference: id(11) },
  );
  expect(result.input.configuration).toMatchObject({
    lifecycle: "Approved",
    approvedByReference: id(11),
    approvalEvidenceReference: body.operationReference,
  });
});
it("rejects approval of the current actor's own pending draft", () => {
  expect(() =>
    bindMerchantStoreConfigurationCommand(
      {
        ...body,
        command: "Approve",
        expectedVersion: 1,
        configuration: configuration("PendingApproval"),
      },
      context,
    ),
  ).toThrow("STORE_CONFIGURATION_COMMAND_INVALID");
});

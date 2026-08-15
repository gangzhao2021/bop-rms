import { describe, expect, it } from "vitest";
import {
  createStoreConfigurationAdministrationService,
  StoreConfigurationAdministrationServiceError,
} from "../application/store-configuration-administration-service.js";
import type {
  StoreConfigurationAdministrationPorts,
  StoreConfigurationOperation,
} from "../application/ports/store-configuration-administration-ports.js";
import { createStoreConfigurationVersion } from "../contracts/store-configuration-administration.js";

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
const command = (value: unknown, operationReference = id(20), actorReference = id(10)) => ({
  operationReference,
  actorReference,
  purposeCode: "STORE.CONFIGURATION",
  auditReference: id(21),
  expectedVersion: 0,
  occurredAt: at,
  configuration: value,
});

function ports(current: ReturnType<typeof createStoreConfigurationVersion> | null = null) {
  const operations = new Map<string, StoreConfigurationOperation>();
  const value: StoreConfigurationAdministrationPorts = {
    authorization: {
      async authorize() {
        return true;
      },
    },
    repository: {
      async resolveOperation(reference) {
        return operations.get(reference) ?? null;
      },
      async loadLatest() {
        return current;
      },
      async commit(input) {
        operations.set(input.operation.operationReference, input.operation);
        return input.operation;
      },
    },
    references: {
      hashIntent(input) {
        return `sha256:${input.length.toString(16).padStart(64, "0")}`;
      },
      equals(left, right) {
        return left === right;
      },
      async validateControlledReferences() {
        return true;
      },
      async validateBrandBaseCompatibility() {
        return true;
      },
    },
    approval: {
      async validate() {
        return true;
      },
    },
    publishing: {
      async validate() {
        return true;
      },
    },
    liveGate: {
      async validate() {
        return true;
      },
    },
  };
  return { value, operations };
}

describe("WP-2192 Store configuration administration service", () => {
  it("authorizes, validates references, commits a versioned draft and replays idempotently", async () => {
    const harness = ports(),
      service = createStoreConfigurationAdministrationService(harness.value);
    const input = command(configuration("Draft"));
    await expect(service.saveDraft(input)).resolves.toMatchObject({ status: "Applied" });
    await expect(service.saveDraft(input)).resolves.toMatchObject({ status: "AlreadyApplied" });
    await expect(service.saveDraft({ ...input, purposeCode: "OTHER" })).rejects.toMatchObject({
      code: "STORE_CONFIGURATION_IDEMPOTENCY_CONFLICT",
    });
  });

  it("requires exact version and fail-closed Publishing and Live Gate validation", async () => {
    const approved = createStoreConfigurationVersion(configuration("Approved"));
    const harness = ports(approved),
      service = createStoreConfigurationAdministrationService(harness.value);
    const next = { ...configuration("Published"), updatedAt: "2026-08-15T15:00:00.000Z" };
    const input = { ...command(next, id(22), id(11)), expectedVersion: 1 };
    harness.value.liveGate.validate = async () => false;
    await expect(service.publish(input)).rejects.toMatchObject({
      code: "STORE_CONFIGURATION_LIVE_GATE_INVALID",
    });
    harness.value.liveGate.validate = async () => true;
    await expect(service.publish(input)).resolves.toMatchObject({ status: "Applied" });
    await expect(
      service.publish({ ...input, operationReference: id(23), expectedVersion: 0 }),
    ).rejects.toBeInstanceOf(StoreConfigurationAdministrationServiceError);
  });
});

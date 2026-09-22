import { beforeEach, expect, it, vi } from "vitest";
import { createMerchantStoreConfiguration } from "./merchant-store-configuration.js";
import type { createPersistentStoreConfigurationReview } from "@rms/store";
const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  review: vi.fn(),
  preparation: vi.fn(),
  administration: vi.fn(),
}));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => mocks.resolve }));
vi.mock("@rms/store", async (original) => ({
  ...(await original<typeof import("@rms/store")>()),
  createPersistentStoreConfigurationReview: mocks.review,
  createPersistentStoreApprovalPreparation: mocks.preparation,
  createPersistentStoreConfigurationAdministration: mocks.administration,
}));
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

type ReviewOptions = Parameters<typeof createPersistentStoreConfigurationReview>[0];
type ReviewInput = Parameters<ReturnType<typeof createPersistentStoreConfigurationReview>>[0];
beforeEach(() => vi.clearAllMocks());
function setup() {
  const decision = Object.freeze({
    effect: "Allow" as "Allow" | "Deny",
    action: "publishing.review.approve",
    scopeKind: "Store",
  });
  const scope = {
    selected: { tenantReference: id(40) },
    context: { actor: { actorReference: id(11) }, brand: { brandReference: id(2) } },
    store: { storeReference: id(3) },
    actorReference: id(11),
    allowed: vi.fn(async () => true),
    authorizeAction: vi.fn(async () => decision),
  };
  mocks.resolve.mockResolvedValue(scope);
  const prepare = vi.fn(async () => ({
    kind: "Approve",
    configuration: configuration("Approved"),
    snapshot: { actorReference: id(11) },
    // Deliberately injected runtime context must be overwritten by the API.
    publishingApproval: { tenantContext: { actor: { actorReference: id(99) } } },
  }));
  mocks.preparation.mockReturnValue(prepare);
  const inputs: ReviewInput[] = [];
  mocks.review.mockImplementation((options: ReviewOptions) => async (input: ReviewInput) => {
    inputs.push(input);
    const result = await options
      .publishingAuthorization({ query: async () => undefined })
      .authorize({
        action: "publishing.review.approve",
      } as never);
    if (result.effect !== "Allow") throw new Error("PUBLISHING_PERMISSION_DENIED");
    return { status: "Applied", operation: { resultingVersion: 1 } };
  });
  const service = createMerchantStoreConfiguration({
    persistence: {
      now: () => at,
      transactions: { run: async (work: (tx: object) => Promise<unknown>) => work({}) },
    },
    authentication: { authorize: async () => ({ sessionReference: id(30) }) },
    actionPermissions: {
      saveDraft: "store.service.save-draft",
      validate: "store.service.validate",
      submit: "store.service.submit",
      approve: "store.service.approve",
      publish: "store.service.publish",
    },
    configure: () => ({ publication: { authorize: async () => true }, ports: () => ({}) }),
    review: { validate: async () => undefined, snapshotAudit: async () => undefined },
  } as unknown as Parameters<typeof createMerchantStoreConfiguration>[0]);
  const request = {
    sessionCookie: "synthetic",
    csrf: "synthetic",
    command: {
      command: "Approve",
      operationReference: id(20),
      auditReference: id(21),
      expectedVersion: 1,
      configuration: configuration("Approved"),
    },
  };
  return { service, request, scope, prepare, inputs };
}
it("routes approval through atomic workflow using server context and current Publishing decision", async () => {
  const f = setup();
  expect(await f.service(f.request)).toEqual({ status: "Applied", resultingVersion: 1 });
  expect(f.inputs[0]?.publishingApproval.tenantContext).toBe(f.scope.context);
  expect(f.inputs[0]?.storeCommand).toMatchObject({ actorReference: id(11), occurredAt: at });
  expect(f.scope.authorizeAction).toHaveBeenCalledWith("publishing.review.approve");
  expect(mocks.administration).not.toHaveBeenCalled();
});
it("rechecks Store authorization after preparation before Publishing approval", async () => {
  const f = setup();
  const prepare = f.prepare.getMockImplementation();
  if (!prepare) throw new Error("Synthetic preparation is missing");
  f.prepare.mockImplementation(async () => {
    f.scope.allowed.mockResolvedValue(false);
    return prepare();
  });
  await expect(f.service(f.request)).rejects.toThrow("STORE_CONFIGURATION_PERMISSION_DENIED");
  expect(f.scope.authorizeAction).not.toHaveBeenCalled();
});
it("passes current Publishing denial through without manufacturing an Allow", async () => {
  const f = setup();
  f.scope.authorizeAction.mockResolvedValue(
    Object.freeze({
      effect: "Deny",
      action: "publishing.review.approve",
      scopeKind: "Store",
    }),
  );
  await expect(f.service(f.request)).rejects.toThrow("PUBLISHING_PERMISSION_DENIED");
});
it("rejects tenant selection drift before preparing approval", async () => {
  const f = setup();
  mocks.resolve
    .mockReset()
    .mockResolvedValueOnce(f.scope)
    .mockResolvedValueOnce({
      ...f.scope,
      selected: { tenantReference: id(99) },
    });
  await expect(f.service(f.request)).rejects.toThrow("STORE_CONFIGURATION_PERMISSION_DENIED");
  expect(f.prepare).not.toHaveBeenCalled();
});

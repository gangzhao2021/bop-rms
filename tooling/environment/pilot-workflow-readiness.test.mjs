import { expect, it, vi } from "vitest";
import { readInternalWorkflowReadiness } from "./pilot-workflow-readiness.mjs";

const id = (n) => "0190999a-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-11-05T10:00:00.000Z";
const transition = {
  transitionReference: id(8),
  currentState: "CartReady",
  action: "SubmitOrder",
  nextState: "Submitted",
  permissionCode: "order.submit",
  ruleReferences: [],
  effects: [],
};
const definition = (overrides = {}) => ({
  schemaVersion: 1,
  workflowReference: id(10),
  versionReference: id(11),
  versionNumber: 2,
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: null,
  purposeCode: "OrderFulfillment",
  applicabilityCode: "Pickup",
  lifecycle: "Published",
  baseVersionReference: null,
  overrideAuthorizationReference: null,
  effectiveFrom: "2026-11-01T00:00:00.000Z",
  effectiveUntil: null,
  publicationReference: id(12),
  approvalEvidenceReference: id(13),
  authoredByReference: id(14),
  createdAt: "2026-11-01T00:00:00.000Z",
  transitions: [transition],
  ...overrides,
});
const resources = (rowsFor) => ({
  publicProfile: { binding: { tenantReference: id(1) } },
  scope: { brandReference: id(2), storeReference: id(3) },
  now: () => at,
  transactions: {
    run: async (work) =>
      work({
        query: async (sql, values) =>
          sql.startsWith("SELECT definition_json")
            ? { rows: rowsFor(values[3], values[4]).map((definition) => ({ definition })) }
            : { rows: [] },
      }),
  },
});
const binding = (version = id(11), purposeCode = "OrderFulfillment") => ({
  workflow: { purposeCode, payment: { workflowVersionReference: version } },
});
const installation = (bindings, cancellation = null) => ({
  loadWorkflow: async (kind) => {
    if (bindings[kind] === undefined) throw new Error("PILOT_INSTALLATION_UNAVAILABLE");
    return bindings[kind];
  },
  loadCancellationWorkflow: async () => {
    if (cancellation === null) throw new Error("PILOT_INSTALLATION_UNAVAILABLE");
    return cancellation;
  },
});
const pickupOnly = (purpose, applicability) =>
  purpose === "OrderFulfillment" && applicability === "Pickup" ? [definition()] : [];

it("asks the owner's resolver about every binding the Store loads", async () => {
  const asked = [];
  const rows = (purpose, applicability) => {
    asked.push(`${purpose}/${applicability}`);
    return [
      definition({
        purposeCode: purpose,
        applicabilityCode: applicability,
        versionReference: { Pickup: id(11), DineIn: id(21) }[applicability],
      }),
    ];
  };
  const cancellationFamily = definition({ purposeCode: "UnpaidDineInBatchCancellation" });
  expect(
    await readInternalWorkflowReadiness(
      resources((purpose, applicability) =>
        purpose === "UnpaidDineInBatchCancellation"
          ? (asked.push(`${purpose}/${applicability}`),
            [{ ...cancellationFamily, applicabilityCode: applicability }])
          : rows(purpose, applicability),
      ),
      installation(
        {
          Pickup: binding(id(11)),
          DineIn: binding(id(21)),
          AdditionalRelease: binding(id(21), "OrderFulfillmentAdditionalRound"),
        },
        { definition: cancellationFamily },
      ),
    ),
  ).toEqual({ ready: true });
  expect(asked).toEqual([
    "OrderFulfillment/Pickup",
    "OrderFulfillment/DineIn",
    "OrderFulfillmentAdditionalRound/DineIn",
    "UnpaidDineInBatchCancellation/DineIn",
  ]);
});

it("names the rule when two families refuse, an order Workflow before the cancellation one", async () => {
  const two = (purpose, applicability) => [
    definition({ purposeCode: purpose, applicabilityCode: applicability }),
    definition({
      purposeCode: purpose,
      applicabilityCode: applicability,
      workflowReference: id(40),
      versionReference: id(41),
    }),
  ];
  expect(
    await readInternalWorkflowReadiness(
      resources(two),
      installation(
        { Pickup: binding() },
        { definition: definition({ purposeCode: "UnpaidDineInBatchCancellation" }) },
      ),
    ),
  ).toEqual({ ready: false, reason: "Orders", rule: "TwoBrandVersions" });
  expect(
    await readInternalWorkflowReadiness(
      resources((purpose, applicability) =>
        purpose === "UnpaidDineInBatchCancellation"
          ? [
              definition({
                purposeCode: purpose,
                applicabilityCode: applicability,
                lifecycle: "Withdrawn",
              }),
            ]
          : pickupOnly(purpose, applicability),
      ),
      installation(
        { Pickup: binding() },
        { definition: definition({ purposeCode: "UnpaidDineInBatchCancellation" }) },
      ),
    ),
  ).toEqual({ ready: false, reason: "Cancellation", rule: "BrandVersionNotActive" });
});

it("refuses a binding naming another version than the one that resolves", async () => {
  expect(
    await readInternalWorkflowReadiness(
      resources(pickupOnly),
      installation({ Pickup: binding(id(99)) }),
    ),
  ).toEqual({ ready: false, reason: "Orders", rule: "ExpectedVersionChanged" });
});

it("does not ask about a binding that does not load, and says nothing is wrong with none", async () => {
  const rows = vi.fn(pickupOnly);
  expect(
    await readInternalWorkflowReadiness(resources(rows), installation({ Pickup: binding() })),
  ).toEqual({ ready: true });
  expect(rows).toHaveBeenCalledTimes(1);
  expect(await readInternalWorkflowReadiness(resources(rows), installation({}))).toEqual({
    ready: true,
  });
  expect(rows).toHaveBeenCalledTimes(1);
});

it("throws when the read itself failed, so the monitor says it could not check", async () => {
  const failing = {
    ...resources(pickupOnly),
    transactions: {
      run: async (work) =>
        work({
          query: async () => {
            throw Object.assign(new Error("lock timeout"), { code: "55P03" });
          },
        }),
    },
  };
  await expect(
    readInternalWorkflowReadiness(failing, installation({ Pickup: binding() })),
  ).rejects.toMatchObject({ code: "WORKFLOW_DEFINITION_UNAVAILABLE", rule: "Dependency" });
});

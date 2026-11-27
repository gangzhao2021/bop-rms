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
/** One database answering the Workflow rows and, separately, the Store's published order types. */
const resources = (rowsFor, modes = ["DineIn", "Pickup"]) => ({
  publicProfile: { binding: { tenantReference: id(1) } },
  scope: { brandReference: id(2), storeReference: id(3) },
  now: () => at,
  transactions: {
    run: async (work) =>
      work({
        query: async (sql, values) => {
          if (sql.startsWith("SELECT definition_json"))
            return {
              rows: rowsFor(values[3], values[4]).map((definition) => ({ definition })),
            };
          if (sql.includes("enabled_service_modes")) {
            if (modes instanceof Error) throw modes;
            return { rows: modes === null ? [] : [{ enabled_service_modes: modes }] };
          }
          return { rows: [] };
        },
      }),
  },
});
const binding = (version = id(11), purposeCode = "OrderFulfillment") => ({
  workflow: { purposeCode, payment: { workflowVersionReference: version } },
});
const cancellationFamily = definition({
  purposeCode: "UnpaidDineInBatchCancellation",
  applicabilityCode: "DineIn",
  workflowReference: id(50),
  versionReference: id(51),
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
/** A Store with every binding, each naming the version the Brand's healthy rows resolve to. */
const whole = (overrides = {}, cancellation = { definition: cancellationFamily }) =>
  installation(
    {
      Pickup: binding(id(11)),
      DineIn: binding(id(21)),
      AdditionalRelease: binding(id(31), "OrderFulfillmentAdditionalRound"),
      ...overrides,
    },
    cancellation,
  );
const healthy = (purpose, applicability) =>
  purpose === "UnpaidDineInBatchCancellation"
    ? [cancellationFamily]
    : [
        definition({
          purposeCode: purpose,
          applicabilityCode: applicability,
          versionReference:
            purpose === "OrderFulfillmentAdditionalRound"
              ? id(31)
              : { Pickup: id(11), DineIn: id(21) }[applicability],
        }),
      ];
/** Healthy, except that these purposes and order types have nothing the resolver can use. */
const withdrawing =
  (...keys) =>
  (purpose, applicability) =>
    keys.includes(`${purpose}/${applicability}`)
      ? healthy(purpose, applicability).map((row) => ({ ...row, lifecycle: "Withdrawn" }))
      : healthy(purpose, applicability);

it("asks the owner's resolver about every binding the Store loads", async () => {
  const asked = [];
  const rows = (purpose, applicability) => {
    asked.push(`${purpose}/${applicability}`);
    return healthy(purpose, applicability);
  };
  expect(await readInternalWorkflowReadiness(resources(rows), whole())).toEqual({ ready: true });
  expect(asked).toEqual([
    "OrderFulfillment/Pickup",
    "OrderFulfillment/DineIn",
    "OrderFulfillmentAdditionalRound/DineIn",
    "UnpaidDineInBatchCancellation/DineIn",
  ]);
});

it("names each binding that refused and the rule, with what the Store offers", async () => {
  const two = (purpose, applicability) => [
    ...healthy(purpose, applicability),
    definition({
      purposeCode: purpose,
      applicabilityCode: applicability,
      workflowReference: id(40),
      versionReference: id(41),
    }),
  ];
  expect(await readInternalWorkflowReadiness(resources(two), whole())).toEqual({
    ready: false,
    refusals: [
      { binding: "Pickup", rule: "TwoBrandVersions" },
      { binding: "DineIn", rule: "TwoBrandVersions" },
      { binding: "AdditionalRelease", rule: "TwoBrandVersions" },
      { binding: "Cancellation", rule: "TwoBrandVersions" },
    ],
    orderTypes: ["DineIn", "Pickup"],
  });
});

it("says which one when only one binding refused", async () => {
  expect(
    await readInternalWorkflowReadiness(
      resources(withdrawing("OrderFulfillment/Pickup"), ["DineIn"]),
      whole(),
    ),
  ).toEqual({
    ready: false,
    refusals: [{ binding: "Pickup", rule: "BrandVersionNotActive" }],
    orderTypes: ["DineIn"],
  });
  expect(
    await readInternalWorkflowReadiness(
      resources(withdrawing("OrderFulfillmentAdditionalRound/DineIn")),
      whole(),
    ),
  ).toMatchObject({ refusals: [{ binding: "AdditionalRelease", rule: "BrandVersionNotActive" }] });
  expect(
    await readInternalWorkflowReadiness(
      resources(withdrawing("UnpaidDineInBatchCancellation/DineIn")),
      whole(),
    ),
  ).toMatchObject({ refusals: [{ binding: "Cancellation", rule: "BrandVersionNotActive" }] });
});

it("tells a binding naming another version from a refusal", async () => {
  expect(
    await readInternalWorkflowReadiness(resources(healthy), whole({ DineIn: binding(id(99)) })),
  ).toEqual({
    ready: false,
    refusals: [{ binding: "DineIn", rule: "ExpectedVersionChanged" }],
    orderTypes: ["DineIn", "Pickup"],
  });
});

it("holds the cancellation binding to what its worker checks: the family and its transitions", async () => {
  const another = (overrides) => ({
    definition: { ...cancellationFamily, ...overrides },
  });
  // A newer version of the same family serves it: the worker follows the family, not one version.
  expect(
    await readInternalWorkflowReadiness(
      resources(healthy),
      whole({}, another({ versionReference: id(52) })),
    ),
  ).toEqual({ ready: true });
  for (const changed of [
    { workflowReference: id(53) },
    { transitions: [{ ...transition, action: "SomethingElse" }] },
  ])
    expect(
      await readInternalWorkflowReadiness(resources(healthy), whole({}, another(changed))),
    ).toMatchObject({ refusals: [{ binding: "Cancellation", rule: "ExpectedVersionChanged" }] });
});

it("still raises a refusal when another binding does not load", async () => {
  const pickupRefused = withdrawing("OrderFulfillment/Pickup");
  expect(
    await readInternalWorkflowReadiness(
      resources(pickupRefused),
      installation({ Pickup: binding(id(11)) }),
    ),
  ).toEqual({
    ready: false,
    refusals: [{ binding: "Pickup", rule: "BrandVersionNotActive" }],
    orderTypes: ["DineIn", "Pickup"],
  });
});

it("cannot say all is well when a binding does not load or names nothing to ask about", async () => {
  // Services keep the copy they loaded at start: only the next restart would notice.
  for (const store of [
    installation({ Pickup: binding(id(11)) }),
    whole({}, null),
    whole({ DineIn: { workflow: { payment: { workflowVersionReference: id(21) } } } }),
    whole({ DineIn: { workflow: { purposeCode: "OrderFulfillment" } } }),
    whole({}, { definition: { purposeCode: "UnpaidDineInBatchCancellation" } }),
  ])
    await expect(readInternalWorkflowReadiness(resources(healthy), store)).rejects.toThrow(
      "PILOT_WORKFLOW_BINDING_UNAVAILABLE",
    );
});

it("tells a Store not installed yet from one that lost its bindings", async () => {
  // Opening step 4 lists the Store before step 5 installs its Workflows: nothing to check yet.
  const asked = vi.fn(() => []);
  expect(await readInternalWorkflowReadiness(resources(asked), installation({}))).toBeNull();
  expect(asked).toHaveBeenCalledTimes(4);
  // The Brand has its Workflows, so a Store without one binding file is not simply not installed.
  await expect(readInternalWorkflowReadiness(resources(healthy), installation({}))).rejects.toThrow(
    "PILOT_WORKFLOW_BINDING_UNAVAILABLE",
  );
  // Even when what the Brand holds is itself refused.
  await expect(
    readInternalWorkflowReadiness(
      resources(withdrawing("UnpaidDineInBatchCancellation/DineIn")),
      installation({}),
    ),
  ).rejects.toThrow("PILOT_WORKFLOW_BINDING_UNAVAILABLE");
});

it("calls a refused Store offering every order type when its order types cannot be read", async () => {
  // A refusal is never hidden by the second read; no published configuration answers the same.
  for (const modes of [new Error("lock timeout"), null])
    expect(
      await readInternalWorkflowReadiness(
        resources(withdrawing("OrderFulfillment/Pickup"), modes),
        whole(),
      ),
    ).toMatchObject({ orderTypes: ["Pickup", "DineIn"] });
});

it("does not read the order types while every binding is healthy", async () => {
  const queries = [];
  const store = resources(healthy);
  const run = store.transactions.run;
  store.transactions.run = (work) =>
    run((tx) =>
      work({
        query: (sql, values) => {
          queries.push(sql);
          return tx.query(sql, values);
        },
      }),
    );
  await readInternalWorkflowReadiness(store, whole());
  expect(queries.some((sql) => sql.includes("enabled_service_modes"))).toBe(false);
});

it("throws when the read itself failed, so the monitor says it could not check", async () => {
  const failing = {
    ...resources(healthy),
    transactions: {
      run: async (work) =>
        work({
          query: async () => {
            throw Object.assign(new Error("lock timeout"), { code: "55P03" });
          },
        }),
    },
  };
  await expect(readInternalWorkflowReadiness(failing, whole())).rejects.toMatchObject({
    code: "WORKFLOW_DEFINITION_UNAVAILABLE",
    rule: "Dependency",
  });
  await expect(readInternalWorkflowReadiness(failing, installation({}))).rejects.toMatchObject({
    code: "WORKFLOW_DEFINITION_UNAVAILABLE",
    rule: "Dependency",
  });
});

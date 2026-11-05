import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";
import {
  matchesPlatformWorkflow,
  orderWorkflowReleases,
  platformWorkflows,
} from "./platform-workflows.mjs";
import {
  derivedReference,
  failureLine,
  installedStatus,
  operationInstant,
  parseArguments,
  planWorkflowRelease,
  readExistingBinding,
  requireReleasedOrderPurposes,
  requireSameBinding,
  runtimeFileName,
  workflowRuntimeFile,
} from "./workflow-release-install.mjs";

const id = (n) => "0190999a-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const operation = "01a1d400-0000-7000-8000-000000000001";
const flags = {
  "--env-file": "a.env",
  "--confirm-target": "local:db",
  "--workflow": "UnpaidDineInBatchCancellation",
  "--runtime-environment": "Pilot",
  "--tenant": id(1),
  "--brand": id(2),
  "--store": id(3),
  "--operator": id(5),
  "--approved-by": id(6),
  "--approval-evidence": id(7),
  "--operation": operation,
  "--output": "stores/tea/cancellation-workflow-draft-result.json",
};
const args = (overrides = {}) =>
  Object.entries({ ...flags, ...overrides }).flatMap(([flag, value]) => [flag, value]);

it("requires every release flag once, a known Workflow and an independent approver", () => {
  assert.equal(parseArguments(args()).approvedByReference, id(6));
  assert.throws(() => parseArguments(args().slice(0, -2)), /usage/u);
  assert.throws(() => parseArguments([...args(), "--force", "x"]), /usage/u);
  assert.throws(() => parseArguments(args({ "--workflow": "AnythingElse" })), /usage/u);
  assert.throws(() => parseArguments(args({ "--runtime-environment": "Production" })), /usage/u);
  assert.throws(
    () => parseArguments(args({ "--operation": "0190999a-0000-4000-8000-000000000009" })),
    /usage/u,
  );
  assert.throws(
    () => parseArguments(args({ "--approved-by": id(5) })),
    /WORKFLOW_RELEASE_APPROVER_NOT_INDEPENDENT/u,
  );
});

it("derives every reference and instant from the operation so a rerun replays it exactly", () => {
  const value = derivedReference(operation, "workflow");
  assert.match(value, /^01a1d400-0000-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.equal(derivedReference(operation, "workflow"), value);
  assert.notEqual(derivedReference(operation, "release"), value);
  assert.equal(operationInstant(operation), new Date(0x01a1d4000000).toISOString());
  const options = parseArguments(args());
  assert.deepEqual(planWorkflowRelease(options), planWorkflowRelease(options));
});

it("plans a Brand-wide, non-expiring Workflow approved by the approver and published by the operator", () => {
  const plan = planWorkflowRelease(parseArguments(args()));
  assert.equal(plan.draft.lifecycle, "Draft");
  assert.equal(plan.published.lifecycle, "Published");
  assert.equal(plan.published.storeReference, null);
  assert.equal(plan.published.effectiveUntil, null);
  assert.equal(plan.published.publicationReference, plan.release.releaseId);
  assert.equal(plan.published.approvalEvidenceReference, id(7));
  assert.deepEqual(
    plan.publishing.map((m) => [m.operation, m.audit.actor.reference]),
    [
      ["CreateDraft", id(5)],
      ["SubmitReview", id(5)],
      ["Approve", id(6)],
      ["Publish", id(5)],
    ],
  );
  assert.equal(plan.publishing[2].approvalEvidence.approvedActorReference, id(6));
  assert.equal(matchesPlatformWorkflow(plan.published), true);
  assert.deepEqual(
    plan.published.transitions.map((t) => `${t.currentState}>${t.nextState}`),
    [
      "Submitted>Submitted",
      "Submitted>Cancelled",
      "Accepted>Accepted",
      "InProgress>InProgress",
      "InProgress>Ready",
      "InProgress>Fulfilled",
    ],
  );
});

it("accepts only an unchanged, Brand-wide, non-expiring released Workflow", () => {
  const published = planWorkflowRelease(parseArguments(args())).published;
  assert.equal(matchesPlatformWorkflow({ ...published, storeReference: id(3) }), false);
  assert.equal(
    matchesPlatformWorkflow({ ...published, effectiveUntil: "2026-10-20T00:00:00.000Z" }),
    false,
  );
  assert.equal(
    matchesPlatformWorkflow({
      ...published,
      transitions: published.transitions.map((t, i) =>
        i === 2 ? { ...t, permissionCode: "order.cancel" } : t,
      ),
    }),
    false,
  );
  assert.equal(
    matchesPlatformWorkflow({ ...published, purposeCode: "InternalTestBatchCancellation" }),
    false,
  );
});

const orderOptions = (release = "OrderFulfillmentPickup") => ({
  ...parseArguments(args()),
  release,
});
const later = "2026-12-01T00:00:00.000Z";

it("refuses an output named for another release, the mistake that once broke a Brand", () => {
  for (const release of orderWorkflowReleases) {
    const name = `internal-test-workflow-${platformWorkflows[release].binding}.json`;
    assert.equal(runtimeFileName(release), name);
    assert.equal(
      parseArguments(args({ "--workflow": release, "--output": "stores/tea/" + name })).output,
      "stores/tea/" + name,
    );
  }
  assert.throws(
    () =>
      parseArguments(
        args({
          "--workflow": "OrderFulfillmentPickup",
          "--output": "stores/tea/internal-test-workflow-DineIn.json",
        }),
      ),
    /WORKFLOW_RELEASE_OUTPUT_MISMATCH/u,
  );
  assert.throws(
    () => parseArguments(args({ "--output": "stores/tea/out.json" })),
    /WORKFLOW_RELEASE_OUTPUT_MISMATCH/u,
  );
});

it("says what the Brand's one family is to this release", () => {
  const published = planWorkflowRelease(orderOptions()).published;
  const status = (definition, release = "OrderFulfillmentPickup") =>
    installedStatus(definition, release, later);
  assert.equal(status(published), "AlreadyInstalled");
  for (const lifecycle of ["Draft", "Withdrawn"])
    assert.equal(status({ ...published, lifecycle }), null);
  assert.equal(status({ ...published, effectiveUntil: later }), null);
  assert.equal(status({ ...published, effectiveFrom: "2027-01-01T00:00:00.000Z" }), null);
  // The repository moved on, but the Brand's family still serves it and can be bound.
  const older = {
    ...published,
    transitions: published.transitions.filter((t) => t.currentState !== "Ready"),
  };
  assert.equal(matchesPlatformWorkflow(older), false);
  assert.equal(status(older), "AlreadyInstalledOlderDefinition");
  // Refused when a binding cannot name it, or the compositions would refuse its payment step.
  assert.equal(
    status({
      ...published,
      transitions: published.transitions.filter((t) => t.action !== "FulfillOrder"),
    }),
    null,
  );
  const changed = (action, patch) => ({
    ...published,
    transitions: published.transitions.map((t) =>
      t.action === action && t.currentState === "Submitted" ? { ...t, ...patch } : t,
    ),
  });
  assert.equal(status(changed("CreatePaymentIntent", { effects: [] })), null);
  assert.equal(status(changed("CreatePaymentIntent", { ruleReferences: [] })), null);
  // The cancellation worker accepts only the repository's current definition.
  const cancellation = planWorkflowRelease(orderOptions("UnpaidDineInBatchCancellation")).published;
  assert.equal(status(cancellation, "UnpaidDineInBatchCancellation"), "AlreadyInstalled");
  assert.equal(
    status(
      { ...cancellation, transitions: cancellation.transitions.slice(1) },
      "UnpaidDineInBatchCancellation",
    ),
    null,
  );
});

const runtime = (published, overrides = {}, release = "OrderFulfillmentPickup") =>
  workflowRuntimeFile(
    { published },
    {
      environment: "InternalTest",
      database: "db",
      scope: { tenantReference: id(1), brandReference: id(2), storeReference: id(3) },
      operationReference: operation,
      release,
      ...overrides,
    },
  );

it("writes a binding from a published version without its plan, and refuses one it cannot name", () => {
  const published = planWorkflowRelease(orderOptions()).published;
  const file = runtime(published);
  assert.equal(file.release, "OrderFulfillmentPickup");
  assert.equal(file.workflow.payment.workflowVersionReference, published.versionReference);
  assert.equal(file.workflow.reserveCommandCode, "ReserveInventory");
  assert.equal(file.workflow.payment.paymentCommandCode, "CreatePaymentIntent");
  assert.throws(
    () =>
      runtime({
        ...published,
        transitions: published.transitions.filter((t) => t.action !== "Accept"),
      }),
    /WORKFLOW_RELEASE_BINDING_UNAVAILABLE/u,
  );
});

it("leaves a binding naming the same thing alone and refuses to move one naming anything else", () => {
  const published = planWorkflowRelease(orderOptions()).published;
  const next = runtime(published);
  // The same release and version, written by an earlier run under another operation.
  requireSameBinding({ ...next, operationReference: id(90) }, next);
  // From before this tool: no `release`, what it names still compared.
  requireSameBinding({ ...next, release: undefined }, next);
  const conflict = /WORKFLOW_RELEASE_BINDING_CONFLICT/u;
  assert.throws(
    () => requireSameBinding({ ...next, release: "OrderFulfillmentDineIn" }, next),
    conflict,
  );
  assert.throws(
    () =>
      requireSameBinding(
        {
          ...next,
          workflow: {
            ...next.workflow,
            payment: { ...next.workflow.payment, workflowVersionReference: id(91) },
          },
        },
        next,
      ),
    conflict,
  );
  assert.throws(
    () =>
      requireSameBinding(
        { ...next, workflow: { ...next.workflow, applicabilityCode: "DineIn" } },
        next,
      ),
    conflict,
  );
  assert.throws(() => requireSameBinding({ ...next, environment: "Pilot" }, next), conflict);
  assert.throws(() => requireSameBinding({ ...next, database: "other" }, next), conflict);
  assert.throws(
    () => requireSameBinding({ ...next, scope: { ...next.scope, storeReference: id(92) } }, next),
    conflict,
  );
  // The cancellation runtime file names its definition.
  const cancellation = planWorkflowRelease(orderOptions("UnpaidDineInBatchCancellation")).published;
  const cancellationFile = runtime(cancellation, {}, "UnpaidDineInBatchCancellation");
  requireSameBinding(cancellationFile, cancellationFile);
  assert.throws(
    () =>
      requireSameBinding(
        { ...cancellationFile, definition: { ...cancellation, versionReference: id(93) } },
        cancellationFile,
      ),
    conflict,
  );
});

it("reads an existing binding, none, or refuses one it cannot read", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workflow-release-"));
  try {
    const file = join(directory, "internal-test-workflow-Pickup.json");
    assert.equal(await readExistingBinding(file), null);
    await writeFile(file, JSON.stringify({ release: "OrderFulfillmentPickup" }));
    assert.deepEqual(await readExistingBinding(file), { release: "OrderFulfillmentPickup" });
    for (const damaged of ["{ half a fi", "null", "7"]) {
      await writeFile(file, damaged);
      await assert.rejects(readExistingBinding(file), /WORKFLOW_RELEASE_BINDING_UNREADABLE/u);
    }
    await assert.rejects(readExistingBinding(directory), /WORKFLOW_RELEASE_BINDING_UNREADABLE/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("refuses a Store on purposes from before this tool, whichever of its files is lost", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workflow-release-"));
  const binding = (file, purposeCode) =>
    writeFile(join(directory, file), JSON.stringify({ workflow: { purposeCode } }));
  const refused = { message: "WORKFLOW_RELEASE_STORE_ON_OTHER_PURPOSE" };
  try {
    // An empty directory is a new Store, and a Store on the released purposes is an ordinary rerun.
    for (const release of orderWorkflowReleases)
      await requireReleasedOrderPurposes(directory, release);
    await binding("internal-test-workflow-DineIn.json", "OrderFulfillment");
    await binding(
      "internal-test-workflow-AdditionalRelease.json",
      "OrderFulfillmentAdditionalRound",
    );
    await requireReleasedOrderPurposes(directory, "OrderFulfillmentPickup");

    // v15's first Store, DEMO 2 and DEMO 3: whichever file is gone, the others say so.
    await binding("internal-test-workflow-DineIn.json", "InternalTestSubmissionInventory");
    await assert.rejects(
      requireReleasedOrderPurposes(directory, "OrderFulfillmentPickup"),
      refused,
    );
    await binding("internal-test-workflow-DineIn.json", "OrderFulfillment");
    await binding("internal-test-workflow-AdditionalRelease.json", "InternalTestAdditionalRelease");
    await assert.rejects(
      requireReleasedOrderPurposes(directory, "OrderFulfillmentDineIn"),
      refused,
    );

    // The cancellation runs on its own, and is repairable whatever the orders run on.
    await requireReleasedOrderPurposes(directory, "UnpaidDineInBatchCancellation");
    // A damaged file says nothing about the Store; its own rerun reports it.
    await writeFile(
      join(directory, "internal-test-workflow-AdditionalRelease.json"),
      "{ half a fi",
    );
    await requireReleasedOrderPurposes(directory, "OrderFulfillmentPickup");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("prints a refusal's code and rule, never other text", () => {
  assert.equal(
    failureLine(new Error("WORKFLOW_RELEASE_DUPLICATE_FAMILIES")),
    "WORKFLOW_RELEASE_DUPLICATE_FAMILIES",
  );
  const refusal = (rule, cause) =>
    Object.assign(new Error("Workflow definition is unavailable", { cause }), {
      code: "WORKFLOW_DEFINITION_UNAVAILABLE",
      rule,
    });
  assert.equal(
    failureLine(refusal("FamilyAlreadyExists")),
    "WORKFLOW_DEFINITION_UNAVAILABLE FamilyAlreadyExists",
  );
  assert.equal(
    failureLine(refusal("Dependency", Object.assign(new Error("secret"), { code: "42501" }))),
    "WORKFLOW_DEFINITION_UNAVAILABLE Dependency 42501",
  );
  assert.equal(failureLine(refusal("not a rule word")), "WORKFLOW_DEFINITION_UNAVAILABLE");
  assert.equal(failureLine(null), "FAILED");
});

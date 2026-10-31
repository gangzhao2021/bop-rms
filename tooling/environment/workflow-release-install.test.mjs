import assert from "node:assert/strict";
import { it } from "vitest";
import { matchesPlatformWorkflow } from "./platform-workflows.mjs";
import {
  derivedReference,
  operationInstant,
  parseArguments,
  planWorkflowRelease,
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
  "--output": "out.json",
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

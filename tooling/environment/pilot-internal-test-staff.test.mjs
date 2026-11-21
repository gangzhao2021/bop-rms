import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "vitest";
import {
  nextDemoStaffReferences,
  parseStaffArguments,
  staffRunResult,
  withStaffEntry,
} from "./pilot-internal-test-staff.mjs";

const demo = (n) => "0190fa30-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const roster = {
  schemaVersion: 2,
  environment: "InternalTest",
  database: "bop_rms_pilot_v15",
  scope: {},
  actors: [
    { selector: "staff", actorReference: demo(0x100), validUntil: "2026-12-06T02:26:31.598Z" },
    { selector: "kitchen", actorReference: demo(0x200), validUntil: "2026-12-06T02:26:31.598Z" },
    { selector: "cashier", actorReference: demo(0x300), validUntil: "2026-12-06T02:26:31.598Z" },
    {
      selector: "owner-tea",
      actorReference: "01a1a99d-0000-7abc-8def-000000096a62",
      validUntil: "2026-12-06T02:26:31.598Z",
    },
  ],
};
const args = (extra = {}) =>
  Object.entries({
    "--database": "bop_rms_pilot_v15",
    "--migration-env": "/x/.env",
    "--selector": "cook",
    "--name": "TEST Cook",
    "--approver": "01a1998d-0000-7abc-8def-0000004ed196",
    "--reason": "batch 38",
    "--approved-by": "Owner",
    "--approval": "standing approval 2026-10-14",
    ...extra,
  }).flat();

it("batch 38: the next DEMO person takes the block after everyone the Brand ever had", () => {
  // v15: 0x400 left the DEMO Store but keeps their Membership and block.
  assert.deepEqual(nextDemoStaffReferences(roster, [demo(0x400), "01a1a968-0000-7abc-8def-0001"]), {
    actorReference: demo(0x500),
    membershipReference: demo(0x501),
    relationshipReference: demo(0x502),
    storeAssignmentReference: demo(0x503),
  });
  assert.equal(nextDemoStaffReferences(roster, []).actorReference, demo(0x400));
});

it("batch 38: the new person is listed last at the common expiry; a taken selector is refused", () => {
  const next = withStaffEntry(roster, {
    selector: "cook",
    actorReference: demo(0x500),
    validUntil: "2026-12-06T02:26:31.598Z",
  });
  assert.equal(next.actors.length, 5);
  assert.deepEqual(next.actors.at(-1), {
    selector: "cook",
    actorReference: demo(0x500),
    validUntil: "2026-12-06T02:26:31.598Z",
  });
  assert.deepEqual(next.actors.slice(0, 4), roster.actors);
  assert.throws(
    () =>
      withStaffEntry(roster, {
        selector: "kitchen",
        actorReference: demo(0x500),
        validUntil: "2026-12-06T02:26:31.598Z",
      }),
    { reason: "selector-taken" },
  );
});

it("batch 38: only a TEST name and an ordinary selector are accepted", () => {
  assert.equal(parseStaffArguments(["add", "/dir", ...args()]).selector, "cook");
  for (const [extra, reason] of [
    [{ "--name": "Cook" }, "name-must-say-test"],
    [{ "--selector": "owner-cook" }, "selector-invalid"],
    [{ "--selector": "support-2" }, "selector-invalid"],
    [{ "--selector": "Cook" }, "selector-invalid"],
    [{ "--approver": "nobody" }, "arguments-invalid"],
  ])
    assert.throws(() => parseStaffArguments(["add", "/dir", ...args(extra)]), { reason });
  assert.throws(() => parseStaffArguments(["remove", "/dir", ...args()]), {
    reason: "arguments-invalid",
  });
});

it("batch 38 review: a rerun reports what Membership did, not that the person was listed", () => {
  const references = {
    actorReference: demo(0x500),
    membershipReference: demo(0x501),
    storeAssignmentReference: demo(0x503),
  };
  for (const status of ["Added", "AlreadyPresent"])
    assert.equal(
      staffRunResult({
        status,
        selector: "cook",
        references,
        validUntil: "2026-12-06T02:26:31.598Z",
        approvedBy: "Owner",
      }).status,
      status,
    );
  // The listed-person shortcut that hid an "Added" rerun is gone from the command itself.
  const source = readFileSync(join(import.meta.dirname, "pilot-internal-test-staff.mjs"), "utf8");
  assert.doesNotMatch(source, /listed === undefined \? status : "AlreadyPresent"/u);
});

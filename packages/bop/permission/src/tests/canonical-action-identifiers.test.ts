import { expect, it } from "vitest";
import {
  parseBusinessAction,
  createPermissionDefinition,
  evaluatePermission,
  parsePolicyReference,
  parsePolicyVersion,
  parseEvidenceReference,
  parseEvidenceInstant,
  parseRoleReference,
  type PermissionEvidence,
} from "../index.js";
import * as f from "./current-policy.fixture.js";
const definition = (action: string) =>
  createPermissionDefinition({
    permissionReference: "0190ed91-0000-7000-8000-000000000001",
    action,
    lifecycle: "Active",
    version: 1,
    createdAt: "2026-09-12T00:00:00.000Z",
    updatedAt: "2026-09-12T00:00:00.000Z",
  });
it("accepts the canonical operations permission identically in policy and evaluation", () => {
  const action = "operations.order-exception.manage";
  expect(parseBusinessAction(action)).toBe(action);
  expect(definition(action).action).toBe(action);
});
it.each([
  "operations.-exception.manage",
  "operations.exception-.manage",
  "operations.order--exception.manage",
  "operations..manage",
  "Operations.exception.manage",
  "operations.exception.*",
  "operations.exception.manage/other",
  "operations.exception.manage\n",
])("rejects malformed action %s", (action) => {
  expect(() => parseBusinessAction(action)).toThrow();
  expect(() => definition(action)).toThrow();
});

it.each([
  "catalog.option_set.read",
  "catalog.option_set.create",
  "catalog.option_set.update",
  "catalog.option_set.submit",
  "catalog.option_set.publish",
  "catalog.option_set.history.read",
])("retains exact accepted Option workflow action %s in both owning parsers", (action) => {
  expect(parseBusinessAction(action)).toBe(action);
  expect(definition(action).action).toBe(action);
});
// DEC-PERM-CATALOG (WP-2423) replaced the per-code underscore exceptions with one grammar shared
// with the database: any well-formed underscore word is accepted, malformed spellings still fail.
it.each([
  "catalog.option_set.approve",
  "catalog.other_set.publish",
  "catalog.option_set.history.write",
  "kitchen.work_item.read",
  "inventory.opening_balance.post",
  "ordering.order.create_staff",
])("accepts a well-formed underscore action %s in both owning parsers", (action) => {
  expect(parseBusinessAction(action)).toBe(action);
  expect(definition(action).action).toBe(action);
});
it.each([
  "catalog.option_set.submit.*",
  "catalog.option_set.Submit",
  "catalog.option_set.submit\n",
  "catalog.option__set.submit",
  "catalog._option_set.read",
  "catalog.option_set_.read",
  "catalog.option_set.submit/other",
  "catalog.option_set.history..read",
  "catalog.option_set.History.read",
  "catalog.option_set.read.*",
])("rejects malformed underscore action %s in both owning parsers", (action) => {
  expect(() => parseBusinessAction(action)).toThrow();
  expect(() => definition(action)).toThrow();
});

function historyRequest(evidence: readonly PermissionEvidence[]) {
  return {
    tenantContext: f.tenantContext,
    action: parseBusinessAction("catalog.option_set.history.read"),
    resourceScope: {
      kind: "Store" as const,
      brandReference: f.brand.brandReference,
      storeReference: f.store.storeReference,
    },
    policySnapshotReference: parsePolicyReference(f.SNAPSHOT),
    policyVersion: parsePolicyVersion(1),
    evidence,
  };
}
function historyEvidence(
  source: "RolePermission" | "ExplicitDeny",
  action: string,
): PermissionEvidence {
  const actor = f.actor.actorReference;
  if (actor === null) throw Error("Missing controlled workforce Actor");
  return {
    source,
    evidenceReference: parseEvidenceReference(source === "RolePermission" ? f.BRAND_GRANT : f.DENY),
    action: parseBusinessAction(action),
    actorReference: actor,
    roleReference: source === "RolePermission" ? parseRoleReference(f.BRAND_ROLE) : null,
    brandReference: f.brand.brandReference,
    storeReference: null,
    effectiveFrom: parseEvidenceInstant(f.FROM),
    effectiveUntil: null,
  };
}
it("evaluates the exact history permission with real role Allow and explicit Deny precedence", () => {
  const action = "catalog.option_set.history.read";
  const role = historyEvidence("RolePermission", action);
  expect(evaluatePermission(historyRequest([role]))).toMatchObject({
    action,
    effect: "Allow",
    reason: "ROLE_PERMISSION",
    source: "RolePermission",
  });
  expect(
    evaluatePermission(historyRequest([role, historyEvidence("ExplicitDeny", action)])),
  ).toMatchObject({
    action,
    effect: "Deny",
    reason: "EXPLICIT_DENY",
    source: "ExplicitDeny",
  });
});
it("does not confer history permission from no grant or ordinary Option read alone", () => {
  for (const evidence of [[], [historyEvidence("RolePermission", "catalog.option_set.read")]]) {
    expect(evaluatePermission(historyRequest(evidence))).toMatchObject({
      action: "catalog.option_set.history.read",
      effect: "Deny",
      reason: "DEFAULT_DENY",
      source: "DefaultDeny",
    });
  }
});

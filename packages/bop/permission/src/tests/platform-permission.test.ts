import { describe, expect, it } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  buildPlatformPermissionPolicy,
  evaluatePlatformPermissionPolicy,
  parsePlatformPermissionContent,
  parsePlatformPermissionPolicy,
  parsePlatformPermissionProvisionCommand,
  platformPermissionIntentDigest,
  type PlatformPermissionProvisionCommand,
} from "../contracts/platform-permission.js";
const id = (n: number) => `0190ed60-0000-7000-8000-${String(n).padStart(12, "0")}`;
const from = "2026-10-06T12:00:00.000Z",
  until = "2026-10-06T13:00:00.000Z";
const entry = (action: string, effect = "Allow", evidenceReference = id(10)) => ({
  evidenceReference,
  action,
  effect,
  effectiveFrom: from,
  effectiveUntil: until,
});
const command = (): PlatformPermissionProvisionCommand =>
  parsePlatformPermissionProvisionCommand({
    profile: "PlatformPermissionProvisionV1",
    targetActorReference: id(1),
    purposeCode: "PLATFORM_BRAND_TEMPLATE",
    operationReference: id(2),
    expectedHead: null,
    content: {
      roleCode: "PlatformAdministrator",
      effectiveFrom: from,
      effectiveUntil: until,
      entries: [
        entry("platform.operate"),
        entry("platform.brand-template.manage", "Allow", id(11)),
      ],
    },
    recordedByReference: id(3),
    approvedByReference: id(4),
    approvalEvidenceReference: id(5),
    reasonCode: "APPROVED_PROVISIONING",
  });
function policy(c = command()) {
  return buildPlatformPermissionPolicy({
    profile: "PlatformPermissionPolicyV1",
    actorReference: c.targetActorReference,
    purposeCode: c.purposeCode,
    policyReference: id(6),
    revision: 1,
    supersedesPolicyReference: null,
    content: c.content,
    operationReference: c.operationReference,
    intentDigest: platformPermissionIntentDigest(c),
    originalCommand: c,
    recordedByReference: c.recordedByReference,
    approvedByReference: c.approvedByReference,
    approvalEvidenceReference: c.approvalEvidenceReference,
    reasonCode: c.reasonCode,
    auditReference: id(7),
    recordedAt: from,
    classification: "RestrictedSecurity",
  });
}
describe("global Template Platform Permission contract", () => {
  it("requires operate plus exact Allow and applies active Deny first", () => {
    expect(
      evaluatePlatformPermissionPolicy(policy(), "platform.brand-template.manage", from)?.exact
        .evidenceReference,
    ).toBe(id(11));
    expect(
      evaluatePlatformPermissionPolicy(policy(), "platform.brand-template.publish", from),
    ).toBeNull();
    for (const action of ["platform.operate", "platform.brand-template.manage"]) {
      const c = parsePlatformPermissionProvisionCommand({
        ...command(),
        content: {
          ...command().content,
          entries: [...command().content.entries, entry(action, "Deny", id(12))],
        },
      });
      expect(
        evaluatePlatformPermissionPolicy(policy(c), "platform.brand-template.manage", from),
      ).toBeNull();
    }
    const c = parsePlatformPermissionProvisionCommand({
      ...command(),
      content: { ...command().content, entries: [entry("platform.brand-template.manage")] },
    });
    expect(
      evaluatePlatformPermissionPolicy(policy(c), "platform.brand-template.manage", from),
    ).toBeNull();
  });
  it("never grants from a role label and limits Support to explicitly allowed read", () => {
    const empty = parsePlatformPermissionProvisionCommand({
      ...command(),
      content: { ...command().content, roleCode: "PlatformSupport", entries: [] },
    });
    expect(
      evaluatePlatformPermissionPolicy(policy(empty), "platform.brand-template.read", from),
    ).toBeNull();
    expect(() =>
      parsePlatformPermissionContent({ ...command().content, roleCode: "PlatformSupport" }),
    ).toThrow();
    const c = parsePlatformPermissionProvisionCommand({
      ...empty,
      content: {
        ...empty.content,
        entries: [
          entry("platform.operate"),
          entry("platform.brand-template.read", "Allow", id(11)),
        ],
      },
    });
    expect(
      evaluatePlatformPermissionPolicy(policy(c), "platform.brand-template.read", from),
    ).not.toBeNull();
  });
  it("bounds authority at finite policy/entry boundaries including an upcoming Deny", () => {
    expect(
      evaluatePlatformPermissionPolicy(policy(), "platform.brand-template.manage", until),
    ).toBeNull();
    const boundary = "2026-10-06T12:00:02.000Z";
    const c = parsePlatformPermissionProvisionCommand({
      ...command(),
      content: {
        ...command().content,
        entries: [
          ...command().content.entries,
          { ...entry("platform.brand-template.manage", "Deny", id(12)), effectiveFrom: boundary },
        ],
      },
    });
    expect(
      evaluatePlatformPermissionPolicy(policy(c), "platform.brand-template.manage", from)
        ?.validUntil,
    ).toBe(boundary);
    expect(
      evaluatePlatformPermissionPolicy(policy(c), "platform.brand-template.manage", boundary),
    ).toBeNull();
  });
  it("pins all original content, author/approver and semantic/full bytes", () => {
    const p = policy();
    expect(parsePlatformPermissionPolicy(p)).toEqual(p);
    expect(Object.isFrozen(p.originalCommand.content.entries)).toBe(true);
    for (const patch of [
      { profile: null },
      { actorReference: id(9) },
      { recordedByReference: id(9) },
      { intentDigest: `sha256:${"b".repeat(64)}` },
      { revision: 2 },
      { sourceDigest: `sha256:${"b".repeat(64)}` },
    ])
      expect(() => parsePlatformPermissionPolicy({ ...p, ...patch })).toThrow();
    expect(() =>
      parsePlatformPermissionProvisionCommand({
        ...command(),
        approvedByReference: command().recordedByReference,
      }),
    ).toThrow();
    const { sourceDigest, ...bytes } = p;
    expect(sourceDigest).toBe(`sha256:${sha256Hex(canonicalizeRfc8785(bytes))}`);
  });
  it("rejects extra scope/client authority, getters, duplicates and noncanonical periods", () => {
    for (const patch of [
      { tenantReference: id(9) },
      { supportCaseReference: id(9) },
      { role: "admin" },
    ])
      expect(() => parsePlatformPermissionProvisionCommand({ ...command(), ...patch })).toThrow();
    for (const patch of [
      { roleCode: null },
      { entries: [{ ...entry("platform.operate"), effect: null }] },
      { effectiveUntil: null },
      { effectiveUntil: from },
      { effectiveFrom: "2026-02-30T12:00:00.000Z" },
      { entries: [entry("platform.tenant.read")] },
      { entries: [entry("platform.operate"), entry("platform.operate")] },
    ])
      expect(() => parsePlatformPermissionContent({ ...command().content, ...patch })).toThrow();
    let invoked = false;
    const input = { ...command() };
    Object.defineProperty(input, "targetActorReference", {
      enumerable: true,
      get() {
        invoked = true;
        return id(1);
      },
    });
    expect(() => parsePlatformPermissionProvisionCommand(input)).toThrow();
    expect(invoked).toBe(false);
  });
});

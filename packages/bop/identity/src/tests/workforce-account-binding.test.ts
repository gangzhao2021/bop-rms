import { describe, it, expect } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { parseSelectorHash } from "../contracts/browser-session.js";
import {
  buildWorkforceAccountBinding,
  parseWorkforceAccountBinding,
  parseWorkforceAccountBindingCommand,
  parseWorkforceAccountBindingAcceptanceCommand,
  parseWorkforceAccountBindingAcceptanceOriginal,
  workforceAccountBindingAcceptanceOriginal,
  parseWorkforceAccountBindingConfiguration,
  parseWorkforceAccountBindingOriginal,
  parseWorkforceAccountBindingSubject,
  parseWorkforceAccountBindingInstant,
  workforceAccountBindingOriginal,
  workforceAccountBindingIntent,
  workforceAccountSubjectContext,
} from "../contracts/workforce-account-binding.js";
const id = (n: number) => `0190ed60-0000-7000-8000-${String(n).padStart(12, "0")}`;
const codec = { canonicalize: canonicalizeRfc8785, hash: sha256Hex };
function fixture() {
  const configuration = parseWorkforceAccountBindingConfiguration({
    environment: "test",
    issuer: "https://cognito-idp.ca-central-1.amazonaws.com/ca-central-1_Test",
    clientIds: ["clientB", "clientA"],
  });
  const command = parseWorkforceAccountBindingCommand({
    profile: "WorkforceAccountBindingImportV1",
    operationReference: id(1),
    actorReference: id(2),
    subject: "opaque-sub",
    invitationReference: id(3),
    originalMembershipReference: id(4),
    providerEvidenceReference: id(5),
    recordedByReference: id(6),
    approvedByReference: id(7),
    approvalEvidenceReference: id(8),
    reasonCode: "APPROVED_BINDING",
  });
  const original = workforceAccountBindingOriginal(command, parseSelectorHash("a".repeat(64)));
  const binding = buildWorkforceAccountBinding(
    {
      profile: "WorkforceAccountBindingV1",
      actorReference: command.actorReference,
      configuration,
      subjectHash: original.subjectHash,
      encryptedSubject: {
        algorithm: "SYNTHETIC_AES_256_GCM",
        keyReference: "test-key",
        ciphertext: "A".repeat(80),
        encryptionContext: workforceAccountSubjectContext(configuration, command.actorReference),
      },
      invitationReference: command.invitationReference,
      originalMembershipReference: command.originalMembershipReference,
      providerEvidenceReference: command.providerEvidenceReference,
      operationReference: command.operationReference,
      intentDigest: workforceAccountBindingIntent(configuration, original, codec),
      originalCommand: original,
      recordedByReference: command.recordedByReference,
      approvedByReference: command.approvedByReference,
      approvalEvidenceReference: command.approvalEvidenceReference,
      reasonCode: command.reasonCode,
      auditReference: id(9),
      recordedAt: "2026-10-06T12:00:00.000Z",
      classification: "RestrictedSecurity",
    },
    codec,
  );
  return { configuration, command, original, binding };
}
describe("immutable Workforce account binding", () => {
  it("detaches closed values and binds every original field and configuration", () => {
    const f = fixture();
    expect(f.configuration.clientIds).toEqual(["clientA", "clientB"]);
    expect(Object.isFrozen(f.binding.encryptedSubject)).toBe(true);
    expect(parseWorkforceAccountBinding(f.binding, codec)).toEqual(f.binding);
    for (const key of [
      "operationReference",
      "actorReference",
      "invitationReference",
      "originalMembershipReference",
      "providerEvidenceReference",
      "recordedByReference",
      "approvedByReference",
      "approvalEvidenceReference",
    ] as const) {
      const changed = { ...f.original, [key]: id(50) };
      expect(workforceAccountBindingIntent(f.configuration, changed, codec)).not.toBe(
        f.binding.intentDigest,
      );
    }
    expect(
      workforceAccountBindingIntent(
        { ...f.configuration, environment: "other" },
        f.original,
        codec,
      ),
    ).not.toBe(f.binding.intentDigest);
    expect(canonicalizeRfc8785(f.binding)).not.toContain(f.command.subject);
  });
  it("refuses subject or session fields in original and independent approval collapse", () => {
    const f = fixture();
    expect(() =>
      parseWorkforceAccountBindingOriginal({ ...f.original, subject: f.command.subject }),
    ).toThrow();
    expect(() =>
      parseWorkforceAccountBindingCommand({
        ...f.command,
        approvedByReference: f.command.recordedByReference,
      }),
    ).toThrow();
    expect(() =>
      parseWorkforceAccountBindingCommand({ ...f.command, authenticatedAt: f.binding.recordedAt }),
    ).toThrow();
  });
  it("never invokes getters in closed commands or clients", () => {
    const f = fixture();
    let calls = 0;
    const command = { ...f.command };
    Object.defineProperty(command, "subject", {
      enumerable: true,
      get() {
        calls++;
        return "x";
      },
    });
    expect(() => parseWorkforceAccountBindingCommand(command)).toThrow();
    const clients = ["client"];
    Object.defineProperty(clients, "0", {
      enumerable: true,
      get() {
        calls++;
        return "client";
      },
    });
    expect(() =>
      parseWorkforceAccountBindingConfiguration({ ...f.configuration, clientIds: clients }),
    ).toThrow();
    expect(calls).toBe(0);
  });
  it.each(["", "email@example.invalid", "a".repeat(129), "white space", "\u0000"])(
    "refuses invalid opaque subject %j",
    (subject) => {
      expect(() => parseWorkforceAccountBindingSubject(subject)).toThrow();
    },
  );
  it.each([
    "0000-01-01T00:00:00.000Z",
    "2026-02-30T00:00:00.000Z",
    "2026-10-06T12:00:00Z",
    "infinity",
  ])("rejects invalid finite UTC %j", (at) => {
    expect(() => parseWorkforceAccountBindingInstant(at)).toThrow();
  });
  it("refuses wrong envelope AAD, wrong intent, source tampering and extra metadata", () => {
    const f = fixture();
    expect(() =>
      parseWorkforceAccountBinding(
        {
          ...f.binding,
          encryptedSubject: { ...f.binding.encryptedSubject, encryptionContext: "other" },
        },
        codec,
      ),
    ).toThrow();
    expect(() =>
      parseWorkforceAccountBinding(
        { ...f.binding, intentDigest: `sha256:${"b".repeat(64)}` },
        codec,
      ),
    ).toThrow();
    expect(() =>
      parseWorkforceAccountBinding({ ...f.binding, reasonCode: "OTHER" }, codec),
    ).toThrow();
    expect(() => parseWorkforceAccountBinding({ ...f.binding, status: "Active" }, codec)).toThrow();
  });
  it("cannot legitimize another actor or invitation with only a recomputed source hash", () => {
    const f = fixture();
    const { sourceDigest, ...body } = f.binding;
    void sourceDigest;
    expect(() =>
      buildWorkforceAccountBinding({ ...body, actorReference: id(30) }, codec),
    ).toThrow();
    expect(() =>
      buildWorkforceAccountBinding({ ...body, originalMembershipReference: id(30) }, codec),
    ).toThrow();
  });
});

describe("closed invitation acceptance origin", () => {
  function accepted() {
    const f = fixture();
    const command = parseWorkforceAccountBindingAcceptanceCommand({
      ...f.command,
      profile: "WorkforceAccountBindingAcceptanceV1",
      recordedByReference: f.command.actorReference,
    });
    const original = workforceAccountBindingAcceptanceOriginal(command, f.original.subjectHash);
    const { sourceDigest, ...body } = f.binding;
    void sourceDigest;
    const binding = buildWorkforceAccountBinding(
      {
        ...body,
        recordedByReference: command.actorReference,
        originalCommand: original,
        intentDigest: workforceAccountBindingIntent(f.configuration, original, codec),
      },
      codec,
    );
    return { command, original, binding };
  }
  it("retains a distinct full-digest source while preserving the shared current-reader snapshot", () => {
    const f = accepted();
    expect(parseWorkforceAccountBinding(f.binding, codec)).toEqual(f.binding);
    expect(f.binding.originalCommand.profile).toBe("WorkforceAccountBindingAcceptanceV1");
    expect(Object.isFrozen(f.original)).toBe(true);
    expect(parseWorkforceAccountBindingAcceptanceOriginal(f.original)).toEqual(f.original);
    expect(() => parseWorkforceAccountBindingCommand(f.command)).toThrow();
    expect(() => parseWorkforceAccountBindingOriginal(f.original)).toThrow();
    expect(() => parseWorkforceAccountBindingAcceptanceCommand(fixture().command)).toThrow();
  });
  it("requires the actual target to record acceptance with an independent original approver", () => {
    const f = accepted();
    for (const patch of [
      { recordedByReference: id(90) },
      { approvedByReference: f.command.actorReference },
      { authorizationTransactionReference: id(91) },
      { status: "Active" },
    ])
      expect(() =>
        parseWorkforceAccountBindingAcceptanceCommand({ ...f.command, ...patch }),
      ).toThrow();
    expect(() =>
      parseWorkforceAccountBindingAcceptanceOriginal({
        ...f.original,
        recordedByReference: id(90),
      }),
    ).toThrow();
  });
  it("cannot rewrite an import snapshot as acceptance merely by changing its profile and rehashing", () => {
    const f = fixture(),
      { sourceDigest, ...body } = f.binding;
    void sourceDigest;
    expect(() =>
      buildWorkforceAccountBinding(
        {
          ...body,
          originalCommand: {
            ...f.original,
            profile: "WorkforceAccountBindingAcceptanceV1",
          },
        },
        codec,
      ),
    ).toThrow();
  });
});

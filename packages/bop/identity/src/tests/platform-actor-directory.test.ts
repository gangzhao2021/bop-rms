import { describe, it, expect } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { parseSelectorHash } from "../contracts/browser-session.js";
import {
  buildPlatformActorDirectoryRevision,
  parsePlatformActorDirectoryCommand,
  parsePlatformActorDirectoryConfiguration,
  parsePlatformActorDirectoryRevision,
  platformActorDirectoryIntent,
  platformActorDirectoryOriginal,
  platformActorSubjectContext,
} from "../contracts/platform-actor-directory.js";
const id = (n: number) => `0190ed60-0000-7000-8000-${String(n).padStart(12, "0")}`;
const at = "2026-10-06T12:00:00.000Z",
  codec = { canonicalize: canonicalizeRfc8785, hash: sha256Hex };
const configuration = parsePlatformActorDirectoryConfiguration({
  environment: "controlled",
  issuer: "https://cognito-idp.ca-central-1.amazonaws.com/ca-central-1_Controlled",
  clientIds: ["controlledclient"],
});
function revision() {
  const command = parsePlatformActorDirectoryCommand({
    profile: "PlatformActorDirectoryCommandV1",
    operation: "ImportActive",
    operationReference: id(1),
    actorReference: id(2),
    expectedHead: null,
    subject: "controlled-opaque-subject",
    recordedByReference: id(3),
    approvedByReference: id(4),
    approvalReference: id(5),
    reasonCode: "APPROVED_INVITATION",
  });
  const subjectHash = parseSelectorHash("a".repeat(64)),
    originalCommand = platformActorDirectoryOriginal(command, subjectHash);
  return buildPlatformActorDirectoryRevision(
    {
      profile: "PlatformActorDirectoryRevisionV1",
      actorReference: command.actorReference,
      configuration,
      subjectHash,
      encryptedSubject: {
        algorithm: "SYNTHETIC_AES_256_GCM",
        keyReference: "controlled-key",
        ciphertext: "Y".repeat(64),
        encryptionContext: platformActorSubjectContext(configuration, command.actorReference),
      },
      revisionReference: id(6),
      version: 1,
      supersedesRevisionReference: null,
      status: "Active",
      operationReference: command.operationReference,
      intentDigest: platformActorDirectoryIntent(originalCommand, codec),
      originalCommand,
      recordedByReference: command.recordedByReference,
      approvedByReference: command.approvedByReference,
      approvalReference: command.approvalReference,
      reasonCode: command.reasonCode,
      auditReference: id(7),
      recordedAt: at,
      classification: "RestrictedSecurity",
    },
    codec,
  );
}
describe("Platform actor directory closed contract", () => {
  it("keeps only keyed subject and bound encrypted metadata in immutable bytes", () => {
    const r = revision();
    expect(parsePlatformActorDirectoryRevision(r, codec)).toEqual(r);
    expect(canonicalizeRfc8785(r)).not.toContain("controlled-opaque-subject");
    expect(Object.hasOwn(r.originalCommand, "subject")).toBe(false);
    expect(Object.isFrozen(r.configuration.clientIds)).toBe(true);
  });
  it("rejects metadata tampering, NULL and mismatched encryption binding", () => {
    const r = revision();
    for (const patch of [
      { profile: null },
      { actorReference: id(9) },
      { status: "Disabled" },
      { sourceDigest: `sha256:${"b".repeat(64)}` },
      { encryptedSubject: { ...r.encryptedSubject, encryptionContext: "wrong-context" } },
    ])
      expect(() => parsePlatformActorDirectoryRevision({ ...r, ...patch }, codec)).toThrow();
  });
  it("requires approved independent import, and never accepts email/groups as identity", () => {
    const r = revision(),
      { subjectHash, ...fields } = r.originalCommand;
    expect(subjectHash).toBe(r.subjectHash);
    for (const patch of [
      { subject: "person@example.invalid" },
      { subject: "x".repeat(129) },
      { approvedByReference: r.recordedByReference },
      { group: "administrators" },
      { operation: "Restore" },
    ])
      expect(() =>
        parsePlatformActorDirectoryCommand({
          ...fields,
          subject: "controlled-opaque-subject",
          ...patch,
        }),
      ).toThrow();
  });
  it("rejects foreign regions, extra config, duplicate client ids and accessors", () => {
    for (const patch of [
      { issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Controlled" },
      { issuer: configuration.issuer + "x".repeat(43) },
      { clientIds: ["controlledclient", "controlledclient"] },
      { subject: "raw" },
    ])
      expect(() =>
        parsePlatformActorDirectoryConfiguration({ ...configuration, ...patch }),
      ).toThrow();
    let invoked = false;
    const r = { ...configuration };
    Object.defineProperty(r, "issuer", {
      enumerable: true,
      get() {
        invoked = true;
        return configuration.issuer;
      },
    });
    expect(() => parsePlatformActorDirectoryConfiguration(r)).toThrow();
    expect(invoked).toBe(false);
  });
});

import { expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { digitalReceiptRequiredFields } from "../contracts/digital-receipt-template.js";
import {
  materializeDigitalReceiptTemplateContent,
  parseDigitalReceiptTemplateContent,
} from "../contracts/digital-receipt-template-content.js";
import { createPostgresReceiptTemplateContentPublicationProof } from "../infrastructure/template-content-publication-proof.js";
const mocks = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("@bop/publishing", async (load) => ({
  ...(await load<typeof import("@bop/publishing")>()),
  createPostgresPublishingMutationStore: () => ({ resolveCurrentRelease: mocks.resolve }),
}));
const id = (n: number) => "0190ed24-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const reviewed = "2026-10-05T14:00:00.000Z",
  approved = "2026-10-05T14:30:00.000Z",
  published = "2026-10-05T15:00:00.000Z",
  observed = "2026-10-05T15:01:00.000Z",
  until = "2026-10-05T16:00:00.000Z";
function fixture() {
  const content = parseDigitalReceiptTemplateContent({
    profile: "DigitalReceiptTemplateContentV2",
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    templateReference: id(4),
    versionReference: id(5),
    versionNumber: 1,
    versionCode: "RECEIPT_V1",
    locale: "en-CA",
    dataContractVersion: 1,
    renderEngineVersion: 1,
    outputProfile: "AccessibleDigitalReceipt",
    layoutDefinitionReference: id(6),
    complianceRuleReference: id(7),
    requiredFields: [...digitalReceiptRequiredFields],
    activation: { mode: "Immediate" },
    effectiveUntil: null,
    dataClassification: "Internal",
  });
  const digest = "sha256:" + sha256Hex(canonicalizeRfc8785(JSON.parse(JSON.stringify(content))));
  const scope = { kind: "Store" as const, brandReference: id(2), storeReference: id(3) },
    snapshot = { scope, snapshotReference: id(5), snapshotDigest: digest };
  const current = {
    release: {
      ...snapshot,
      releaseId: id(8),
      familyReference: id(4),
      configurationType: "RECEIPT_TEMPLATE",
      purposeCode: "RECEIPT_ISSUANCE",
      sequence: 1,
      sourceLifecycleId: id(9),
      kind: "Publish",
      previousReleaseId: null,
      createdAt: published,
    },
    approvalEvidence: {
      ...snapshot,
      evidenceReference: id(10),
      reviewLifecycleId: id(9),
      reviewVersion: 2,
      decision: "Accepted",
      approvedActorReference: id(13),
      approvedAt: approved,
      validUntil: until,
    },
    validationEvidence: {
      ...snapshot,
      evidenceReference: id(11),
      result: "Pass",
      checkCodes: ["RECEIPT_CONTENT_VALID"],
      checkedAt: reviewed,
      validUntil: until,
    },
  };
  const version = materializeDigitalReceiptTemplateContent({
    content,
    publicationReference: id(8),
    publishedAt: published,
  });
  const packet = {
    profile: "DigitalReceiptTemplateAuthoredContentV2",
    content,
    authoredByReference: id(12),
    submittedByReference: id(14),
    familyReference: id(4),
    reviewLifecycleReference: id(9),
    reviewVersion: 2,
  };
  const authorize = vi.fn(async () => true),
    readAuthoredContent = vi.fn(async (): Promise<unknown> => packet);
  const options = {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    familyReference: id(4),
    configurationType: "RECEIPT_TEMPLATE",
    purposeCode: "RECEIPT_ISSUANCE",
    authorize,
    readAuthoredContent,
  };
  mocks.resolve.mockResolvedValue(current);
  return {
    content,
    digest,
    current,
    version,
    packet,
    options,
    authorize,
    readAuthoredContent,
    read: createPostgresReceiptTemplateContentPublicationProof(options),
    tx: { query: vi.fn() },
  };
}
it("qualifies delayed independent approval without assigning publication time during Review", async () => {
  const f = fixture(),
    proof = await f.read(f.tx, f.version, observed);
  expect(proof?.contentDigest).toBe(f.digest);
  expect(proof?.version.publishedAt).toBe(published);
  expect(proof?.version.effectiveFrom).toBe(published);
  expect(f.current.validationEvidence.checkedAt).toBe(reviewed);
  expect(f.authorize).toHaveBeenCalledTimes(3);
  expect(f.readAuthoredContent).toHaveBeenCalledWith(
    f.tx,
    expect.objectContaining({
      tenantReference: id(1),
      templateReference: id(4),
      versionReference: id(5),
    }),
  );
  expect(f.digest).not.toBe("sha256:" + sha256Hex(canonicalizeRfc8785(f.version)));
});
it.each(["release", "approvalEvidence", "validationEvidence"] as const)(
  "refuses changed %s reviewed content",
  async (key) => {
    const f = fixture();
    f.current[key].snapshotDigest = "sha256:" + "f".repeat(64);
    await expect(f.read(f.tx, f.version, observed)).rejects.toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
  },
);
it.each(["authoredByReference", "submittedByReference"] as const)(
  "refuses approval by actual %s",
  async (key) => {
    const f = fixture();
    f.current.approvalEvidence.approvedActorReference = f.packet[key];
    await expect(f.read(f.tx, f.version, observed)).rejects.toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
  },
);
it.each([
  "layoutDefinitionReference",
  "complianceRuleReference",
  "locale",
  "templateReference",
] as const)("refuses Published envelope changes to %s", async (key) => {
  const f = fixture(),
    version = { ...f.version, [key]: key === "locale" ? "fr-CA" : id(20) };
  await expect(f.read(f.tx, version, observed)).rejects.toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
  expect(f.readAuthoredContent).toHaveBeenCalledTimes(1);
});
it("returns no proof for a different current release", async () => {
  const f = fixture();
  f.current.release.releaseId = id(21);
  expect(await f.read(f.tx, f.version, observed)).toBeNull();
});
it.each(["validationEvidence", "approvalEvidence"] as const)(
  "refuses %s expired before real delayed publication",
  async (key) => {
    const f = fixture();
    f.current[key].validUntil = published;
    await expect(f.read(f.tx, f.version, observed)).rejects.toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
  },
);
it("refuses a foreign owner content scope before Publishing", async () => {
  const f = fixture();
  mocks.resolve.mockClear();
  f.readAuthoredContent.mockResolvedValue({
    ...f.packet,
    content: { ...f.content, tenantReference: id(22) },
  });
  await expect(f.read(f.tx, f.version, observed)).rejects.toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
  expect(mocks.resolve).not.toHaveBeenCalled();
});
it.each([0, 1, 2])("refuses authorization withdrawal at boundary %s", async (boundary) => {
  const f = fixture();
  f.authorize.mockClear();
  for (let i = 0; i < boundary; i++) f.authorize.mockResolvedValueOnce(true);
  f.authorize.mockResolvedValueOnce(false);
  await expect(f.read(f.tx, f.version, observed)).rejects.toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
  if (boundary === 0) expect(f.readAuthoredContent).not.toHaveBeenCalled();
});
it("rejects a substituted source port rather than invoking it", async () => {
  const f = fixture(),
    other = vi.fn(async (): Promise<unknown> => f.packet);
  f.options.readAuthoredContent = other;
  await expect(f.read(f.tx, f.version, observed)).rejects.toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
  expect(other).not.toHaveBeenCalled();
});
it.each(["familyReference", "reviewLifecycleReference", "reviewVersion"] as const)(
  "rejects unrelated stored Submit %s",
  async (key) => {
    const f = fixture();
    f.readAuthoredContent.mockResolvedValue({
      ...f.packet,
      [key]: key === "reviewVersion" ? 3 : id(30),
    });
    await expect(f.read(f.tx, f.version, observed)).rejects.toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
  },
);
it("does not invoke accessors in owner provenance", async () => {
  const f = fixture(),
    getter = vi.fn(() => f.content),
    packet = { ...f.packet };
  Object.defineProperty(packet, "content", { enumerable: true, get: getter });
  f.readAuthoredContent.mockResolvedValue(packet);
  await expect(f.read(f.tx, f.version, observed)).rejects.toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
  expect(getter).not.toHaveBeenCalled();
});

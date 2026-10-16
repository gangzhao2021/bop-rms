import { describe, expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { digitalReceiptRequiredFields } from "../contracts/digital-receipt-template.js";
import {
  createPostgresReceiptTemplatePublicationProof,
  createPostgresInstalledReceiptTemplatePublicationProof,
} from "../infrastructure/template-publication-proof.js";
const mocks = vi.hoisted(() => ({ resolve: vi.fn(), forReference: vi.fn() }));
vi.mock("@bop/publishing", async (load) => ({
  ...(await load<typeof import("@bop/publishing")>()),
  createPostgresPublishingMutationStore: () => ({
    resolveCurrentRelease: mocks.resolve,
    resolveCurrentReleaseForReference: mocks.forReference,
  }),
}));
const id = (n: number) => "0190ed14-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-13T00:00:00.000Z";
function fixture() {
  const scope = { kind: "Store", brandReference: id(1), storeReference: id(2) };
  const version = {
    templateReference: id(3),
    versionReference: id(4),
    versionNumber: 1,
    versionCode: "RECEIPT_V1",
    brandReference: id(1),
    storeReference: id(2),
    locale: "en-CA",
    dataContractVersion: 1,
    renderEngineVersion: 1,
    outputProfile: "AccessibleDigitalReceipt",
    layoutDefinitionReference: id(5),
    complianceRuleReference: id(6),
    requiredFields: [...digitalReceiptRequiredFields],
    publicationReference: id(7),
    publishedAt: at,
    effectiveFrom: at,
    effectiveUntil: null,
  };
  const digest = "sha256:" + sha256Hex(canonicalizeRfc8785(version));
  const snapshot = { snapshotReference: version.versionReference, snapshotDigest: digest, scope };
  const current = {
    release: { ...snapshot, releaseId: id(7), sourceLifecycleId: id(8), createdAt: at },
    approvalEvidence: {
      ...snapshot,
      reviewLifecycleId: id(8),
      approvedAt: at,
      validUntil: "2026-09-13T01:00:00.000Z",
    },
    validationEvidence: { ...snapshot, checkedAt: at, validUntil: "2026-09-13T01:00:00.000Z" },
  };
  const authorize = vi.fn(async () => true);
  mocks.resolve.mockResolvedValue(current);
  const read = createPostgresReceiptTemplatePublicationProof({
    ...scope,
    tenantReference: id(9),
    familyReference: id(10),
    configurationType: "RECEIPT_TEMPLATE",
    purposeCode: "RECEIPT_ISSUANCE",
    authorize,
  });
  return { version, digest, current, read, authorize, tx: { query: vi.fn() } };
}
describe("receipt template current publication proof", () => {
  it("binds the exact release, approval and validation snapshot", async () => {
    const f = fixture();
    expect((await f.read(f.tx, f.version, at))?.contentDigest).toBe(f.digest);
    expect(f.authorize).toHaveBeenCalledTimes(2);
  });
  it("returns no proof for a superseded release", async () => {
    const f = fixture();
    f.current.release.releaseId = id(11);
    expect(await f.read(f.tx, f.version, at)).toBeNull();
  });
  it.each(["release", "approvalEvidence", "validationEvidence"] as const)(
    "rejects changed %s content",
    async (key) => {
      const f = fixture();
      f.current[key].snapshotDigest = "sha256:" + "f".repeat(64);
      await expect(f.read(f.tx, f.version, at)).rejects.toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
    },
  );
  it("rejects approval expired before the release and a foreign Store", async () => {
    const f = fixture();
    f.current.approvalEvidence.validUntil = at;
    await expect(f.read(f.tx, f.version, at)).rejects.toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
    const other = fixture();
    other.current.validationEvidence.scope = {
      ...other.current.validationEvidence.scope,
      storeReference: id(12),
    };
    await expect(other.read(other.tx, other.version, at)).rejects.toThrow(
      "RECEIPT_TEMPLATE_UNAVAILABLE",
    );
  });
  it("rejects authority revoked while publication was read", async () => {
    const f = fixture();
    f.authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(f.read(f.tx, f.version, at)).rejects.toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
  });
  it("rejects denied authority before the Publishing owner is invoked", async () => {
    const f = fixture();
    mocks.resolve.mockClear();
    f.authorize.mockResolvedValue(false);
    await expect(f.read(f.tx, f.version, at)).rejects.toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
});
// WP-2423 DEC-STORE-SETUP-PUBLICATION: the installer-published template the Store uses today.
describe("installed receipt template publication proof", () => {
  const installed = (f: ReturnType<typeof fixture>) =>
    createPostgresInstalledReceiptTemplatePublicationProof({
      brandReference: id(1),
      storeReference: id(2),
      tenantReference: id(9),
      configurationType: "RECEIPT_TEMPLATE",
      purposeCode: "RECEIPT_ISSUANCE",
      authorize: f.authorize,
    });
  const recorded = (f: ReturnType<typeof fixture>) => ({
    recorded: { release: { ...f.current.release, familyReference: id(10) } },
    current: f.current,
  });
  it("learns the family from the exact current release and proves the full version envelope", async () => {
    const f = fixture();
    mocks.forReference.mockResolvedValue(recorded(f));
    const proof = await installed(f)(f.tx, f.version, at);
    expect(proof?.contentDigest).toBe(f.digest);
    expect(proof?.familyReference).toBe(id(10));
    expect(mocks.forReference).toHaveBeenCalledWith({
      publicationReference: id(7),
      configurationType: "RECEIPT_TEMPLATE",
      purposeCode: "RECEIPT_ISSUANCE",
      observedAt: at,
    });
  });
  it("proves nothing for a release that is not current, and refuses changed content", async () => {
    const f = fixture();
    mocks.forReference.mockRejectedValueOnce(new Error("not current"));
    expect(await installed(f)(f.tx, f.version, at)).toBeNull();
    mocks.forReference.mockResolvedValue(recorded(f));
    await expect(installed(f)(f.tx, { ...f.version, locale: "fr-CA" }, at)).rejects.toThrow(
      "RECEIPT_TEMPLATE_UNAVAILABLE",
    );
    f.authorize.mockResolvedValueOnce(false);
    await expect(installed(f)(f.tx, f.version, at)).rejects.toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
  });
});

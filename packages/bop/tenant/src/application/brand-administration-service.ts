import {
  createBrandConfigurationVersion,
  createBrandStoreMembershipRecord,
  parseBrandAdministrationReference,
  type BrandConfigurationVersion,
} from "../contracts/brand-administration.js";
import {
  createBrand,
  parseBrandReference,
  parseCanonicalInstant,
  transitionBrand,
  type Brand,
} from "../domain/brand-store.js";
import type {
  BrandAdministrationArtifact,
  BrandAdministrationCommand,
  BrandAdministrationOperation,
  BrandAdministrationPorts,
} from "./ports/brand-administration-ports.js";
export type BrandAdministrationServiceErrorCode =
  | "BRAND_ADMIN_INPUT_INVALID"
  | "BRAND_ADMIN_PERMISSION_DENIED"
  | "BRAND_ADMIN_NOT_FOUND"
  | "BRAND_ADMIN_VERSION_CONFLICT"
  | "BRAND_ADMIN_IDEMPOTENCY_CONFLICT"
  | "BRAND_ADMIN_LIFECYCLE_CONFLICT"
  | "BRAND_ADMIN_APPROVAL_INVALID"
  | "BRAND_ADMIN_REFERENCE_INVALID"
  | "BRAND_ADMIN_MEMBERSHIP_INVALID"
  | "BRAND_ADMIN_DEPENDENCY_UNAVAILABLE";
export class BrandAdministrationServiceError extends Error {
  constructor(readonly code: BrandAdministrationServiceErrorCode) {
    super("Brand administration operation is unavailable");
    this.name = "BrandAdministrationServiceError";
  }
}
const fail = (c: BrandAdministrationServiceErrorCode): never => {
    throw new BrandAdministrationServiceError(c);
  },
  dependency = (e: unknown): never => {
    if (e instanceof BrandAdministrationServiceError) throw e;
    throw new BrandAdministrationServiceError("BRAND_ADMIN_DEPENDENCY_UNAVAILABLE");
  };
const CODE = /^[A-Z][A-Z0-9_.:-]{0,63}$/u;
function parseInput(value: unknown) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return fail("BRAND_ADMIN_INPUT_INVALID");
  const fields = [
      "operationReference",
      "actorReference",
      "purposeCode",
      "auditReference",
      "expectedBrandVersion",
      "occurredAt",
      "artifact",
    ],
    keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((k) => typeof k !== "string" || !fields.includes(k))
  )
    return fail("BRAND_ADMIN_INPUT_INVALID");
  const r = value as Record<string, unknown>;
  try {
    if (
      typeof r.purposeCode !== "string" ||
      !CODE.test(r.purposeCode) ||
      typeof r.expectedBrandVersion !== "number" ||
      !Number.isSafeInteger(r.expectedBrandVersion) ||
      r.expectedBrandVersion < 0
    )
      return fail("BRAND_ADMIN_INPUT_INVALID");
    return Object.freeze({
      operationReference: parseBrandAdministrationReference(r.operationReference),
      actorReference: parseBrandAdministrationReference(r.actorReference),
      purposeCode: r.purposeCode,
      auditReference: parseBrandAdministrationReference(r.auditReference),
      expectedBrandVersion: r.expectedBrandVersion,
      occurredAt: parseCanonicalInstant(r.occurredAt),
      artifact: r.artifact,
    });
  } catch {
    return fail("BRAND_ADMIN_INPUT_INVALID");
  }
}
type Input = ReturnType<typeof parseInput>;
const same = (
  a: BrandConfigurationVersion,
  b: BrandConfigurationVersion,
  ignored: readonly (keyof BrandConfigurationVersion)[],
) => {
  const skip = new Set(ignored);
  return (Object.keys(a) as (keyof BrandConfigurationVersion)[]).every(
    (k) => skip.has(k) || JSON.stringify(a[k]) === JSON.stringify(b[k]),
  );
};
export function createBrandAdministrationService(ports: BrandAdministrationPorts) {
  async function execute(
    command: BrandAdministrationCommand,
    raw: unknown,
    parse: (v: unknown) => BrandAdministrationArtifact,
    validate: (i: Input, a: BrandAdministrationArtifact, current: Brand | null) => Promise<void>,
  ) {
    const input = parseInput(raw);
    let artifact: BrandAdministrationArtifact;
    try {
      artifact = parse(input.artifact);
    } catch {
      return fail("BRAND_ADMIN_INPUT_INVALID");
    }
    const brandReference = parseBrandReference(artifact.brandReference);
    if (
      !(await ports.authorization
        .authorize({
          command,
          actorReference: input.actorReference,
          brandReference,
          purposeCode: input.purposeCode,
          observedAt: input.occurredAt,
        })
        .catch(dependency))
    )
      return fail("BRAND_ADMIN_PERMISSION_DENIED");
    const digest = ports.references.hashIntent(JSON.stringify({ command, ...input })),
      existing = await ports.repository
        .resolveOperation(input.operationReference)
        .catch(dependency);
    if (existing) {
      if (!ports.references.equals(existing.intentDigest, digest))
        return fail("BRAND_ADMIN_IDEMPOTENCY_CONFLICT");
      return Object.freeze({ status: "AlreadyApplied" as const, operation: existing });
    }
    const current = await ports.repository.loadBrand(brandReference).catch(dependency);
    if ((current?.version ?? 0) !== input.expectedBrandVersion)
      return fail("BRAND_ADMIN_VERSION_CONFLICT");
    await validate(input, artifact, current);
    const version =
      "version" in artifact
        ? artifact.version
        : (current?.version ?? fail("BRAND_ADMIN_NOT_FOUND"));
    const operation: BrandAdministrationOperation = Object.freeze({
      command,
      operationReference: input.operationReference,
      brandReference,
      intentDigest: digest,
      brandVersion: version,
      artifact,
    });
    const committed = await ports.repository
      .commit({
        operation,
        expectedBrandVersion: input.expectedBrandVersion,
        audit: {
          actorReference: input.actorReference,
          purposeCode: input.purposeCode,
          auditReference: input.auditReference,
          occurredAt: input.occurredAt,
        },
      })
      .catch(dependency);
    return Object.freeze({ status: "Applied" as const, operation: committed });
  }
  const parseConfig = (v: unknown) => createBrandConfigurationVersion(v),
    parseMembership = (v: unknown) => createBrandStoreMembershipRecord(v);
  return Object.freeze({
    createBrand: (i: unknown) =>
      execute("CreateBrand", i, createBrand, async (_i, a, current) => {
        const next = createBrand(a);
        if (current !== null || next.version !== 1 || next.lifecycle !== "Draft")
          return fail("BRAND_ADMIN_LIFECYCLE_CONFLICT");
      }),
    activateBrand: (i: unknown) =>
      execute("ActivateBrand", i, createBrand, async (input, a, current) => {
        if (!current) return fail("BRAND_ADMIN_NOT_FOUND");
        let expected: Brand;
        try {
          expected = transitionBrand(current, current.version, "Active", input.occurredAt);
        } catch {
          return fail("BRAND_ADMIN_LIFECYCLE_CONFLICT");
        }
        if (JSON.stringify(createBrand(a)) !== JSON.stringify(expected))
          return fail("BRAND_ADMIN_LIFECYCLE_CONFLICT");
      }),
    archiveBrand: (i: unknown) =>
      execute("ArchiveBrand", i, createBrand, async (input, a, current) => {
        if (!current) return fail("BRAND_ADMIN_NOT_FOUND");
        let expected: Brand;
        try {
          expected = transitionBrand(current, current.version, "Archived", input.occurredAt);
        } catch {
          return fail("BRAND_ADMIN_LIFECYCLE_CONFLICT");
        }
        if (JSON.stringify(createBrand(a)) !== JSON.stringify(expected))
          return fail("BRAND_ADMIN_LIFECYCLE_CONFLICT");
      }),
    saveConfigurationDraft: (i: unknown) =>
      execute("SaveConfigurationDraft", i, parseConfig, async (_input, a, current) => {
        if (!current || current.lifecycle === "Archived")
          return fail("BRAND_ADMIN_LIFECYCLE_CONFLICT");
        const next = createBrandConfigurationVersion(a),
          latest = await ports.repository
            .loadLatestConfiguration(next.brandReference)
            .catch(dependency);
        if (
          next.lifecycle !== "Draft" ||
          next.configurationVersion !== (latest?.configurationVersion ?? 0) + 1 ||
          (latest !== null &&
            next.supersedesVersionReference !== latest.configurationVersionReference)
        )
          return fail("BRAND_ADMIN_VERSION_CONFLICT");
        if (
          !(await ports.references.validateMedia(next.mediaThemeReference).catch(dependency)) ||
          !(await ports.references.validateCatalog(next.catalogSourceReference).catch(dependency))
        )
          return fail("BRAND_ADMIN_REFERENCE_INVALID");
      }),
    submitConfiguration: (i: unknown) =>
      execute("SubmitConfiguration", i, parseConfig, async (_input, a) => {
        const next = createBrandConfigurationVersion(a),
          latest = await ports.repository
            .loadLatestConfiguration(next.brandReference)
            .catch(dependency);
        if (
          !latest ||
          latest.lifecycle !== "Draft" ||
          next.lifecycle !== "PendingApproval" ||
          !same(latest, next, ["lifecycle", "updatedAt"])
        )
          return fail("BRAND_ADMIN_LIFECYCLE_CONFLICT");
      }),
    approveConfiguration: (i: unknown) =>
      execute("ApproveConfiguration", i, parseConfig, async (input, a) => {
        const next = createBrandConfigurationVersion(a),
          latest = await ports.repository
            .loadLatestConfiguration(next.brandReference)
            .catch(dependency);
        if (
          !latest ||
          latest.lifecycle !== "PendingApproval" ||
          next.lifecycle !== "Approved" ||
          next.approvedByReference !== input.actorReference ||
          next.approvalEvidenceReference === null ||
          next.authoredByReference === input.actorReference ||
          !same(latest, next, [
            "lifecycle",
            "approvedByReference",
            "approvalEvidenceReference",
            "updatedAt",
          ])
        )
          return fail("BRAND_ADMIN_LIFECYCLE_CONFLICT");
        if (
          !(await ports.approval
            .validate({
              brandReference: next.brandReference,
              approvalEvidenceReference: next.approvalEvidenceReference,
              configurationVersionReference: next.configurationVersionReference,
              observedAt: input.occurredAt,
            })
            .catch(dependency))
        )
          return fail("BRAND_ADMIN_APPROVAL_INVALID");
      }),
    publishConfiguration: (i: unknown) =>
      execute("PublishConfiguration", i, parseConfig, async (_input, a) => {
        const next = createBrandConfigurationVersion(a),
          latest = await ports.repository
            .loadLatestConfiguration(next.brandReference)
            .catch(dependency);
        if (
          !latest ||
          latest.lifecycle !== "Approved" ||
          next.lifecycle !== "Published" ||
          next.publicationReference === null ||
          !same(latest, next, ["lifecycle", "publicationReference", "updatedAt"])
        )
          return fail("BRAND_ADMIN_LIFECYCLE_CONFLICT");
        if (
          !(await ports.publishing
            .validate({ configuration: next, observedAt: next.updatedAt })
            .catch(dependency))
        )
          return fail("BRAND_ADMIN_REFERENCE_INVALID");
      }),
    addStoreMembership: (i: unknown) =>
      execute("AddStoreMembership", i, parseMembership, async (input, a, current) =>
        validateMembership(input, createBrandStoreMembershipRecord(a), current, "Added"),
      ),
    removeStoreMembership: (i: unknown) =>
      execute("RemoveStoreMembership", i, parseMembership, async (input, a, current) =>
        validateMembership(input, createBrandStoreMembershipRecord(a), current, "Removed"),
      ),
  });
  async function validateMembership(
    input: Input,
    record: ReturnType<typeof createBrandStoreMembershipRecord>,
    current: Brand | null,
    action: "Added" | "Removed",
  ) {
    if (
      !current ||
      current.lifecycle === "Archived" ||
      record.action !== action ||
      record.brandVersion !== current.version ||
      record.actorReference !== input.actorReference
    )
      return fail("BRAND_ADMIN_MEMBERSHIP_INVALID");
    const store = await ports.repository.loadStore(record.storeReference).catch(dependency),
      latest = await ports.repository
        .loadLatestMembership(record.brandReference, record.storeReference)
        .catch(dependency);
    if (
      !store ||
      store.brandReference !== record.brandReference ||
      (action === "Added" && latest?.action === "Added") ||
      (action === "Removed" && latest?.action !== "Added")
    )
      return fail("BRAND_ADMIN_MEMBERSHIP_INVALID");
    if (
      !(await ports.approval
        .validate({
          brandReference: record.brandReference,
          approvalEvidenceReference: record.approvalEvidenceReference,
          configurationVersionReference: null,
          observedAt: input.occurredAt,
        })
        .catch(dependency))
    )
      return fail("BRAND_ADMIN_APPROVAL_INVALID");
  }
}

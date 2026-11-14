import { readClosedRecord } from "@bop/identity";
import { appendAuditRecordInTransaction, sha256Hex } from "@bop/audit";
import {
  BrandAdministrationServiceError,
  createBrand,
  createBrandAdministrationService,
  createPostgresBrandLifecycleStore,
  type createPostgresBrandLifecycleAdministrationStore,
  parseBrandAdministrationReference,
  parseBrandReference,
  parseCanonicalInstant,
  transitionBrand,
  type Brand,
  type BrandAdministrationOperation,
  type BrandLifecycleTransaction,
} from "@bop/tenant";

type Command = "ActivateBrand" | "ArchiveBrand";
type Transactions = Parameters<typeof createPostgresBrandLifecycleStore>[0]["transactions"];
const fail = (code: ConstructorParameters<typeof BrandAdministrationServiceError>[0]): never => {
  throw new BrandAdministrationServiceError(code);
};
export function parseBrandLifecycleCommand(value: unknown) {
  try {
    const raw = readClosedRecord(value, [
      "brandReference",
      "action",
      "expectedBrandVersion",
      "operationReference",
    ]);
    if (
      (raw.action !== "ActivateBrand" && raw.action !== "ArchiveBrand") ||
      !Number.isSafeInteger(raw.expectedBrandVersion) ||
      Number(raw.expectedBrandVersion) < 1
    )
      return fail("BRAND_ADMIN_INPUT_INVALID");
    return Object.freeze({
      brandReference: parseBrandReference(raw.brandReference),
      action: raw.action,
      expectedBrandVersion: Number(raw.expectedBrandVersion),
      operationReference: parseBrandAdministrationReference(raw.operationReference),
    });
  } catch {
    return fail("BRAND_ADMIN_INPUT_INVALID");
  }
}
type LifecycleStore = Pick<
  ReturnType<typeof createPostgresBrandLifecycleStore>,
  "loadBrand" | "resolveOperation" | "commit"
>;
function lifecycleService(
  store: LifecycleStore,
  authorize: Parameters<typeof createBrandAdministrationService>[0]["authorization"]["authorize"],
) {
  const unavailable = (): never => fail("BRAND_ADMIN_DEPENDENCY_UNAVAILABLE");
  return createBrandAdministrationService({
    repository: {
      ...store,
      loadStore: unavailable,
      loadLatestConfiguration: unavailable,
      loadLatestMembership: unavailable,
    },
    authorization: { authorize },
    approval: { validate: unavailable },
    publishing: { validate: unavailable },
    references: {
      validateMedia: unavailable,
      validateCatalog: unavailable,
      hashIntent: (value) => "sha256:" + sha256Hex(value),
      equals: (a, b) => a === b,
    },
  });
}
type AdministrationStore = ReturnType<typeof createPostgresBrandLifecycleAdministrationStore>;
type Recorded = NonNullable<Awaited<ReturnType<AdministrationStore["resolveRecordedOperation"]>>>;
export interface MerchantBrandLifecycleReceipt {
  readonly profile: "MerchantBrandLifecycleReceiptV1";
  readonly actorReference: string;
  readonly brandReference: string;
  readonly action: Command;
  readonly operationReference: string;
  readonly expectedBrandVersion: number;
  readonly status: "Applied" | "AlreadyApplied";
  readonly lifecycle: "Active" | "Archived";
  readonly version: number;
  readonly occurredAt: string;
}
/** Runs inside the caller's held administrative transaction. Only an absent
 * original plus an inapplicable current CAS/transition produces Conflict. */
export async function executeBrandLifecycleAdministration(options: {
  readonly store: AdministrationStore;
  readonly command: ReturnType<typeof parseBrandLifecycleCommand>;
  readonly actorReference: string;
  readonly occurredAt: string;
  nextAuditReference(): string;
  authorize(): Promise<boolean>;
  onPlanned(before: Brand, after: Brand): void;
  onRecorded(record: Recorded): void;
}): Promise<MerchantBrandLifecycleReceipt | { readonly conflict: "Version" | "Lifecycle" }> {
  const command = options.command,
    actorReference = parseBrandAdministrationReference(options.actorReference),
    purposeCode = "BRAND_ADMINISTRATION" as const,
    store = options.store;
  const prior = await store.resolveRecordedOperation(command.operationReference);
  let input: {
    operationReference: typeof command.operationReference;
    actorReference: typeof actorReference;
    purposeCode: string;
    auditReference: ReturnType<typeof parseBrandAdministrationReference>;
    expectedBrandVersion: number;
    occurredAt: ReturnType<typeof parseCanonicalInstant>;
    artifact: Brand;
  };
  if (prior) {
    const artifact = createBrand(prior.operation.artifact);
    input = {
      operationReference: command.operationReference,
      actorReference,
      purposeCode,
      auditReference: parseBrandAdministrationReference(prior.auditReference),
      expectedBrandVersion: artifact.version - 1,
      occurredAt: parseCanonicalInstant(prior.occurredAt),
      artifact,
    };
    if (
      prior.actorReference !== actorReference ||
      prior.purposeCode !== purposeCode ||
      prior.operation.operationReference !== command.operationReference ||
      prior.operation.brandReference !== command.brandReference ||
      artifact.brandReference !== command.brandReference ||
      artifact.version < 2 ||
      prior.operation.brandVersion !== artifact.version ||
      artifact.updatedAt !== input.occurredAt ||
      input.occurredAt > parseCanonicalInstant(options.occurredAt) ||
      prior.operation.intentDigest !==
        "sha256:" + sha256Hex(JSON.stringify({ command: prior.operation.command, ...input })) ||
      prior.operation.command !== command.action ||
      input.expectedBrandVersion !== command.expectedBrandVersion
    )
      return fail("BRAND_ADMIN_DEPENDENCY_UNAVAILABLE");
  } else {
    const before = await store.loadBrand(command.brandReference);
    if (!before) return fail("BRAND_ADMIN_NOT_FOUND");
    if (before.version > command.expectedBrandVersion)
      return Object.freeze({ conflict: "Version" });
    if (before.version < command.expectedBrandVersion)
      return fail("BRAND_ADMIN_DEPENDENCY_UNAVAILABLE");
    const occurredAt = parseCanonicalInstant(options.occurredAt);
    if (before.updatedAt > occurredAt) return fail("BRAND_ADMIN_DEPENDENCY_UNAVAILABLE");
    let artifact: Brand;
    try {
      artifact = transitionBrand(
        before,
        before.version,
        command.action === "ActivateBrand" ? "Active" : "Archived",
        occurredAt,
      );
    } catch {
      return Object.freeze({ conflict: "Lifecycle" });
    }
    options.onPlanned(before, artifact);
    input = {
      operationReference: command.operationReference,
      actorReference,
      purposeCode,
      auditReference: parseBrandAdministrationReference(options.nextAuditReference()),
      expectedBrandVersion: command.expectedBrandVersion,
      occurredAt,
      artifact,
    };
  }
  const service = lifecycleService(
    store,
    async (request) =>
      request.command === command.action &&
      request.actorReference === actorReference &&
      request.brandReference === command.brandReference &&
      request.purposeCode === purposeCode &&
      (await options.authorize()),
  );
  const result = await (command.action === "ActivateBrand"
    ? service.activateBrand(input)
    : service.archiveBrand(input));
  const recorded = await store.resolveRecordedOperation(command.operationReference);
  const operation: BrandAdministrationOperation = result.operation;
  if (
    !recorded ||
    recorded.actorReference !== actorReference ||
    recorded.purposeCode !== purposeCode ||
    recorded.auditReference !== input.auditReference ||
    recorded.occurredAt !== input.occurredAt ||
    JSON.stringify(recorded.operation) !== JSON.stringify(operation) ||
    operation.intentDigest !==
      "sha256:" + sha256Hex(JSON.stringify({ command: command.action, ...input })) ||
    JSON.stringify(createBrand(operation.artifact)) !== JSON.stringify(input.artifact) ||
    result.status !== (prior ? "AlreadyApplied" : "Applied")
  )
    return fail("BRAND_ADMIN_DEPENDENCY_UNAVAILABLE");
  options.onRecorded(recorded);
  if (!(await options.authorize())) return fail("BRAND_ADMIN_PERMISSION_DENIED");
  const saved = createBrand(operation.artifact),
    lifecycle = command.action === "ActivateBrand" ? "Active" : "Archived";
  if (saved.lifecycle !== lifecycle) return fail("BRAND_ADMIN_DEPENDENCY_UNAVAILABLE");
  return Object.freeze({
    profile: "MerchantBrandLifecycleReceiptV1",
    actorReference: String(actorReference),
    brandReference: String(saved.brandReference),
    action: command.action,
    operationReference: String(command.operationReference),
    expectedBrandVersion: command.expectedBrandVersion,
    status: result.status,
    lifecycle,
    version: saved.version,
    occurredAt: String(input.occurredAt),
  });
}
/** Administration authority is explicit: normal Store-selected scope cannot activate a Draft Brand. */
export function createBrandLifecycleCommand(options: {
  transactions: Transactions;
  now(): string;
  auditReference(operationReference: string): string;
  authorize(
    tx: BrandLifecycleTransaction,
    input: {
      sessionCookie: unknown;
      csrf: unknown;
      brandReference: string;
      command: Command;
      observedAt: string;
    },
  ): Promise<{ actorReference: string; purposeCode: string } | null>;
}) {
  return async (request: { sessionCookie: unknown; csrf: unknown; command: unknown }) => {
    const command = parseBrandLifecycleCommand(request.command);
    const credentials = { sessionCookie: request.sessionCookie, csrf: request.csrf };
    return options.transactions.run(async (tx) => {
      const initial = await options.authorize(tx, {
        ...credentials,
        brandReference: command.brandReference,
        command: command.action,
        observedAt: parseCanonicalInstant(options.now()),
      });
      if (!initial) return fail("BRAND_ADMIN_PERMISSION_DENIED");
      const actor = parseBrandAdministrationReference(initial.actorReference);
      const purpose = initial.purposeCode;
      if (!/^[A-Z][A-Z0-9_.:-]{0,63}$/.test(purpose)) return fail("BRAND_ADMIN_PERMISSION_DENIED");
      const allowed = async () => {
        const fresh = await options.authorize(tx, {
          ...credentials,
          brandReference: command.brandReference,
          command: command.action,
          observedAt: parseCanonicalInstant(options.now()),
        });
        return fresh !== null && fresh.actorReference === actor && fresh.purposeCode === purpose;
      };
      const store = createPostgresBrandLifecycleStore({
        brandReference: command.brandReference,
        transactions: { run: (work) => work(tx) },
        authorize: async (_tx, operation) =>
          (!operation ||
            (operation.command === command.action &&
              operation.operationReference === command.operationReference)) &&
          (await allowed()),
        appendAudit: async (transaction, input) => {
          await appendAuditRecordInTransaction(transaction, {
            auditId: input.audit.auditReference,
            brandId: command.brandReference,
            actor: { type: "User", reference: actor },
            actionCode: command.action === "ActivateBrand" ? "BRAND_ACTIVATED" : "BRAND_ARCHIVED",
            targetType: "Brand",
            targetId: command.brandReference,
            correlationId: command.operationReference,
            reasonCode: purpose,
            occurredAt: input.audit.occurredAt,
            sourceChannel: "MERCHANT_WEB",
            dataClassification: "Internal",
            retentionPolicyCode: "CONFIGURATION_AUDIT",
            retentionPolicyVersion: 1,
          });
        },
      });
      const prior = await store.resolveOperation(
        parseBrandAdministrationReference(command.operationReference),
      );
      const priorBrand = prior ? createBrand(prior.artifact) : null;
      const at = parseCanonicalInstant(priorBrand?.updatedAt ?? options.now());
      const current =
        priorBrand ?? (await store.loadBrand(parseBrandReference(command.brandReference)));
      if (!current) return fail("BRAND_ADMIN_NOT_FOUND");
      if (!priorBrand && current.version !== command.expectedBrandVersion)
        return fail("BRAND_ADMIN_VERSION_CONFLICT");
      const artifact =
        priorBrand ??
        transitionBrand(
          current,
          current.version,
          command.action === "ActivateBrand" ? "Active" : "Archived",
          at,
        );
      const service = lifecycleService(
        store,
        async (input) =>
          input.command === command.action &&
          input.actorReference === actor &&
          input.brandReference === command.brandReference &&
          input.purposeCode === purpose &&
          (await allowed()),
      );
      const input = {
        operationReference: command.operationReference,
        actorReference: actor,
        purposeCode: purpose,
        auditReference: parseBrandAdministrationReference(
          options.auditReference(command.operationReference),
        ),
        expectedBrandVersion: command.expectedBrandVersion,
        occurredAt: at,
        artifact,
      };
      const result = await (command.action === "ActivateBrand"
        ? service.activateBrand(input)
        : service.archiveBrand(input));
      if (!(await allowed())) return fail("BRAND_ADMIN_PERMISSION_DENIED");
      const saved = createBrand(result.operation.artifact);
      return {
        status: result.status,
        brandReference: saved.brandReference,
        lifecycle: saved.lifecycle,
        version: saved.version,
      };
    });
  };
}

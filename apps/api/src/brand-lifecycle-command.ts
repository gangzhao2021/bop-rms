import { readClosedRecord } from "@bop/identity";
import { appendAuditRecordInTransaction, sha256Hex } from "@bop/audit";
import {
  BrandAdministrationServiceError,
  createBrand,
  createBrandAdministrationService,
  createPostgresBrandLifecycleStore,
  parseBrandAdministrationReference,
  parseBrandReference,
  parseCanonicalInstant,
  transitionBrand,
  type BrandLifecycleTransaction,
} from "@bop/tenant";

type Command = "ActivateBrand" | "ArchiveBrand";
type Transactions = Parameters<typeof createPostgresBrandLifecycleStore>[0]["transactions"];
const fail = (code: ConstructorParameters<typeof BrandAdministrationServiceError>[0]): never => {
  throw new BrandAdministrationServiceError(code);
};
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
    let command: {
      brandReference: string;
      action: Command;
      expectedBrandVersion: number;
      operationReference: string;
    };
    try {
      const raw = readClosedRecord(request.command, [
        "brandReference",
        "action",
        "expectedBrandVersion",
        "operationReference",
      ]);
      if (
        (raw.action !== "ActivateBrand" && raw.action !== "ArchiveBrand") ||
        !Number.isSafeInteger(raw.expectedBrandVersion) ||
        (raw.expectedBrandVersion as number) < 1
      )
        return fail("BRAND_ADMIN_INPUT_INVALID");
      command = {
        brandReference: parseBrandReference(raw.brandReference),
        action: raw.action,
        expectedBrandVersion: raw.expectedBrandVersion as number,
        operationReference: parseBrandAdministrationReference(raw.operationReference),
      };
    } catch {
      return fail("BRAND_ADMIN_INPUT_INVALID");
    }
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
      const unavailable = (): never => fail("BRAND_ADMIN_DEPENDENCY_UNAVAILABLE");
      const service = createBrandAdministrationService({
        repository: {
          ...store,
          loadStore: unavailable,
          loadLatestConfiguration: unavailable,
          loadLatestMembership: unavailable,
        },
        authorization: {
          authorize: async (input) =>
            input.command === command.action &&
            input.actorReference === actor &&
            input.brandReference === command.brandReference &&
            input.purposeCode === purpose &&
            (await allowed()),
        },
        approval: { validate: unavailable },
        publishing: { validate: unavailable },
        references: {
          validateMedia: unavailable,
          validateCatalog: unavailable,
          hashIntent: (input) => "sha256:" + sha256Hex(input),
          equals: (a, b) => a === b,
        },
      });
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

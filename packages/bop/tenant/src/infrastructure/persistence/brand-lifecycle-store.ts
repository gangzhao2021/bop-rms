import { createHash } from "node:crypto";
import { readClosedRecord } from "@bop/identity";
import {
  createBrand,
  parseBrandReference,
  parseCanonicalInstant,
  transitionBrand,
  type Brand,
} from "../../domain/brand-store.js";
import { parseBrandAdministrationReference } from "../../contracts/brand-administration.js";
import {
  BrandAdministrationServiceError,
  type BrandAdministrationServiceErrorCode,
} from "../../application/brand-administration-service.js";
import type {
  BrandAdministrationOperation,
  BrandAdministrationPorts,
} from "../../application/ports/brand-administration-ports.js";
import {
  parseTenantBrandConfigurationContentRequest,
  parseTenantOptionSetBrandConfigurationContentRequest,
  parseTenantStoreBrandConfigurationContentRequest,
  parseTenantRecordedBrandConfiguration,
  tenantBrandConfigurationContent,
  tenantBrandConfigurationFields,
  type TenantBrandConfigurationContentRequest,
  type TenantOptionSetBrandConfigurationContentRequest,
  type TenantStoreBrandConfigurationContentRequest,
} from "../../contracts/brand-configuration-content-source.js";

export interface BrandLifecycleTransaction {
  query<Row = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[],
  ): Promise<{ rows: readonly Row[]; rowCount: number | null }>;
}
export interface TenantBrandConfigurationTransaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
export const tenantBrandConfigurationRequiredFields = Object.freeze([
  ...tenantBrandConfigurationFields,
  "brandLifecycle",
  "brandVersion",
  "brandUpdatedAt",
]);
/** Consistency of the owning closed V1 content, never authorization evidence. */
export function tenantBrandConfigurationContentDigest(value: unknown): string {
  return (
    "sha256:" +
    createHash("sha256")
      .update(JSON.stringify(tenantBrandConfigurationContent(value)))
      .digest("hex")
  );
}
export interface TenantRecordedBrandConfiguration {
  readonly profile: "TenantRecordedBrandConfigurationV1";
  readonly configuration: ReturnType<typeof parseTenantRecordedBrandConfiguration>;
  readonly brandVersion: number;
  readonly contentDigest: string;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly currentPublication: "NotEvaluated";
}
type BrandContentRequest =
  | TenantBrandConfigurationContentRequest
  | TenantOptionSetBrandConfigurationContentRequest
  | TenantStoreBrandConfigurationContentRequest;
interface BrandContentSourceOptions<R extends BrandContentRequest> {
  readonly brandReference: string;
  readonly clock: () => string;
  readonly transactions: {
    /** Actual READ COMMITTED outer UoW; retain Brand and Publishing fences through COMMIT. */
    run<T>(work: (tx: TenantBrandConfigurationTransaction) => Promise<T>): Promise<T>;
  };
  readonly authority: {
    /** Current session/Tenant/Brand/Actor/purpose and every unmasked required field through COMMIT. */
    withCurrentContentRead<T>(
      request: R,
      requiredFields: readonly string[],
      work: () => Promise<T>,
    ): Promise<T>;
    isCurrent(
      tx: TenantBrandConfigurationTransaction,
      request: R,
      requiredFields: readonly string[],
    ): Promise<boolean>;
  };
}
/** Exact immutable metadata candidate. A Published row alone is never current release evidence. */
function createBrandConfigurationContentSource<R extends BrandContentRequest>(
  options: BrandContentSourceOptions<R>,
  parseRequest: (value: unknown) => R,
) {
  const brand = parseBrandReference(options.brandReference);
  const unavailable = (): never => {
    throw new Error("TENANT_BRAND_CONFIGURATION_UNAVAILABLE");
  };
  const rows = (value: unknown): readonly Record<string, unknown>[] => {
    if (!value || typeof value !== "object") return unavailable();
    const d = Object.getOwnPropertyDescriptor(value, "rows");
    if (!d || !("value" in d) || !Array.isArray(d.value) || d.value.length !== 1)
      return unavailable();
    return d.value;
  };
  return Object.freeze({
    async withRecordedConfiguration<T>(
      input: R,
      work: (
        source: TenantRecordedBrandConfiguration,
        tx: TenantBrandConfigurationTransaction,
      ) => Promise<T>,
    ): Promise<T> {
      try {
        const request = parseRequest(input);
        if (request.brandReference !== brand) return unavailable();
        return await options.authority.withCurrentContentRead(
          request,
          tenantBrandConfigurationRequiredFields,
          () =>
            options.transactions.run(async (tx) => {
              let configuration: TenantRecordedBrandConfiguration["configuration"] | null = null;
              const assertCurrent = async () => {
                const now = parseCanonicalInstant(options.clock());
                if (
                  now < request.observedAt ||
                  now >= request.validUntil ||
                  (configuration !== null &&
                    (now < configuration.effectiveFrom ||
                      (configuration.effectiveUntil !== null &&
                        now >= configuration.effectiveUntil))) ||
                  (await options.authority.isCurrent(
                    tx,
                    request,
                    tenantBrandConfigurationRequiredFields,
                  )) !== true
                )
                  return unavailable();
              };
              await assertCurrent();
              if (
                rows(await tx.query("SHOW transaction_isolation", []))[0]?.transaction_isolation !==
                "read committed"
              )
                return unavailable();
              await tx.query(
                "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)",
                [brand],
              );
              const root = rows(
                await tx.query(
                  `SELECT brand_id,lifecycle,version::text,
              to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at,
              updated_at=date_trunc('milliseconds',updated_at) AS precise
              FROM bop_tenant.brand WHERE brand_id=$1 FOR SHARE`,
                  [brand],
                ),
              )[0];
              if (
                !root ||
                root.brand_id !== brand ||
                root.lifecycle !== "Active" ||
                root.precise !== true ||
                typeof root.version !== "string" ||
                !/^[1-9][0-9]{0,15}$/.test(root.version) ||
                Number(root.version) !== request.expectedBrandVersion ||
                typeof root.updated_at !== "string" ||
                parseCanonicalInstant(root.updated_at) > request.observedAt
              )
                return unavailable();
              const c = rows(
                await tx.query(
                  `SELECT configuration_version_id,brand_id,configuration_version::text,lifecycle,
              default_locale,supported_locales,media_theme_reference,catalog_source_reference,platform_template_reference,
              override_allowed_field_codes,hard_requirement_field_codes,
              to_char(effective_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS effective_from,
              CASE WHEN effective_until IS NULL THEN NULL ELSE to_char(effective_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END AS effective_until,
              supersedes_version_reference,reason_code,authored_by_reference,approved_by_reference,approval_evidence_reference,publication_reference,
              to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
              to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at,data_classification,
              effective_from=date_trunc('milliseconds',effective_from) AND
              (effective_until IS NULL OR effective_until=date_trunc('milliseconds',effective_until)) AND
              created_at=date_trunc('milliseconds',created_at) AND updated_at=date_trunc('milliseconds',updated_at) AS precise
              FROM bop_tenant.brand_configuration_version WHERE brand_id=$1 AND configuration_version_id=$2`,
                  [brand, request.configurationVersionReference],
                ),
              )[0];
              if (
                !c ||
                c.precise !== true ||
                typeof c.configuration_version !== "string" ||
                !/^[1-9][0-9]{0,15}$/.test(c.configuration_version)
              )
                return unavailable();
              configuration = parseTenantRecordedBrandConfiguration({
                configurationVersionReference: c.configuration_version_id,
                brandReference: c.brand_id,
                configurationVersion: Number(c.configuration_version),
                lifecycle: c.lifecycle,
                defaultLocale: c.default_locale,
                supportedLocales: c.supported_locales,
                mediaThemeReference: c.media_theme_reference,
                catalogSourceReference: c.catalog_source_reference,
                platformTemplateReference: c.platform_template_reference,
                overrideAllowedFieldCodes: c.override_allowed_field_codes,
                hardRequirementFieldCodes: c.hard_requirement_field_codes,
                effectiveFrom: c.effective_from,
                effectiveUntil: c.effective_until,
                supersedesVersionReference: c.supersedes_version_reference,
                reasonCode: c.reason_code,
                authoredByReference: c.authored_by_reference,
                approvedByReference: c.approved_by_reference,
                approvalEvidenceReference: c.approval_evidence_reference,
                publicationReference: c.publication_reference,
                createdAt: c.created_at,
                updatedAt: c.updated_at,
                dataClassification: c.data_classification,
              });
              if (
                configuration.brandReference !== brand ||
                configuration.configurationVersionReference !==
                  request.configurationVersionReference ||
                configuration.lifecycle !== "Published" ||
                configuration.updatedAt > request.observedAt ||
                configuration.effectiveFrom > request.observedAt ||
                (configuration.effectiveUntil !== null &&
                  configuration.effectiveUntil <= request.observedAt)
              )
                return unavailable();
              await assertCurrent();
              const source: TenantRecordedBrandConfiguration = Object.freeze({
                profile: "TenantRecordedBrandConfigurationV1",
                configuration,
                brandVersion: request.expectedBrandVersion,
                contentDigest: tenantBrandConfigurationContentDigest(configuration),
                observedAt: request.observedAt,
                validUntil:
                  configuration.effectiveUntil !== null &&
                  configuration.effectiveUntil < request.validUntil
                    ? configuration.effectiveUntil
                    : request.validUntil,
                currentPublication: "NotEvaluated",
              });
              const result = await work(source, tx);
              await assertCurrent();
              return result;
            }),
        );
      } catch {
        return unavailable();
      }
    },
  });
}
export type TenantBrandConfigurationContentSourceOptions =
  BrandContentSourceOptions<TenantBrandConfigurationContentRequest>;
export type TenantOptionSetBrandConfigurationContentSourceOptions =
  BrandContentSourceOptions<TenantOptionSetBrandConfigurationContentRequest>;
export type TenantStoreBrandConfigurationContentSourceOptions =
  BrandContentSourceOptions<TenantStoreBrandConfigurationContentRequest>;
export function createPostgresTenantBrandConfigurationContentSource(
  options: TenantBrandConfigurationContentSourceOptions,
) {
  return createBrandConfigurationContentSource(
    options,
    parseTenantBrandConfigurationContentRequest,
  );
}
export function createPostgresTenantOptionSetBrandConfigurationContentSource(
  options: TenantOptionSetBrandConfigurationContentSourceOptions,
) {
  return createBrandConfigurationContentSource(
    options,
    parseTenantOptionSetBrandConfigurationContentRequest,
  );
}
export function createPostgresTenantStoreBrandConfigurationContentSource(
  options: TenantStoreBrandConfigurationContentSourceOptions,
) {
  return createBrandConfigurationContentSource(
    options,
    parseTenantStoreBrandConfigurationContentRequest,
  );
}
type Repository = BrandAdministrationPorts["repository"];
type Commit = Parameters<Repository["commit"]>[0];
const fail = (
  code: BrandAdministrationServiceErrorCode = "BRAND_ADMIN_DEPENDENCY_UNAVAILABLE",
): never => {
  throw new BrandAdministrationServiceError(code);
};
const commands = ["CreateBrand", "ActivateBrand", "ArchiveBrand"] as const;
function parseOperation(input: BrandAdministrationOperation): BrandAdministrationOperation {
  if (
    !(commands as readonly string[]).includes(input.command) ||
    !/^sha256:[0-9a-f]{64}$/.test(input.intentDigest)
  )
    return fail("BRAND_ADMIN_INPUT_INVALID");
  const artifact = createBrand(input.artifact);
  if (artifact.brandReference !== input.brandReference || artifact.version !== input.brandVersion)
    return fail("BRAND_ADMIN_INPUT_INVALID");
  return {
    command: input.command,
    operationReference: parseBrandAdministrationReference(input.operationReference),
    brandReference: parseBrandReference(input.brandReference),
    intentDigest: input.intentDigest,
    brandVersion: artifact.version,
    artifact,
  };
}
export interface BrandLifecycleStoreOptions {
  brandReference: string;
  transactions: { run<T>(work: (tx: BrandLifecycleTransaction) => Promise<T>): Promise<T> };
  authorize(
    tx: BrandLifecycleTransaction,
    operation: BrandAdministrationOperation | null,
  ): Promise<boolean>;
  appendAudit(tx: BrandLifecycleTransaction, input: Commit): Promise<void>;
}
export interface BrandInitialCreationBinding {
  readonly operationReference: string;
  readonly intentDigest: string;
  readonly actorReference: string;
  readonly auditReference: string;
}
export interface BrandInitialCreationStoreOptions extends BrandLifecycleStoreOptions {
  readonly binding: BrandInitialCreationBinding;
}
/** Brand lifecycle only; caller binds current identity/permission and real Audit append. */
export function createPostgresBrandLifecycleStore(
  options: BrandLifecycleStoreOptions,
): Pick<Repository, "loadBrand" | "resolveOperation" | "commit"> {
  return createBrandLifecycleStore(options);
}
export interface BrandLifecycleAdministrationStoreOptions extends BrandLifecycleStoreOptions {
  readonly binding: {
    readonly actorReference: string;
    readonly purposeCode: "BRAND_ADMINISTRATION";
  };
}
export interface BrandLifecycleAdministrationRecordedOperation {
  readonly operation: BrandAdministrationOperation;
  readonly actorReference: string;
  readonly purposeCode: "BRAND_ADMINISTRATION";
  readonly auditReference: string;
  readonly occurredAt: string;
}
/** Ordinary lifecycle only. The caller retains actual Session/IAM/Feature and
 * final guards in its borrowed transaction. Absence is not an abandonment. */
export function createPostgresBrandLifecycleAdministrationStore(
  options: BrandLifecycleAdministrationStoreOptions,
): Pick<Repository, "loadBrand" | "resolveOperation" | "commit"> & {
  resolveRecordedOperation(
    reference: string,
  ): Promise<BrandLifecycleAdministrationRecordedOperation | null>;
} {
  const input = initialRecord(options.binding, ["actorReference", "purposeCode"]);
  if (input.purposeCode !== "BRAND_ADMINISTRATION") return fail("BRAND_ADMIN_INPUT_INVALID");
  const administration = Object.freeze({
    actorReference: parseBrandAdministrationReference(input.actorReference),
    purposeCode: "BRAND_ADMINISTRATION" as const,
  });
  const transactions = options.transactions,
    run = transactions.run,
    authorize = options.authorize,
    appendAudit = options.appendAudit;
  return createBrandLifecycleStore(
    {
      brandReference: options.brandReference,
      transactions: { run: run.bind(transactions) },
      authorize: (tx, operation) => authorize.call(options, tx, operation),
      appendAudit: (tx, input) => appendAudit.call(options, tx, input),
    },
    undefined,
    administration,
  );
}
/** The outer provisioning owner resolves this immutable original before creating
 * Membership/Permission facts, and holds its actual authority and transaction
 * through COMMIT. This facade does not supply that authority or repair grants. */
export function createPostgresBrandInitialCreationStore(
  options: BrandInitialCreationStoreOptions,
): Pick<Repository, "loadBrand" | "resolveOperation" | "commit"> {
  const row = initialRecord(options.binding, [
    "operationReference",
    "intentDigest",
    "actorReference",
    "auditReference",
  ]);
  if (typeof row.intentDigest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(row.intentDigest))
    return fail("BRAND_ADMIN_INPUT_INVALID");
  const binding = Object.freeze({
    operationReference: parseBrandAdministrationReference(row.operationReference),
    intentDigest: row.intentDigest,
    actorReference: parseBrandAdministrationReference(row.actorReference),
    auditReference: parseBrandAdministrationReference(row.auditReference),
  });
  const transactions = options.transactions,
    run = transactions.run,
    authorize = options.authorize,
    appendAudit = options.appendAudit;
  return createBrandLifecycleStore(
    {
      brandReference: options.brandReference,
      transactions: { run: run.bind(transactions) },
      authorize: (tx, operation) => authorize.call(options, tx, operation),
      appendAudit: (tx, input) => appendAudit.call(options, tx, input),
    },
    binding,
  );
}
function initialRecord(value: unknown, keys: readonly string[]) {
  try {
    return readClosedRecord(value, keys);
  } catch {
    return fail("BRAND_ADMIN_INPUT_INVALID");
  }
}
function createBrandLifecycleStore(
  options: BrandLifecycleStoreOptions,
  binding?: Readonly<BrandInitialCreationBinding>,
  administration?: Readonly<BrandLifecycleAdministrationStoreOptions["binding"]>,
): Pick<Repository, "loadBrand" | "resolveOperation" | "commit"> & {
  resolveRecordedOperation(
    reference: string,
  ): Promise<BrandLifecycleAdministrationRecordedOperation | null>;
} {
  const brand = parseBrandReference(options.brandReference);
  function boundOperation(operation: BrandAdministrationOperation) {
    if (!binding) return;
    if (
      operation.operationReference !== binding.operationReference ||
      operation.brandReference !== brand ||
      operation.intentDigest !== binding.intentDigest
    )
      return fail("BRAND_ADMIN_IDEMPOTENCY_CONFLICT");
    const artifact = createBrand(operation.artifact);
    if (
      operation.command !== "CreateBrand" ||
      operation.brandVersion !== 1 ||
      artifact.lifecycle !== "Draft" ||
      artifact.version !== 1 ||
      artifact.createdAt !== artifact.updatedAt
    )
      return fail("BRAND_ADMIN_LIFECYCLE_CONFLICT");
  }
  async function admitAdministration(tx: BrandLifecycleTransaction, reference?: string) {
    if (!administration) return;
    // Serialize before actual IAM takes the Brand SHARE row lock. Distinct
    // lifecycle operations must not both hold SHARE and then upgrade to UPDATE.
    if (reference !== undefined) {
      const operation = parseBrandAdministrationReference(reference);
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "BrandOperation:" + brand + ":" + operation,
      ]);
    }
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["Brand:" + brand]);
  }
  async function allowed(
    tx: BrandLifecycleTransaction,
    operation: BrandAdministrationOperation | null,
  ) {
    if (!(await options.authorize(tx, operation))) return fail("BRAND_ADMIN_PERMISSION_DENIED");
    await tx.query(
      administration
        ? "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)"
        : "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)",
      [brand],
    );
  }
  function strictRows(result: unknown) {
    const d =
      result && typeof result === "object"
        ? Object.getOwnPropertyDescriptor(result, "rows")
        : undefined;
    if (
      !d?.enumerable ||
      !("value" in d) ||
      !Array.isArray(d.value) ||
      Object.getPrototypeOf(d.value) !== Array.prototype ||
      d.value.length > 1 ||
      Reflect.ownKeys(d.value).length !== d.value.length + 1
    )
      return fail();
    if (d.value.length === 0) return null;
    const row = Object.getOwnPropertyDescriptor(d.value, "0");
    if (!row?.enumerable || !("value" in row)) return fail();
    return row.value;
  }
  function strictVersion(value: unknown) {
    if (
      typeof value !== "string" ||
      !/^[1-9][0-9]*$/u.test(value) ||
      !Number.isSafeInteger(Number(value))
    )
      return fail();
    return Number(value);
  }
  function strictBrand(value: unknown) {
    const raw = initialRecord(value, [
      "brandReference",
      "code",
      "displayName",
      "defaultLocale",
      "currencyCode",
      "lifecycle",
      "version",
      "createdAt",
      "updatedAt",
    ]);
    const parsed = createBrand(raw);
    if (parsed.createdAt.startsWith("0000-") || parsed.updatedAt.startsWith("0000-")) return fail();
    return parsed;
  }
  async function resolveAdministration(
    tx: BrandLifecycleTransaction,
    reference: string,
  ): Promise<BrandLifecycleAdministrationRecordedOperation | null> {
    if (!administration) return fail("BRAND_ADMIN_PERMISSION_DENIED");
    const operationReference = parseBrandAdministrationReference(reference);
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "BrandOperation:" + brand + ":" + operationReference,
    ]);
    const result = await tx.query(
      `SELECT operation_id,brand_id,command_type,intent_digest,brand_version::text,
      actor_reference,purpose_code,audit_reference,data_classification,artifact_snapshot_json,
      to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS occurred_at,
      occurred_at=date_trunc('milliseconds',occurred_at) AS precise
      FROM bop_tenant.brand_admin_operation WHERE brand_id=$1 AND operation_id=$2`,
      [brand, operationReference],
    );
    const value = strictRows(result);
    if (value === null) return null;
    const row = initialRecord(value, [
      "operation_id",
      "brand_id",
      "command_type",
      "intent_digest",
      "brand_version",
      "actor_reference",
      "purpose_code",
      "audit_reference",
      "data_classification",
      "artifact_snapshot_json",
      "occurred_at",
      "precise",
    ]);
    if (
      row.operation_id !== operationReference ||
      row.brand_id !== brand ||
      row.actor_reference !== administration.actorReference ||
      row.purpose_code !== administration.purposeCode ||
      row.data_classification !== "ConfigurationMetadata" ||
      row.precise !== true ||
      (row.command_type !== "ActivateBrand" && row.command_type !== "ArchiveBrand")
    )
      return fail("BRAND_ADMIN_IDEMPOTENCY_CONFLICT");
    const artifact = strictBrand(row.artifact_snapshot_json),
      occurredAt = parseCanonicalInstant(row.occurred_at);
    if (strictVersion(row.brand_version) !== artifact.version)
      return fail("BRAND_ADMIN_IDEMPOTENCY_CONFLICT");
    const operation = Object.freeze(
      parseOperation({
        command: row.command_type,
        operationReference,
        brandReference: brand,
        intentDigest: typeof row.intent_digest === "string" ? row.intent_digest : "",
        brandVersion: artifact.version,
        artifact,
      }),
    );
    if (
      operation.brandVersion < 2 ||
      artifact.updatedAt !== occurredAt ||
      artifact.lifecycle !== (operation.command === "ActivateBrand" ? "Active" : "Archived")
    )
      return fail("BRAND_ADMIN_IDEMPOTENCY_CONFLICT");
    return Object.freeze({
      operation,
      actorReference: administration.actorReference,
      purposeCode: administration.purposeCode,
      auditReference: parseBrandAdministrationReference(row.audit_reference),
      occurredAt,
    });
  }
  async function load(tx: BrandLifecycleTransaction): Promise<Brand | null> {
    if (administration) {
      const result = await tx.query(
        `SELECT brand_id,code,display_name,default_locale,currency_code,lifecycle,version::text,
        to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
        to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at,
        created_at=date_trunc('milliseconds',created_at) AND updated_at=date_trunc('milliseconds',updated_at) AS precise
        FROM bop_tenant.brand WHERE brand_id=$1 FOR UPDATE`,
        [brand],
      );
      const value = strictRows(result);
      if (value === null) return null;
      const row = initialRecord(value, [
        "brand_id",
        "code",
        "display_name",
        "default_locale",
        "currency_code",
        "lifecycle",
        "version",
        "created_at",
        "updated_at",
        "precise",
      ]);
      if (row.brand_id !== brand || row.precise !== true) return fail();
      return strictBrand({
        brandReference: row.brand_id,
        code: row.code,
        displayName: row.display_name,
        defaultLocale: row.default_locale,
        currencyCode: row.currency_code,
        lifecycle: row.lifecycle,
        version: strictVersion(row.version),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      });
    }

    const result = await tx.query<{
      brand_id: string;
      code: string;
      display_name: string;
      default_locale: string;
      currency_code: string;
      lifecycle: string;
      version: string | number;
      created_at: Date;
      updated_at: Date;
    }>("SELECT * FROM bop_tenant.brand WHERE brand_id=$1 FOR UPDATE", [brand]);
    if (result.rows.length === 0) return null;
    if (result.rows.length !== 1) return fail();
    const row = result.rows[0];
    if (!row) return fail();
    return createBrand({
      brandReference: row.brand_id,
      code: row.code,
      displayName: row.display_name,
      defaultLocale: row.default_locale,
      currencyCode: row.currency_code,
      lifecycle: row.lifecycle,
      version: Number(row.version),
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    });
  }
  async function resolve(tx: BrandLifecycleTransaction, reference: string) {
    if (administration) return (await resolveAdministration(tx, reference))?.operation ?? null;
    const operation = parseBrandAdministrationReference(reference);
    if (binding && operation !== binding.operationReference)
      return fail("BRAND_ADMIN_IDEMPOTENCY_CONFLICT");
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "BrandOperation:" + brand + ":" + operation,
    ]);
    const result = await tx.query<Record<string, unknown>>(
      binding
        ? `SELECT operation_id,brand_id,command_type,intent_digest,brand_version::text,
          actor_reference,purpose_code,audit_reference,data_classification,artifact_snapshot_json,
          to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS occurred_at,
          occurred_at=date_trunc('milliseconds',occurred_at) AS precise
          FROM bop_tenant.brand_admin_operation WHERE brand_id=$1 AND operation_id=$2`
        : "SELECT * FROM bop_tenant.brand_admin_operation WHERE brand_id=$1 AND operation_id=$2",
      [brand, operation],
    );
    if (binding) {
      const descriptor = Object.getOwnPropertyDescriptor(result, "rows");
      if (
        !descriptor ||
        !("value" in descriptor) ||
        !Array.isArray(descriptor.value) ||
        Object.getPrototypeOf(descriptor.value) !== Array.prototype ||
        descriptor.value.length > 1 ||
        Reflect.ownKeys(descriptor.value).length !== descriptor.value.length + 1
      )
        return fail();
      if (descriptor.value.length === 0) return null;
      const entry = Object.getOwnPropertyDescriptor(descriptor.value, "0");
      if (!entry?.enumerable || !("value" in entry)) return fail();
      const row = initialRecord(entry.value, [
        "operation_id",
        "brand_id",
        "command_type",
        "intent_digest",
        "brand_version",
        "actor_reference",
        "purpose_code",
        "audit_reference",
        "data_classification",
        "artifact_snapshot_json",
        "occurred_at",
        "precise",
      ]);
      if (
        row.operation_id !== operation ||
        row.brand_id !== brand ||
        row.command_type !== "CreateBrand" ||
        row.intent_digest !== binding.intentDigest ||
        row.actor_reference !== binding.actorReference ||
        row.purpose_code !== "BRAND_INITIAL_PROVISIONING" ||
        row.audit_reference !== binding.auditReference ||
        row.brand_version !== "1" ||
        row.data_classification !== "ConfigurationMetadata" ||
        row.precise !== true
      )
        return fail("BRAND_ADMIN_IDEMPOTENCY_CONFLICT");
      const artifact = createBrand(row.artifact_snapshot_json),
        occurredAt = parseCanonicalInstant(row.occurred_at);
      const original = parseOperation({
        command: "CreateBrand",
        operationReference: operation,
        brandReference: brand,
        intentDigest: binding.intentDigest,
        brandVersion: artifact.version,
        artifact,
      });
      boundOperation(original);
      if (artifact.createdAt !== occurredAt || artifact.updatedAt !== occurredAt)
        return fail("BRAND_ADMIN_IDEMPOTENCY_CONFLICT");
      return Object.freeze(original);
    }
    if (result.rows.length === 0) return null;
    if (result.rows.length !== 1) return fail();
    const row = result.rows[0];
    if (!row) return fail();
    // Never reconstruct an old result from today's mutable Brand.
    if (row.artifact_snapshot_json === null) return fail();
    return parseOperation({
      command: row.command_type as BrandAdministrationOperation["command"],
      operationReference: parseBrandAdministrationReference(row.operation_id),
      brandReference: brand,
      intentDigest: row.intent_digest as string,
      brandVersion: Number(row.brand_version) as Brand["version"],
      artifact: createBrand(row.artifact_snapshot_json),
    });
  }
  return Object.freeze({
    async resolveRecordedOperation(reference: string) {
      if (!administration) return fail("BRAND_ADMIN_PERMISSION_DENIED");
      return options.transactions.run(async (tx) => {
        await admitAdministration(tx, reference);
        await allowed(tx, null);
        const result = await resolveAdministration(tx, reference);
        await allowed(tx, result?.operation ?? null);
        return result;
      });
    },
    async loadBrand(reference) {
      if (reference !== brand) return fail("BRAND_ADMIN_PERMISSION_DENIED");
      return options.transactions.run(async (tx) => {
        await admitAdministration(tx);
        await allowed(tx, null);
        const result = await load(tx);
        await allowed(tx, null);
        return result;
      });
    },
    async resolveOperation(reference) {
      return options.transactions.run(async (tx) => {
        await admitAdministration(tx, reference);
        await allowed(tx, null);
        const result = await resolve(tx, reference);
        await allowed(tx, result);
        return result;
      });
    },
    async commit(raw) {
      if (administration) {
        const input = initialRecord(raw, ["operation", "expectedBrandVersion", "audit"]);
        const operation = initialRecord(input.operation, [
          "command",
          "operationReference",
          "brandReference",
          "intentDigest",
          "brandVersion",
          "artifact",
        ]);
        const audit = initialRecord(input.audit, [
          "actorReference",
          "purposeCode",
          "auditReference",
          "occurredAt",
        ]);
        if (
          (operation.command !== "ActivateBrand" && operation.command !== "ArchiveBrand") ||
          audit.actorReference !== administration.actorReference ||
          audit.purposeCode !== administration.purposeCode
        )
          return fail("BRAND_ADMIN_PERMISSION_DENIED");
        const artifact = strictBrand(operation.artifact);
        if (input.expectedBrandVersion !== artifact.version - 1 || artifact.version < 2)
          return fail("BRAND_ADMIN_VERSION_CONFLICT");
      }
      if (binding) {
        const input = initialRecord(raw, ["operation", "expectedBrandVersion", "audit"]);
        initialRecord(input.operation, [
          "command",
          "operationReference",
          "brandReference",
          "intentDigest",
          "brandVersion",
          "artifact",
        ]);
        const audit = initialRecord(input.audit, [
          "actorReference",
          "purposeCode",
          "auditReference",
          "occurredAt",
        ]);
        if (input.expectedBrandVersion !== 0) return fail("BRAND_ADMIN_VERSION_CONFLICT");
        if (
          audit.actorReference !== binding.actorReference ||
          audit.auditReference !== binding.auditReference ||
          audit.purposeCode !== "BRAND_INITIAL_PROVISIONING"
        )
          return fail("BRAND_ADMIN_IDEMPOTENCY_CONFLICT");
      }
      const operation = parseOperation(raw.operation);
      boundOperation(operation);
      if (binding) Object.freeze(operation);
      const next = createBrand(operation.artifact);
      const audit = {
        actorReference: parseBrandAdministrationReference(raw.audit.actorReference),
        purposeCode: raw.audit.purposeCode,
        auditReference: parseBrandAdministrationReference(raw.audit.auditReference),
        occurredAt: parseCanonicalInstant(raw.audit.occurredAt),
      };
      if (operation.brandReference !== brand) return fail("BRAND_ADMIN_PERMISSION_DENIED");
      if (
        !/^[A-Z][A-Z0-9_.:-]{0,63}$/.test(audit.purposeCode) ||
        audit.occurredAt !== next.updatedAt ||
        !Number.isSafeInteger(raw.expectedBrandVersion) ||
        raw.expectedBrandVersion < 0
      )
        return fail("BRAND_ADMIN_INPUT_INVALID");
      const input = { operation, audit, expectedBrandVersion: raw.expectedBrandVersion };
      if (binding) {
        Object.freeze(audit);
        Object.freeze(input);
      }
      return options.transactions.run(async (tx) => {
        await admitAdministration(tx, operation.operationReference);
        await allowed(tx, operation);
        const recorded = administration
          ? await resolveAdministration(tx, operation.operationReference)
          : null;
        const prior = administration
          ? (recorded?.operation ?? null)
          : await resolve(tx, operation.operationReference);
        if (
          recorded &&
          (recorded.auditReference !== audit.auditReference ||
            recorded.occurredAt !== audit.occurredAt)
        )
          return fail("BRAND_ADMIN_IDEMPOTENCY_CONFLICT");
        if (prior) {
          if (JSON.stringify(prior) !== JSON.stringify(operation))
            return fail("BRAND_ADMIN_IDEMPOTENCY_CONFLICT");
          await allowed(tx, prior);
          return prior;
        }
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["Brand:" + brand]);
        const current = await load(tx);
        if ((current?.version ?? 0) !== input.expectedBrandVersion)
          return fail("BRAND_ADMIN_VERSION_CONFLICT");
        if (operation.command === "CreateBrand") {
          if (
            current ||
            next.lifecycle !== "Draft" ||
            next.version !== 1 ||
            next.createdAt !== audit.occurredAt
          )
            return fail("BRAND_ADMIN_LIFECYCLE_CONFLICT");
        } else {
          if (!current) return fail("BRAND_ADMIN_NOT_FOUND");
          const expected = transitionBrand(
            current,
            current.version,
            operation.command === "ActivateBrand" ? "Active" : "Archived",
            audit.occurredAt,
          );
          if (JSON.stringify(next) !== JSON.stringify(expected))
            return fail("BRAND_ADMIN_LIFECYCLE_CONFLICT");
        }
        await tx.query("SAVEPOINT brand_lifecycle", []);
        try {
          if (!current) {
            await tx.query(
              "INSERT INTO bop_tenant.brand(brand_id,code,display_name,default_locale,currency_code,lifecycle,version,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
              [
                brand,
                next.code,
                next.displayName,
                next.defaultLocale,
                next.currencyCode,
                next.lifecycle,
                next.version,
                next.createdAt,
                next.updatedAt,
              ],
            );
          } else {
            const updated = await tx.query(
              "UPDATE bop_tenant.brand SET lifecycle=$3,version=$4,updated_at=$5 WHERE brand_id=$1 AND version=$2",
              [brand, current.version, next.lifecycle, next.version, next.updatedAt],
            );
            if (updated.rowCount !== 1) return fail("BRAND_ADMIN_VERSION_CONFLICT");
          }
          await tx.query(
            "INSERT INTO bop_tenant.brand_admin_operation(operation_id,brand_id,command_type,intent_digest,brand_version,actor_reference,purpose_code,audit_reference,occurred_at,data_classification,artifact_snapshot_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'ConfigurationMetadata',$10)",
            [
              operation.operationReference,
              brand,
              operation.command,
              operation.intentDigest,
              operation.brandVersion,
              audit.actorReference,
              audit.purposeCode,
              audit.auditReference,
              audit.occurredAt,
              JSON.stringify(next),
            ],
          );
          await options.appendAudit(tx, input);
          await allowed(tx, operation);
          if (administration) {
            const saved = await resolveAdministration(tx, operation.operationReference);
            if (
              !saved ||
              JSON.stringify(saved.operation) !== JSON.stringify(operation) ||
              saved.auditReference !== audit.auditReference ||
              saved.occurredAt !== audit.occurredAt
            )
              return fail("BRAND_ADMIN_IDEMPOTENCY_CONFLICT");
          }
          if (binding) {
            const original = await resolve(tx, binding.operationReference);
            if (!original || JSON.stringify(original) !== JSON.stringify(operation))
              return fail("BRAND_ADMIN_IDEMPOTENCY_CONFLICT");
          }
          await tx.query("RELEASE SAVEPOINT brand_lifecycle", []);
          return operation;
        } catch (error) {
          await tx.query("ROLLBACK TO SAVEPOINT brand_lifecycle", []);
          await tx.query("RELEASE SAVEPOINT brand_lifecycle", []);
          throw error;
        }
      });
    },
  });
}

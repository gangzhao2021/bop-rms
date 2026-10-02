import { createHash } from "node:crypto";
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
  parseTenantRecordedBrandConfiguration,
  tenantBrandConfigurationContent,
  tenantBrandConfigurationFields,
  type TenantBrandConfigurationContentRequest,
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
export interface TenantBrandConfigurationContentSourceOptions {
  readonly brandReference: string;
  readonly clock: () => string;
  readonly transactions: {
    /** Actual READ COMMITTED outer UoW; retain Brand and Publishing fences through COMMIT. */
    run<T>(work: (tx: TenantBrandConfigurationTransaction) => Promise<T>): Promise<T>;
  };
  readonly authority: {
    /** Current session/Tenant/Brand/Actor/purpose and every unmasked required field through COMMIT. */
    withCurrentContentRead<T>(
      request: TenantBrandConfigurationContentRequest,
      requiredFields: readonly string[],
      work: () => Promise<T>,
    ): Promise<T>;
    isCurrent(
      tx: TenantBrandConfigurationTransaction,
      request: TenantBrandConfigurationContentRequest,
      requiredFields: readonly string[],
    ): Promise<boolean>;
  };
}
/** Exact immutable metadata candidate. A Published row alone is never current release evidence. */
export function createPostgresTenantBrandConfigurationContentSource(
  options: TenantBrandConfigurationContentSourceOptions,
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
      input: TenantBrandConfigurationContentRequest,
      work: (
        source: TenantRecordedBrandConfiguration,
        tx: TenantBrandConfigurationTransaction,
      ) => Promise<T>,
    ): Promise<T> {
      try {
        const request = parseTenantBrandConfigurationContentRequest(input);
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
/** Brand lifecycle only; caller binds current identity/permission and real Audit append. */
export function createPostgresBrandLifecycleStore(options: {
  brandReference: string;
  transactions: { run<T>(work: (tx: BrandLifecycleTransaction) => Promise<T>): Promise<T> };
  authorize(
    tx: BrandLifecycleTransaction,
    operation: BrandAdministrationOperation | null,
  ): Promise<boolean>;
  appendAudit(tx: BrandLifecycleTransaction, input: Commit): Promise<void>;
}): Pick<Repository, "loadBrand" | "resolveOperation" | "commit"> {
  const brand = parseBrandReference(options.brandReference);
  async function allowed(
    tx: BrandLifecycleTransaction,
    operation: BrandAdministrationOperation | null,
  ) {
    if (!(await options.authorize(tx, operation))) return fail("BRAND_ADMIN_PERMISSION_DENIED");
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)", [
      brand,
    ]);
  }
  async function load(tx: BrandLifecycleTransaction): Promise<Brand | null> {
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
    const operation = parseBrandAdministrationReference(reference);
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "BrandOperation:" + brand + ":" + operation,
    ]);
    const result = await tx.query<Record<string, unknown>>(
      "SELECT * FROM bop_tenant.brand_admin_operation WHERE brand_id=$1 AND operation_id=$2",
      [brand, operation],
    );
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
    async loadBrand(reference) {
      if (reference !== brand) return fail("BRAND_ADMIN_PERMISSION_DENIED");
      return options.transactions.run(async (tx) => {
        await allowed(tx, null);
        const result = await load(tx);
        await allowed(tx, null);
        return result;
      });
    },
    async resolveOperation(reference) {
      return options.transactions.run(async (tx) => {
        await allowed(tx, null);
        const result = await resolve(tx, reference);
        await allowed(tx, result);
        return result;
      });
    },
    async commit(raw) {
      const operation = parseOperation(raw.operation);
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
      return options.transactions.run(async (tx) => {
        await allowed(tx, operation);
        const prior = await resolve(tx, operation.operationReference);
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

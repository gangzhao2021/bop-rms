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

export interface BrandLifecycleTransaction {
  query<Row = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[],
  ): Promise<{ rows: readonly Row[]; rowCount: number | null }>;
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

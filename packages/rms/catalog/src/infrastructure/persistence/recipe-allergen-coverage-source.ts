import { createHash } from "node:crypto";
import { canonicalizeRfc8785 } from "@bop/audit";
import {
  parseCatalogReference,
  parseCatalogInstant,
  parseCatalogCode,
  parseLocalizedNames,
} from "../../contracts/product.js";
import type { ProductLifecycleTransaction } from "./product-lifecycle-store.js";
interface AllergenTransactionRunner {
  run<T>(work: (tx: ProductLifecycleTransaction) => Promise<T>): Promise<T>;
}
export type CatalogAllergenSourceErrorCode =
  | "ALLERGEN_SOURCE_INPUT_INVALID"
  | "ALLERGEN_SOURCE_PERMISSION_DENIED"
  | "ALLERGEN_SOURCE_UNAVAILABLE"
  | "ALLERGEN_SOURCE_CHANGED"
  | "ALLERGEN_SOURCE_INTEGRITY_CONFLICT";
export class CatalogAllergenSourceError extends Error {
  constructor(readonly code: CatalogAllergenSourceErrorCode) {
    super("Allergen coverage is unavailable");
    this.name = "CatalogAllergenSourceError";
  }
}
export interface CatalogAllergenSourceRequest {
  readonly actorReference: string;
  readonly purpose: "RecipeProjectionBuild";
  readonly observedAtUtc: string;
}
export interface CatalogAllergenSourceAuthorization extends CatalogAllergenSourceRequest {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly family: "Allergen";
}
export interface CatalogAllergenDependency {
  readonly objectReference: string;
  readonly versionReference: string;
  readonly digest: string;
}
export interface CatalogAllergenCoverage {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly family: "Allergen";
  readonly snapshotReference: string;
  readonly digest: string;
  readonly complete: true;
  readonly dependencies: readonly CatalogAllergenDependency[];
}
export interface CatalogAllergenCoverageRead {
  readonly coverage: CatalogAllergenCoverage;
  readonly capturedAtUtc: string;
  readonly asOfUtc: string;
}
function fail(code: CatalogAllergenSourceErrorCode = "ALLERGEN_SOURCE_UNAVAILABLE"): never {
  throw new CatalogAllergenSourceError(code);
}
function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length
  )
    return fail();
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor?.enumerable || !("value" in descriptor)) return fail();
    result[field] = descriptor.value;
  }
  return result;
}
function list(value: unknown, max = 2048): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > max ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return fail();
  const result: unknown[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor?.enumerable || !("value" in descriptor)) return fail();
    result.push(descriptor.value);
  }
  return result;
}
function rows(value: unknown, max = 2048): readonly unknown[] {
  if (value === null || typeof value !== "object") return fail();
  const descriptor = Object.getOwnPropertyDescriptor(value, "rows");
  if (!descriptor || !("value" in descriptor)) return fail();
  return list(descriptor.value, max);
}
function hash(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) return fail();
  return value;
}
const digest = (value: unknown) =>
  `sha256:${createHash("sha256").update(canonicalizeRfc8785(value)).digest("hex")}`;
const captureSelect = `SELECT coverage_json AS coverage,to_char(captured_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "capturedAtUtc" FROM rms_catalog.recipe_allergen_source_capture WHERE tenant_id=$1 AND brand_id=$2 AND `;
/** Complete Catalog allergen history, never a safety/validity approval. Authorizer must
 * hold actual Tenant/Brand relationship and Actor/purpose/phase/permission authority.
 * withCurrent holds all source tables through callback/COMMIT; callback cannot mutate them. */
export function createPostgresCatalogAllergenCoverageSource(options: {
  readonly runner: AllergenTransactionRunner;
  readonly scope: { readonly tenantReference: string; readonly brandReference: string };
  readonly generateReference: () => string;
  readonly authorize: (
    tx: ProductLifecycleTransaction,
    input: CatalogAllergenSourceAuthorization,
  ) => Promise<boolean>;
}) {
  const scope = object(options.scope, ["tenantReference", "brandReference"]),
    tenant = parseCatalogReference(scope.tenantReference),
    brand = parseCatalogReference(scope.brandReference);
  const runner = options.runner,
    authorize = options.authorize,
    generateReference = options.generateReference;
  function request(value: unknown): CatalogAllergenSourceRequest {
    try {
      const raw = object(value, ["actorReference", "purpose", "observedAtUtc"]);
      if (raw.purpose !== "RecipeProjectionBuild") return fail();
      return Object.freeze({
        actorReference: parseCatalogReference(raw.actorReference),
        purpose: raw.purpose,
        observedAtUtc: parseCatalogInstant(raw.observedAtUtc),
      });
    } catch {
      return fail("ALLERGEN_SOURCE_INPUT_INVALID");
    }
  }
  function coverage(value: unknown): CatalogAllergenCoverage {
    const raw = object(value, [
      "tenantReference",
      "brandReference",
      "family",
      "snapshotReference",
      "digest",
      "complete",
      "dependencies",
    ]);
    if (
      raw.tenantReference !== tenant ||
      raw.brandReference !== brand ||
      raw.family !== "Allergen" ||
      raw.complete !== true
    )
      return fail();
    const seen = new Set<string>();
    const dependencies = list(raw.dependencies)
      .map((value) => {
        const d = object(value, ["objectReference", "versionReference", "digest"]);
        const objectReference = parseCatalogReference(d.objectReference),
          versionReference = parseCatalogReference(d.versionReference),
          key = `${objectReference}:${versionReference}`;
        if (seen.has(key)) return fail();
        seen.add(key);
        return Object.freeze({ objectReference, versionReference, digest: hash(d.digest) });
      })
      .sort(
        (a, b) =>
          a.objectReference.localeCompare(b.objectReference) ||
          a.versionReference.localeCompare(b.versionReference),
      );
    const sourceDigest = digest({
      family: "Allergen",
      tenantReference: tenant,
      brandReference: brand,
      dependencies,
    });
    if (hash(raw.digest) !== sourceDigest) return fail("ALLERGEN_SOURCE_INTEGRITY_CONFLICT");
    return Object.freeze({
      family: "Allergen",
      tenantReference: tenant,
      brandReference: brand,
      snapshotReference: parseCatalogReference(raw.snapshotReference),
      digest: sourceDigest,
      complete: true,
      dependencies: Object.freeze(dependencies),
    });
  }
  function decode(value: unknown, at: string): CatalogAllergenCoverageRead {
    const row = object(value, ["coverage", "capturedAtUtc"]),
      parsed = coverage(row.coverage),
      capturedAtUtc = parseCatalogInstant(row.capturedAtUtc);
    if (capturedAtUtc > at) return fail();
    return Object.freeze({ coverage: parsed, capturedAtUtc, asOfUtc: at });
  }
  async function authorized<T>(
    input: CatalogAllergenSourceRequest,
    work: (tx: ProductLifecycleTransaction) => Promise<T>,
  ): Promise<T> {
    try {
      return await runner.run(async (tx) => {
        await tx.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED", []);
        await tx.query(
          "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
          [tenant, brand],
        );
        const auth = Object.freeze({
          ...input,
          tenantReference: tenant,
          brandReference: brand,
          family: "Allergen" as const,
        });
        if ((await authorize(tx, auth)) !== true) return fail("ALLERGEN_SOURCE_PERMISSION_DENIED");
        await tx.query(
          "SELECT set_config('lock_timeout','5000',true),set_config('statement_timeout','60000',true)",
          [],
        );
        const result = await work(tx);
        if ((await authorize(tx, auth)) !== true) return fail("ALLERGEN_SOURCE_PERMISSION_DENIED");
        return result;
      });
    } catch (error) {
      if (error instanceof CatalogAllergenSourceError) throw error;
      return fail();
    }
  }
  async function current(
    tx: ProductLifecycleTransaction,
    at: string,
  ): Promise<readonly CatalogAllergenDependency[]> {
    await tx.query(
      "LOCK TABLE rms_catalog.allergen_registry_version,rms_catalog.allergen_registry_entry,rms_catalog.allergen_source_evidence,rms_catalog.allergen_source_assertion IN SHARE MODE",
      [],
    );
    async function read(sql: string): Promise<readonly unknown[]> {
      const value = rows(await tx.query(sql, [brand]), 2049);
      if (value.length > 2048) return fail();
      return value;
    }
    const registries = await read(
      `SELECT registry_version_id AS reference,jurisdiction_code AS jurisdiction,policy_document_digest AS digest,to_char(reviewed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS reviewed,reviewer_actor_id AS reviewer,status,(isfinite(reviewed_at) AND reviewed_at=date_trunc('milliseconds',reviewed_at)) AS precise FROM rms_catalog.allergen_registry_version WHERE brand_id=$1 ORDER BY registry_version_id LIMIT 2049`,
    );
    const entries = await read(
      `SELECT registry_version_id AS registry,allergen_id AS reference,allergen_code AS code,localized_names_json AS names FROM rms_catalog.allergen_registry_entry WHERE brand_id=$1 ORDER BY registry_version_id,allergen_id LIMIT 2049`,
    );
    const evidence = await read(
      `SELECT evidence_id AS reference,subject_id AS subject,subject_kind AS kind,source_version_id AS version,supplier_id AS supplier,document_digest AS digest,to_char(reviewed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS reviewed,to_char(valid_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS until,evidence_status AS status,(isfinite(reviewed_at) AND isfinite(valid_until) AND reviewed_at=date_trunc('milliseconds',reviewed_at) AND valid_until=date_trunc('milliseconds',valid_until)) AS precise FROM rms_catalog.allergen_source_evidence WHERE brand_id=$1 ORDER BY evidence_id LIMIT 2049`,
    );
    const assertions = await read(
      `SELECT evidence_id AS evidence,registry_version_id AS registry,allergen_id AS reference,classification FROM rms_catalog.allergen_source_assertion WHERE brand_id=$1 ORDER BY evidence_id,allergen_id LIMIT 2049`,
    );
    const registryMap = new Map<
      string,
      {
        fact: Record<string, unknown>;
        entries: Record<string, unknown>[];
        codes: Set<string>;
        refs: Set<string>;
      }
    >();
    for (const value of registries) {
      const raw = object(value, [
        "reference",
        "jurisdiction",
        "digest",
        "reviewed",
        "reviewer",
        "status",
        "precise",
      ]);
      const reference = parseCatalogReference(raw.reference),
        reviewed = parseCatalogInstant(raw.reviewed);
      if (
        raw.precise !== true ||
        reviewed > at ||
        !["Approved", "Superseded", "Invalidated"].includes(
          typeof raw.status === "string" ? raw.status : "",
        ) ||
        typeof raw.jurisdiction !== "string" ||
        !/^[A-Z][A-Z0-9_-]{1,31}$/u.test(raw.jurisdiction) ||
        registryMap.has(reference)
      )
        return fail();
      registryMap.set(reference, {
        fact: {
          reference,
          jurisdiction: raw.jurisdiction,
          digest: hash(raw.digest),
          reviewed,
          reviewer: parseCatalogReference(raw.reviewer),
          status: raw.status,
        },
        entries: [],
        codes: new Set(),
        refs: new Set(),
      });
    }
    for (const value of entries) {
      const raw = object(value, ["registry", "reference", "code", "names"]),
        registry = registryMap.get(parseCatalogReference(raw.registry));
      if (!registry) return fail();
      const reference = parseCatalogReference(raw.reference),
        code = parseCatalogCode(raw.code);
      if (raw.code !== code || registry.codes.has(code) || registry.refs.has(reference))
        return fail();
      // Validate own data descriptors before the existing display-name parser touches values.
      if (
        raw.names === null ||
        typeof raw.names !== "object" ||
        Object.getPrototypeOf(raw.names) !== Object.prototype
      )
        return fail();
      const keys = Reflect.ownKeys(raw.names);
      if (!keys.length || keys.length > 64 || keys.some((key) => typeof key !== "string"))
        return fail();
      const names = object(raw.names, keys as string[]),
        first = keys[0];
      const normalized = parseLocalizedNames(names, first);
      // Hash exact stored content as well as parsed validity; whitespace edits are detectable.
      registry.entries.push({ reference, code, names, normalized });
      registry.codes.add(code);
      registry.refs.add(reference);
    }
    const evidenceMap = new Map<
      string,
      {
        subject: string;
        fact: Record<string, unknown>;
        assertions: Record<string, unknown>[];
        refs: Set<string>;
      }
    >();
    for (const value of evidence) {
      const raw = object(value, [
        "reference",
        "subject",
        "kind",
        "version",
        "supplier",
        "digest",
        "reviewed",
        "until",
        "status",
        "precise",
      ]);
      const reference = parseCatalogReference(raw.reference),
        subject = parseCatalogReference(raw.subject),
        reviewed = parseCatalogInstant(raw.reviewed),
        until = parseCatalogInstant(raw.until);
      if (
        raw.precise !== true ||
        reviewed > at ||
        until <= reviewed ||
        !["Ingredient", "Recipe", "Product", "Option"].includes(
          typeof raw.kind === "string" ? raw.kind : "",
        ) ||
        !["Approved", "Invalidated", "Conflicting"].includes(
          typeof raw.status === "string" ? raw.status : "",
        ) ||
        evidenceMap.has(reference)
      )
        return fail();
      evidenceMap.set(reference, {
        subject,
        fact: {
          reference,
          subject,
          kind: raw.kind,
          version: parseCatalogReference(raw.version),
          supplier: raw.supplier === null ? null : parseCatalogReference(raw.supplier),
          digest: hash(raw.digest),
          reviewed,
          until,
          status: raw.status,
        },
        assertions: [],
        refs: new Set(),
      });
    }
    for (const value of assertions) {
      const raw = object(value, ["evidence", "registry", "reference", "classification"]),
        ref = parseCatalogReference(raw.reference),
        registryReference = parseCatalogReference(raw.registry),
        registry = registryMap.get(registryReference),
        parent = evidenceMap.get(parseCatalogReference(raw.evidence));
      if (
        !parent ||
        !registry?.refs.has(ref) ||
        parent.refs.has(ref) ||
        !["Contains", "CrossContactPossible", "Unverified"].includes(
          typeof raw.classification === "string" ? raw.classification : "",
        )
      )
        return fail();
      parent.assertions.push({
        registry: registryReference,
        reference: ref,
        classification: raw.classification,
      });
      parent.refs.add(ref);
    }
    const dependencies: CatalogAllergenDependency[] = [];
    for (const [reference, registry] of registryMap) {
      if (!registry.entries.length) return fail();
      dependencies.push({
        objectReference: brand,
        versionReference: reference,
        digest: digest({
          ...registry.fact,
          entries: registry.entries.sort((a, b) =>
            String(a.reference).localeCompare(String(b.reference)),
          ),
        }),
      });
    }
    for (const [reference, item] of evidenceMap) {
      if (!item.assertions.length) return fail();
      dependencies.push({
        objectReference: item.subject,
        versionReference: reference,
        digest: digest({
          ...item.fact,
          assertions: item.assertions.sort((a, b) =>
            String(a.reference).localeCompare(String(b.reference)),
          ),
        }),
      });
    }
    if (
      dependencies.length > 2048 ||
      new Set(dependencies.map((d) => d.versionReference)).size !== dependencies.length
    )
      return fail();
    return Object.freeze(
      dependencies
        .sort(
          (a, b) =>
            a.objectReference.localeCompare(b.objectReference) ||
            a.versionReference.localeCompare(b.versionReference),
        )
        .map((d) => Object.freeze(d)),
    );
  }
  async function assertHistorical(
    tx: ProductLifecycleTransaction,
    dependencies: readonly CatalogAllergenDependency[],
  ) {
    const result = rows(
      await tx.query(
        `SELECT EXISTS(SELECT 1 FROM rms_catalog.recipe_allergen_source_capture c CROSS JOIN LATERAL jsonb_to_recordset(c.coverage_json->'dependencies') AS old("objectReference" uuid,"versionReference" uuid,digest text) JOIN jsonb_to_recordset($3::jsonb) AS now("objectReference" uuid,"versionReference" uuid,digest text) ON old."objectReference"=now."objectReference" AND old."versionReference"=now."versionReference" WHERE c.tenant_id=$1 AND c.brand_id=$2 AND old.digest<>now.digest) AS conflict`,
        [tenant, brand, JSON.stringify(dependencies)],
      ),
      1,
    );
    if (result.length !== 1) return fail();
    const row = object(result[0], ["conflict"]);
    if (row.conflict === true) return fail("ALLERGEN_SOURCE_INTEGRITY_CONFLICT");
    if (row.conflict !== false) return fail();
  }
  return Object.freeze({
    async capture(value: unknown): Promise<CatalogAllergenCoverageRead> {
      const input = request(value);
      return authorized(input, async (tx) => {
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          `CatalogAllergenSource:${tenant}:${brand}`,
        ]);
        const dependencies = await current(tx, input.observedAtUtc),
          sourceDigest = digest({
            family: "Allergen",
            tenantReference: tenant,
            brandReference: brand,
            dependencies,
          });
        await assertHistorical(tx, dependencies);
        const existing = rows(
          await tx.query(captureSelect + "content_digest=$3", [tenant, brand, sourceDigest]),
          1,
        );
        if (existing.length === 1) {
          const read = decode(existing[0], input.observedAtUtc);
          if (canonicalizeRfc8785(read.coverage.dependencies) !== canonicalizeRfc8785(dependencies))
            return fail("ALLERGEN_SOURCE_INTEGRITY_CONFLICT");
          return read;
        }
        const parsed = coverage({
          family: "Allergen",
          tenantReference: tenant,
          brandReference: brand,
          snapshotReference: parseCatalogReference(generateReference()),
          digest: sourceDigest,
          complete: true,
          dependencies,
        });
        const saved = rows(
          await tx.query(
            `INSERT INTO rms_catalog.recipe_allergen_source_capture(snapshot_id,tenant_id,brand_id,content_digest,captured_at,captured_by_actor_id,coverage_json) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING coverage_json AS coverage,to_char(captured_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "capturedAtUtc"`,
            [
              parsed.snapshotReference,
              tenant,
              brand,
              parsed.digest,
              input.observedAtUtc,
              input.actorReference,
              JSON.stringify(parsed),
            ],
          ),
          1,
        );
        if (saved.length !== 1) return fail();
        const read = decode(saved[0], input.observedAtUtc);
        if (canonicalizeRfc8785(read.coverage) !== canonicalizeRfc8785(parsed)) return fail();
        return read;
      });
    },
    async withCurrent<T>(
      value: unknown,
      captured: unknown,
      work: (read: CatalogAllergenCoverageRead) => Promise<T>,
    ): Promise<T> {
      const input = request(value);
      let expected: CatalogAllergenCoverageRead;
      try {
        const raw = object(captured, ["coverage", "capturedAtUtc", "asOfUtc"]),
          at = parseCatalogInstant(raw.asOfUtc);
        expected = decode({ coverage: raw.coverage, capturedAtUtc: raw.capturedAtUtc }, at);
        if (at > input.observedAtUtc) return fail();
      } catch {
        return fail("ALLERGEN_SOURCE_INPUT_INVALID");
      }
      return authorized(input, async (tx) => {
        const found = rows(
          await tx.query(captureSelect + "snapshot_id=$3", [
            tenant,
            brand,
            expected.coverage.snapshotReference,
          ]),
          1,
        );
        if (found.length !== 1) return fail();
        const read = decode(found[0], input.observedAtUtc);
        if (
          canonicalizeRfc8785(read.coverage) !== canonicalizeRfc8785(expected.coverage) ||
          read.capturedAtUtc !== expected.capturedAtUtc
        )
          return fail("ALLERGEN_SOURCE_INTEGRITY_CONFLICT");
        const dependencies = await current(tx, input.observedAtUtc);
        if (canonicalizeRfc8785(dependencies) !== canonicalizeRfc8785(read.coverage.dependencies))
          return fail("ALLERGEN_SOURCE_CHANGED");
        await assertHistorical(tx, dependencies);
        return work(read);
      });
    },
  });
}

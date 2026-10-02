import { createHash } from "node:crypto";
import { canonicalizeRfc8785 } from "@bop/audit";
import { parseInventoryReference, parseInventoryInstant } from "../../domain/inventory-item.js";
import { parseInventoryItemSnapshot } from "../../domain/inventory-item-snapshot.js";
import type {
  InventoryItemTransaction,
  InventoryItemTransactionRunner,
} from "./inventory-item-store.js";
export type InventoryConfigurationSourceErrorCode =
  | "INVENTORY_SOURCE_INPUT_INVALID"
  | "INVENTORY_SOURCE_PERMISSION_DENIED"
  | "INVENTORY_SOURCE_UNAVAILABLE"
  | "INVENTORY_SOURCE_CHANGED"
  | "INVENTORY_SOURCE_INTEGRITY_CONFLICT";
export class InventoryConfigurationSourceError extends Error {
  constructor(readonly code: InventoryConfigurationSourceErrorCode) {
    super("Inventory configuration coverage is unavailable");
    this.name = "InventoryConfigurationSourceError";
  }
}
export interface InventoryConfigurationSourceRequest {
  readonly actorReference: string;
  readonly purpose: "RecipeProjectionBuild";
  readonly observedAtUtc: string;
}
export interface InventoryConfigurationSourceAuthorization extends InventoryConfigurationSourceRequest {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly family: "Inventory";
}
export interface InventoryConfigurationDependency {
  readonly objectReference: string;
  readonly versionReference: string;
  readonly digest: string;
}
export interface InventoryConfigurationCoverage {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly family: "Inventory";
  readonly snapshotReference: string;
  readonly digest: string;
  readonly complete: true;
  readonly dependencies: readonly InventoryConfigurationDependency[];
}
export interface InventoryConfigurationCoverageRead {
  readonly coverage: InventoryConfigurationCoverage;
  readonly capturedAtUtc: string;
  readonly asOfUtc: string;
}
function fail(code: InventoryConfigurationSourceErrorCode = "INVENTORY_SOURCE_UNAVAILABLE"): never {
  throw new InventoryConfigurationSourceError(code);
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
const captureSelect = `SELECT coverage_json AS coverage,to_char(captured_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "capturedAtUtc" FROM rms_inventory.recipe_configuration_source_capture WHERE tenant_id=$1 AND brand_id=$2 AND `;
/** Owner configuration history only. Authorizer validates actual Actor/purpose/phase/permission.
 * withCurrent holds Item configuration collections through callback; callback cannot mutate them. */
export function createPostgresInventoryRecipeConfigurationSource(options: {
  readonly runner: InventoryItemTransactionRunner;
  readonly scope: { readonly tenantReference: string; readonly brandReference: string };
  readonly generateReference: () => string;
  readonly authorize: (
    tx: InventoryItemTransaction,
    input: InventoryConfigurationSourceAuthorization,
  ) => Promise<boolean>;
}) {
  const scope = object(options.scope, ["tenantReference", "brandReference"]),
    tenant = parseInventoryReference(scope.tenantReference),
    brand = parseInventoryReference(scope.brandReference);
  const runner = options.runner,
    authorize = options.authorize,
    generateReference = options.generateReference;
  function request(value: unknown): InventoryConfigurationSourceRequest {
    try {
      const raw = object(value, ["actorReference", "purpose", "observedAtUtc"]);
      if (raw.purpose !== "RecipeProjectionBuild") return fail();
      return Object.freeze({
        actorReference: parseInventoryReference(raw.actorReference),
        purpose: raw.purpose,
        observedAtUtc: parseInventoryInstant(raw.observedAtUtc),
      });
    } catch {
      return fail("INVENTORY_SOURCE_INPUT_INVALID");
    }
  }
  function coverage(value: unknown): InventoryConfigurationCoverage {
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
      raw.family !== "Inventory" ||
      raw.complete !== true
    )
      return fail();
    const seen = new Set<string>();
    const dependencies = list(raw.dependencies)
      .map((value) => {
        const d = object(value, ["objectReference", "versionReference", "digest"]);
        const objectReference = parseInventoryReference(d.objectReference),
          versionReference = parseInventoryReference(d.versionReference),
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
      family: "Inventory",
      tenantReference: tenant,
      brandReference: brand,
      dependencies,
    });
    if (hash(raw.digest) !== sourceDigest) return fail("INVENTORY_SOURCE_INTEGRITY_CONFLICT");
    return Object.freeze({
      family: "Inventory",
      tenantReference: tenant,
      brandReference: brand,
      snapshotReference: parseInventoryReference(raw.snapshotReference),
      digest: sourceDigest,
      complete: true,
      dependencies: Object.freeze(dependencies),
    });
  }
  function decode(value: unknown, at: string): InventoryConfigurationCoverageRead {
    const row = object(value, ["coverage", "capturedAtUtc"]),
      parsed = coverage(row.coverage),
      capturedAtUtc = parseInventoryInstant(row.capturedAtUtc);
    if (capturedAtUtc > at) return fail();
    return Object.freeze({ coverage: parsed, capturedAtUtc, asOfUtc: at });
  }
  async function authorized<T>(
    input: InventoryConfigurationSourceRequest,
    work: (tx: InventoryItemTransaction) => Promise<T>,
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
          family: "Inventory" as const,
        });
        if ((await authorize(tx, auth)) !== true) return fail("INVENTORY_SOURCE_PERMISSION_DENIED");
        await tx.query(
          "SELECT set_config('lock_timeout','5000',true),set_config('statement_timeout','60000',true)",
          [],
        );
        const result = await work(tx);
        if ((await authorize(tx, auth)) !== true) return fail("INVENTORY_SOURCE_PERMISSION_DENIED");
        return result;
      });
    } catch (error) {
      if (error instanceof InventoryConfigurationSourceError) throw error;
      return fail();
    }
  }
  async function current(
    tx: InventoryItemTransaction,
    at: string,
    create: boolean,
  ): Promise<readonly InventoryConfigurationDependency[]> {
    await tx.query(
      "LOCK TABLE rms_inventory.inventory_item,rms_inventory.inventory_item_version,rms_inventory.inventory_item_operation IN SHARE MODE",
      [],
    );
    const facts = rows(
      await tx.query(
        `SELECT r.item_id AS "itemReference",r.internal_code AS "internalCode",r.item_type AS "itemType",r.created_by_actor_id AS "createdBy",to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",v.version::text AS version,v.snapshot_json AS snapshot,to_char(v.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "recordedAt"
   FROM rms_inventory.inventory_item r LEFT JOIN rms_inventory.inventory_item_version v ON v.tenant_id=r.tenant_id AND v.brand_id=r.brand_id AND v.item_id=r.item_id WHERE r.tenant_id=$1 AND r.brand_id=$2 ORDER BY r.item_id,v.version LIMIT 2049`,
        [tenant, brand],
      ),
      2049,
    );
    if (facts.length > 2048) return fail();
    const byVersion = new Map<string, { itemReference: string; version: string; digest: string }>();
    for (const value of facts) {
      const row = object(value, [
          "itemReference",
          "internalCode",
          "itemType",
          "createdBy",
          "createdAt",
          "version",
          "snapshot",
          "recordedAt",
        ]),
        item = parseInventoryItemSnapshot(row.snapshot);
      if (
        item.tenantReference !== tenant ||
        item.brandReference !== brand ||
        item.itemReference !== row.itemReference ||
        item.internalCode !== row.internalCode ||
        item.itemType !== row.itemType ||
        item.createdBy !== row.createdBy ||
        item.createdAt !== row.createdAt ||
        String(item.aggregateVersion) !== row.version ||
        item.updatedAt !== row.recordedAt ||
        item.updatedAt > at
      )
        return fail();
      const key = `${item.itemReference}:${item.aggregateVersion}`;
      if (byVersion.has(key)) return fail();
      byVersion.set(key, {
        itemReference: item.itemReference,
        version: String(item.aggregateVersion),
        digest: digest(item),
      });
    }
    const mapped = new Map<
      string,
      { objectReference: string; versionReference: string; digest: string }
    >();
    function binding(value: unknown) {
      const row = object(value, ["itemReference", "version", "versionReference", "digest"]),
        key = `${row.itemReference}:${row.version}`,
        fact = byVersion.get(key);
      if (fact === undefined || mapped.has(key) || fact.digest !== hash(row.digest))
        return fail("INVENTORY_SOURCE_INTEGRITY_CONFLICT");
      mapped.set(
        key,
        Object.freeze({
          objectReference: fact.itemReference,
          versionReference: parseInventoryReference(row.versionReference),
          digest: fact.digest,
        }),
      );
    }
    for (const row of rows(
      await tx.query(
        'SELECT item_id AS "itemReference",item_version::text AS version,version_id AS "versionReference",content_digest AS digest FROM rms_inventory.recipe_configuration_source_version WHERE tenant_id=$1 AND brand_id=$2',
        [tenant, brand],
      ),
    ))
      binding(row);
    const missingFacts = [...byVersion.entries()]
      .filter(([key]) => !mapped.has(key))
      .map(([, fact]) => fact);
    if (missingFacts.length > 0 && !create) return fail("INVENTORY_SOURCE_CHANGED");
    const missing = missingFacts.map((fact) => ({
      ...fact,
      versionReference: parseInventoryReference(generateReference()),
    }));
    if (missing.length > 0) {
      const inserted = rows(
        await tx.query(
          `INSERT INTO rms_inventory.recipe_configuration_source_version(tenant_id,brand_id,item_id,item_version,version_id,content_digest) SELECT $1::uuid,$2::uuid,i."itemReference",i.version,i."versionReference",i.digest FROM jsonb_to_recordset($3::jsonb) AS i("itemReference" uuid,version bigint,"versionReference" uuid,digest text) RETURNING item_id AS "itemReference",item_version::text AS version,version_id AS "versionReference",content_digest AS digest`,
          [tenant, brand, JSON.stringify(missing)],
        ),
      );
      if (inserted.length !== missing.length) return fail();
      for (const row of inserted) binding(row);
    }
    const operations = rows(
      await tx.query(
        'SELECT item_id AS "itemReference",version::text AS version,operation_id AS "operationReference" FROM rms_inventory.inventory_item_operation WHERE tenant_id=$1 AND brand_id=$2',
        [tenant, brand],
      ),
    );
    const operationDependencies = operations.map((value) => {
      const row = object(value, ["itemReference", "version", "operationReference"]);
      const fact = byVersion.get(`${row.itemReference}:${row.version}`);
      if (fact === undefined) return fail("INVENTORY_SOURCE_INTEGRITY_CONFLICT");
      return Object.freeze({
        objectReference: fact.itemReference,
        versionReference: parseInventoryReference(row.operationReference),
        digest: fact.digest,
      });
    });
    if (mapped.size + operationDependencies.length > 2048) return fail();
    const result = [...mapped.values(), ...operationDependencies].sort(
      (a, b) =>
        a.objectReference.localeCompare(b.objectReference) ||
        a.versionReference.localeCompare(b.versionReference),
    );
    if (new Set(result.map((d) => d.versionReference)).size !== result.length) return fail();
    return Object.freeze(result);
  }
  return Object.freeze({
    async capture(value: unknown): Promise<InventoryConfigurationCoverageRead> {
      const input = request(value);
      return authorized(input, async (tx) => {
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          `InventoryRecipeSource:${tenant}:${brand}`,
        ]);
        const dependencies = await current(tx, input.observedAtUtc, true),
          sourceDigest = digest({
            family: "Inventory",
            tenantReference: tenant,
            brandReference: brand,
            dependencies,
          });
        const existing = rows(
          await tx.query(captureSelect + "content_digest=$3", [tenant, brand, sourceDigest]),
          1,
        );
        if (existing.length === 1) {
          const read = decode(existing[0], input.observedAtUtc);
          if (canonicalizeRfc8785(read.coverage.dependencies) !== canonicalizeRfc8785(dependencies))
            return fail("INVENTORY_SOURCE_INTEGRITY_CONFLICT");
          return read;
        }
        const parsed = coverage({
          family: "Inventory",
          tenantReference: tenant,
          brandReference: brand,
          snapshotReference: parseInventoryReference(generateReference()),
          digest: sourceDigest,
          complete: true,
          dependencies,
        });
        const saved = rows(
          await tx.query(
            `INSERT INTO rms_inventory.recipe_configuration_source_capture(snapshot_id,tenant_id,brand_id,content_digest,captured_at,captured_by_actor_id,coverage_json) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING coverage_json AS coverage,to_char(captured_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "capturedAtUtc"`,
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
      work: (read: InventoryConfigurationCoverageRead) => Promise<T>,
    ): Promise<T> {
      const input = request(value);
      let expected: InventoryConfigurationCoverageRead;
      try {
        const raw = object(captured, ["coverage", "capturedAtUtc", "asOfUtc"]),
          at = parseInventoryInstant(raw.asOfUtc);
        expected = decode({ coverage: raw.coverage, capturedAtUtc: raw.capturedAtUtc }, at);
        if (at > input.observedAtUtc) return fail();
      } catch {
        return fail("INVENTORY_SOURCE_INPUT_INVALID");
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
          return fail("INVENTORY_SOURCE_INTEGRITY_CONFLICT");
        const dependencies = await current(tx, input.observedAtUtc, false);
        if (canonicalizeRfc8785(dependencies) !== canonicalizeRfc8785(read.coverage.dependencies))
          return fail("INVENTORY_SOURCE_CHANGED");
        return work(read);
      });
    },
  });
}

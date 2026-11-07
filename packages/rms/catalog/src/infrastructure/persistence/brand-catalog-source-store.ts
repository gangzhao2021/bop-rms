import { parseBrandAdministrationContext, type BrandAdministrationContext } from "@bop/tenant";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  brandCatalogSourceIntentDigest,
  parseBrandCatalogSourceScope,
  parseBrandCatalogSourceRegister,
  parseBrandCatalogSourceResolve,
  parseBrandCatalogSourceRegisteredIdentity,
  parseBrandCatalogSourceReceipt,
  parseBrandCatalogSourceCurrent,
  parseBrandCatalogSourceExact,
  type BrandCatalogSourceScope,
  type BrandCatalogSourceRegister,
  type BrandCatalogSourceResolve,
  type BrandCatalogSourceReceipt,
  type BrandCatalogSourceRegisteredIdentity,
} from "../../contracts/brand-catalog-source.js";
import { copyCategoryPersistenceValue } from "../../contracts/category-persistence.js";
import {
  CatalogError,
  parseCatalogInstant,
  parseCatalogReference,
} from "../../contracts/product.js";
import type { ProductLifecycleTransaction } from "./product-lifecycle-store.js";

type Original = BrandCatalogSourceRegister | BrandCatalogSourceResolve;
type Mode = "Read" | "Register" | "Resolve";
export const brandCatalogSourceRequiredFields = Object.freeze([
  "sourceReference",
  "code",
  "label",
  "registeredByReference",
  "operationReference",
  "auditReference",
  "registeredAt",
  "dataClassification",
  "originalCommand",
  "intentDigest",
  "outcome",
] as const);
export interface BrandCatalogSourceStoreOptions extends BrandCatalogSourceScope {
  readonly transaction: ProductLifecycleTransaction;
  readonly clock: { now(): string };
  readonly originalObservedAt: string;
  readonly originalValidUntil: string;
  readonly authority: {
    /** The actual server producer holds Tenant/Brand authority before any owner admission.
     * This owner never queries Tenant private tables or infers a grant from a source UUID. */
    holdUntilTransactionCompletes(
      tx: ProductLifecycleTransaction,
      input: Readonly<
        BrandCatalogSourceScope & {
          permission: "catalog.manage";
          purposeCode: "BRAND_CATALOG_SOURCE";
          mode: Mode;
          requiredFields: typeof brandCatalogSourceRequiredFields;
          original: Original | null;
          observedAt: string;
          validUntil: string;
        }
      >,
    ): Promise<{ readonly validUntil: string }>;
  };
  readonly nextReference: (kind: "Source" | "Audit") => string;
  /** Trusted production host calls the public Audit writer in this actual transaction.
   * Void completion is mandatory; supplied IDs are binding data, not audit evidence. */
  readonly appendAudit: (
    tx: ProductLifecycleTransaction,
    input: Readonly<
      BrandCatalogSourceScope & {
        purposeCode: "BRAND_CATALOG_SOURCE";
        mode: "Register" | "Abandon";
        operationReference: string;
        intentDigest: string;
        sourceReference: string | null;
        auditReference: string;
        occurredAt: string;
      }
    >,
  ) => Promise<void>;
  readonly registerBeforeCommit: (
    tx: ProductLifecycleTransaction,
    guard: () => Promise<void>,
    final: () => void,
  ) => Promise<void> | void;
}
type CommonOptions = Omit<BrandCatalogSourceStoreOptions, "authority"> & {
  readonly authority: object;
};
type HoldInput = Readonly<
  BrandCatalogSourceScope & {
    mode: Mode;
    requiredFields: typeof brandCatalogSourceRequiredFields;
    original: Original | null;
    observedAt: string;
    validUntil: string;
  }
>;
export interface BrandAdministrationCatalogSourceStoreOptions extends Omit<
  BrandCatalogSourceStoreOptions,
  "authority"
> {
  readonly authority: {
    holdUntilTransactionCompletes(
      tx: ProductLifecycleTransaction,
      input: HoldInput & {
        readonly permission: "organization.manage";
        readonly purposeCode: "BRAND_ADMINISTRATION";
      },
    ): Promise<{
      readonly administrationContext: BrandAdministrationContext;
      readonly validUntil: string;
    }>;
  };
}
/** Metadata identity only; no Product/SKU/Price editing permission is granted. */
export function createPostgresBrandAdministrationCatalogSourceStore(
  options: BrandAdministrationCatalogSourceStoreOptions,
) {
  const authority = options.authority,
    held = authority.holdUntilTransactionCompletes;
  if (typeof held !== "function") throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  return createCatalogSourceStore(
    options,
    true,
    (tx, input) =>
      held.call(authority, tx, {
        ...input,
        permission: "organization.manage",
        purposeCode: "BRAND_ADMINISTRATION",
      }),
    () => authority.holdUntilTransactionCompletes === held,
  );
}
export function createPostgresBrandCatalogSourceStore(options: BrandCatalogSourceStoreOptions) {
  const authority = options.authority,
    held = authority.holdUntilTransactionCompletes;
  if (typeof held !== "function") throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  return createCatalogSourceStore(
    options,
    false,
    (tx, input) =>
      held.call(authority, tx, {
        ...input,
        permission: "catalog.manage",
        purposeCode: "BRAND_CATALOG_SOURCE",
      }),
    () => authority.holdUntilTransactionCompletes === held,
  );
}
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const same = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);

/** One immutable identity for the actual Brand catalogue, independent of Product publication.
 * All work borrows the caller's actual transaction and its original finite authority window. */
function createCatalogSourceStore(
  options: CommonOptions,
  administrative: boolean,
  holdPort: (tx: ProductLifecycleTransaction, input: HoldInput) => Promise<unknown>,
  currentHold: () => boolean,
) {
  const fixed = parseBrandCatalogSourceScope({
    tenantReference: options.tenantReference,
    brandReference: options.brandReference,
    actorReference: options.actorReference,
  });
  const tx = options.transaction,
    queryPort = tx.query,
    clock = options.clock,
    nowPort = clock.now,
    authority = options.authority,
    nextPort = options.nextReference,
    auditPort = options.appendAudit,
    registerPort = options.registerBeforeCommit;
  const origin = parseCatalogInstant(options.originalObservedAt),
    originalUntil = parseCatalogInstant(options.originalValidUntil);
  let latest = origin,
    deadline = originalUntil,
    failed = false,
    active = false,
    registered = false,
    phase: "Work" | "Checks" | "Final" = "Work",
    guardCalls = 0,
    finalCalls = 0,
    done = false,
    wrote = false;
  let heldAdministration: BrandAdministrationContext | undefined,
    administrationIdentity: string | undefined;
  let heldSource: BrandCatalogSourceRegisteredIdentity | null | undefined;
  const requests = new Map<string, { mode: Mode; original: Original | null }>(),
    heldOperations = new Map<string, BrandCatalogSourceReceipt>();
  const fail = (
    code: ConstructorParameters<typeof CatalogError>[0] = "CATALOG_DEPENDENCY_UNAVAILABLE",
  ): never => {
    failed = true;
    throw new CatalogError(code);
  };
  function unchanged() {
    return (
      options.transaction === tx &&
      tx.query === queryPort &&
      options.clock === clock &&
      clock.now === nowPort &&
      options.authority === authority &&
      currentHold() &&
      options.nextReference === nextPort &&
      options.appendAudit === auditPort &&
      options.registerBeforeCommit === registerPort &&
      options.tenantReference === fixed.tenantReference &&
      options.brandReference === fixed.brandReference &&
      options.actorReference === fixed.actorReference &&
      options.originalObservedAt === origin &&
      options.originalValidUntil === originalUntil
    );
  }
  function check() {
    if (failed || !unchanged()) return fail();
    const at = parseCatalogInstant(nowPort.call(clock));
    if (!unchanged() || at < latest || at >= deadline) return fail();
    latest = at;
    return at;
  }
  if (
    [queryPort, nowPort, holdPort, nextPort, auditPort, registerPort].some(
      (p) => typeof p !== "function",
    ) ||
    originalUntil <= origin ||
    Date.parse(originalUntil) - Date.parse(origin) > 5000
  )
    return fail();
  function record(value: unknown, keys: readonly string[]) {
    const copied = stored(copyCategoryPersistenceValue, value);
    if (
      !copied ||
      typeof copied !== "object" ||
      Array.isArray(copied) ||
      Reflect.ownKeys(copied).length !== keys.length ||
      keys.some((k) => !Object.hasOwn(copied, k))
    )
      return fail();
    return copied as Record<string, unknown>;
  }
  function stored<T>(parse: (value: unknown) => T, value: unknown): T {
    try {
      return parse(value);
    } catch {
      return fail();
    }
  }
  function rows(value: unknown) {
    if (!value || typeof value !== "object") return fail();
    const d = Object.getOwnPropertyDescriptor(value, "rows");
    if (!d?.enumerable || !("value" in d)) return fail();
    const copied = stored(copyCategoryPersistenceValue, d.value);
    if (!Array.isArray(copied) || copied.length > 1) return fail();
    return copied as unknown[];
  }
  async function query(sql: string, values: readonly unknown[]) {
    const remain = String(Math.max(1, Date.parse(deadline) - Date.parse(check())));
    await queryPort.call(
      tx,
      "SELECT set_config('lock_timeout',$1,true),set_config('statement_timeout',$1,true)",
      [remain],
    );
    check();
    const result = await queryPort.call(tx, sql, values);
    check();
    return result;
  }
  async function insert(sql: string, values: readonly unknown[]) {
    const result = await query(sql, values),
      d = Object.getOwnPropertyDescriptor(result, "rowCount");
    if (!d || !("value" in d) || d.value !== 1) return fail();
  }
  const restore = () =>
    query(
      "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
      [fixed.tenantReference, fixed.brandReference],
    );
  async function hold(mode: Mode, original: Original | null) {
    const observedAt = check();
    const answer = await holdPort(
      tx,
      Object.freeze({
        ...fixed,
        mode,
        requiredFields: brandCatalogSourceRequiredFields,
        original,
        observedAt,
        validUntil: deadline,
      }),
    );
    check();
    const packet = record(
      answer,
      administrative ? ["administrationContext", "validUntil"] : ["validUntil"],
    );
    if (administrative) {
      const context = parseBrandAdministrationContext(packet.administrationContext);
      if (
        fixed.tenantReference !== fixed.brandReference ||
        String(context.brand.brandReference) !== fixed.brandReference ||
        String(context.actor.actorReference) !== fixed.actorReference ||
        context.store !== null ||
        context.purposeCode !== "BRAND_ADMINISTRATION" ||
        String(context.resolvedAt) < observedAt ||
        String(context.resolvedAt) > check()
      )
        return fail("CATALOG_PERMISSION_DENIED");
      const identity = canonicalizeRfc8785({
        profile: context.profile,
        actor: context.actor,
        brand: context.brand,
        store: context.store,
        purposeCode: context.purposeCode,
      });
      if (administrationIdentity !== undefined && identity !== administrationIdentity)
        return fail("CATALOG_PERMISSION_DENIED");
      administrationIdentity = identity;
      heldAdministration = context;
    }
    const until = parseCatalogInstant(packet.validUntil);
    if (until < deadline) deadline = until;
    check();
    await restore();
  }
  async function operation(op: string, actor?: string): Promise<BrandCatalogSourceReceipt | null> {
    const values = rows(
      await query(
        `SELECT receipt_json,receipt_digest,(date_trunc('milliseconds',occurred_at)=occurred_at) precise FROM rms_catalog.brand_catalog_source_operation WHERE tenant_id=$1 AND brand_id=$2 AND operation_id=$3`,
        [fixed.tenantReference, fixed.brandReference, op],
      ),
    );
    if (!values.length) return null;
    const r = record(values[0], ["receipt_json", "receipt_digest", "precise"]);
    const receipt = stored(parseBrandCatalogSourceReceipt, r.receipt_json);
    if (
      r.precise !== true ||
      !same(receipt, r.receipt_json) ||
      r.receipt_digest !== hash(receipt) ||
      receipt.tenantReference !== fixed.tenantReference ||
      receipt.brandReference !== fixed.brandReference ||
      receipt.operationReference !== op ||
      (actor !== undefined && receipt.actorReference !== actor) ||
      receipt.occurredAt > check()
    )
      return fail();
    return receipt;
  }
  async function source(): Promise<BrandCatalogSourceRegisteredIdentity | null> {
    const values = rows(
      await query(
        `SELECT identity_json,identity_digest,(date_trunc('milliseconds',registered_at)=registered_at) precise FROM rms_catalog.brand_catalog_source WHERE tenant_id=$1 AND brand_id=$2`,
        [fixed.tenantReference, fixed.brandReference],
      ),
    );
    if (!values.length) return null;
    const r = record(values[0], ["identity_json", "identity_digest", "precise"]),
      identity = stored(parseBrandCatalogSourceRegisteredIdentity, r.identity_json);
    if (
      r.precise !== true ||
      !same(identity, r.identity_json) ||
      r.identity_digest !== hash(identity) ||
      identity.tenantReference !== fixed.tenantReference ||
      identity.brandReference !== fixed.brandReference ||
      identity.registeredAt > check()
    )
      return fail();
    const original = await operation(identity.operationReference, identity.registeredByReference);
    if (!original || original.outcome !== "Committed" || !same(original.source, identity))
      return fail();
    heldOperations.set(original.operationReference, original);
    return identity;
  }
  async function admit(mode: Mode, original: Original | null) {
    if (active || phase !== "Work") return fail();
    active = true;
    if (
      original &&
      (original.tenantReference !== fixed.tenantReference ||
        original.brandReference !== fixed.brandReference ||
        original.actorReference !== fixed.actorReference)
    )
      return fail("CATALOG_PERMISSION_DENIED");
    requests.set(mode + ":" + (original?.operationReference ?? "Read"), { mode, original });
    if (!registered) {
      registered = true;
      const returned = await registerPort.call(
        options,
        tx,
        async () => {
          try {
            if (++guardCalls !== 1 || active || phase !== "Work") return fail();
            phase = "Checks";
            for (const request of requests.values()) await hold(request.mode, request.original);
            if (heldSource !== undefined && !same(await source(), heldSource))
              return fail("CATALOG_VERSION_CONFLICT");
            for (const [op, receipt] of heldOperations)
              if (!same(await operation(op, receipt.actorReference), receipt)) return fail();
            await restore();
            if (wrote)
              await query(
                "SET CONSTRAINTS rms_catalog.brand_catalog_source_coherence,rms_catalog.brand_catalog_source_operation_coherence IMMEDIATE",
                [],
              );
            check();
            done = true;
          } catch (error) {
            failed = true;
            if (error instanceof CatalogError) throw error;
            return fail();
          }
        },
        () => {
          if (++finalCalls !== 1 || !done || guardCalls !== 1 || active || phase !== "Checks")
            return fail();
          check();
          phase = "Final";
        },
      );
      if (returned !== undefined) return fail();
    }
    // Lock order is shared with the Brand owner: genuine parent first, global original next, singleton last.
    await hold(mode, original);
    const isolation = rows(
      await query("SELECT current_setting('transaction_isolation') isolation", []),
    );
    if (
      isolation.length !== 1 ||
      record(isolation[0], ["isolation"]).isolation !== "read committed"
    )
      return fail();
    if (original)
      await query("SELECT rms_catalog.brand_catalog_source_operation_admit($1,$2)", [
        original.operationReference,
        fixed.actorReference,
      ]);
    await query(
      `SELECT pg_advisory_xact_lock${mode === "Read" ? "_shared" : ""}(hashtextextended($1,0))`,
      [`BrandCatalogSource:${fixed.tenantReference}:${fixed.brandReference}`],
    );
  }
  async function run<T>(mode: Mode, original: Original | null, work: () => Promise<T>): Promise<T> {
    try {
      await admit(mode, original);
      const result = await work();
      check();
      return result;
    } catch (error) {
      failed = true;
      if (error instanceof CatalogError) throw error;
      const sql =
        error && typeof error === "object"
          ? Object.getOwnPropertyDescriptor(error, "code")
          : undefined;
      if (sql && "value" in sql && (sql.value === "23505" || sql.value === "P0001"))
        return fail("CATALOG_IDEMPOTENCY_CONFLICT");
      return fail();
    } finally {
      active = false;
    }
  }
  async function lookup(original: Original) {
    const found = await operation(original.operationReference, fixed.actorReference);
    if (
      found &&
      found.intentDigest !==
        (original.profile === "BrandCatalogSourceRegisterV1"
          ? brandCatalogSourceIntentDigest(original)
          : original.intentDigest)
    )
      return fail("CATALOG_IDEMPOTENCY_CONFLICT");
    if (found) {
      if (found.outcome === "Committed") {
        heldSource = await source();
        if (!same(heldSource, found.source)) return fail();
      }
      heldOperations.set(found.operationReference, found);
    }
    return found;
  }
  async function append(
    original: Original,
    identity: BrandCatalogSourceRegisteredIdentity | null,
    auditReference: string,
    occurredAt: string,
  ) {
    const intentDigest =
      original.profile === "BrandCatalogSourceRegisterV1"
        ? brandCatalogSourceIntentDigest(original)
        : original.intentDigest;
    const receipt = parseBrandCatalogSourceReceipt({
      profile: "BrandCatalogSourceReceiptV1",
      ...fixed,
      operationReference: original.operationReference,
      intentDigest,
      outcome: identity ? "Committed" : "Abandoned",
      originalCommand: identity ? original : null,
      source: identity,
      auditReference,
      occurredAt,
    });
    const answer = await auditPort.call(
      options,
      tx,
      Object.freeze({
        ...fixed,
        purposeCode: "BRAND_CATALOG_SOURCE" as const,
        mode: identity ? ("Register" as const) : ("Abandon" as const),
        operationReference: original.operationReference,
        intentDigest,
        sourceReference: identity?.sourceReference ?? null,
        auditReference,
        occurredAt,
      }),
    );
    check();
    if (answer !== undefined) return fail();
    await restore();
    if (identity)
      await insert(
        `INSERT INTO rms_catalog.brand_catalog_source(tenant_id,brand_id,source_id,actor_id,operation_id,audit_id,code,label,registered_at,identity_json,identity_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)`,
        [
          fixed.tenantReference,
          fixed.brandReference,
          identity.sourceReference,
          fixed.actorReference,
          original.operationReference,
          auditReference,
          identity.code,
          identity.label,
          occurredAt,
          canonicalizeRfc8785(identity),
          hash(identity),
        ],
      );
    await insert(
      `INSERT INTO rms_catalog.brand_catalog_source_operation(operation_id,tenant_id,brand_id,actor_id,intent_digest,outcome,source_id,original_command_json,receipt_json,receipt_digest,audit_id,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12)`,
      [
        original.operationReference,
        fixed.tenantReference,
        fixed.brandReference,
        fixed.actorReference,
        intentDigest,
        receipt.outcome,
        identity?.sourceReference ?? null,
        identity ? canonicalizeRfc8785(original) : null,
        canonicalizeRfc8785(receipt),
        hash(receipt),
        auditReference,
        occurredAt,
      ],
    );
    wrote = true;
    heldOperations.set(original.operationReference, receipt);
    return receipt;
  }
  return Object.freeze({
    current: () =>
      run("Read", null, async () => {
        heldSource = await source();
        return parseBrandCatalogSourceCurrent(
          {
            profile: "BrandCatalogSourceCurrentV1",
            ...fixed,
            source: heldSource,
            observedAt: check(),
            validUntil: deadline,
            publicationStatus: "NotEvaluated",
            referenceEligibility: "NotEvaluated",
          },
          fixed,
          check(),
        );
      }),
    exact: (requested: string) => {
      const reference = parseCatalogReference(requested);
      return run("Read", null, async () => {
        heldSource = await source();
        return parseBrandCatalogSourceExact(
          {
            profile: "BrandCatalogSourceExactV1",
            ...fixed,
            requestedSourceReference: reference,
            source: heldSource?.sourceReference === reference ? heldSource : null,
            observedAt: check(),
            validUntil: deadline,
            publicationStatus: "NotEvaluated",
            referenceEligibility: "NotEvaluated",
          },
          fixed,
          reference,
          check(),
        );
      });
    },
    register: (value: unknown) => {
      const original = parseBrandCatalogSourceRegister(value);
      return run("Register", original, async () => {
        const found = await lookup(original);
        if (found) {
          if (found.outcome === "Abandoned") return fail("CATALOG_IDEMPOTENCY_CONFLICT");
          return found;
        }
        if (
          administrative &&
          (!heldAdministration || !["Draft", "Active"].includes(heldAdministration.brand.lifecycle))
        )
          return fail("CATALOG_PERMISSION_DENIED");
        heldSource = await source();
        if (heldSource) return fail("CATALOG_CODE_CONFLICT");
        const sourceReference = parseCatalogReference(nextPort.call(options, "Source"));
        check();
        const auditReference = parseCatalogReference(nextPort.call(options, "Audit")),
          occurredAt = check();
        const identity = parseBrandCatalogSourceRegisteredIdentity({
          profile: "BrandCatalogSourceRegisteredIdentityV1",
          tenantReference: fixed.tenantReference,
          brandReference: fixed.brandReference,
          sourceReference,
          code: original.code,
          label: original.label,
          registeredByReference: fixed.actorReference,
          operationReference: original.operationReference,
          auditReference,
          registeredAt: occurredAt,
          dataClassification: "ConfigurationMetadata",
        });
        // Identity carries a historical registrant, not the current Reader scope key.
        const receipt = await append(original, identity, auditReference, occurredAt);
        heldSource = identity;
        return receipt;
      });
    },
    resolve: (value: unknown) => {
      const original = parseBrandCatalogSourceResolve(value);
      return run("Resolve", original, async () => {
        const found = await lookup(original);
        if (found) return found;
        const auditReference = parseCatalogReference(nextPort.call(options, "Audit")),
          occurredAt = check();
        return append(original, null, auditReference, occurredAt);
      });
    },
    /** Called after outer COMMIT: no clock/permission/SQL/ID/Audit callback is permitted. */
    assertFinalized: (): void => {
      if (
        failed ||
        !unchanged() ||
        !registered ||
        !done ||
        guardCalls !== 1 ||
        finalCalls !== 1 ||
        phase !== "Final" ||
        active
      )
        return fail();
    },
  });
}

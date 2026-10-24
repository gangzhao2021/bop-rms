import { readClosedRecord } from "@bop/identity";
import {
  parseBrandAdministrationContext,
  type BrandAdministrationContext,
} from "../../contracts/brand-administration-context.js";
import { type BrandConfigurationActorScope } from "../../contracts/brand-configuration-operation.js";
import { parseCanonicalInstant } from "../../domain/brand-store.js";
import { parsePlatformTenantReference } from "../../contracts/platform-tenant-administration.js";
import {
  PlatformBrandTemplateError,
  type PlatformBrandTemplateCodec,
  type PlatformBrandTemplateRevision,
} from "../../contracts/platform-brand-template.js";
import { type PlatformBrandTemplateTransaction } from "./platform-brand-template-store.js";
import {
  decodePlatformBrandTemplateOperation,
  decodePlatformBrandTemplateRevision,
  platformBrandTemplateStoredRecord,
} from "./platform-brand-template-read-kernel.js";

export interface PlatformBrandTemplateReferenceSourceOptions {
  readonly transaction: PlatformBrandTemplateTransaction;
  readonly scope: BrandConfigurationActorScope;
  readonly clock: { now(): string };
  readonly originalObservedAt: string;
  readonly originalValidUntil: string;
  readonly references: PlatformBrandTemplateCodec;
  readonly authority: {
    holdUntilTransactionCompletes(
      tx: PlatformBrandTemplateTransaction,
      input: Readonly<{
        scope: BrandConfigurationActorScope;
        purposeCode: "BRAND_ADMINISTRATION";
        permission: "organization.manage";
        observedAt: string;
        validUntil: string;
      }>,
    ): Promise<{
      readonly administrationContext: BrandAdministrationContext;
      readonly validUntil: string;
    }>;
  };
  readonly registerBeforeCommit: (
    tx: PlatformBrandTemplateTransaction,
    guard: () => Promise<void>,
    final: () => void,
  ) => void | Promise<void>;
}
/** Actual Brand administrative admission to authored immutable material. No
 * release status or assignment is inferred; Publishing owns qualification. */
export function createPostgresPlatformBrandTemplateReferenceSource(
  options: PlatformBrandTemplateReferenceSourceOptions,
) {
  const scopeInput = options.scope;
  const inputScope = readClosedRecord(scopeInput, [
    "tenantReference",
    "brandReference",
    "actorReference",
  ]);
  const scope = Object.freeze({
      tenantReference: String(parsePlatformTenantReference(inputScope.tenantReference)),
      brandReference: String(parsePlatformTenantReference(inputScope.brandReference)),
      actorReference: String(parsePlatformTenantReference(inputScope.actorReference)),
    }),
    tx = options.transaction,
    queryPort = tx.query,
    clock = options.clock,
    now = clock.now,
    references = options.references,
    canonical = references.canonicalize,
    hash = references.hashIntent,
    authority = options.authority,
    hold = authority.holdUntilTransactionCompletes,
    register = options.registerBeforeCommit,
    origin = String(parseCanonicalInstant(options.originalObservedAt)),
    originUntil = String(parseCanonicalInstant(options.originalValidUntil));
  let deadline = originUntil,
    latest = origin,
    poisoned = false,
    active = false,
    registered = false,
    phase: "Work" | "Checks" | "Final" = "Work",
    guardCalls = 0,
    finalCalls = 0,
    authorityIdentity: string | undefined;
  const reads = new Map<string, PlatformBrandTemplateRevision | null>();
  const fail = (
    code: PlatformBrandTemplateError["code"] = "PLATFORM_TEMPLATE_DEPENDENCY_UNAVAILABLE",
  ): never => {
    poisoned = true;
    throw new PlatformBrandTemplateError(code);
  };
  const unchanged = () =>
    !(
      poisoned ||
      options.scope !== scopeInput ||
      options.transaction !== tx ||
      tx.query !== queryPort ||
      options.clock !== clock ||
      clock.now !== now ||
      options.references !== references ||
      references.canonicalize !== canonical ||
      references.hashIntent !== hash ||
      options.authority !== authority ||
      authority.holdUntilTransactionCompletes !== hold ||
      options.registerBeforeCommit !== register ||
      options.originalObservedAt !== origin ||
      options.originalValidUntil !== originUntil ||
      options.scope.tenantReference !== scope.tenantReference ||
      options.scope.brandReference !== scope.brandReference ||
      options.scope.actorReference !== scope.actorReference
    );
  function check() {
    try {
      if (!unchanged()) return fail();
      readClosedRecord(scopeInput, ["tenantReference", "brandReference", "actorReference"]);
      const at = String(parseCanonicalInstant(now.call(clock)));
      if (!unchanged() || at < latest || at >= deadline) return fail();
      latest = at;
      return at;
    } catch {
      return fail();
    }
  }
  const codec: PlatformBrandTemplateCodec = {
    canonicalize(value) {
      check();
      const result = canonical.call(references, value);
      check();
      return result;
    },
    hashIntent(value) {
      check();
      const result = hash.call(references, value);
      check();
      return result;
    },
  };
  const same = (a: unknown, b: unknown) => codec.canonicalize(a) === codec.canonicalize(b);
  async function query(sql: string, values: readonly unknown[]) {
    check();
    const result = await queryPort.call(tx, sql, values);
    check();
    return result;
  }
  async function currentAuthority() {
    const observedAt = check();
    const packet = readClosedRecord(
      await hold.call(
        authority,
        tx,
        Object.freeze({
          scope,
          purposeCode: "BRAND_ADMINISTRATION",
          permission: "organization.manage",
          observedAt,
          validUntil: deadline,
        }),
      ),
      ["administrationContext", "validUntil"],
    );
    check();
    const context = parseBrandAdministrationContext(packet.administrationContext),
      until = String(parseCanonicalInstant(packet.validUntil));
    if (
      String(context.actor.actorReference) !== scope.actorReference ||
      String(context.brand.brandReference) !== scope.brandReference ||
      scope.tenantReference !== scope.brandReference ||
      context.store !== null ||
      context.purposeCode !== "BRAND_ADMINISTRATION" ||
      String(context.resolvedAt) < observedAt ||
      String(context.resolvedAt) > check() ||
      until <= check()
    )
      return fail("PLATFORM_TEMPLATE_PERMISSION_DENIED");
    const identity = codec.canonicalize({
      profile: context.profile,
      actor: context.actor,
      brand: context.brand,
      store: context.store,
      purposeCode: context.purposeCode,
    });
    if (authorityIdentity !== undefined && identity !== authorityIdentity)
      return fail("PLATFORM_TEMPLATE_PERMISSION_DENIED");
    authorityIdentity = identity;
    if (until < deadline) deadline = until;
    check();
  }
  async function read(version: string) {
    const remaining = String(Math.max(1, Date.parse(deadline) - Date.parse(check())));
    await query(
      "SELECT set_config('lock_timeout',$1,true),set_config('statement_timeout',$1,true)",
      [remaining],
    );
    await query(
      "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true),set_config('bop.brand_template_actor_id',$2,true),set_config('bop.brand_template_purpose','BRAND_ADMINISTRATION',true)",
      [scope.brandReference, scope.actorReference],
    );
    const result = await query(
      "SELECT revision_row,operation_row FROM bop_tenant.platform_brand_template_reference_read($1::uuid,$2::uuid,$3::uuid)",
      [scope.actorReference, scope.brandReference, version],
    );
    if (!result || typeof result !== "object") return fail();
    const d = Object.getOwnPropertyDescriptor(result, "rows");
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
    const entry = Object.getOwnPropertyDescriptor(d.value, "0");
    if (!entry?.enumerable || !("value" in entry)) return fail();
    const row = platformBrandTemplateStoredRecord(entry.value, ["revision_row", "operation_row"]),
      snapshot = decodePlatformBrandTemplateRevision(row.revision_row, codec, check());
    if (snapshot.templateVersionReference !== version) return fail();
    const original = decodePlatformBrandTemplateOperation(
      row.operation_row,
      snapshot.authoredByReference,
      snapshot.operationReference,
      codec,
      check(),
    );
    if (original.outcome !== "Committed" || !same(original.snapshot, snapshot)) return fail();
    return snapshot;
  }
  async function guard() {
    if (active || poisoned || phase === "Final") return fail();
    phase = "Checks";
    active = true;
    try {
      await currentAuthority();
      for (const [version, snapshot] of reads)
        if (!same(await read(version), snapshot)) return fail();
      check();
      guardCalls++;
    } catch (error) {
      return fail(error instanceof PlatformBrandTemplateError ? error.code : undefined);
    } finally {
      active = false;
    }
  }
  function final() {
    if (active || poisoned || phase !== "Checks" || guardCalls < 1 || finalCalls !== 0)
      return fail();
    check();
    finalCalls++;
    phase = "Final";
  }
  if (
    scope.tenantReference !== scope.brandReference ||
    origin.startsWith("0000-") ||
    originUntil.startsWith("0000-") ||
    origin >= originUntil ||
    Date.parse(originUntil) > Date.parse(origin) + 5000 ||
    [queryPort, now, canonical, hash, hold, register].some((port) => typeof port !== "function")
  )
    return fail();
  return Object.freeze({
    async exact(input: {
      readonly templateVersionReference: string;
    }): Promise<PlatformBrandTemplateRevision | null> {
      if (active || phase !== "Work" || poisoned) return fail();
      active = true;
      try {
        if (!registered) {
          registered = true;
          if ((await register(tx, guard, final)) !== undefined) return fail();
          const isolation = await query(
            "SELECT current_setting('transaction_isolation') isolation",
            [],
          );
          if (!isolation || typeof isolation !== "object") return fail();
          const rows = Object.getOwnPropertyDescriptor(isolation, "rows");
          if (
            !rows ||
            !("value" in rows) ||
            !Array.isArray(rows.value) ||
            rows.value.length !== 1 ||
            Reflect.ownKeys(rows.value).length !== 2
          )
            return fail();
          const entry = Object.getOwnPropertyDescriptor(rows.value, "0");
          if (
            !entry ||
            !("value" in entry) ||
            readClosedRecord(entry.value, ["isolation"]).isolation !== "read committed"
          )
            return fail();
        }
        check();
        const packet = readClosedRecord(input, ["templateVersionReference"]),
          version = String(parsePlatformTenantReference(packet.templateVersionReference));
        await currentAuthority();
        const snapshot = await read(version);
        if (reads.has(version) && !same(reads.get(version), snapshot)) return fail();
        reads.set(version, snapshot);
        return snapshot;
      } catch (error) {
        return fail(error instanceof PlatformBrandTemplateError ? error.code : undefined);
      } finally {
        active = false;
      }
    },
    assertFinalized() {
      if (
        poisoned ||
        active ||
        !registered ||
        guardCalls < 1 ||
        finalCalls !== 1 ||
        phase !== "Final"
      )
        return fail();
    },
  });
}

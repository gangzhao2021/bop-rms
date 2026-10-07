import { revalidateTenantContext, type PermissionDecision } from "@bop/permission";
import {
  parseBrandReference,
  parseStoreReference,
  parseCanonicalInstant,
  type TenantContext,
} from "@bop/tenant";
import {
  createOperatingEntity,
  createStoreOperatingEntityAssignment,
  resolveStoreOperatingEntity,
  parseEvidenceReference,
} from "../../domain/operating-entity.js";
import { createOperatingEntityProfileVersion } from "../../contracts/operating-entity-administration.js";
export interface TaxRegistrantTransaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
export interface TaxRegistrantScope {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly actorReference: string;
}
export const taxRegistrantSourceRequiredFields = Object.freeze([
  "scope",
  "effectiveAt",
  "businessFunction",
  "assignmentReference",
  "assignmentVersion",
  "assignmentWindow",
  "currentEntity",
  "entityVersion",
  "currentProfile",
  "profileVersion",
  "registrationReference",
  "taxRegistrationReference",
  "qualification",
] as const);
export interface TaxRegistrantCurrentSource extends TaxRegistrantScope {
  readonly profile: "TaxRegistrantCurrentSourceV1";
  readonly businessFunction: "TaxRegistrant";
  readonly effectiveAt: string;
  readonly assignmentReference: string;
  readonly assignmentVersion: number;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
  readonly operatingEntityReference: string;
  readonly entityVersion: number;
  readonly operatingEntityProfileVersionReference: string;
  readonly profileVersion: number;
  readonly legalName: string;
  readonly jurisdictionCode: "CA-ON";
  readonly registrationReference: string | null;
  readonly taxRegistrationReference: string | null;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly qualification: "NotEvaluated";
}
export class TaxRegistrantSourceError extends Error {
  constructor(
    readonly code:
      | "TAX_REGISTRANT_INPUT_INVALID"
      | "TAX_REGISTRANT_PERMISSION_DENIED"
      | "TAX_REGISTRANT_UNAVAILABLE",
  ) {
    super(code);
    this.name = "TaxRegistrantSourceError";
  }
}
export interface TaxRegistrantSourceOptions extends TaxRegistrantScope {
  readonly originalObservedAt: string;
  readonly originalValidUntil: string;
  readonly clock: { now(): string };
  readonly registerBeforeCommit: (
    tx: TaxRegistrantTransaction,
    guard: () => Promise<void>,
    finalAssert: () => void,
  ) => Promise<void> | void;
  readonly authority: {
    holdUntilTransactionCompletes(
      tx: TaxRegistrantTransaction,
      input: Readonly<
        TaxRegistrantScope & {
          actorKind: "User";
          permission: "organization.manage";
          purposeCode: "TAX_REGISTRANT_SOURCE";
          businessFunction: "TaxRegistrant";
          effectiveAt: string;
          requiredFields: typeof taxRegistrantSourceRequiredFields;
          observedAt: string;
          validUntil: string;
        }
      >,
    ): Promise<{
      readonly scope: TaxRegistrantScope;
      readonly tenantContext: TenantContext;
      readonly permission: PermissionDecision;
      readonly validUntil: string;
    }>;
  };
}
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length
  )
    throw new TaxRegistrantSourceError("TAX_REGISTRANT_UNAVAILABLE");
  return Object.fromEntries(
    keys.map((key) => {
      const d = Object.getOwnPropertyDescriptor(value, key);
      if (!d?.enumerable || !("value" in d))
        throw new TaxRegistrantSourceError("TAX_REGISTRANT_UNAVAILABLE");
      return [key, d.value];
    }),
  );
}
function data(value: object, key: string): unknown {
  const d = Object.getOwnPropertyDescriptor(value, key);
  if (!d || !("value" in d)) throw new TaxRegistrantSourceError("TAX_REGISTRANT_UNAVAILABLE");
  return d.value;
}
function rows(value: unknown): readonly unknown[] {
  if (!value || typeof value !== "object")
    throw new TaxRegistrantSourceError("TAX_REGISTRANT_UNAVAILABLE");
  const r = data(value, "rows");
  if (
    !Array.isArray(r) ||
    Object.getPrototypeOf(r) !== Array.prototype ||
    Reflect.ownKeys(r).length !== r.length + 1 ||
    r.length > 2
  )
    throw new TaxRegistrantSourceError("TAX_REGISTRANT_UNAVAILABLE");
  return Array.from({ length: r.length }, (_, i) => data(r, String(i)));
}
function detached(value: unknown): unknown {
  let nodes = 0;
  const seen = new Set<object>();
  const visit = (v: unknown, depth: number): unknown => {
    if (++nodes > 1024 || depth > 8)
      throw new TaxRegistrantSourceError("TAX_REGISTRANT_UNAVAILABLE");
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "string" && v.length <= 512) return v;
    if (typeof v === "number" && Number.isSafeInteger(v)) return v;
    if (!v || typeof v !== "object" || seen.has(v))
      throw new TaxRegistrantSourceError("TAX_REGISTRANT_UNAVAILABLE");
    seen.add(v);
    try {
      if (Array.isArray(v)) {
        if (
          Object.getPrototypeOf(v) !== Array.prototype ||
          v.length > 50 ||
          Reflect.ownKeys(v).length !== v.length + 1
        )
          throw new TaxRegistrantSourceError("TAX_REGISTRANT_UNAVAILABLE");
        return Object.freeze(
          Array.from({ length: v.length }, (_, i) => visit(data(v, String(i)), depth + 1)),
        );
      }
      if (Object.getPrototypeOf(v) !== Object.prototype)
        throw new TaxRegistrantSourceError("TAX_REGISTRANT_UNAVAILABLE");
      return Object.freeze(
        Object.fromEntries(
          Reflect.ownKeys(v).map((k) => {
            if (typeof k !== "string")
              throw new TaxRegistrantSourceError("TAX_REGISTRANT_UNAVAILABLE");
            return [k, visit(data(v, k), depth + 1)];
          }),
        ),
      );
    } finally {
      seen.delete(v);
    }
  };
  return visit(value, 0);
}
const utc = (field: string) =>
  `to_char(${field} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const selection = `SELECT jsonb_build_object('assignment',jsonb_build_object(
'assignmentReference',a.assignment_id,'brandReference',a.brand_id,'storeReference',a.store_id,'operatingEntityReference',a.operating_entity_id,'businessFunction',a.business_function,'lifecycle',a.lifecycle,'effectiveFrom',${utc("a.effective_from")},'effectiveUntil',CASE WHEN a.effective_until IS NULL THEN NULL ELSE ${utc("a.effective_until")} END,'version',a.version,'createdAt',${utc("a.created_at")},'updatedAt',${utc("a.updated_at")}),
'entity',jsonb_build_object('operatingEntityReference',e.operating_entity_id,'kind',e.kind,'legalName',e.legal_name,'tradeName',e.trade_name,'jurisdictionCode',e.jurisdiction_code,'registrationReference',e.registration_reference,'taxRegistrationReference',e.tax_registration_reference,'billingIdentityReference',e.billing_identity_reference,'settlementReference',e.settlement_reference,'evidenceReference',e.evidence_reference,'lifecycle',e.lifecycle,'version',e.version,'createdAt',${utc("e.created_at")},'updatedAt',${utc("e.updated_at")}),
'profile',CASE WHEN p.profile_version_id IS NULL THEN NULL ELSE jsonb_build_object('profileVersionReference',p.profile_version_id,'operatingEntityReference',p.operating_entity_id,'profileVersion',p.profile_version,'legalName',p.legal_name,'tradeName',p.trade_name,'jurisdictionCode',p.jurisdiction_code,'registrationReference',p.registration_reference,'taxRegistrationReference',p.tax_registration_reference,'registeredAddressReference',p.registered_address_reference,'billingIdentityReference',p.billing_identity_reference,'settlementReference',p.settlement_reference,'evidenceReferences',p.evidence_references,'recordedByReference',p.recorded_by_reference,'recordedAt',${utc("p.recorded_at")},'dataClassification',p.data_classification) END,
'profileBrandReference',p.brand_id,'profileStoreReference',p.store_id,
'precise',date_trunc('milliseconds',a.created_at)=a.created_at AND date_trunc('milliseconds',a.updated_at)=a.updated_at AND date_trunc('milliseconds',a.effective_from)=a.effective_from AND (a.effective_until IS NULL OR date_trunc('milliseconds',a.effective_until)=a.effective_until) AND date_trunc('milliseconds',e.created_at)=e.created_at AND date_trunc('milliseconds',e.updated_at)=e.updated_at AND (p.recorded_at IS NULL OR date_trunc('milliseconds',p.recorded_at)=p.recorded_at)) source
FROM bop_operating_entity.store_operating_entity_assignment a JOIN bop_operating_entity.operating_entity e ON e.operating_entity_id=a.operating_entity_id
LEFT JOIN LATERAL (SELECT p.* FROM bop_operating_entity.operating_entity_profile_version p WHERE p.brand_id=$1 AND p.operating_entity_id=e.operating_entity_id ORDER BY p.profile_version DESC LIMIT 1) p ON true
WHERE a.brand_id=$1 AND a.store_id=$2 AND a.business_function='TaxRegistrant' AND a.lifecycle='Active' AND a.effective_from<=$3::timestamptz AND (a.effective_until IS NULL OR a.effective_until>$3::timestamptz)
ORDER BY a.assignment_id LIMIT 2 FOR SHARE OF a,e`;
/** Current reference metadata, never verified tax applicability. Borrow the actual
 * outer transaction; authority must register its real current permission guard.
 * Shared owning assignment/profile advisory barriers exclude the actual BEFORE
 * writer triggers through outer COMMIT. Their scope is one Store and one entity;
 * entity/assignment row locks retain current scalar facts. No profile UPDATE
 * privilege or table-wide lock is needed. Call assertFinalized after outer COMMIT. */
export function createPostgresTaxRegistrantSource(options: TaxRegistrantSourceOptions) {
  let poisoned = false,
    active = false,
    tx: TaxRegistrantTransaction | undefined,
    queryPort: TaxRegistrantTransaction["query"] | undefined,
    effectiveAt: string | undefined,
    registered = false,
    asyncCalls = 0,
    asyncComplete = false,
    finalCalls = 0;
  const unavailable = (): never => {
    poisoned = true;
    throw new TaxRegistrantSourceError("TAX_REGISTRANT_UNAVAILABLE");
  };
  let scope: TaxRegistrantScope, origin: string, deadline: string;
  closed(options, [
    "tenantReference",
    "brandReference",
    "storeReference",
    "actorReference",
    "originalObservedAt",
    "originalValidUntil",
    "clock",
    "registerBeforeCommit",
    "authority",
  ]);
  try {
    scope = Object.freeze({
      tenantReference: String(parseEvidenceReference(data(options, "tenantReference"))),
      brandReference: String(parseBrandReference(data(options, "brandReference"))),
      storeReference: String(parseStoreReference(data(options, "storeReference"))),
      actorReference: String(parseEvidenceReference(data(options, "actorReference"))),
    });
    origin = String(parseCanonicalInstant(data(options, "originalObservedAt")));
    deadline = String(parseCanonicalInstant(data(options, "originalValidUntil")));
    if (
      Date.parse(deadline) <= Date.parse(origin) ||
      Date.parse(deadline) - Date.parse(origin) > 5000
    )
      throw Error();
  } catch {
    throw new TaxRegistrantSourceError("TAX_REGISTRANT_INPUT_INVALID");
  }
  const originalDeadline = deadline,
    clockOwner = options.clock,
    clockPort = data(clockOwner, "now"),
    authorityOwner = options.authority,
    register = options.registerBeforeCommit;
  if (typeof data(authorityOwner, "holdUntilTransactionCompletes") !== "function")
    return unavailable();
  const authorityPort = authorityOwner.holdUntilTransactionCompletes;
  if (
    typeof clockPort !== "function" ||
    typeof authorityPort !== "function" ||
    typeof register !== "function"
  )
    return unavailable();
  let latest = origin,
    baseline: string | undefined;
  const ports = () => {
    if (
      poisoned ||
      data(options, "clock") !== clockOwner ||
      data(clockOwner, "now") !== clockPort ||
      data(options, "authority") !== authorityOwner ||
      data(authorityOwner, "holdUntilTransactionCompletes") !== authorityPort ||
      data(options, "registerBeforeCommit") !== register ||
      data(options, "originalObservedAt") !== origin ||
      data(options, "originalValidUntil") !== originalDeadline ||
      Object.entries(scope).some(([key, v]) => data(options, key) !== v) ||
      !tx ||
      data(tx, "query") !== queryPort
    )
      return unavailable();
  };
  const check = () => {
    ports();
    let now: string;
    try {
      now = String(parseCanonicalInstant(clockPort.call(clockOwner)));
    } catch {
      return unavailable();
    }
    ports();
    if (now < latest || now < origin || now >= deadline) return unavailable();
    latest = now;
    return now;
  };
  const query = async (sql: string, values: readonly unknown[]) => {
    check();
    if (!tx || !queryPort) return unavailable();
    const value = await queryPort.call(tx, sql, values);
    check();
    return value;
  };
  const restore = () =>
    query(
      "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true),set_config('statement_timeout',$4,true)",
      [
        scope.tenantReference,
        scope.brandReference,
        scope.storeReference,
        String(Math.max(1, Date.parse(deadline) - Date.parse(check()))),
      ],
    );
  const hold = async () => {
    const observedAt = check();
    if (!tx || !effectiveAt) return unavailable();
    const raw = await authorityPort.call(
      authorityOwner,
      tx,
      Object.freeze({
        ...scope,
        actorKind: "User",
        permission: "organization.manage",
        purposeCode: "TAX_REGISTRANT_SOURCE",
        businessFunction: "TaxRegistrant",
        effectiveAt,
        requiredFields: taxRegistrantSourceRequiredFields,
        observedAt,
        validUntil: deadline,
      }),
    );
    check();
    const p = closed(raw, ["scope", "tenantContext", "permission", "validUntil"]),
      proofScope = closed(p.scope, [
        "tenantReference",
        "brandReference",
        "storeReference",
        "actorReference",
      ]);
    detached(p.tenantContext);
    const context = revalidateTenantContext(raw.tenantContext),
      decision = closed(p.permission, [
        "effect",
        "reason",
        "source",
        "action",
        "scopeKind",
        "policySnapshotReference",
        "policyVersion",
        "audit",
      ]),
      audit = closed(decision.audit, ["effect", "reason", "source"]);
    if (
      Object.entries(scope).some(([key, v]) => proofScope[key] !== v) ||
      context.scopeKind !== "Store" ||
      context.actor.actorType !== "User" ||
      String(context.actor.actorReference) !== scope.actorReference ||
      String(context.brand.brandReference) !== scope.brandReference ||
      context.store === null ||
      String(context.store.storeReference) !== scope.storeReference ||
      String(context.resolvedAt) < origin ||
      String(context.resolvedAt) > check() ||
      decision.effect !== "Allow" ||
      decision.action !== "organization.manage" ||
      decision.scopeKind !== "Store" ||
      !(
        (decision.reason === "ROLE_PERMISSION" && decision.source === "RolePermission") ||
        (decision.reason === "EXPLICIT_ALLOW" && decision.source === "ExplicitAllow")
      ) ||
      !Number.isSafeInteger(decision.policyVersion) ||
      Number(decision.policyVersion) < 1 ||
      audit.effect !== decision.effect ||
      audit.reason !== decision.reason ||
      audit.source !== decision.source
    ) {
      poisoned = true;
      throw new TaxRegistrantSourceError("TAX_REGISTRANT_PERMISSION_DENIED");
    }
    parseEvidenceReference(decision.policySnapshotReference);
    const until = String(parseCanonicalInstant(p.validUntil));
    if (until <= latest) return unavailable();
    if (until < deadline) deadline = until;
    check();
  };
  const read = async (): Promise<TaxRegistrantCurrentSource | null> => {
    await restore();
    await query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))", [
      `TaxRegistrantAssignment:${scope.brandReference}:${scope.storeReference}`,
    ]);
    const identities = rows(
      await query(
        "SELECT operating_entity_id AS \"operatingEntityReference\" FROM bop_operating_entity.store_operating_entity_assignment WHERE brand_id=$1 AND store_id=$2 AND business_function='TaxRegistrant' AND lifecycle='Active' AND effective_from<=$3::timestamptz AND (effective_until IS NULL OR effective_until>$3::timestamptz) ORDER BY assignment_id LIMIT 2",
        [scope.brandReference, scope.storeReference, effectiveAt],
      ),
    );
    if (identities.length === 0) return null;
    if (identities.length !== 1) return unavailable();
    const entityReference = String(
      parseEvidenceReference(
        closed(identities[0], ["operatingEntityReference"]).operatingEntityReference,
      ),
    );
    await query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))", [
      `TaxRegistrantProfile:${entityReference}`,
    ]);
    const result = rows(
      await query(selection, [scope.brandReference, scope.storeReference, effectiveAt]),
    );
    if (result.length !== 1) return unavailable();
    const r = closed(detached(closed(result[0], ["source"]).source), [
      "assignment",
      "entity",
      "profile",
      "profileBrandReference",
      "profileStoreReference",
      "precise",
    ]);
    if (
      r.precise !== true ||
      r.profile === null ||
      r.profileBrandReference !== scope.brandReference ||
      (r.profileStoreReference !== null && r.profileStoreReference !== scope.storeReference)
    )
      return unavailable();
    const assignment = createStoreOperatingEntityAssignment(r.assignment),
      entity = createOperatingEntity(r.entity),
      profile = createOperatingEntityProfileVersion(r.profile);
    const at = effectiveAt;
    if (!at) return unavailable();
    resolveStoreOperatingEntity(
      [assignment],
      scope.brandReference,
      scope.storeReference,
      "TaxRegistrant",
      at,
    );
    if (
      String(entity.operatingEntityReference) !== entityReference ||
      entity.lifecycle !== "Active" ||
      assignment.operatingEntityReference !== entity.operatingEntityReference ||
      profile.operatingEntityReference !== entity.operatingEntityReference ||
      assignment.updatedAt > at ||
      entity.updatedAt > at ||
      profile.recordedAt > at ||
      profile.recordedAt < entity.createdAt ||
      (
        [
          "legalName",
          "tradeName",
          "jurisdictionCode",
          "registrationReference",
          "taxRegistrationReference",
          "billingIdentityReference",
          "settlementReference",
        ] as const
      ).some((key) => profile[key] !== entity[key])
    )
      return unavailable();
    return Object.freeze({
      profile: "TaxRegistrantCurrentSourceV1",
      ...scope,
      businessFunction: "TaxRegistrant",
      effectiveAt: at,
      assignmentReference: String(assignment.assignmentReference),
      assignmentVersion: Number(assignment.version),
      effectiveFrom: String(assignment.effectiveFrom),
      effectiveUntil: assignment.effectiveUntil === null ? null : String(assignment.effectiveUntil),
      operatingEntityReference: String(entity.operatingEntityReference),
      entityVersion: Number(entity.version),
      operatingEntityProfileVersionReference: String(profile.profileVersionReference),
      profileVersion: Number(profile.profileVersion),
      legalName: entity.legalName,
      jurisdictionCode: "CA-ON",
      registrationReference:
        entity.registrationReference === null ? null : String(entity.registrationReference),
      taxRegistrationReference:
        entity.taxRegistrationReference === null ? null : String(entity.taxRegistrationReference),
      observedAt: check(),
      validUntil: deadline,
      qualification: "NotEvaluated",
    });
  };
  const stable = (value: TaxRegistrantCurrentSource | null) => {
    if (!value) return "null";
    const { observedAt: ignored, validUntil: ignoredLease, ...facts } = value;
    void ignored;
    void ignoredLease;
    return JSON.stringify(facts);
  };
  const guarded = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      poisoned = true;
      if (error instanceof TaxRegistrantSourceError) throw error;
      return unavailable();
    }
  };
  return Object.freeze({
    async resolve(input: {
      transaction: TaxRegistrantTransaction;
      effectiveAt: string;
    }): Promise<TaxRegistrantCurrentSource | null> {
      return guarded(async () => {
        if (active || asyncCalls || finalCalls) return unavailable();
        const r = closed(input, ["transaction", "effectiveAt"]),
          actual = r.transaction;
        if (!actual || typeof actual !== "object") return unavailable();
        const selected = r.effectiveAt;
        const at = String(parseCanonicalInstant(selected));
        if (!tx) {
          tx = input.transaction;
          if (typeof data(tx, "query") !== "function") return unavailable();
          queryPort = tx.query;
          effectiveAt = at;
        }
        if (actual !== tx || at !== effectiveAt || at < origin || at > check())
          return unavailable();
        active = true;
        try {
          await hold();
          await restore();
          if (!registered) {
            const isolation = rows(
              await query("SELECT current_setting('transaction_isolation') isolation", []),
            );
            if (
              isolation.length !== 1 ||
              closed(isolation[0], ["isolation"]).isolation !== "read committed"
            )
              return unavailable();
            if (
              (await register(
                tx,
                async () => {
                  await guarded(async () => {
                    if (++asyncCalls !== 1 || active) return unavailable();
                    await hold();
                    const current = await read();
                    if (stable(current) !== baseline) return unavailable();
                    await hold();
                    await restore();
                    check();
                    asyncComplete = true;
                  });
                },
                () => {
                  if (++finalCalls !== 1 || !asyncComplete || active) return unavailable();
                  check();
                },
              )) !== undefined
            )
              return unavailable();
            registered = true;
          }
          const value = await read(),
            key = stable(value);
          if (baseline !== undefined && key !== baseline) return unavailable();
          baseline = key;
          await hold();
          await restore();
          check();
          return value === null ? null : Object.freeze({ ...value, validUntil: deadline });
        } finally {
          active = false;
        }
      });
    },
    assertFinalized(actualTx: TaxRegistrantTransaction): string {
      if (
        actualTx !== tx ||
        !registered ||
        asyncCalls !== 1 ||
        !asyncComplete ||
        finalCalls !== 1 ||
        active ||
        baseline === undefined
      )
        return unavailable();
      check();
      return deadline;
    },
  });
}

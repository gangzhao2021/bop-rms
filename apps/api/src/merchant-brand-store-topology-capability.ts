import {
  createCurrentStoreCapabilityService,
  createEmptyStoreCapabilityDependencySource,
  createPostgresFeatureControlAdministrationQueryStore,
  createOrganizationStoreCapabilityBindings,
  parseFeatureControlInstant,
  parseFeatureControlReference,
  type FeatureControlAdministrationSource,
} from "@bop/feature-control";
import {
  revalidateTenantContext,
  parsePolicyReference,
  parsePolicyVersion,
  type PermissionDecision,
} from "@bop/permission";
import {
  BrandStoreTopologyError,
  type BrandStoreTopologyActorScope,
  parsePlatformTenantReference,
  parseBrandReference,
  parseStoreReference,
  type TenantContext,
} from "@bop/tenant";
import type { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";

type Host = ReturnType<typeof createMerchantCategoryTransactions>;
export interface MerchantBrandStoreTopologyCapabilityOptions {
  readonly mode?: "Command" | "Navigation";
  readonly transaction: Parameters<Host["registerBeforeCommit"]>[0];
  readonly scope: BrandStoreTopologyActorScope;
  readonly selectedStoreReference: string;
  readonly clock: { now(): string };
  readonly originalObservedAt: string;
  readonly originalValidUntil: string;
  readonly registerBeforeCommit: Host["registerBeforeCommit"];
  readonly holdCurrentBrandAuthority: (
    transaction: Parameters<Host["registerBeforeCommit"]>[0],
    input: {
      readonly scope: BrandStoreTopologyActorScope;
      readonly selectedStoreReference: string;
      readonly permission: "organization.manage";
      readonly purposeCode: "STORE_CAPABILITY_EVALUATION";
      readonly requiredFields: readonly string[];
      readonly observedAt: string;
      readonly validUntil: string;
    },
  ) => Promise<{
    readonly scope: BrandStoreTopologyActorScope;
    readonly selectedStoreReference: string;
    readonly tenantContext: TenantContext;
    readonly permission: PermissionDecision;
    readonly validUntil: string;
  }>;
}
export class MerchantBrandStoreTopologyFeatureDisabled extends BrandStoreTopologyError {
  constructor() {
    super("BRAND_STORE_TOPOLOGY_DEPENDENCY_UNAVAILABLE");
    this.name = "MerchantBrandStoreTopologyFeatureDisabled";
  }
}
const key = "organization.brand.detail",
  capability = "organization.org_brand_detail",
  purpose = "STORE_CAPABILITY_EVALUATION";
export const merchantBrandStoreTopologyCapabilityRequiredFields = Object.freeze([
  "controlId",
  "key",
  "description",
  "version",
  "ownerReference",
  "purposeCode",
  "scope",
  "source",
  "defaultValue",
  "configuredValue",
  "lifecycle",
  "temporary",
  "effectiveFrom",
  "effectiveUntil",
  "reviewAt",
  "expiresAt",
  "dependencies",
  "authoredByReference",
  "approvedByReference",
  "approvalEvidenceReference",
  "publicationReference",
]);
const fail = (): never => {
  throw new BrandStoreTopologyError("BRAND_STORE_TOPOLOGY_DEPENDENCY_UNAVAILABLE");
};
function record(value: unknown, expected: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return fail();
  const keys = Reflect.ownKeys(value),
    descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    keys.length !== expected.length ||
    keys.some(
      (k) =>
        typeof k !== "string" ||
        !expected.includes(k) ||
        !("value" in (descriptors[k] ?? {})) ||
        !descriptors[k]?.enumerable,
    )
  )
    return fail();
  return Object.fromEntries(expected.map((k) => [k, descriptors[k]?.value]));
}
function parseTopologyScope(value: unknown): BrandStoreTopologyActorScope {
  const row = record(value, ["tenantReference", "brandReference", "actorReference"]);
  return Object.freeze({
    tenantReference: String(parsePlatformTenantReference(row.tenantReference)),
    brandReference: String(parseBrandReference(row.brandReference)),
    actorReference: String(parseFeatureControlReference(row.actorReference)),
  });
}
function assertData(value: unknown, depth = 0, budget = { count: 0 }): void {
  if (++budget.count > 10000 || depth > 16) return fail();
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return;
  if (!value || typeof value !== "object") return fail();
  if (Object.getPrototypeOf(value) !== Object.prototype && !Array.isArray(value)) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !("value" in (descriptors[key] ?? {}))) return fail();
    if (Array.isArray(value) && key === "length") continue;
    assertData(descriptors[key]?.value, depth + 1, budget);
  }
}
/** Actual Brand authority remains independent of the selected Store context
 * used to read and evaluate owning FeatureControl definitions. */
export function createMerchantBrandStoreTopologyCapability(
  options: MerchantBrandStoreTopologyCapabilityOptions,
) {
  const originalMode = options.mode,
    mode = originalMode === undefined ? "Command" : originalMode,
    tx = options.transaction,
    queryPort = tx?.query,
    clock = options.clock,
    nowPort = clock?.now,
    registerPort = options.registerBeforeCommit,
    authorityPort = options.holdCurrentBrandAuthority,
    scope = parseTopologyScope(options.scope),
    selectedStoreReference = String(parseStoreReference(options.selectedStoreReference)),
    origin = parseFeatureControlInstant(options.originalObservedAt);
  let deadline = String(parseFeatureControlInstant(options.originalValidUntil)),
    latest = String(origin),
    phase: "Work" | "Checks" | "Final" = "Work",
    failed = false,
    active = false,
    registered = false,
    ready = false,
    checked = false,
    finals = 0,
    navigationVisible: boolean | undefined,
    navigationDefinitions: string | undefined;
  if (
    (mode !== "Command" && mode !== "Navigation") ||
    typeof queryPort !== "function" ||
    typeof nowPort !== "function" ||
    typeof registerPort !== "function" ||
    typeof authorityPort !== "function" ||
    deadline <= origin ||
    Date.parse(deadline) - Date.parse(origin) > 5000
  )
    return fail();
  const poison = (): never => {
    failed = true;
    return fail();
  };
  function check(): string {
    const at = String(parseFeatureControlInstant(nowPort.call(clock)));
    if (
      failed ||
      tx.query !== queryPort ||
      clock.now !== nowPort ||
      options.clock !== clock ||
      options.transaction !== tx ||
      options.mode !== originalMode ||
      options.registerBeforeCommit !== registerPort ||
      options.holdCurrentBrandAuthority !== authorityPort ||
      options.originalObservedAt !== origin ||
      options.originalValidUntil !== originalDeadline ||
      JSON.stringify(parseTopologyScope(options.scope)) !== JSON.stringify(scope) ||
      options.selectedStoreReference !== selectedStoreReference ||
      at < latest ||
      at >= deadline
    )
      return poison();
    latest = at;
    return at;
  }
  const originalDeadline = options.originalValidUntil;
  function tighten(value: unknown) {
    const until = String(parseFeatureControlInstant(value));
    if (until <= check()) return poison();
    if (until < deadline) deadline = until;
  }
  let authorityFailure: BrandStoreTopologyError | undefined;
  async function current(observedAt = check()): Promise<TenantContext> {
    try {
      const value = await authorityPort(tx, {
        scope,
        selectedStoreReference,
        permission: "organization.manage",
        purposeCode: purpose,
        requiredFields: merchantBrandStoreTopologyCapabilityRequiredFields,
        observedAt,
        validUntil: deadline,
      });
      check();
      assertData(value);
      const packet = record(value, [
          "scope",
          "selectedStoreReference",
          "tenantContext",
          "permission",
          "validUntil",
        ]),
        decision = record(packet.permission, [
          "effect",
          "reason",
          "source",
          "action",
          "scopeKind",
          "policySnapshotReference",
          "policyVersion",
          "audit",
        ]),
        audit = record(decision.audit, ["effect", "reason", "source"]);
      const context = revalidateTenantContext(value.tenantContext);
      if (
        JSON.stringify(parseTopologyScope(packet.scope)) !== JSON.stringify(scope) ||
        packet.selectedStoreReference !== selectedStoreReference ||
        context.scopeKind !== "Store" ||
        context.actor.actorType !== "User" ||
        String(context.actor.actorReference) !== scope.actorReference ||
        String(context.brand.brandReference) !== scope.brandReference ||
        String(context.store?.storeReference) !== selectedStoreReference ||
        String(context.resolvedAt) < observedAt ||
        String(context.resolvedAt) > check() ||
        decision.effect !== "Allow" ||
        decision.action !== "organization.manage" ||
        decision.scopeKind !== "Brand" ||
        !(
          (decision.reason === "ROLE_PERMISSION" && decision.source === "RolePermission") ||
          (decision.reason === "EXPLICIT_ALLOW" && decision.source === "ExplicitAllow")
        ) ||
        !Number.isSafeInteger(decision.policyVersion) ||
        Number(decision.policyVersion) < 1 ||
        audit.effect !== decision.effect ||
        audit.reason !== decision.reason ||
        audit.source !== decision.source
      )
        throw new BrandStoreTopologyError("BRAND_STORE_TOPOLOGY_PERMISSION_DENIED");
      parsePolicyReference(decision.policySnapshotReference);
      parsePolicyVersion(decision.policyVersion);
      tighten(packet.validUntil);
      return context;
    } catch (error) {
      failed = true;
      if (error instanceof BrandStoreTopologyError) {
        authorityFailure = error;
        throw error;
      }
      return fail();
    }
  }
  const borrowed = Object.freeze({
    async query<Row = Record<string, unknown>>(sql: string, values: readonly unknown[]) {
      const at = check(),
        remaining = Math.max(1, Math.floor(Date.parse(deadline) - Date.parse(at)));
      await queryPort.call(
        tx,
        "SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$1,true)",
        [String(remaining)],
      );
      check();
      const result = await tx.query<Row>(sql, values);
      check();
      return result;
    },
  });
  const definitions = createPostgresFeatureControlAdministrationQueryStore(
    {
      async run(work) {
        check();
        const result = await work(borrowed);
        check();
        return result;
      },
    },
    { brandReference: scope.brandReference, storeReference: selectedStoreReference },
    {
      async withAuthorizedDefinitionsScope(input, work) {
        if (
          input.actorReference !== scope.actorReference ||
          input.brandReference !== scope.brandReference ||
          input.storeReference !== selectedStoreReference ||
          input.key !== key ||
          input.purposeCode !== purpose ||
          input.access !== "AdministrationDefinitions" ||
          input.observedAt < origin ||
          input.observedAt > check()
        )
          return poison();
        await current();
        const result = await work();
        await current();
        return result;
      },
    },
  );
  async function evaluate() {
    let source: FeatureControlAdministrationSource | undefined,
      disabled = false,
      visible: boolean | undefined,
      definitionIdentity: string | undefined;
    try {
      const heldContext = await current();
      let firstClock = true,
        scopeCalls = 0;
      const service = createCurrentStoreCapabilityService(
        {
          clock: {
            now() {
              check();
              if (firstClock) {
                firstClock = false;
                return heldContext.resolvedAt;
              }
              return check();
            },
          },
          bindings: createOrganizationStoreCapabilityBindings(),
          dependencies: createEmptyStoreCapabilityDependencySource(),
          definitions: {
            withCurrentDefinitions(input, work) {
              return definitions.withCurrentDefinitions(input, async (actual) => {
                source = actual;
                return work(actual);
              });
            },
          },
          authority: {
            async withCurrentStoreScope(input, work) {
              if (
                input.brandReference !== scope.brandReference ||
                input.storeReference !== selectedStoreReference ||
                input.capabilityKey !== capability ||
                input.observedAt !== heldContext.resolvedAt ||
                ++scopeCalls !== 1
              )
                return poison();
              check();
              return work(heldContext);
            },
          },
        },
        { brandReference: scope.brandReference, storeReference: selectedStoreReference },
      );
      await service.withCurrentCapability(capability, async (decision) => {
        check();
        if (
          decision.capabilityKey !== capability ||
          decision.controlKey !== key ||
          decision.brandReference !== scope.brandReference ||
          decision.storeReference !== selectedStoreReference
        )
          return poison();
        if (decision.reason === "Disabled") {
          disabled = true;
          if (mode === "Command") throw new MerchantBrandStoreTopologyFeatureDisabled();
        }
        if (
          (decision.reason !== "Enabled" && !(mode === "Navigation" && disabled)) ||
          decision.backendExecution !== (disabled ? "Deny" : "Allow") ||
          decision.frontendVisibility !== (disabled ? "Hide" : "Show") ||
          !source
        )
          return poison();
        const selected = source.definitions.find(
          (d) => d.controlId === decision.controlReference && d.version === decision.controlVersion,
        );
        if (!selected) return poison();
        visible = !disabled;
        definitionIdentity = JSON.stringify(source.definitions);
        for (const definition of source.definitions)
          for (const boundary of [
            definition.effectiveFrom,
            definition.effectiveUntil,
            definition.expiresAt,
          ])
            if (
              boundary !== null &&
              boundary > decision.observedAt &&
              boundary < deadline &&
              (definition.lifecycle === "Published" || definition.lifecycle === "Disabled")
            )
              deadline = boundary;
        check();
      });
      await current();
      if (mode === "Navigation") {
        if (visible === undefined || definitionIdentity === undefined) return poison();
        // Preserve the navigation actually returned, including an actual disabled
        // definition. Observation changes do not create new business identity.
        if (
          navigationVisible !== undefined &&
          (navigationVisible !== visible || navigationDefinitions !== definitionIdentity)
        )
          return poison();
        navigationVisible = visible;
        navigationDefinitions = definitionIdentity;
      }
      ready = true;
    } catch (error) {
      failed = true;
      if (authorityFailure) throw authorityFailure;
      if (disabled && mode === "Command") throw new MerchantBrandStoreTopologyFeatureDisabled();
      if (error instanceof BrandStoreTopologyError) throw error;
      return fail();
    }
  }
  async function hold(): Promise<void> {
    if (active || phase === "Final") return poison();
    active = true;
    try {
      check();
      if (!registered) {
        registered = true;
        const result = await registerPort(
          tx,
          async () => {
            if (active || phase !== "Work" || checked || !ready) return poison();
            phase = "Checks";
            active = true;
            try {
              await evaluate();
              check();
              checked = true;
            } catch (error) {
              failed = true;
              throw error;
            } finally {
              active = false;
            }
          },
          () => {
            if (!checked || active || phase !== "Checks" || ++finals !== 1) return poison();
            check();
            phase = "Final";
          },
        );
        if (result !== undefined) return poison();
      }
      await evaluate();
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      active = false;
    }
  }
  return Object.freeze({
    async holdUntilCommit(): Promise<void> {
      if (mode !== "Command") return poison();
      await hold();
    },
    async holdForNavigation(): Promise<boolean> {
      if (mode !== "Navigation") return poison();
      await hold();
      if (navigationVisible === undefined) return poison();
      return navigationVisible;
    },
    leaseDeadline(): string {
      if (!ready || active) return poison();
      check();
      return deadline;
    },
    assertFinalized(): string {
      if (phase !== "Final" || !checked || finals !== 1 || active) return poison();
      check();
      return deadline;
    },
  });
}

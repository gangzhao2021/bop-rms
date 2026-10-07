import {
  createCurrentBrandCapabilityService,
  createCurrentBrandAdministrationCapabilityService,
  type CurrentBrandCapabilityPorts,
  createPostgresFeatureControlAdministrationQueryStore,
  organizationStoreCapabilityBindings,
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
  BrandConfigurationOperationError,
  type BrandConfigurationActorScope,
  parsePlatformTenantReference,
  parseBrandReference,
  type TenantContext,
  type BrandAdministrationContext,
  parseBrandAdministrationContext,
} from "@bop/tenant";
import type { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";

type Host = ReturnType<typeof createMerchantCategoryTransactions>;
export interface MerchantBrandAdministrationCapabilityOptions {
  readonly mode?: "Command" | "Navigation";
  readonly transaction: Parameters<Host["registerBeforeCommit"]>[0];
  readonly scope: BrandConfigurationActorScope;
  readonly clock: { now(): string };
  readonly originalObservedAt: string;
  readonly originalValidUntil: string;
  readonly registerBeforeCommit: Host["registerBeforeCommit"];
  readonly holdCurrentBrandAuthority: (
    transaction: Parameters<Host["registerBeforeCommit"]>[0],
    input: {
      readonly scope: BrandConfigurationActorScope;
      readonly permission: "organization.manage";
      readonly purposeCode: "BRAND_CAPABILITY_EVALUATION";
      readonly requiredFields: readonly string[];
      readonly observedAt: string;
      readonly validUntil: string;
    },
  ) => Promise<{
    readonly scope: BrandConfigurationActorScope;
    readonly tenantContext: TenantContext;
    readonly permission: PermissionDecision;
    readonly validUntil: string;
  }>;
}
export type MerchantCurrentBrandAdministrationCapabilityOptions = Omit<
  MerchantBrandAdministrationCapabilityOptions,
  "holdCurrentBrandAuthority"
> & {
  readonly screen?: "List" | "Detail";
  readonly holdCurrentBrandAdministrationAuthority: (
    transaction: Parameters<Host["registerBeforeCommit"]>[0],
    input: {
      readonly scope: BrandConfigurationActorScope;
      readonly permission: "organization.manage";
      readonly purposeCode: "BRAND_ADMINISTRATION";
      readonly requiredFields: readonly string[];
      readonly observedAt: string;
      readonly validUntil: string;
    },
  ) => Promise<{
    readonly scope: BrandConfigurationActorScope;
    readonly administrationContext: BrandAdministrationContext;
    readonly permission: PermissionDecision;
    readonly validUntil: string;
  }>;
};
export class MerchantBrandAdministrationFeatureDisabled extends BrandConfigurationOperationError {
  constructor() {
    super("BRAND_CONFIGURATION_DEPENDENCY_UNAVAILABLE");
    this.name = "MerchantBrandAdministrationFeatureDisabled";
  }
}
export const merchantBrandAdministrationCapabilityRequiredFields = Object.freeze([
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
  throw new BrandConfigurationOperationError("BRAND_CONFIGURATION_DEPENDENCY_UNAVAILABLE");
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
function parseAdministrationScope(value: unknown): BrandConfigurationActorScope {
  const row = record(value, ["tenantReference", "brandReference", "actorReference"]);
  if (row.tenantReference !== row.brandReference) return fail();
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
/** Genuine no-Store Brand authority and the owning Brand definitions share the
 * same borrowed transaction through the final synchronous pre-COMMIT check. */
export function createMerchantBrandAdministrationCapability(
  options: MerchantBrandAdministrationCapabilityOptions,
) {
  const authority = options.holdCurrentBrandAuthority;
  return createCapabilityHolder<
    TenantContext,
    Awaited<ReturnType<MerchantBrandAdministrationCapabilityOptions["holdCurrentBrandAuthority"]>>
  >(options, {
    purpose: "BRAND_CAPABILITY_EVALUATION",
    contextKey: "tenantContext",
    authority,
    currentAuthority: () => options.holdCurrentBrandAuthority,
    hold: (tx, input) => authority(tx, { ...input, purposeCode: "BRAND_CAPABILITY_EVALUATION" }),
    context: (packet) => revalidateTenantContext(packet.tenantContext),
    createService: (context, ports, admit) =>
      createCurrentBrandCapabilityService(
        {
          ...ports,
          authority: {
            withCurrentBrandScope: (input, work) => {
              admit(input);
              return work(context);
            },
          },
        },
        options.scope,
      ),
  });
}
export function createMerchantCurrentBrandAdministrationCapability(
  options: MerchantCurrentBrandAdministrationCapabilityOptions,
) {
  const authority = options.holdCurrentBrandAdministrationAuthority;
  return createCapabilityHolder<
    BrandAdministrationContext,
    Awaited<
      ReturnType<
        MerchantCurrentBrandAdministrationCapabilityOptions["holdCurrentBrandAdministrationAuthority"]
      >
    >
  >(options, {
    purpose: "BRAND_ADMINISTRATION",
    contextKey: "administrationContext",
    authority,
    currentAuthority: () => options.holdCurrentBrandAdministrationAuthority,
    hold: (tx, input) => authority(tx, { ...input, purposeCode: "BRAND_ADMINISTRATION" }),
    context: (packet) => parseBrandAdministrationContext(packet.administrationContext),
    createService: (context, ports, admit) =>
      createCurrentBrandAdministrationCapabilityService(
        {
          ...ports,
          authority: {
            withCurrentBrandAdministrationScope: (input, work) => {
              admit(input);
              return work(context);
            },
          },
        },
        options.scope,
        options.screen,
      ),
  });
}
type HolderOptions = Omit<
  MerchantBrandAdministrationCapabilityOptions,
  "holdCurrentBrandAuthority"
> & { readonly screen?: "List" | "Detail" };
type AuthorityInput = Parameters<
  MerchantBrandAdministrationCapabilityOptions["holdCurrentBrandAuthority"]
>[1];
interface HolderStrategy<C, P> {
  readonly purpose: "BRAND_CAPABILITY_EVALUATION" | "BRAND_ADMINISTRATION";
  readonly contextKey: "tenantContext" | "administrationContext";
  readonly authority: unknown;
  currentAuthority(): unknown;
  hold(tx: HolderOptions["transaction"], input: Omit<AuthorityInput, "purposeCode">): Promise<P>;
  context(packet: P): C;
  createService(
    context: C,
    ports: Omit<CurrentBrandCapabilityPorts, "authority">,
    admit: (input: {
      brandReference: string;
      storeReference: null;
      capabilityKey: string;
      observedAt: string;
    }) => void,
  ): ReturnType<typeof createCurrentBrandCapabilityService>;
}
function createCapabilityHolder<C extends TenantContext | BrandAdministrationContext, P>(
  options: HolderOptions,
  strategy: HolderStrategy<C, P>,
) {
  const purpose = strategy.purpose;
  const originalScreen = options.screen,
    screen = originalScreen === undefined ? "Detail" : originalScreen,
    key = screen === "List" ? "organization.brand.list" : "organization.brand.detail",
    capability =
      screen === "List" ? "organization.org_brand_list" : "organization.org_brand_detail",
    originalMode = options.mode,
    mode = originalMode === undefined ? "Command" : originalMode,
    tx = options.transaction,
    queryPort = tx?.query,
    clock = options.clock,
    nowPort = clock?.now,
    registerPort = options.registerBeforeCommit,
    authorityPort = strategy.authority,
    scope = parseAdministrationScope(options.scope),
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
    navigationDefinitions: string | undefined,
    baselineDefinitions: string | undefined;
  if (
    (screen !== "List" && screen !== "Detail") ||
    (purpose !== "BRAND_ADMINISTRATION" && screen !== "Detail") ||
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
      options.screen !== originalScreen ||
      options.registerBeforeCommit !== registerPort ||
      strategy.currentAuthority() !== authorityPort ||
      options.originalObservedAt !== origin ||
      options.originalValidUntil !== originalDeadline ||
      JSON.stringify(parseAdministrationScope(options.scope)) !== JSON.stringify(scope) ||
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
  let authorityFailure: BrandConfigurationOperationError | undefined;
  async function current(observedAt = check()): Promise<C> {
    try {
      const value = await strategy.hold(tx, {
        scope,
        permission: "organization.manage",
        requiredFields: merchantBrandAdministrationCapabilityRequiredFields,
        observedAt,
        validUntil: deadline,
      });
      check();
      assertData(value);
      const packet = record(value, ["scope", strategy.contextKey, "permission", "validUntil"]),
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
      const context = strategy.context(value);
      if (
        JSON.stringify(parseAdministrationScope(packet.scope)) !== JSON.stringify(scope) ||
        context.actor.actorType !== "User" ||
        String(context.actor.actorReference) !== scope.actorReference ||
        String(context.brand.brandReference) !== scope.brandReference ||
        context.store !== null ||
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
        throw new BrandConfigurationOperationError("BRAND_CONFIGURATION_PERMISSION_DENIED");
      parsePolicyReference(decision.policySnapshotReference);
      parsePolicyVersion(decision.policyVersion);
      tighten(packet.validUntil);
      return context;
    } catch (error) {
      failed = true;
      if (error instanceof BrandConfigurationOperationError) {
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
    { brandReference: scope.brandReference, storeReference: null },
    {
      async withAuthorizedDefinitionsScope(input, work) {
        if (
          input.actorReference !== scope.actorReference ||
          input.brandReference !== scope.brandReference ||
          input.storeReference !== null ||
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
      const service = strategy.createService(
        heldContext,
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
          bindings: {
            async withCurrentBinding(input, work) {
              const binding = organizationStoreCapabilityBindings.find(
                (row) => row.capabilityKey === input.capabilityKey,
              );
              if (
                !binding ||
                input.brandReference !== scope.brandReference ||
                input.storeReference !== null
              )
                return poison();
              return work(binding);
            },
          },
          dependencies: {
            async withCurrentEvidence() {
              return poison();
            },
          },
          definitions: {
            withCurrentDefinitions(input, work) {
              return definitions.withCurrentDefinitions(input, async (actual) => {
                source = actual;
                return work(actual);
              });
            },
          },
        },
        (input) => {
          if (
            input.brandReference !== scope.brandReference ||
            input.storeReference !== null ||
            input.capabilityKey !== capability ||
            input.observedAt !== heldContext.resolvedAt ||
            ++scopeCalls !== 1
          )
            return poison();
          check();
        },
      );
      await service.withCurrentCapability(capability, async (decision) => {
        check();
        if (
          decision.capabilityKey !== capability ||
          decision.controlKey !== key ||
          decision.brandReference !== scope.brandReference ||
          decision.storeReference !== null
        )
          return poison();
        // Phase 1A administration is a fixed baseline, not a positive Feature
        // verdict. Only the actual held owner's entirely empty source qualifies.
        const baseline = purpose === "BRAND_ADMINISTRATION" && source?.definitions.length === 0;
        if (baseline) {
          if (!source || (ready && baselineDefinitions === undefined)) return poison();
          if (
            decision.reason !== "Unavailable" ||
            decision.backendExecution !== "Deny" ||
            decision.frontendVisibility !== "Hide" ||
            decision.controlReference !== null ||
            decision.controlVersion !== null ||
            decision.source !== null
          )
            return poison();
          visible = true;
          definitionIdentity = JSON.stringify(source.definitions);
          if (baselineDefinitions !== undefined && baselineDefinitions !== definitionIdentity)
            return poison();
          baselineDefinitions = definitionIdentity;
          check();
          return;
        }
        if (baselineDefinitions !== undefined) return poison();
        if (decision.reason === "Disabled") {
          disabled = true;
          if (mode === "Command") throw new MerchantBrandAdministrationFeatureDisabled();
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
      if (disabled && mode === "Command") throw new MerchantBrandAdministrationFeatureDisabled();
      if (error instanceof BrandConfigurationOperationError) throw error;
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
      if (failed || phase !== "Final" || !checked || finals !== 1 || active) return poison();
      return deadline;
    },
  });
}

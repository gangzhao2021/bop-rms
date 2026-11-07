import { revalidateTenantContext } from "@bop/permission";
import {
  parseBrandReference,
  parseStoreReference,
  parseBrandAdministrationContext,
  type BrandAdministrationContext,
  type TenantContext,
} from "@bop/tenant";
import {
  createFeatureControlAdministrationDefinition,
  type FeatureControlAdministrationDefinition,
  type FeatureControlDependency,
} from "../contracts/feature-control-administration.js";
import {
  parseFeatureControlInstant,
  parseFeatureControlKey,
  parseFeatureControlReference,
  parseFeatureControlVersion,
} from "../contracts/feature-control.js";

export class StoreCapabilityUnavailableError extends Error {
  readonly code = "STORE_CAPABILITY_UNAVAILABLE";
  constructor() {
    super("current Store capability is unavailable");
    this.name = "StoreCapabilityUnavailableError";
  }
}
const fail = (): never => {
  throw new StoreCapabilityUnavailableError();
};
export function parseStoreCapabilityKey(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 128 ||
    !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u.test(value)
  )
    return fail();
  return value;
}
/** Server-owned mapping is required. Registry identity is not a persisted control
 * key and is never transformed through an implicit prefix/default rule. */
export interface StoreCapabilityBinding {
  readonly capabilityKey: string;
  readonly controlKey: string;
  readonly mappingReference: string;
  readonly mappingVersion: number;
  readonly phase: "phase_0" | "phase_0_plus" | "phase_1" | "phase_1a" | "phase_2" | "phase_3";
  readonly commitment: "Committed";
}
interface CapabilityDecision<S extends string | null> {
  readonly capabilityKey: string;
  readonly controlKey: string;
  readonly brandReference: string;
  readonly storeReference: S;
  readonly backendExecution: "Allow" | "Deny";
  readonly frontendVisibility: "Show" | "Hide";
  readonly reason: "Enabled" | "Disabled" | "Unavailable";
  readonly source: "BrandOverride" | "StoreOverride" | null;
  readonly controlReference: string | null;
  readonly controlVersion: number | null;
  readonly observedAt: string;
}
export interface StoreCapabilityDependencyEvidence {
  readonly dependencyId: string;
  readonly targetKey: string;
  readonly kind: FeatureControlDependency["kind"];
  readonly evidenceReference: string;
  readonly evidenceVersion: number;
  readonly outcome: "Enabled" | "Disabled" | "Accepted";
  readonly observedAt: string;
  readonly validUntil: string;
}
interface CurrentCapabilityPorts<S extends string | null, C = TenantContext> {
  readonly clock: { now(): string };
  readonly authority: {
    withCurrentScope<T>(
      input: {
        readonly brandReference: string;
        readonly storeReference: S;
        readonly capabilityKey: string;
        readonly observedAt: string;
      },
      work: (context: C) => Promise<T>,
    ): Promise<T>;
  };
  readonly bindings: {
    withCurrentBinding<T>(
      input: {
        readonly brandReference: string;
        readonly storeReference: S;
        readonly capabilityKey: string;
        readonly observedAt: string;
      },
      work: (binding: StoreCapabilityBinding) => Promise<T>,
    ): Promise<T>;
  };
  readonly definitions: {
    withCurrentDefinitions<T>(
      input: {
        readonly actorReference: string;
        readonly purposeCode: string;
        readonly key: string;
        readonly observedAt: string;
      },
      work: (source: {
        readonly brandReference: string;
        readonly storeReference: string | null;
        readonly key: string;
        readonly observedAt: string;
        readonly dependencyCoverage: "Unconfirmed" | "Complete";
        readonly definitions: readonly FeatureControlAdministrationDefinition[];
      }) => Promise<T>,
    ): Promise<T>;
  };
  readonly dependencies: {
    withCurrentEvidence<T>(
      input: {
        readonly brandReference: string;
        readonly storeReference: S;
        readonly dependencies: readonly FeatureControlDependency[];
        readonly observedAt: string;
      },
      work: (evidence: readonly StoreCapabilityDependencyEvidence[]) => Promise<T>,
    ): Promise<T>;
  };
}
export type StoreCapabilityDecision = CapabilityDecision<string>;
export type BrandCapabilityDecision = CapabilityDecision<null>;
export type CurrentStoreCapabilityPorts = Omit<CurrentCapabilityPorts<string>, "authority"> & {
  readonly authority: {
    withCurrentStoreScope: CurrentCapabilityPorts<string>["authority"]["withCurrentScope"];
  };
};
export type CurrentBrandCapabilityPorts = Omit<CurrentCapabilityPorts<null>, "authority"> & {
  readonly authority: {
    withCurrentBrandScope: CurrentCapabilityPorts<null>["authority"]["withCurrentScope"];
  };
};
export type BrandAdministrationCapabilityDecision = CapabilityDecision<null>;
export type CurrentBrandAdministrationCapabilityPorts = Omit<
  CurrentCapabilityPorts<null, BrandAdministrationContext>,
  "authority"
> & {
  readonly authority: {
    withCurrentBrandAdministrationScope: CurrentCapabilityPorts<
      null,
      BrandAdministrationContext
    >["authority"]["withCurrentScope"];
  };
};
export class BrandCapabilityUnavailableError extends Error {
  readonly code = "BRAND_CAPABILITY_UNAVAILABLE";
  constructor() {
    super("current Brand capability is unavailable");
    this.name = "BrandCapabilityUnavailableError";
  }
}

/** Preserve the Store contract while sharing the same owning definition rules. */
export function createCurrentStoreCapabilityService(
  ports: CurrentStoreCapabilityPorts,
  scope: { readonly brandReference: string; readonly storeReference: string },
) {
  const storeReference = parseStoreReference(scope.storeReference);
  return createCurrentCapabilityService(
    {
      ...ports,
      authority: {
        withCurrentScope: (input, work) => ports.authority.withCurrentStoreScope(input, work),
      },
    },
    { brandReference: scope.brandReference, storeReference },
    "STORE_CAPABILITY_EVALUATION",
    operationalContext,
  );
}

/** A genuine Brand context has no Store, and cannot inherit a Store override. */
export function createCurrentBrandCapabilityService(
  ports: CurrentBrandCapabilityPorts,
  scope: { readonly brandReference: string },
) {
  const service = createCurrentCapabilityService(
    {
      ...ports,
      authority: {
        withCurrentScope: (input, work) => ports.authority.withCurrentBrandScope(input, work),
      },
    },
    { brandReference: scope.brandReference, storeReference: null },
    "BRAND_CAPABILITY_EVALUATION",
    operationalContext,
  );
  return Object.freeze({
    async withCurrentCapability<T>(
      value: unknown,
      work: (decision: BrandCapabilityDecision) => Promise<T>,
    ): Promise<T> {
      try {
        return await service.withCurrentCapability(value, work);
      } catch {
        throw new BrandCapabilityUnavailableError();
      }
    },
  });
}

/** Administrative observation retains the actual Brand lifecycle and grants no
 * operational scope. Only the registered Brand list and detail capabilities are supported. */
export function createCurrentBrandAdministrationCapabilityService(
  ports: CurrentBrandAdministrationCapabilityPorts,
  scope: { readonly brandReference: string },
  screen: "List" | "Detail" = "Detail",
) {
  if (screen !== "List" && screen !== "Detail") throw new BrandCapabilityUnavailableError();
  const service = createCurrentCapabilityService(
    {
      ...ports,
      authority: {
        withCurrentScope: (input, work) =>
          ports.authority.withCurrentBrandAdministrationScope(input, work),
      },
    },
    { brandReference: scope.brandReference, storeReference: null },
    "BRAND_ADMINISTRATION",
    (value) => parseBrandAdministrationContext(value),
    screen === "List"
      ? { capabilityKey: "organization.org_brand_list", controlKey: "organization.brand.list" }
      : { capabilityKey: "organization.org_brand_detail", controlKey: "organization.brand.detail" },
  );
  return Object.freeze({
    async withCurrentCapability<T>(
      value: unknown,
      work: (decision: BrandAdministrationCapabilityDecision) => Promise<T>,
    ): Promise<T> {
      try {
        return await service.withCurrentCapability(value, work);
      } catch {
        throw new BrandCapabilityUnavailableError();
      }
    },
  });
}
function operationalContext(value: TenantContext): TenantContext {
  const context = revalidateTenantContext(value);
  if (context.scopeKind !== (context.store === null ? "Brand" : "Store")) return fail();
  return context;
}

function data(value: unknown): unknown {
  let budget = 10000;
  function copy(v: unknown, depth: number): unknown {
    if (--budget < 0 || depth > 10) return fail();
    if (v === null || typeof v === "boolean" || typeof v === "number") return v;
    if (typeof v === "string") {
      if (v.length > 4096) return fail();
      return v;
    }
    if (!v || typeof v !== "object") return fail();
    const ds = Object.getOwnPropertyDescriptors(v),
      keys = Reflect.ownKeys(v);
    if (Array.isArray(v)) {
      if (
        Object.getPrototypeOf(v) !== Array.prototype ||
        v.length > 256 ||
        keys.length !== v.length + 1
      )
        return fail();
      return Array.from({ length: v.length }, (_, i) => {
        const d = ds[String(i)];
        if (!d?.enumerable || !("value" in d)) return fail();
        return copy(d.value, depth + 1);
      });
    }
    if (Object.getPrototypeOf(v) !== Object.prototype || keys.length > 32) return fail();
    return Object.fromEntries(
      keys.map((k) => {
        if (typeof k !== "string") return fail();
        const d = ds[k];
        if (!d?.enumerable || !("value" in d)) return fail();
        return [k, copy(d.value, depth + 1)];
      }),
    );
  }
  return copy(value, 0);
}
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const v = data(value) as Record<string, unknown>;
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.keys(v).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(v, k))
  )
    return fail();
  return v;
}
/** A current decision is an observation, never a durable grant. New-work consumers
 * must stay inside this callback; all configured ports hold their source/authority
 * fences through it and COMMIT. No request carries identities, evidence or an allow. */
function createCurrentCapabilityService<
  S extends string | null,
  C extends TenantContext | BrandAdministrationContext,
>(
  ports: CurrentCapabilityPorts<S, C>,
  scope: { readonly brandReference: string; readonly storeReference: S },
  purposeCode:
    "STORE_CAPABILITY_EVALUATION" | "BRAND_CAPABILITY_EVALUATION" | "BRAND_ADMINISTRATION",
  parseContext: (value: C) => C,
  fixedBinding?: { readonly capabilityKey: string; readonly controlKey: string },
) {
  const brandReference = parseBrandReference(scope.brandReference),
    storeReference = scope.storeReference;
  return Object.freeze({
    async withCurrentCapability<T>(
      value: unknown,
      work: (decision: CapabilityDecision<S>) => Promise<T>,
    ): Promise<T> {
      try {
        const capabilityKey = parseStoreCapabilityKey(value),
          startedAt = parseFeatureControlInstant(ports.clock.now());
        if (fixedBinding && capabilityKey !== fixedBinding.capabilityKey) return fail();
        const input = Object.freeze({
          brandReference,
          storeReference,
          capabilityKey,
          observedAt: startedAt,
        });
        let authorityCalls = 0,
          bindingCalls = 0,
          sourceCalls = 0,
          evidenceCalls = 0;
        let completed: { value: T } | undefined;
        const output = await ports.authority.withCurrentScope(input, async (rawContext) => {
          if (++authorityCalls !== 1) return fail();
          const context = parseContext(rawContext);
          if (
            context.brand.brandReference !== brandReference ||
            (context.store?.storeReference ?? null) !== storeReference ||
            context.resolvedAt !== startedAt ||
            context.actor.actorReference === null
          )
            return fail();
          return ports.bindings.withCurrentBinding(input, async (rawBinding) => {
            if (++bindingCalls !== 1) return fail();
            const b = exact(rawBinding, [
              "capabilityKey",
              "controlKey",
              "mappingReference",
              "mappingVersion",
              "phase",
              "commitment",
            ]);
            if (
              parseStoreCapabilityKey(b.capabilityKey) !== capabilityKey ||
              b.commitment !== "Committed" ||
              !["phase_0", "phase_0_plus", "phase_1", "phase_1a", "phase_2", "phase_3"].includes(
                String(b.phase),
              )
            )
              return fail();
            parseFeatureControlReference(b.mappingReference);
            parseFeatureControlVersion(b.mappingVersion);
            const controlKey = parseFeatureControlKey(b.controlKey);
            if (fixedBinding && controlKey !== fixedBinding.controlKey) return fail();
            return ports.definitions.withCurrentDefinitions(
              {
                actorReference: parseFeatureControlReference(context.actor.actorReference),
                purposeCode,
                key: controlKey,
                observedAt: startedAt,
              },
              async (rawSource) => {
                if (++sourceCalls !== 1) return fail();
                const source = exact(rawSource, [
                  "brandReference",
                  "storeReference",
                  "key",
                  "observedAt",
                  "dependencyCoverage",
                  "definitions",
                ]);
                if (
                  source.brandReference !== brandReference ||
                  source.storeReference !== storeReference ||
                  source.key !== controlKey ||
                  source.observedAt !== startedAt ||
                  source.dependencyCoverage !== "Complete" ||
                  !Array.isArray(source.definitions)
                )
                  return fail();
                const latest = new Map<string, FeatureControlAdministrationDefinition>();
                for (const raw of source.definitions) {
                  const d = createFeatureControlAdministrationDefinition(raw);
                  if (
                    d.key !== controlKey ||
                    d.scope.brandReference !== brandReference ||
                    (d.scope.storeReference !== null &&
                      String(d.scope.storeReference) !== String(storeReference))
                  )
                    return fail();
                  const old = latest.get(d.controlId);
                  if (old?.version === d.version) return fail();
                  if (!old || d.version > old.version) latest.set(d.controlId, d);
                }
                const current = [...latest.values()].filter(
                  (d) =>
                    (d.lifecycle === "Published" || d.lifecycle === "Disabled") &&
                    d.effectiveFrom <= startedAt,
                );
                const store = current.filter((d) => d.scope.kind === "Store"),
                  brand = current.filter((d) => d.scope.kind === "Brand");
                const eligible = store.length > 0 ? store : brand;
                const chosen = eligible.length === 1 ? eligible[0] : undefined;
                const finish = async (
                  reason: CapabilityDecision<S>["reason"],
                ): Promise<{ value: T }> => {
                  const before = parseFeatureControlInstant(ports.clock.now());
                  if (before < startedAt || Date.parse(before) - Date.parse(startedAt) > 5000)
                    return fail();
                  if (
                    reason !== "Unavailable" &&
                    chosen &&
                    ((chosen.effectiveUntil !== null && before >= chosen.effectiveUntil) ||
                      (chosen.expiresAt !== null && before >= chosen.expiresAt))
                  )
                    return fail();
                  const allowed = reason === "Enabled";
                  const decision = Object.freeze({
                    capabilityKey,
                    controlKey,
                    brandReference,
                    storeReference,
                    backendExecution: allowed ? ("Allow" as const) : ("Deny" as const),
                    frontendVisibility: allowed ? ("Show" as const) : ("Hide" as const),
                    reason,
                    source:
                      chosen?.source === "StoreOverride"
                        ? ("StoreOverride" as const)
                        : chosen
                          ? ("BrandOverride" as const)
                          : null,
                    controlReference: chosen?.controlId ?? null,
                    controlVersion: chosen?.version ?? null,
                    observedAt: startedAt,
                  });
                  const result = await work(decision);
                  const after = parseFeatureControlInstant(ports.clock.now());
                  if (
                    after < before ||
                    Date.parse(after) - Date.parse(startedAt) > 5000 ||
                    (reason !== "Unavailable" &&
                      chosen &&
                      ((chosen.effectiveUntil !== null && after >= chosen.effectiveUntil) ||
                        (chosen.expiresAt !== null && after >= chosen.expiresAt)))
                  )
                    return fail();
                  completed = Object.freeze({ value: result });
                  return completed;
                };
                if (!chosen) return finish("Unavailable");
                if (
                  (chosen.effectiveUntil !== null && startedAt >= chosen.effectiveUntil) ||
                  (chosen.expiresAt !== null && startedAt >= chosen.expiresAt)
                )
                  return finish("Unavailable");
                if (chosen.lifecycle === "Disabled" || chosen.configuredValue === "Disabled")
                  return finish("Disabled");
                if (
                  chosen.dependencies.some(
                    (d) =>
                      d.status !== "Satisfied" ||
                      d.evidenceVersion === null ||
                      d.evidenceVersion < d.minimumCompatibleVersion,
                  )
                )
                  return finish("Unavailable");
                if (chosen.dependencies.length === 0) return finish("Enabled");
                return ports.dependencies.withCurrentEvidence(
                  {
                    brandReference,
                    storeReference,
                    dependencies: chosen.dependencies,
                    observedAt: startedAt,
                  },
                  async (rawEvidence) => {
                    if (++evidenceCalls !== 1) return fail();
                    const evidence = data(rawEvidence);
                    if (!Array.isArray(evidence) || evidence.length !== chosen.dependencies.length)
                      return fail();
                    const seen = new Set<string>();
                    let validUntil: string | null = null;
                    for (const raw of evidence) {
                      const e = exact(raw, [
                        "dependencyId",
                        "targetKey",
                        "kind",
                        "evidenceReference",
                        "evidenceVersion",
                        "outcome",
                        "observedAt",
                        "validUntil",
                      ]);
                      const dep = chosen.dependencies.find(
                        (d) => d.dependencyId === e.dependencyId,
                      );
                      if (!dep || seen.has(dep.dependencyId)) return fail();
                      seen.add(dep.dependencyId);
                      const until = parseFeatureControlInstant(e.validUntil);
                      if (
                        e.kind !== dep.kind ||
                        e.targetKey !== dep.targetKey ||
                        e.evidenceReference !== dep.evidenceReference ||
                        parseFeatureControlVersion(e.evidenceVersion) !== dep.evidenceVersion ||
                        e.observedAt !== startedAt ||
                        until <= startedAt ||
                        e.outcome !==
                          (dep.kind === "RequiresCapability"
                            ? "Enabled"
                            : dep.kind === "ConflictsWithCapability"
                              ? "Disabled"
                              : "Accepted")
                      )
                        return fail();
                      if (validUntil === null || String(until) < String(validUntil))
                        validUntil = String(until);
                    }
                    const r = await finish("Enabled");
                    if (
                      validUntil !== null &&
                      parseFeatureControlInstant(ports.clock.now()) >= validUntil
                    )
                      return fail();
                    return r;
                  },
                );
              },
            );
          });
        });
        if (
          authorityCalls !== 1 ||
          bindingCalls !== 1 ||
          sourceCalls !== 1 ||
          !completed ||
          output !== completed
        )
          return fail();
        return completed.value;
      } catch {
        return fail();
      }
    },
  });
}

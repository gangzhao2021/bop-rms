import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { parsePublishingProductPublicationPolicy } from "@bop/publishing";
import {
  CatalogError,
  bindCatalogProductPublicationQualificationContext,
  bindCatalogProductWarningAcknowledgementQualificationContext,
  bindCatalogProductPublicationValidationContextV2,
  buildCatalogProductPublicationReferenceRequestV2,
  buildCatalogProductWarningAcknowledgementReferenceRequest,
  copyCategoryPersistenceValue,
  deriveCatalogProductPublicationContentIdentity,
  parseCatalogInstant,
  parseCatalogReference,
  parseCatalogProductPublicationValidationDetails,
  parseCatalogProductPublicationValidationReport,
  parseCatalogProductPublicationReferenceRequestV2,
  parseCatalogProductWarningAcknowledgementReferenceRequest,
  buildCatalogProductPublicationBusinessRules,
  parseCatalogProductPublicationBusinessRules,
  classifyCatalogProductPublicationBusinessRules,
  type catalogProductPublicationBusinessDomains,
  catalogProductPublicationBusinessSourceCode,
  catalogProductPublicationReferenceSourceCodes,
  type CatalogProductPublicationBusinessRules,
  type CatalogProductPublicationReferenceRequirement,
  type CatalogProductQualificationContext,
} from "@rms/catalog";
import type {
  MerchantProductPublicationBusinessAssessment,
  MerchantProductPublicationSourcesConfiguration,
} from "./merchant-product-publication-sources.js";

type Policy = MerchantProductPublicationSourcesConfiguration["businessPolicy"];
type Input = Parameters<Policy["withAssessment"]>[1];
type Transaction = Parameters<Policy["withAssessment"]>[0];
type Domain = (typeof catalogProductPublicationBusinessDomains)[number];
export type MerchantProductPublicationReferenceRequirement =
  CatalogProductPublicationReferenceRequirement;
interface BusinessConfigurationFields {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly policyReference: string;
  readonly policyVersion: number;
  readonly configurationReference: string;
  readonly configurationRevision: number;
  readonly observedAt: string;
  readonly validUntil: string;
}
export type MerchantProductPublicationBusinessConfiguration = BusinessConfigurationFields &
  CatalogProductPublicationBusinessRules;
export interface MerchantProductPublicationBusinessPolicyOptions {
  readonly clock: { now(): string };
  readonly configurations: {
    /** The owning configuration holder must register its current identity and
     * authority guards and retain them through the actual enclosing COMMIT. */
    withCurrentConfiguration<T>(
      transaction: Transaction,
      input: Pick<Input, "context" | "policy" | "registerBeforeCommit">,
      work: (
        configuration: MerchantProductPublicationBusinessConfiguration,
        actualTx: Transaction,
      ) => Promise<T>,
    ): Promise<T>;
  };
}
const sourceCode = catalogProductPublicationBusinessSourceCode;
const sourceCodes = catalogProductPublicationReferenceSourceCodes;
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const equal = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);
const unavailable = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
function field(value: unknown, key: string): unknown {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) return unavailable();
  const d = Object.getOwnPropertyDescriptor(value, key);
  if (!d?.enumerable || !("value" in d)) return unavailable();
  return d.value;
}
function closed(value: unknown, keys: readonly string[]) {
  if (
    !value ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length
  )
    return unavailable();
  return Object.fromEntries(keys.map((key) => [key, field(value, key)]));
}
function list(value: unknown, maximum = 10000): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return unavailable();
  return Array.from({ length: value.length }, (_, i) => {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d?.enumerable || !("value" in d)) return unavailable();
    return d.value;
  });
}
const rows = (value: unknown, key: string, maximum = 10000) => list(field(value, key), maximum);
const ref = (value: unknown, key: string) => parseCatalogReference(field(value, key));
function captureContext(value: unknown): CatalogProductQualificationContext {
  const r = closed(value, [
    "kind",
    "command",
    "aggregate",
    "current",
    "report",
    "tenantReference",
    "brandReference",
    "actorReference",
    "actorKind",
    "productReference",
    "versionReference",
    "aggregateVersion",
    "contentDigest",
    "configurationDigest",
    "scopeSet",
    "scopeDigest",
    "effectivePeriod",
    "periodDigest",
    "replacementIntent",
    "replacementIntentDigest",
    "recordedPolicy",
    "originalIntentDigest",
    "aggregateSnapshotDigest",
    "currentPublicationDigest",
    "observedAt",
    "validUntil",
  ]);
  const safe = Object.fromEntries(
    Object.entries(r).map(([key, v]) => [
      key,
      key === "report" && v !== null
        ? parseCatalogProductPublicationValidationReport(v)
        : copyCategoryPersistenceValue(v),
    ]),
  );
  const bound =
    safe.kind === "Publication"
      ? bindCatalogProductPublicationQualificationContext(
          {
            command: safe.command,
            aggregate: safe.aggregate,
            current: safe.current,
            content: null,
            observedAt: safe.observedAt,
          } as Parameters<typeof bindCatalogProductPublicationQualificationContext>[0],
          safe.validUntil as string,
        )
      : safe.kind === "WarningAcknowledgement"
        ? bindCatalogProductWarningAcknowledgementQualificationContext({
            command: safe.command,
            aggregate: safe.aggregate,
            current: safe.current,
            report: safe.report,
            observedAt: safe.observedAt,
            validUntil: safe.validUntil,
          } as Parameters<typeof bindCatalogProductWarningAcknowledgementQualificationContext>[0])
        : unavailable();
  if (!equal(bound, safe)) return unavailable();
  return bound;
}
function configuration(
  value: unknown,
  context: CatalogProductQualificationContext,
  policy: Input["policy"],
): MerchantProductPublicationBusinessConfiguration {
  const relative =
    value !== null && typeof value === "object" && Object.hasOwn(value, "backdateAnchor");
  const r = closed(value, [
    "tenantReference",
    "brandReference",
    "policyReference",
    "policyVersion",
    "configurationReference",
    "configurationRevision",
    "matchingBasis",
    ...(relative
      ? ["backdateAnchor", "backdateMaximumMilliseconds"]
      : ["earliestPermittedEffectiveFrom"]),
    "requirements",
    "observedAt",
    "validUntil",
  ]);
  if (
    !Number.isSafeInteger(r.configurationRevision) ||
    Number(r.configurationRevision) < 1 ||
    r.tenantReference !== context.tenantReference ||
    r.brandReference !== context.brandReference ||
    r.policyReference !== policy.content.policyReference ||
    r.policyVersion !== policy.content.policyVersion
  )
    return unavailable();
  const active = context.aggregate.draft.skus
    .filter((s) => s.lifecycle === "Active")
    .map((s) => s.skuReference)
    .sort();
  const rules = parseCatalogProductPublicationBusinessRules(
    {
      matchingBasis: r.matchingBasis,
      requirements: r.requirements,
      ...(relative
        ? {
            backdateAnchor: r.backdateAnchor,
            backdateMaximumMilliseconds: r.backdateMaximumMilliseconds,
          }
        : { earliestPermittedEffectiveFrom: r.earliestPermittedEffectiveFrom }),
    },
    active,
  );
  const observedAt = parseCatalogInstant(r.observedAt),
    validUntil = parseCatalogInstant(r.validUntil);
  if (
    observedAt < context.observedAt ||
    validUntil <= observedAt ||
    validUntil > context.validUntil
  )
    return unavailable();
  return Object.freeze({
    tenantReference: context.tenantReference,
    brandReference: context.brandReference,
    policyReference: policy.content.policyReference,
    policyVersion: policy.content.policyVersion,
    configurationReference: parseCatalogReference(r.configurationReference),
    configurationRevision: Number(r.configurationRevision),
    ...rules,
    observedAt,
    validUntil,
  });
}

/** Owner-selected ordinary rules. Building this configuration supplies no
 * authority: the current configuration holder must still retain it to COMMIT. */
export function buildMerchantProductPublicationBusinessConfiguration(
  input: Pick<Input, "context" | "policy"> & {
    readonly configurationReference: string;
    readonly configurationRevision: number;
  },
): MerchantProductPublicationBusinessConfiguration {
  try {
    const r = closed(input, [
        "context",
        "policy",
        "configurationReference",
        "configurationRevision",
      ]),
      context = captureContext(r.context);
    const p = closed(copyCategoryPersistenceValue(r.policy), [
      "content",
      "currentPublicationReference",
      "observedAt",
      "validUntil",
    ]);
    const policy = {
      content: parsePublishingProductPublicationPolicy(p.content),
      currentPublicationReference: parseCatalogReference(p.currentPublicationReference),
      observedAt: parseCatalogInstant(p.observedAt),
      validUntil: parseCatalogInstant(p.validUntil),
    };
    return configuration(
      {
        tenantReference: context.tenantReference,
        brandReference: context.brandReference,
        policyReference: policy.content.policyReference,
        policyVersion: policy.content.policyVersion,
        configurationReference: r.configurationReference,
        configurationRevision: r.configurationRevision,
        ...buildCatalogProductPublicationBusinessRules(
          context.aggregate.draft.skus
            .filter((s) => s.lifecycle === "Active")
            .map((s) => s.skuReference),
        ),
        observedAt: context.observedAt,
        validUntil: context.validUntil,
      },
      context,
      policy,
    );
  } catch {
    return unavailable();
  }
}

/** Project only the fixed fields consumed below, synchronously before awaits.
 * The composite's owning sources establish provenance/authority; this does not
 * manufacture a new parsed-source or current sale eligibility claim. */
function references(value: unknown, context: CatalogProductQualificationContext) {
  const isPublication = context.kind === "Publication";
  if (
    field(value, "profile") !==
    (isPublication
      ? "MerchantProductPublicationImpactReferencesV2"
      : "MerchantProductWarningAcknowledgementImpactReferencesV1")
  )
    return unavailable();
  const request = isPublication
    ? parseCatalogProductPublicationReferenceRequestV2(field(value, "request"))
    : parseCatalogProductWarningAcknowledgementReferenceRequest(field(value, "request"));
  const expected = isPublication
    ? buildCatalogProductPublicationReferenceRequestV2(
        bindCatalogProductPublicationValidationContextV2({
          command: context.command,
          aggregate: context.aggregate,
          current: context.current,
          content: null,
          observedAt: context.observedAt,
        }),
        context.validUntil,
      )
    : buildCatalogProductWarningAcknowledgementReferenceRequest({
        command: context.command,
        aggregate: context.aggregate,
        current: context.current,
        report: context.report,
        observedAt: context.observedAt,
        validUntil: context.validUntil,
      });
  if (!equal(request, expected)) return unavailable();
  const observedAt = parseCatalogInstant(field(value, "observedAt")),
    validUntil = parseCatalogInstant(field(value, "validUntil"));
  if (
    observedAt < context.observedAt ||
    validUntil > context.validUntil ||
    validUntil <= observedAt
  )
    return unavailable();
  const evidence = parseCatalogProductPublicationValidationDetails({
    coverage: "Complete",
    impact: "Recorded",
    findings: [],
    sources: field(value, "referenceEvidence"),
  });
  if (
    evidence.coverage !== "Complete" ||
    evidence.sources.length !== 8 ||
    new Set(evidence.sources.map((s) => s.sourceCode)).size !== 8 ||
    [
      "PRODUCT_RECORDED_REFERENCE_CONFIGURATIONS",
      "BUNDLE_PRODUCT_REFERENCES",
      "AVAILABILITY_PRODUCT_REFERENCES",
      "RECIPE_INVENTORY_PRODUCT_REFERENCES",
      ...Object.values(sourceCodes),
    ].some((code) => !evidence.sources.some((s) => s.sourceCode === code)) ||
    evidence.sources.some(
      (s) => s.observedAt < context.observedAt || s.validUntil > context.validUntil,
    )
  )
    return unavailable();
  const current = field(value, "current"),
    graph = deriveCatalogProductPublicationContentIdentity(
      context.aggregate,
    ).referenceConfiguration;
  if (
    field(current, "referenceConfigurationDigest") !== hash(graph) ||
    !equal(copyCategoryPersistenceValue(field(current, "referenceConfiguration")), graph)
  )
    return unavailable();
  const configurations = [current, ...rows(value, "recorded", 1000)];
  const knownBindings = new Set<string>(),
    resolvedRecipe = new Set<string>(),
    resolvedModifiers = new Set<string>(),
    resolvedMappings = new Set<string>(),
    resolvedPriceRoots = new Set<string>(),
    resolvedPriceVersions = new Set<string>(),
    relatedItems = new Set<string>(),
    priceRootBindings = new Map<string, string>();
  const pendingRecipe: string[] = [],
    pendingModifiers: string[] = [],
    pendingMappings: string[] = [],
    pendingPriceRoots: { binding: string; id: string }[] = [],
    pendingPriceVersions: { binding: string; id: string }[] = [],
    unknownItems: string[] = [];
  const presence: Record<Domain, Set<string>> = {
    Pricing: new Set(),
    Recipe: new Set(),
    Inventory: new Set(),
    Menu: new Set(),
  };
  if (rows(value, "unresolvedMenuReferences").length !== 0) return unavailable();
  for (const item of configurations) {
    const isCurrent = item === current;
    for (const binding of rows(field(item, "referenceConfiguration"), "bindings", 1000))
      knownBindings.add(ref(binding, "bindingReference"));
    const recipe = field(item, "recipe");
    for (const group of rows(recipe, "references")) {
      for (const binding of rows(group, "bindings")) {
        resolvedRecipe.add(ref(binding, "bindingReference"));
        // A modifier/Option-specific recipe cannot stand in for a base binding.
        if (
          isCurrent &&
          field(binding, "optionBindingReference") === null &&
          field(group, "isCurrentRecipeVersion") === true &&
          !["Archived", "Invalidated"].includes(String(field(field(group, "version"), "lifecycle")))
        )
          presence.Recipe.add(ref(binding, "skuReference"));
      }
      for (const modifier of rows(group, "modifiers"))
        resolvedModifiers.add(ref(field(modifier, "reference"), "ruleVersionReference"));
    }
    for (const group of rows(recipe, "unresolved")) {
      for (const binding of rows(group, "bindings"))
        pendingRecipe.push(ref(field(binding, "reference"), "bindingReference"));
      for (const modifier of rows(group, "modifiers"))
        pendingModifiers.push(ref(field(modifier, "reference"), "ruleVersionReference"));
    }
    const inventory = field(item, "inventory");
    for (const row of rows(inventory, "references")) {
      const mapping = field(row, "mapping"),
        target = field(mapping, "target"),
        identity = ref(mapping, "operationReference"),
        itemReference = ref(mapping, "itemReference");
      relatedItems.add(itemReference);
      if (
        field(mapping, "action") !== "Set" ||
        ref(target, "productReference") !== context.productReference
      )
        return unavailable();
      if (field(row, "configurationMatch") === "Matched") {
        resolvedMappings.add(identity);
        if (isCurrent && field(mapping, "current") === true)
          presence.Inventory.add(ref(target, "skuReference"));
      } else if (field(row, "configurationMatch") === "Unresolved") pendingMappings.push(identity);
      else return unavailable();
    }
    for (const row of rows(inventory, "unresolvedItemCoverage"))
      unknownItems.push(ref(row, "itemReference"));
    const recipeInventory = field(item, "recipeInventory");
    for (const row of rows(recipeInventory, "inventoryReferences")) {
      const requirement = field(row, "requirement"),
        reference = field(requirement, "reference");
      relatedItems.add(ref(reference, "sourceReference"));
      if (field(field(row, "resolution"), "state") !== "ResolvedStoredConfiguration")
        return unavailable();
    }
    const pricing = isCurrent ? field(item, "pricing") : field(field(item, "pricing"), "matches");
    if (pricing === null) return unavailable();
    for (const row of rows(pricing, "priceEntries")) {
      const sellable = ref(row, "sellableReference");
      if (isCurrent) {
        if (sellable !== context.productReference && !graph.skuReferences.includes(sellable))
          return unavailable();
        if (
          graph.skuReferences.includes(sellable) &&
          field(row, "isCurrentVersion") === true &&
          field(row, "currentVersionReference") === field(row, "versionReference") &&
          field(row, "lifecycle") !== "Archived"
        )
          presence.Pricing.add(sellable);
      }
    }
    for (const row of rows(pricing, "optionRoots")) {
      const id = ref(row, "ruleReference");
      resolvedPriceRoots.add(id);
      priceRootBindings.set(id, ref(row, "bindingReference"));
    }
    for (const row of rows(pricing, "optionVersions"))
      resolvedPriceVersions.add(ref(field(row, "reference"), "versionReference"));
    for (const row of rows(pricing, "unresolvedOptionRoots")) {
      const reference = field(row, "reference");
      priceRootBindings.set(ref(reference, "ruleReference"), ref(reference, "bindingReference"));
      pendingPriceRoots.push({
        binding: ref(reference, "bindingReference"),
        id: ref(reference, "ruleReference"),
      });
    }
    for (const row of rows(pricing, "unresolvedOptionVersions")) {
      const reference = field(row, "reference");
      pendingPriceVersions.push({
        binding: priceRootBindings.get(ref(reference, "ruleReference")) ?? unavailable(),
        id: ref(reference, "versionReference"),
      });
    }
    if (isCurrent)
      for (const menu of rows(item, "menuReferences"))
        for (const placement of rows(menu, "placements")) {
          if (ref(placement, "productVersionReference") !== context.versionReference)
            return unavailable();
          const sku = ref(placement, "skuReference");
          if (!graph.skuReferences.includes(sku)) return unavailable();
          const lifecycle = field(menu, "lifecycle");
          if (
            lifecycle === null ||
            !["Archived", "Superseded"].includes(String(field(lifecycle, "state")))
          )
            presence.Menu.add(sku);
        }
  }
  if (
    pendingRecipe.some((id) => !resolvedRecipe.has(id)) ||
    pendingModifiers.some((id) => !resolvedModifiers.has(id)) ||
    pendingMappings.some((id) => !resolvedMappings.has(id)) ||
    pendingPriceRoots.some(
      (row) => knownBindings.has(row.binding) && !resolvedPriceRoots.has(row.id),
    ) ||
    pendingPriceVersions.some(
      (row) => knownBindings.has(row.binding) && !resolvedPriceVersions.has(row.id),
    ) ||
    unknownItems.some((id) => relatedItems.has(id))
  )
    return unavailable();
  return { presence, evidence: evidence.sources, observedAt, validUntil };
}

/** A fixed stored-reference classifier. It consumes actual held source graphs;
 * it does not resolve prices, stock, sales or effective release coverage. */
export function createMerchantProductPublicationBusinessPolicy(
  options: MerchantProductPublicationBusinessPolicyOptions,
): Policy {
  if (
    typeof options.clock?.now !== "function" ||
    typeof options.configurations?.withCurrentConfiguration !== "function"
  )
    return unavailable();
  const now = options.clock.now.bind(options.clock),
    hold = options.configurations.withCurrentConfiguration.bind(options.configurations);
  const transactions = new WeakMap<Transaction, { failed: boolean }>();
  return Object.freeze({
    async withAssessment<T>(
      tx: Transaction,
      input: Input,
      work: (assessment: MerchantProductPublicationBusinessAssessment) => Promise<T>,
    ): Promise<T> {
      const old = transactions.get(tx);
      if (old) {
        old.failed = true;
        return unavailable();
      }
      const state = { failed: false };
      transactions.set(tx, state);
      const fail = (): never => {
        state.failed = true;
        return unavailable();
      };
      const query = tx.query;
      let context: CatalogProductQualificationContext | undefined,
        policy: Input["policy"] | undefined,
        captured: ReturnType<typeof references> | undefined,
        register: Input["registerBeforeCommit"] | undefined,
        deadline: string | undefined,
        latest: string | undefined,
        ready = false,
        active = true,
        committing = false,
        guardComplete = false,
        guardCalls = 0,
        finalCalls = 0,
        consumerError: unknown;
      const children: { guard: () => Promise<void>; finalAssert: () => void }[] = [];
      const check = () => {
        try {
          const at = parseCatalogInstant(now());
          if (
            state.failed ||
            tx.query !== query ||
            !deadline ||
            !latest ||
            at < latest ||
            at >= deadline
          )
            return fail();
          latest = at;
          return at;
        } catch {
          return fail();
        }
      };
      try {
        if (
          typeof field(input, "registerBeforeCommit") !== "function" ||
          typeof query !== "function"
        )
          return fail();
        register = input.registerBeforeCommit.bind(input);
        // Capture original data/clock before the first awaited host registration.
        try {
          const raw = closed(input, ["context", "policy", "references", "registerBeforeCommit"]);
          context = captureContext(raw.context);
          const p = closed(copyCategoryPersistenceValue(raw.policy), [
            "content",
            "currentPublicationReference",
            "observedAt",
            "validUntil",
          ]);
          policy = Object.freeze({
            content: parsePublishingProductPublicationPolicy(p.content),
            currentPublicationReference: parseCatalogReference(p.currentPublicationReference),
            observedAt: parseCatalogInstant(p.observedAt),
            validUntil: parseCatalogInstant(p.validUntil),
          });
          if (
            policy.content.tenantReference !== context.tenantReference ||
            policy.content.brandReference !== context.brandReference ||
            policy.observedAt !== context.observedAt ||
            policy.validUntil <= policy.observedAt ||
            ((context.kind !== "Publication" || context.command.action !== "Validate") &&
              (!context.recordedPolicy ||
                context.recordedPolicy.policyReference !== policy.content.policyReference ||
                context.recordedPolicy.policyVersion !== policy.content.policyVersion))
          )
            return fail();
          captured = references(raw.references, context);
          latest = context.observedAt;
          deadline = [
            context.validUntil,
            policy.validUntil,
            captured.validUntil,
            ...captured.evidence.map((s) => s.validUntil),
          ].sort()[0];
          if (
            captured.observedAt > check() ||
            captured.evidence.some((s) => s.observedAt > check())
          )
            return fail();
        } catch {
          state.failed = true;
        }
        if (
          (await register(
            tx,
            async () => {
              try {
                if (++guardCalls !== 1 || !ready || active || !children.length) return fail();
                committing = true;
                check();
                for (const child of children) {
                  if ((await child.guard()) !== undefined) return fail();
                  check();
                }
                guardComplete = true;
              } catch (error) {
                state.failed = true;
                throw error;
              }
            },
            () => {
              try {
                if (++finalCalls !== 1 || !guardComplete || !ready || active) return fail();
                check();
                for (const child of children) {
                  if (child.finalAssert() !== undefined) return fail();
                  check();
                }
              } catch (error) {
                state.failed = true;
                throw error;
              }
            },
          )) !== undefined
        )
          return fail();
        if (!context || !policy || !captured || state.failed || typeof work !== "function")
          return fail();
        const c = context,
          p = policy,
          r = captured;
        const childRegister: Input["registerBeforeCommit"] = async (actual, guard, finalAssert) => {
          check();
          if (
            actual !== tx ||
            !active ||
            committing ||
            typeof guard !== "function" ||
            typeof finalAssert !== "function" ||
            children.length >= 64 ||
            children.some((child) => child.guard === guard || child.finalAssert === finalAssert)
          )
            return fail();
          children.push({ guard, finalAssert });
        };
        let calls = 0,
          completed: { value: T } | undefined;
        const result = await hold(
          tx,
          Object.freeze({ context: c, policy: p, registerBeforeCommit: childRegister }),
          async (rawConfiguration, actual) => {
            try {
              if (++calls !== 1 || actual !== tx || !active || committing || children.length === 0)
                return fail();
              const config = configuration(rawConfiguration, c, p);
              if (config.observedAt > check()) return fail();
              deadline = [deadline ?? fail(), config.validUntil].sort()[0];
              check();
              const { observedAt, validUntil, configurationRevision, ...semantic } = config;
              void observedAt;
              void validUntil;
              const semanticDigest = hash(semantic),
                activeSkuReferences = c.aggregate.draft.skus
                  .filter((s) => s.lifecycle === "Active")
                  .map((s) => s.skuReference);
              const present = (domain: Domain) =>
                [...r.presence[domain]].filter((sku) =>
                  activeSkuReferences.some((value) => value === sku),
                );
              const referenceDigest = (domain: Domain) =>
                (r.evidence.find((s) => s.sourceCode === sourceCodes[domain]) ?? fail())
                  .relevantReferenceDigest;
              const classified = classifyCatalogProductPublicationBusinessRules({
                activeSkuReferences,
                presentReferences: {
                  Pricing: present("Pricing"),
                  Recipe: present("Recipe"),
                  Inventory: present("Inventory"),
                  Menu: present("Menu"),
                },
                rules: {
                  matchingBasis: config.matchingBasis,
                  requirements: config.requirements,
                  ...("earliestPermittedEffectiveFrom" in config
                    ? { earliestPermittedEffectiveFrom: config.earliestPermittedEffectiveFrom }
                    : {
                        backdateAnchor: config.backdateAnchor,
                        backdateMaximumMilliseconds: config.backdateMaximumMilliseconds,
                      }),
                },
                observedAt: c.observedAt,
                effectiveFrom: c.effectivePeriod.effectiveFrom.instant,
                productReference: c.productReference,
                versionReference: c.versionReference,
                configurationReference: config.configurationReference,
                ruleDigest: semanticDigest,
                referenceDigests: {
                  Pricing: referenceDigest("Pricing"),
                  Recipe: referenceDigest("Recipe"),
                  Inventory: referenceDigest("Inventory"),
                  Menu: referenceDigest("Menu"),
                },
              });
              const assessment: MerchantProductPublicationBusinessAssessment = Object.freeze({
                originalIntentDigest: c.originalIntentDigest,
                aggregateSnapshotDigest: c.aggregateSnapshotDigest,
                policyReference: p.content.policyReference,
                policyVersion: p.content.policyVersion,
                ...classified,
                sources: Object.freeze([
                  {
                    sourceCode,
                    sourceDigest: hash(config),
                    generation: String(configurationRevision),
                    relevantReferenceDigest: semanticDigest,
                    observedAt: config.observedAt,
                    validUntil: deadline ?? fail(),
                  },
                ]),
                observedAt: config.observedAt,
                validUntil: deadline ?? fail(),
              });
              let value: T;
              try {
                value = await work(assessment);
              } catch (error) {
                consumerError = error;
                throw error;
              }
              check();
              completed = { value };
              return value;
            } catch (error) {
              state.failed = true;
              throw error;
            }
          },
        );
        if (calls !== 1 || !completed || !Object.is(result, completed.value) || !children.length)
          return fail();
        check();
        active = false;
        ready = true;
        return completed.value;
      } catch (error) {
        state.failed = true;
        if (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED")
          throw error;
        if (consumerError instanceof CatalogError) throw consumerError;
        return unavailable();
      }
    },
  });
}

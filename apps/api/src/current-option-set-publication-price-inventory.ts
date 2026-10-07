import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import {
  CatalogError,
  copyCategoryPersistenceValue,
  evaluateCatalogOptionSetRuleSatisfiability,
  parseCatalogInstant,
  parseCatalogReference,
  parseCatalogOptionSetContentPolicyBinding,
  parseCatalogOptionSetEditorContent,
} from "@rms/catalog";
import {
  createPostgresConfigurationReferenceSourceStore,
  configurationReferenceSourceFields,
  priceBookReferenceSourceFields,
  optionPriceReferenceSourceFields,
  promotionReferenceSourceFields,
  parsePriceBookReferenceSourceRequest,
  matchOptionDraftPriceReferenceMetadata,
} from "@rms/pricing";
import {
  createPostgresInventoryConfigurationReferenceSourceStore,
  createPostgresInventoryOptionConsumptionUnitSource,
  inventoryConfigurationReferenceFields,
  inventoryConfigurationReferencePermissions,
  inventoryOptionConsumptionUnitFields,
  parseInventoryConfigurationReferenceRequest,
  matchOptionDraftInventoryConsumptionMetadata,
} from "@rms/inventory";
import { parseBusinessAction, parsePolicyReference, parsePolicyVersion } from "@bop/permission";
import type { CurrentPublishedOptionSetGraphOptions } from "./current-published-option-set-graph.js";
import type { createCurrentOptionSetPublicationDraftGraphSource } from "./current-option-set-publication-draft-graph.js";
import { MerchantProductWriteFeatureDisabled } from "./merchant-product-write-authority.js";

type Graph = Parameters<
  Parameters<
    ReturnType<typeof createCurrentOptionSetPublicationDraftGraphSource>["withCurrentGraph"]
  >[1]
>[0];
type Price = ReturnType<typeof matchOptionDraftPriceReferenceMetadata>;
type Inventory = ReturnType<typeof matchOptionDraftInventoryConsumptionMetadata>;
type Units = Parameters<
  Parameters<
    ReturnType<typeof createPostgresInventoryOptionConsumptionUnitSource>["withCurrentUnits"]
  >[3]
>[0];
export interface CurrentOptionSetPublicationPriceInventoryOptions extends CurrentPublishedOptionSetGraphOptions {
  /** Fixed server publication operation; never the Draft provenance operation. */
  readonly operationReference: string;
}
interface NodeEvidence {
  readonly optionSetReference: string;
  readonly versionReference: string;
  readonly price: Price | null;
  readonly inventory: Inventory | null;
  readonly inventoryUnits: Units | null;
  readonly priceCoverage: "NoReferences" | "AllRecordedPins";
  readonly inventoryCoverage: "NoReferences" | "AllRecordedPins";
  readonly inventoryUnitCoverage: "NoReferences" | "AllRecordedPins" | "BlockedByReferenceErrors";
}
export interface StandaloneOptionReferenceCheck {
  readonly code: string;
  readonly outcome: "Satisfied" | "HardError" | "Indeterminate";
  readonly optionSetReference: string;
  readonly optionReference: string | null;
  readonly reference: string | null;
  readonly reasonCode: string;
}
export interface StandaloneOptionReferenceAssessment {
  readonly phase: "OptionSetPublication";
  readonly decision: "Pass" | "HardError" | "Indeterminate";
  readonly checks: readonly StandaloneOptionReferenceCheck[];
  readonly productBinding: "NotApplicableForIndependentOptionSet";
  readonly skuMembership: "NotApplicableForIndependentOptionSet";
  readonly saleQuote: "NotApplicableForIndependentOptionSet";
  readonly inventoryBalance: "NotApplicableForIndependentOptionSet";
}
export interface CurrentOptionSetPublicationPriceInventory {
  readonly profile: "CurrentOptionSetPublicationPriceInventoryV1";
  readonly binding: ReturnType<typeof parseCatalogOptionSetContentPolicyBinding>;
  readonly operationReference: string;
  readonly nodes: readonly NodeEvidence[];
  readonly standaloneReferenceAssessment: StandaloneOptionReferenceAssessment;
  readonly graphDigest: string;
  readonly originalObservedAt: string;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly eligibility: "NotEvaluated";
  readonly publishValidation: "Incomplete";
  readonly sourceAuthority: "CurrentPricingInventoryMetadataAndUnits";
  readonly digest: string;
}
const equal = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);
/** Invoke inside the actual held Draft publication graph callback. Complete
 * per-node pins include inactive and unselected choices. Metadata and exact unit
 * arithmetic remain separate from conditional/scope publication eligibility. */
export function createCurrentOptionSetPublicationPriceInventorySource(
  options: CurrentOptionSetPublicationPriceInventoryOptions,
) {
  const tx = options.transaction,
    query = tx?.query,
    tenant = String(parseCatalogReference(options.tenantReference)),
    brand = String(parseCatalogReference(options.brandReference)),
    actor = String(parseCatalogReference(options.actorReference)),
    operation = String(parseCatalogReference(options.operationReference)),
    store = String(parseCatalogReference(options.storeReference)),
    session = String(parseCatalogReference(options.sessionReference));
  if (
    typeof query !== "function" ||
    typeof options.clock?.now !== "function" ||
    typeof options.currentAuthorization?.authorizeActions !== "function" ||
    typeof options.currentAuthorization?.authorizeActionsWithDecisions !== "function" ||
    typeof options.currentAuthorization?.assertCurrent !== "function" ||
    typeof options.currentAuthorization?.leaseDeadline !== "function" ||
    typeof options.capability?.holdUntilCommit !== "function" ||
    (options.capability.holdUntilCommitWithDecisions !== undefined &&
      typeof options.capability.holdUntilCommitWithDecisions !== "function") ||
    typeof options.capability?.leaseDeadline !== "function" ||
    typeof options.registerBeforeCommit !== "function"
  )
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  const clockPort = options.clock.now,
    clock = clockPort.bind(options.clock),
    authPort = options.currentAuthorization.authorizeActions,
    decisionsPort = options.currentAuthorization.authorizeActionsWithDecisions,
    authorize = decisionsPort.bind(options.currentAuthorization),
    assertPort = options.currentAuthorization.assertCurrent,
    assertCurrent = assertPort.bind(options.currentAuthorization),
    leasePort = options.currentAuthorization.leaseDeadline,
    lease = leasePort.bind(options.currentAuthorization),
    combinedPort = options.capability.holdUntilCommitWithDecisions,
    combined =
      typeof combinedPort === "function" ? combinedPort.bind(options.capability) : undefined,
    capPort = options.capability.holdUntilCommit,
    capability = capPort.bind(options.capability),
    capLeasePort = options.capability.leaseDeadline,
    capLease = capLeasePort.bind(options.capability),
    registerPort = options.registerBeforeCommit,
    register = registerPort.bind(options);
  const startedAt = parseCatalogInstant(clock()),
    originalDeadline = parseCatalogInstant(options.originalValidUntil);
  if (originalDeadline <= startedAt || Date.parse(originalDeadline) - Date.parse(startedAt) > 5000)
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  let deadline: string = originalDeadline,
    latest: string = startedAt,
    failed = false,
    entered = false,
    active = false,
    ready = false,
    guards = 0,
    guardComplete = false,
    finals = 0;
  const permissions = new Set<string>(["catalog.manage", "catalog.option_set.read"]);
  const fail = (): never => {
    failed = true;
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  };
  const reject = (error: unknown): never => {
    failed = true;
    if (error instanceof CatalogError || error instanceof MerchantProductWriteFeatureDisabled)
      throw error;
    return fail();
  };
  const check = () => {
    try {
      const at = parseCatalogInstant(clock());
      if (
        failed ||
        options.transaction !== tx ||
        tx.query !== query ||
        at < latest ||
        at >= deadline ||
        options.clock.now !== clockPort ||
        options.currentAuthorization.authorizeActions !== authPort ||
        options.currentAuthorization.authorizeActionsWithDecisions !== decisionsPort ||
        options.currentAuthorization.assertCurrent !== assertPort ||
        options.currentAuthorization.leaseDeadline !== leasePort ||
        options.capability.holdUntilCommit !== capPort ||
        options.capability.holdUntilCommitWithDecisions !== combinedPort ||
        options.capability.leaseDeadline !== capLeasePort ||
        options.registerBeforeCommit !== registerPort ||
        options.operationReference !== operation ||
        options.tenantReference !== tenant ||
        options.brandReference !== brand ||
        options.actorReference !== actor ||
        options.storeReference !== store ||
        options.sessionReference !== session ||
        options.originalValidUntil !== originalDeadline
      )
        return fail();
      assertCurrent();
      latest = at;
      return at;
    } catch (error) {
      return reject(error);
    }
  };
  const hold = async (selected: readonly string[]) => {
    check();
    for (const permission of selected) permissions.add(permission);
    const actions = Object.freeze(
      [...new Set(combined ? ["catalog.manage", ...selected] : selected)].sort(),
    );
    let decisions;
    if (combined) decisions = await combined(actions);
    else {
      if ((await capability()) !== undefined) return fail();
      check();
      decisions = await authorize(actions);
    }
    check();
    if (combined) {
      if (
        !Array.isArray(decisions) ||
        Object.getPrototypeOf(decisions) !== Array.prototype ||
        decisions.length !== actions.length
      )
        return fail();
      const descriptors = Object.getOwnPropertyDescriptors(decisions);
      if (
        Reflect.ownKeys(decisions).length !== actions.length + 1 ||
        actions.some((_, i) => {
          const d = descriptors[String(i)];
          return !d || !d.enumerable || !("value" in d);
        })
      )
        return fail();

      for (let i = 0; i < decisions.length; i++) {
        const row = readClosedRecord(decisions[i], [
            "effect",
            "reason",
            "source",
            "action",
            "scopeKind",
            "policySnapshotReference",
            "policyVersion",
            "audit",
          ]),
          audit = readClosedRecord(row.audit, ["effect", "reason", "source"]);
        if (
          row.effect !== "Allow" ||
          row.scopeKind !== "Brand" ||
          row.action !== actions[i] ||
          parseBusinessAction(row.action) !== actions[i] ||
          (row.reason !== "EXPLICIT_ALLOW" && row.reason !== "ROLE_PERMISSION") ||
          (row.source !== "ExplicitAllow" && row.source !== "RolePermission") ||
          (row.reason === "EXPLICIT_ALLOW") !== (row.source === "ExplicitAllow") ||
          audit.effect !== row.effect ||
          audit.reason !== row.reason ||
          audit.source !== row.source
        )
          return fail();
        parsePolicyReference(row.policySnapshotReference);
        parsePolicyVersion(row.policyVersion);
      }
    } else {
      if (!Array.isArray(decisions) || decisions.length !== actions.length) return fail();
      for (let i = 0; i < actions.length; i++) {
        const decision = decisions[i];
        if (
          !decision ||
          decision.effect !== "Allow" ||
          decision.scopeKind !== "Brand" ||
          String(decision.action) !== actions[i]
        )
          return fail();
      }
    }
    const a = parseCatalogInstant(lease()),
      b = parseCatalogInstant(capLease());
    if (a < deadline) deadline = a;
    if (b < deadline) deadline = b;
    check();
  };
  const sql = Object.freeze({ query: query.bind(tx) });
  return Object.freeze({
    async withCurrentAssessment<T>(
      input: { readonly graph: Graph; readonly binding: unknown },
      work: (source: CurrentOptionSetPublicationPriceInventory) => Promise<T>,
    ): Promise<T> {
      if (entered) return fail();
      entered = true;
      active = true;
      try {
        if (
          (await register(
            tx,
            async () => {
              if (!ready || active || ++guards !== 1) return fail();
              try {
                await hold([...permissions]);
                check();
                guardComplete = true;
              } catch (error) {
                return reject(error);
              }
            },
            () => {
              if (!ready || active || !guardComplete || guards !== 1 || ++finals !== 1)
                return fail();
              check();
            },
          )) !== undefined
        )
          return fail();
        const supplied = readClosedRecord(input, ["graph", "binding"]),
          binding = parseCatalogOptionSetContentPolicyBinding(supplied.binding),
          originalGraph = readClosedRecord(supplied.graph, [
            "profile",
            "graph",
            "sourceRecords",
            "sourceOperationReference",
            "sourceSnapshotTuple",
            "aggregateVersion",
            "sourceDigest",
            "contentDigest",
            "configurationDigest",
            "graphDigest",
            "rules",
            "originalObservedAt",
            "observedAt",
            "validUntil",
            "sourceAuthority",
            "referenceEligibility",
            "eligibility",
            "publishValidation",
          ]),
          // Avoid charging unrelated release provenance twice against the pure
          // complete graph budget. Nodes and binding are detached by owning parsers.
          graph = {
            ...originalGraph,
            graph: copyCategoryPersistenceValue(originalGraph.graph),
            sourceSnapshotTuple: copyCategoryPersistenceValue(originalGraph.sourceSnapshotTuple),
          } as Graph;
        if (
          typeof work !== "function" ||
          graph.profile !== "CurrentOptionSetPublicationDraftGraphV1" ||
          graph.sourceAuthority !== "CurrentDraftRootAndCurrentPublishedChildren" ||
          graph.eligibility !== "NotEvaluated" ||
          graph.referenceEligibility !== "NotEvaluated" ||
          graph.publishValidation !== "Incomplete" ||
          String(binding.tenantReference) !== tenant ||
          String(binding.brandReference) !== brand ||
          graph.graph.brandReference !== brand ||
          graph.graph.rootOptionSetReference !== String(binding.optionSetReference) ||
          graph.graph.rootVersionReference !== String(binding.versionReference) ||
          graph.aggregateVersion !== binding.expectedAggregateVersion ||
          graph.sourceDigest !== binding.sourceDigest ||
          graph.contentDigest !== binding.contentDigest ||
          graph.configurationDigest !== binding.configurationDigest ||
          graph.graphDigest !== binding.graphDigest ||
          parseCatalogInstant(graph.originalObservedAt) > check() ||
          binding.observedAt < graph.originalObservedAt ||
          binding.observedAt > check() ||
          graph.graph.contents.length < 1 ||
          graph.graph.contents.length > 32
        )
          return fail();
        parseCatalogReference(graph.sourceOperationReference);
        if (
          !equal(graph.sourceSnapshotTuple, {
            tenantReference: tenant,
            brandReference: brand,
            optionSetReference: String(binding.optionSetReference),
            versionReference: String(binding.versionReference),
            aggregateVersion: binding.expectedAggregateVersion,
            sourceDigest: String(binding.sourceDigest),
            contentDigest: String(binding.contentDigest),
            configurationDigest: String(binding.configurationDigest),
          })
        )
          return fail();
        const rule = evaluateCatalogOptionSetRuleSatisfiability(graph.graph);
        if (
          rule.graphDigest !== binding.graphDigest ||
          ("reason" in rule &&
            ["IncompleteTriggerGraph", "AmbiguousTriggerVersion"].includes(rule.reason ?? ""))
        )
          return fail();
        for (const until of [graph.validUntil, binding.validUntil]) {
          const parsed = parseCatalogInstant(until);
          if (parsed < deadline) deadline = parsed;
        }
        check();
        const originalPublicationClock = Object.freeze({
          profile: "OptionPublicationOriginalClockV1" as const,
          operationReference: operation,
          catalogIntentDigest: binding.originalIntentDigest,
          observedAt: binding.observedAt,
          validUntil: binding.validUntil,
        });
        const nodes = graph.graph.contents.map((content) => {
          const { sourceAggregate, profile, ...additional } = content;
          if (profile !== "CatalogOptionSetEditorContentV1") return fail();
          const full = parseCatalogOptionSetEditorContent(sourceAggregate, {
            profile,
            ...additional,
          });
          if (String(full.content.sourceAggregate.brandReference) !== brand) return fail();
          return full;
        });
        if (
          new Set(nodes.map((n) => String(n.content.sourceAggregate.optionSetReference))).size !==
          nodes.length
        )
          return fail();
        const root = nodes.find(
          (n) =>
            String(n.content.sourceAggregate.optionSetReference) ===
            String(binding.optionSetReference),
        );
        if (
          !root ||
          root.sourceDigest !== binding.sourceDigest ||
          root.contentDigest !== binding.contentDigest ||
          root.configurationDigest !== binding.configurationDigest
        )
          return fail();
        await hold(["catalog.manage", "catalog.option_set.read"]);
        const pricingRequest = parsePriceBookReferenceSourceRequest({
            purposeCode: "CATALOG_LIFECYCLE_PRICING_SOURCE_READ",
            brandReference: brand,
            actorReference: actor,
            operationReference: operation,
            catalogIntentDigest: binding.originalIntentDigest,
          }),
          inventoryRequest = parseInventoryConfigurationReferenceRequest({
            purposeCode: "CATALOG_LIFECYCLE_INVENTORY_CONFIGURATION_SOURCE_READ",
            tenantReference: tenant,
            brandReference: brand,
            actorReference: actor,
            operationReference: operation,
            catalogIntentDigest: binding.originalIntentDigest,
          });
        const validateRequest = (
          request: unknown,
          expected: unknown,
          observedAt: string,
          actual: unknown,
        ) => {
          if (actual !== sql || !equal(request, expected)) return fail();
          const at = parseCatalogInstant(observedAt);
          if (at < startedAt || at > check()) return fail();
        };
        const priceAuthority = <F extends readonly string[]>(fields: F, permission: string) => ({
          async holdUntilTransactionCompletes(
            actual: typeof sql,
            input: {
              tenantReference: string;
              request: typeof pricingRequest;
              observedAt: string;
              permission: string;
              requiredFields: F;
            },
          ) {
            validateRequest(input.request, pricingRequest, input.observedAt, actual);
            if (
              String(input.tenantReference) !== tenant ||
              input.permission !== permission ||
              !equal(input.requiredFields, fields)
            )
              return fail();
            await hold([permission]);
          },
        });
        const inventoryAuthority: Parameters<
          typeof createPostgresInventoryConfigurationReferenceSourceStore
        >[0]["authority"] = {
          async holdUntilTransactionCompletes(actual, input) {
            validateRequest(input.request, inventoryRequest, input.observedAt, actual);
            if (
              String(input.tenantReference) !== tenant ||
              input.requiredScope !== "FullBrandScope" ||
              !equal(input.requiredPermissions, inventoryConfigurationReferencePermissions) ||
              !equal(input.requiredFields, inventoryConfigurationReferenceFields)
            )
              return fail();
            await hold(inventoryConfigurationReferencePermissions);
          },
        };
        const evidence: NodeEvidence[] = nodes.map((n) => ({
          optionSetReference: String(n.content.sourceAggregate.optionSetReference),
          versionReference: String(n.content.sourceAggregate.draft.versionReference),
          price: null,
          inventory: null,
          inventoryUnits: null,
          priceCoverage: n.content.optionDetails.some((d) => d.pricingRule !== null)
            ? "AllRecordedPins"
            : "NoReferences",
          inventoryCoverage: n.content.optionDetails.some(
            (d) => d.consumption?.kind === "Inventory",
          )
            ? "AllRecordedPins"
            : "NoReferences",
          inventoryUnitCoverage: n.content.optionDetails.some(
            (d) => d.consumption?.kind === "Inventory",
          )
            ? "AllRecordedPins"
            : "NoReferences",
        }));
        const base = (index: number) => {
          const n = nodes[index];
          if (!n) return fail();
          return {
            brandReference: brand,
            optionSetReference: String(n.content.sourceAggregate.optionSetReference),
            versionReference: String(n.content.sourceAggregate.draft.versionReference),
            sourceDigest: n.sourceDigest,
            contentDigest: n.contentDigest,
            configurationDigest: n.configurationDigest,
          };
        };
        const inventoryPins = (index: number) => {
          const n = nodes[index];
          if (!n) return fail();
          return n.content.optionDetails.flatMap((d) =>
            d.consumption?.kind === "Inventory"
              ? [
                  {
                    optionReference: d.optionReference,
                    reference: d.consumption.reference,
                    versionReference: d.consumption.versionReference,
                    quantity: d.consumption.quantity,
                    unitCode: d.consumption.unitCode,
                  },
                ]
              : [],
          );
        };
        const standaloneAssessment = (): StandaloneOptionReferenceAssessment => {
          const checks: StandaloneOptionReferenceCheck[] = [];
          for (let index = 0; index < nodes.length; index++) {
            const node = nodes[index],
              recorded = evidence[index];
            if (!node || !recorded) return fail();
            const optionSetReference = recorded.optionSetReference;
            const add = (
              code: string,
              outcome: StandaloneOptionReferenceCheck["outcome"],
              optionReference: string | null,
              reference: string | null,
              reasonCode: string,
            ) => {
              checks.push(
                Object.freeze({
                  code,
                  outcome,
                  optionSetReference,
                  optionReference,
                  reference,
                  reasonCode,
                }),
              );
            };
            if (recorded.priceCoverage === "NoReferences")
              add("PRICE_REFERENCE_PRESENCE", "Satisfied", null, null, "NoReferences");
            if (recorded.inventoryCoverage === "NoReferences")
              add("INVENTORY_REFERENCE_PRESENCE", "Satisfied", null, null, "NoReferences");
            for (const detail of node.content.optionDetails) {
              const pins = [
                detail.pricingRule?.reference,
                detail.consumption?.kind === "Inventory" ? detail.consumption.reference : undefined,
              ].filter((reference): reference is string => reference !== undefined);
              // Section71 quantity/conditional rules are evaluated by Catalog,
              // independently of Product Binding defaults and sale quantities.
              for (const reference of pins) {
                add(
                  "OPTION_CONFIGURED_QUANTITY_LIMITS",
                  "Satisfied",
                  detail.optionReference,
                  reference,
                  "CatalogValidatedIntegerQuantityBounds",
                );
                add(
                  "OPTION_CONDITIONAL_RULES",
                  rule.status === "Satisfiable"
                    ? "Satisfied"
                    : rule.status === "Unsatisfiable"
                      ? "HardError"
                      : "Indeterminate",
                  detail.optionReference,
                  reference,
                  rule.status === "Satisfiable"
                    ? "CompleteRuleGraphSatisfiable"
                    : "reason" in rule
                      ? rule.reason
                      : "RuleEvaluationUnavailable",
                );
              }
              if (detail.pricingRule !== null) {
                const pin = detail.pricingRule,
                  match = recorded.price?.references.find(
                    (value) =>
                      String(value.optionReference) === detail.optionReference &&
                      String(value.ruleReference) === pin.reference &&
                      String(value.versionReference) === pin.versionReference,
                  );
                add(
                  "PRICE_PIN_CURRENT_EFFECTIVE",
                  match?.status === "CurrentPublishedMetadata" ? "Satisfied" : "HardError",
                  detail.optionReference,
                  pin.reference,
                  match?.status ?? "SourcePinCoverageMismatch",
                );
              }
              if (detail.consumption?.kind === "Inventory") {
                const pin = detail.consumption,
                  metadata = recorded.inventory?.matches.find(
                    (value) =>
                      String(value.optionReference) === detail.optionReference &&
                      String(value.reference) === pin.reference &&
                      String(value.versionReference) === pin.versionReference,
                  ),
                  units = recorded.inventoryUnits?.matches.find(
                    (value) =>
                      String(value.optionReference) === detail.optionReference &&
                      String(value.reference) === pin.reference &&
                      String(value.versionReference) === pin.versionReference &&
                      value.unitCode === pin.unitCode,
                  );
                add(
                  "INVENTORY_PIN_CURRENT_ACTIVE",
                  metadata?.status === "CurrentActiveMetadata" ? "Satisfied" : "HardError",
                  detail.optionReference,
                  pin.reference,
                  metadata?.status ?? "SourcePinCoverageMismatch",
                );
                add(
                  "INVENTORY_CONFIGURED_QUANTITY_UNITS",
                  metadata?.status === "CurrentActiveMetadata" &&
                    units?.status === "ExactBaseQuantity" &&
                    units.baseQuantity !== null
                    ? "Satisfied"
                    : "HardError",
                  detail.optionReference,
                  pin.reference,
                  metadata?.status !== "CurrentActiveMetadata"
                    ? (metadata?.status ?? "SourcePinCoverageMismatch")
                    : (units?.status ?? "SourcePinCoverageMismatch"),
                );
              }
            }
          }
          const decision = checks.some((value) => value.outcome === "HardError")
            ? "HardError"
            : checks.some((value) => value.outcome === "Indeterminate")
              ? "Indeterminate"
              : "Pass";
          return Object.freeze({
            phase: "OptionSetPublication",
            decision,
            checks: Object.freeze(checks),
            productBinding: "NotApplicableForIndependentOptionSet",
            skuMembership: "NotApplicableForIndependentOptionSet",
            saleQuote: "NotApplicableForIndependentOptionSet",
            inventoryBalance: "NotApplicableForIndependentOptionSet",
          });
        };
        const finish = async () => {
          const body = {
            profile: "CurrentOptionSetPublicationPriceInventoryV1" as const,
            binding,
            operationReference: operation,
            nodes: Object.freeze(evidence.map((n) => Object.freeze(n))),
            standaloneReferenceAssessment: standaloneAssessment(),
            graphDigest: graph.graphDigest,
            originalObservedAt: startedAt,
            observedAt: check(),
            validUntil: deadline,
            eligibility: "NotEvaluated" as const,
            publishValidation: "Incomplete" as const,
            sourceAuthority: "CurrentPricingInventoryMetadataAndUnits" as const,
          };
          const answer = await work(
            Object.freeze({ ...body, digest: "sha256:" + sha256Hex(canonicalizeRfc8785(body)) }),
          );
          check();
          await hold([...permissions]);
          return answer;
        };
        const withUnits = async (index: number): Promise<T> => {
          if (index === nodes.length) return finish();
          const entry = evidence[index];
          if (!entry) return fail();
          const allPins = inventoryPins(index);
          // Metadata retains every recorded pin. The unit owner accepts only
          // current Active revisions; invalid references remain concrete errors,
          // rather than being relabelled as absent or acquired unit evidence.
          const pins = allPins.filter((pin) =>
            entry.inventory?.matches.some(
              (match) =>
                String(match.optionReference) === String(pin.optionReference) &&
                String(match.reference) === String(pin.reference) &&
                String(match.versionReference) === String(pin.versionReference) &&
                match.status === "CurrentActiveMetadata",
            ),
          );
          if (pins.length !== allPins.length)
            evidence[index] = { ...entry, inventoryUnitCoverage: "BlockedByReferenceErrors" };
          if (pins.length === 0) return withUnits(index + 1);
          const owner = createPostgresInventoryOptionConsumptionUnitSource({
            originalPublicationClock,
            tenantReference: tenant,
            brandReference: brand,
            actorReference: actor,
            clock: { now: check },
            transactions: { run: (action) => action(sql) },
            authority: inventoryAuthority,
            unitAuthority: {
              async holdUntilTransactionCompletes(actual, input) {
                validateRequest(input.request, inventoryRequest, input.observedAt, actual);
                if (
                  input.requiredScope !== "FullBrandScope" ||
                  !equal(input.requiredPermissions, inventoryConfigurationReferencePermissions) ||
                  !equal(input.requiredFields, inventoryOptionConsumptionUnitFields) ||
                  !equal(
                    input.itemReferences,
                    [...new Set(pins.map((p) => String(p.reference)))].sort(),
                  )
                )
                  return fail();
                await hold(inventoryConfigurationReferencePermissions);
              },
            },
          });
          let calls = 0,
            completed: { value: T } | undefined;
          const answer = await owner.withCurrentUnits(
            inventoryRequest,
            pins,
            binding.activationAt,
            async (units) => {
              if (++calls !== 1) return fail();
              if (units.validUntil < deadline) deadline = parseCatalogInstant(units.validUntil);
              check();
              const current = evidence[index];
              if (!current) return fail();
              evidence[index] = { ...current, inventoryUnits: units };
              const value = await withUnits(index + 1);
              completed = { value };
              return value;
            },
          );
          if (calls !== 1 || !completed || !Object.is(completed.value, answer)) return fail();
          check();
          return answer;
        };
        const withInventory = async () => {
          if (!evidence.some((n) => n.inventoryCoverage === "AllRecordedPins")) return withUnits(0);
          const owner = createPostgresInventoryConfigurationReferenceSourceStore({
            tenantReference: tenant,
            brandReference: brand,
            actorReference: actor,
            clock: { now: check },
            transactions: { run: (action) => action(sql) },
            authority: inventoryAuthority,
          });
          let calls = 0,
            completed: { value: T } | undefined;
          const answer = await owner.withCurrentSnapshot(inventoryRequest, async (source) => {
            if (++calls !== 1) return fail();
            const sourceUntil = new Date(Date.parse(source.observedAt) + 5000).toISOString();
            if (sourceUntil < deadline) deadline = sourceUntil;
            check();
            for (let i = 0; i < nodes.length; i++) {
              const entry = evidence[i];
              if (!entry) return fail();
              if (entry.inventoryCoverage === "NoReferences") continue;
              const pins = inventoryPins(i).map(({ quantity, unitCode, ...pin }) => {
                void quantity;
                void unitCode;
                return pin;
              });
              evidence[i] = {
                ...entry,
                inventory: matchOptionDraftInventoryConsumptionMetadata(
                  { profile: "CurrentFullOptionDraftConsumptionPinsV1", ...base(i), pins },
                  source,
                  inventoryRequest,
                  check(),
                  binding.activationAt,
                  originalPublicationClock,
                ),
              };
            }
            const value = await withUnits(0);
            completed = { value };
            return value;
          });
          if (calls !== 1 || !completed || !Object.is(completed.value, answer)) return fail();
          check();
          return answer;
        };
        const withPricing = async () => {
          if (!evidence.some((n) => n.priceCoverage === "AllRecordedPins")) return withInventory();
          const owner = createPostgresConfigurationReferenceSourceStore({
            tenantReference: tenant,
            brandReference: brand,
            actorReference: actor,
            clock: { now: check },
            transactions: { run: (action) => action(sql) },
            priceBookAuthority: priceAuthority(
              priceBookReferenceSourceFields,
              "pricing.price-book.manage",
            ),
            optionPriceAuthority: priceAuthority(
              optionPriceReferenceSourceFields,
              "pricing.price-book.manage",
            ),
            promotionAuthority: priceAuthority(
              promotionReferenceSourceFields,
              "pricing.promotion.manage",
            ),
            authority: {
              async holdUntilTransactionCompletes(actual, input) {
                validateRequest(input.request, pricingRequest, input.observedAt, actual);
                if (
                  String(input.tenantReference) !== tenant ||
                  input.requiredScope !== "Brand" ||
                  !equal(input.requiredPermissions, [
                    "pricing.price-book.manage",
                    "pricing.promotion.manage",
                  ]) ||
                  !equal(input.requiredFields, configurationReferenceSourceFields)
                )
                  return fail();
                await hold(input.requiredPermissions);
              },
            },
          });
          let calls = 0,
            completed: { value: T } | undefined;
          const answer = await owner.withCurrentSnapshot(pricingRequest, async (source) => {
            if (++calls !== 1) return fail();
            const sourceUntil = new Date(Date.parse(source.observedAt) + 5000).toISOString();
            if (sourceUntil < deadline) deadline = sourceUntil;
            check();
            for (let i = 0; i < nodes.length; i++) {
              const entry = evidence[i],
                node = nodes[i];
              if (!entry || !node) return fail();
              if (entry.priceCoverage === "NoReferences") continue;
              const optionPins = node.content.optionDetails.flatMap((d) =>
                d.pricingRule
                  ? [
                      {
                        optionReference: d.optionReference,
                        ruleReference: d.pricingRule.reference,
                        versionReference: d.pricingRule.versionReference,
                      },
                    ]
                  : [],
              );
              // A shared source lock cannot stop wall time crossing a pinned
              // price's half-open period. Retain the earliest relevant expiry.
              // Already invalid periods remain concrete assessment HardErrors.
              const at = check();
              for (const pin of optionPins) {
                const version = source.optionPrices.versions.find(
                  (value) =>
                    String(value.ruleReference) === pin.ruleReference &&
                    String(value.versionReference) === pin.versionReference,
                );
                if (version?.effectiveUntil !== null && version?.effectiveUntil !== undefined) {
                  const until = parseCatalogInstant(version.effectiveUntil);
                  if (until > at && until < deadline) deadline = until;
                }
              }
              check();
              evidence[i] = {
                ...entry,
                price: matchOptionDraftPriceReferenceMetadata(
                  { profile: "CurrentFullOptionDraftPricePinsV1", ...base(i), optionPins },
                  source,
                  pricingRequest,
                  check(),
                  binding.activationAt,
                  originalPublicationClock,
                ),
              };
            }
            const value = await withInventory();
            completed = { value };
            return value;
          });
          if (calls !== 1 || !completed || !Object.is(completed.value, answer)) return fail();
          check();
          return answer;
        };
        const result = await withPricing();
        check();
        ready = true;
        return result;
      } catch (error) {
        return reject(error);
      } finally {
        active = false;
      }
    },
  });
}

import { parseCanonicalInstant } from "@bop/tenant";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  createPostgresInventoryRecipeIngredientUnitSource,
  assessRecipeIngredientUnits,
  assessRecipeBaseDemands,
  type InventoryRecipeIngredientUnitOptions,
  type InventoryConfigurationReferenceTransaction,
} from "@rms/inventory";
import {
  requireRecipeMeasurementContentDigest,
  calculateRecipeMeasurementDemand,
  createPostgresRecipeMeasurementPublicationStore,
  createRecipeService,
  RecipeWorkflowError,
  parseRecipeReference,
  parseRecipeDigest,
  createPinnedPublishedRecipeMeasurementGraphSource,
  type CurrentPublishedRecipeMeasurementGraphOptions,
  type RecipeMeasurementContentV2,
  type RecipePorts,
} from "@rms/recipe";
type Tx = InventoryConfigurationReferenceTransaction;
const fail = (): never => {
  throw new RecipeWorkflowError("RECIPE_DEPENDENCY_UNAVAILABLE");
};
export function createCurrentRecipeMeasurementPublicationService(options: {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly clock: { now(): string };
  readonly generateReference: () => string;
  readonly recipePorts: Omit<RecipePorts, "repository">;
  readonly recipeAuthority: {
    holdUntilTransactionCompletes(
      tx: Tx,
      input: {
        tenantReference: string;
        brandReference: string;
        actorReference: string;
        operationReference: string;
        contentDigest: string;
        permission: "recipe.manage";
        purpose: "RecipeMeasurementPublication";
        observedAt: string;
      },
    ): Promise<void>;
  };
  readonly pinnedRecipes?: Pick<
    CurrentPublishedRecipeMeasurementGraphOptions,
    "authority" | "measurementAuthority"
  >;
  readonly inventory: Pick<InventoryRecipeIngredientUnitOptions, "authority" | "unitAuthority">;
}) {
  const tenant = parseRecipeReference(options.tenantReference),
    brand = parseRecipeReference(options.brandReference),
    actor = parseRecipeReference(options.actorReference),
    now = options.clock.now.bind(options.clock),
    hold = options.recipeAuthority.holdUntilTransactionCompletes.bind(options.recipeAuthority),
    active = new WeakSet<object>(),
    failed = new WeakSet<object>();
  return Object.freeze({
    async execute(tx: Tx, input: unknown) {
      let entered = false;
      try {
        if (
          !tx ||
          typeof tx !== "object" ||
          typeof tx.query !== "function" ||
          active.has(tx) ||
          failed.has(tx)
        ) {
          if (tx && typeof tx === "object") failed.add(tx);
          return fail();
        }
        active.add(tx);
        entered = true;
        if (
          !input ||
          typeof input !== "object" ||
          Object.getPrototypeOf(input) !== Object.prototype ||
          Reflect.ownKeys(input).length !== 5
        )
          return fail();
        const raw: Record<string, unknown> = {};
        for (const key of [
          "action",
          "operationReference",
          "expectedAggregateVersion",
          "candidate",
          "occurredAt",
        ]) {
          const d = Object.getOwnPropertyDescriptor(input, key);
          if (!d?.enumerable || !("value" in d)) return fail();
          raw[key] = d.value;
        }
        if (raw.action !== "Publish") return fail();
        const content = requireRecipeMeasurementContentDigest(raw.candidate),
          operationReference = parseRecipeReference(raw.operationReference),
          occurredAt = parseCanonicalInstant(raw.occurredAt);
        if (
          content.snapshot.lifecycle !== "Published" ||
          content.snapshot.brandReference !== brand ||
          content.snapshot.createdAt !== occurredAt ||
          !Number.isSafeInteger(raw.expectedAggregateVersion) ||
          (raw.expectedAggregateVersion as number) < 1
        )
          return fail();
        const command = {
            action: "Publish" as const,
            operationReference,
            expectedAggregateVersion: raw.expectedAggregateVersion as number,
            candidate: content.snapshot,
            occurredAt,
          },
          query = tx.query,
          boundQuery = query.bind(tx);
        let latest: string | undefined, deadline: string | undefined;
        const check = () => {
          const at = parseCanonicalInstant(now());
          if (
            failed.has(tx) ||
            tx.query !== query ||
            (latest !== undefined && at < latest) ||
            (deadline !== undefined && at >= deadline)
          )
            return fail();
          latest = at;
          return at;
        };
        const facade: Tx = {
          async query<R extends Record<string, unknown>>(sql: string, values: readonly unknown[]) {
            check();
            const result = await boundQuery(sql, values);
            check();
            return result as { rows: readonly R[] };
          },
        };
        const authorize = async () => {
          await hold(tx, {
            tenantReference: tenant,
            brandReference: brand,
            actorReference: actor,
            operationReference,
            contentDigest: content.snapshot.snapshotDigest,
            permission: "recipe.manage",
            purpose: "RecipeMeasurementPublication",
            observedAt: check(),
          });
          check();
        };
        const repository = createPostgresRecipeMeasurementPublicationStore(
          { run: (work) => work(facade) },
          brand,
          options.generateReference,
          content,
        );
        const ports: RecipePorts = {
          ...options.recipePorts,
          repository,
          authorization: {
            async authorize(value) {
              const evidence = await options.recipePorts.authorization.authorize(value);
              if (
                evidence &&
                (String(evidence.tenantContext.actor.actorReference) !== String(actor) ||
                  String(evidence.tenantContext.brand.brandReference) !== String(brand))
              )
                return null;
              return evidence;
            },
          },
        };
        const execute = async () => {
          const result = await createRecipeService(ports).execute(command);
          check();
          if (canonicalizeRfc8785(result.aggregate) !== canonicalizeRfc8785(content.snapshot))
            return fail();
          await authorize();
          return Object.freeze({ ...result, content });
        };
        await authorize();
        // Exact native operation recovery checks current authorization and original intent, not old Item currentness.
        const prior = await repository.resolveMeasurementOperation(operationReference);
        check();
        if (prior) {
          const result = await execute();
          check();
          return result;
        }
        const qualify = async (children: readonly RecipeMeasurementContentV2[]) => {
          const allContents = [content, ...children];
          const pins = allContents.flatMap((c) =>
            c.snapshot.ingredients
              .filter((i) => i.sourceKind === "InventoryItem")
              .map((i) => ({
                recipeReference: c.snapshot.recipeReference,
                recipeVersionReference: c.snapshot.versionReference,
                requirementReference: i.requirementReference,
                itemReference: i.sourceReference,
                operationReference: i.sourceVersionReference,
              })),
          );
          const unitSource = createPostgresInventoryRecipeIngredientUnitSource({
            tenantReference: tenant,
            brandReference: brand,
            actorReference: actor,
            clock: { now: check },
            transactions: { run: (work) => work(facade) },
            authority: {
              async holdUntilTransactionCompletes(actual, value) {
                if (actual !== facade) return fail();
                check();
                await options.inventory.authority.holdUntilTransactionCompletes(tx, value);
                check();
              },
            },
            unitAuthority: {
              async holdUntilTransactionCompletes(actual, value) {
                if (actual !== facade) return fail();
                check();
                await options.inventory.unitAuthority.holdUntilTransactionCompletes(tx, value);
                check();
              },
            },
          });
          const request = {
            purposeCode: "CATALOG_LIFECYCLE_INVENTORY_CONFIGURATION_SOURCE_READ" as const,
            tenantReference: tenant,
            brandReference: brand,
            actorReference: actor,
            operationReference,
            catalogIntentDigest: parseRecipeDigest(
              ports.references.hashIntent(JSON.stringify(command)),
            ),
          };
          let calls = 0,
            answer: Awaited<ReturnType<typeof execute>> | undefined;
          const result = await unitSource.withCurrentUnits(request, pins, async (facts) => {
            if (++calls !== 1) return fail();
            deadline =
              deadline === undefined || facts.validUntil < deadline ? facts.validUntil : deadline;
            const assessedAt = check(),
              activationAt =
                content.snapshot.effectivePeriod.effectiveFrom.instant > assessedAt
                  ? content.snapshot.effectivePeriod.effectiveFrom.instant
                  : assessedAt;
            if (
              content.snapshot.effectivePeriod.effectiveUntil !== null &&
              content.snapshot.effectivePeriod.effectiveUntil.instant <= activationAt
            )
              return fail();
            const measurements = allContents.flatMap((c) =>
              c.snapshot.ingredients
                .filter((i) => i.sourceKind === "InventoryItem")
                .map((i) => {
                  const m = c.measurements.find(
                    (m) => m.requirementReference === i.requirementReference,
                  );
                  if (!m) return fail();
                  return {
                    recipeReference: c.snapshot.recipeReference,
                    recipeVersionReference: c.snapshot.versionReference,
                    requirementReference: i.requirementReference,
                    itemReference: i.sourceReference,
                    operationReference: i.sourceVersionReference,
                    usageUnitCode: m.usageUnitCode,
                    usageDimension: m.usageDimension,
                    targetUnitCode: m.targetUnitCode,
                    targetDimension: m.targetDimension,
                    conversionKind: m.conversionKind,
                    conversionReference: m.conversionReference,
                    quantityMicrounits: i.quantityMicrounits,
                    conversionNumerator: i.conversionNumerator,
                    conversionDenominator: i.conversionDenominator,
                  };
                }),
            );
            if (
              assessRecipeIngredientUnits(measurements, facts, assessedAt, activationAt)
                .unitArithmetic !== "Pass"
            )
              return fail();
            const demand = calculateRecipeMeasurementDemand(
              content,
              children,
              content.snapshot.yieldQuantityMicrounits,
              assessedAt,
              activationAt,
            );
            const final = assessRecipeBaseDemands(
              demand.demands.map((d) => ({
                recipeReference: d.recipeReference,
                recipeVersionReference: d.recipeVersionReference,
                requirementReference: d.requirementReference,
                itemReference: d.itemReference,
                operationReference: d.operationReference,
                targetUnitCode: d.targetUnitCode,
                targetDimension: d.targetDimension,
                quantityNumerator: d.quantityNumerator,
                quantityDenominator: d.quantityDenominator,
                pathDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(d.sourcePath)),
              })),
              facts,
              assessedAt,
              activationAt,
            );
            if (final.inventoryPrecision !== "Pass") return fail();
            check();
            answer = await execute();
            check();
            return answer;
          });
          if (calls !== 1 || answer === undefined || !Object.is(result, answer)) return fail();
          check();
          await authorize();
          check();
          return result;
        };
        const selected = [
          ...new Map(
            content.snapshot.ingredients
              .filter((i) => i.sourceKind === "SubRecipe")
              .map((i) => [
                i.sourceReference + ":" + i.sourceVersionReference,
                {
                  recipeReference: i.sourceReference,
                  versionReference: i.sourceVersionReference,
                },
              ]),
          ).values(),
        ];
        if (selected.length === 0) return await qualify([]);
        const pinnedAuthority = options.pinnedRecipes;
        if (!pinnedAuthority) return fail();
        const observedAt = check(),
          activationAt =
            content.snapshot.effectivePeriod.effectiveFrom.instant > observedAt
              ? content.snapshot.effectivePeriod.effectiveFrom.instant
              : observedAt;
        const pinned = createPinnedPublishedRecipeMeasurementGraphSource({
          tenantReference: tenant,
          brandReference: brand,
          actorReference: actor,
          clock: { now: check },
          transactions: { run: (work) => work(facade) },
          authority: {
            async holdUntilTransactionCompletes(actual, value) {
              if (actual !== facade) return fail();
              check();
              await pinnedAuthority.authority.holdUntilTransactionCompletes(tx, value);
              check();
            },
          },
          measurementAuthority: {
            async holdUntilTransactionCompletes(actual, value) {
              if (actual !== facade) return fail();
              check();
              await pinnedAuthority.measurementAuthority.holdUntilTransactionCompletes(tx, value);
              check();
            },
          },
        });
        const result = await pinned.withCurrentGraph(
          {
            request: {
              purposeCode: "CATALOG_LIFECYCLE_RECIPE_SOURCE_READ",
              brandReference: brand,
              actorReference: actor,
              operationReference,
              catalogIntentDigest: parseRecipeDigest(
                ports.references.hashIntent(JSON.stringify(command)),
              ),
            },
            observedAt,
            validUntil: new Date(Date.parse(observedAt) + 5000).toISOString(),
            activationAt,
            recipeVersions: selected,
          },
          async (graph) => {
            deadline = graph.validUntil;
            check();
            return qualify(graph.contents.map((c) => c.content));
          },
        );
        check();
        await authorize();
        check();
        return result;
      } catch (error) {
        if (tx && typeof tx === "object") failed.add(tx);
        if (error instanceof RecipeWorkflowError) throw error;
        return fail();
      } finally {
        if (entered) active.delete(tx);
      }
    },
  });
}

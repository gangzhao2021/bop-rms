import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { parseRecipeReference } from "../../domain/recipe.js";
import { RecipeWorkflowError } from "../../application/recipe-service.js";
import { parseRecipeReferenceSourceInstant } from "../../contracts/recipe-reference-source.js";
import type { RecipeMeasurementContentV2 } from "../../domain/recipe-measurement-content.js";
import { readPublishedRecipeMeasurementContent } from "./recipe-measurement-draft-store.js";
import {
  createCurrentPublishedRecipeDependencyGraphSource,
  createPinnedPublishedRecipeDependencyGraphSource,
  type CurrentPublishedRecipeDependencyGraph,
  type CurrentPublishedRecipeDependencyGraphOptions,
} from "./current-published-recipe-dependency-graph-source.js";
import type { RecipeReferenceTransaction } from "./recipe-reference-source-store.js";
export const currentPublishedRecipeMeasurementGraphFields = Object.freeze([
  "Recipe.MeasurementProfile",
  "Recipe.CompleteMeasurementContent",
  "Recipe.MeasurementDigest",
  "Recipe.UsageUnits",
  "Recipe.TargetUnits",
  "Recipe.ConversionProvenance",
] as const);
export interface CurrentPublishedRecipeMeasurementGraphOptions extends CurrentPublishedRecipeDependencyGraphOptions {
  readonly measurementAuthority: {
    holdUntilTransactionCompletes(
      tx: RecipeReferenceTransaction,
      input: {
        readonly tenantReference: string;
        readonly request: CurrentPublishedRecipeDependencyGraph["request"];
        readonly permission: "recipe.manage";
        readonly requiredScope: "FullBrandScope";
        readonly requiredFields: typeof currentPublishedRecipeMeasurementGraphFields;
        readonly observedAt: string;
      },
    ): Promise<void>;
  };
}
interface PublishedRecipeMeasurementGraph<
  P extends "CurrentPublishedRecipeMeasurementGraphV2" | "PinnedPublishedRecipeMeasurementGraphV2",
> {
  readonly profile: P;
  readonly tenantReference: string;
  readonly request: CurrentPublishedRecipeDependencyGraph["request"];
  readonly observedAt: string;
  readonly validUntil: string;
  readonly activationAt: string;
  readonly coreGraphDigest: string;
  readonly contents: readonly (CurrentPublishedRecipeDependencyGraph["contents"][number] & {
    readonly content: RecipeMeasurementContentV2;
  })[];
  readonly rootVersionReferences: readonly string[];
  readonly measurementRepresentation: "CompleteV2";
  readonly inventoryReferences: "NotEvaluated";
  readonly unitArithmetic: "NotEvaluated";
  readonly publishValidation: "Incomplete";
  readonly eligibility: "NotEvaluated";
  readonly digest: string;
}
const fail = (): never => {
  throw new RecipeWorkflowError("RECIPE_DEPENDENCY_UNAVAILABLE");
};
export type CurrentPublishedRecipeMeasurementGraph =
  PublishedRecipeMeasurementGraph<"CurrentPublishedRecipeMeasurementGraphV2">;
export type PinnedPublishedRecipeMeasurementGraph =
  PublishedRecipeMeasurementGraph<"PinnedPublishedRecipeMeasurementGraphV2">;
/** Actual owning core source plus exact immutable V2 attachments. Must remain inside the original outer UoW. */
export function createCurrentPublishedRecipeMeasurementGraphSource(
  options: CurrentPublishedRecipeMeasurementGraphOptions,
) {
  return createMeasurementGraphSource(options, "CurrentPublishedRecipeMeasurementGraphV2", true);
}
export function createPinnedPublishedRecipeMeasurementGraphSource(
  options: CurrentPublishedRecipeMeasurementGraphOptions,
) {
  return createMeasurementGraphSource(options, "PinnedPublishedRecipeMeasurementGraphV2", false);
}
function createMeasurementGraphSource<
  P extends "CurrentPublishedRecipeMeasurementGraphV2" | "PinnedPublishedRecipeMeasurementGraphV2",
>(options: CurrentPublishedRecipeMeasurementGraphOptions, profile: P, currentRoots: boolean) {
  const tenant = parseRecipeReference(options.tenantReference),
    brand = parseRecipeReference(options.brandReference),
    actor = parseRecipeReference(options.actorReference),
    now = options.clock.now.bind(options.clock),
    run = options.transactions.run.bind(options.transactions),
    hold = options.measurementAuthority.holdUntilTransactionCompletes.bind(
      options.measurementAuthority,
    ),
    active = new WeakSet<object>(),
    failed = new WeakSet<object>();
  return Object.freeze({
    async withCurrentGraph<T>(
      input: unknown,
      work: (graph: PublishedRecipeMeasurementGraph<P>) => Promise<T>,
    ): Promise<T> {
      let finalCheck: (() => string) | undefined;
      let original: RecipeReferenceTransaction | undefined,
        calls = 0,
        complete: { answer: T } | undefined;
      try {
        if (typeof work !== "function") return fail();
        const result = await run(async (tx) => {
          original = tx;
          if (++calls !== 1 || active.has(tx) || failed.has(tx)) {
            failed.add(tx);
            return fail();
          }
          active.add(tx);
          try {
            const query = tx.query,
              bound = query.bind(tx);
            let latest: string | undefined, deadline: string | undefined;
            const check = () => {
              const at = parseRecipeReferenceSourceInstant(now());
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
            finalCheck = check;
            let graphCalls = 0;
            const facade: RecipeReferenceTransaction = Object.freeze({
              async query<R extends Record<string, unknown>>(
                sql: string,
                values: readonly unknown[],
              ) {
                check();
                const rows = await bound(sql, values);
                check();
                return rows as { rows: readonly R[] };
              },
            });
            const createCore = currentRoots
              ? createCurrentPublishedRecipeDependencyGraphSource
              : createPinnedPublishedRecipeDependencyGraphSource;
            const source = createCore({
              tenantReference: tenant,
              brandReference: brand,
              actorReference: actor,
              clock: { now: check },
              transactions: { run: (action) => action(facade) },
              authority: {
                async holdUntilTransactionCompletes(actual, fields) {
                  if (actual !== facade) return fail();
                  check();
                  await options.authority.holdUntilTransactionCompletes(tx, fields);
                  check();
                },
              },
            });
            return await source.withCurrentGraph(input, async (graph) => {
              if (++graphCalls !== 1) return fail();
              deadline = graph.validUntil;
              check();
              const authorize = async () => {
                await hold(
                  tx,
                  Object.freeze({
                    tenantReference: tenant,
                    request: graph.request,
                    permission: "recipe.manage",
                    requiredScope: "FullBrandScope",
                    requiredFields: currentPublishedRecipeMeasurementGraphFields,
                    observedAt: check(),
                  }),
                );
                check();
              };
              const read = async () => {
                const contents: CurrentPublishedRecipeMeasurementGraph["contents"][number][] = [];
                for (const c of graph.contents) {
                  check();
                  const content = await readPublishedRecipeMeasurementContent(
                    facade,
                    brand,
                    c.snapshot,
                    c.publicationOperationReference,
                  );
                  check();
                  contents.push(Object.freeze({ ...c, content }));
                }
                return Object.freeze(contents);
              };
              await authorize();
              const contents = await read(),
                body = Object.freeze({
                  profile,
                  tenantReference: tenant,
                  request: graph.request,
                  observedAt: graph.observedAt,
                  validUntil: graph.validUntil,
                  activationAt: graph.activationAt,
                  coreGraphDigest: graph.digest,
                  contents,
                  rootVersionReferences: graph.rootVersionReferences,
                  measurementRepresentation: "CompleteV2" as const,
                  inventoryReferences: "NotEvaluated" as const,
                  unitArithmetic: "NotEvaluated" as const,
                  publishValidation: "Incomplete" as const,
                  eligibility: "NotEvaluated" as const,
                });
              const full = Object.freeze({
                ...body,
                digest: "sha256:" + sha256Hex(canonicalizeRfc8785(body)),
              });
              const answer = await work(full);
              check();
              await authorize();
              if (canonicalizeRfc8785(await read()) !== canonicalizeRfc8785(contents))
                return fail();
              check();
              await authorize();
              complete = { answer };
              return answer;
            });
          } catch (error) {
            failed.add(tx);
            throw error;
          } finally {
            active.delete(tx);
          }
        });
        finalCheck?.();
        if (calls !== 1 || !complete || !Object.is(complete.answer, result)) return fail();
        return result;
      } catch (error) {
        if (original) failed.add(original);
        if (error instanceof RecipeWorkflowError) throw error;
        return fail();
      }
    },
  });
}

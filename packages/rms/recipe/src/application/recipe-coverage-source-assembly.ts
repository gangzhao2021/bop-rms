import { RecipeCoveragePublicationError } from "./recipe-coverage-publication-error.js";
import { parseRecipeReference } from "../domain/recipe.js";
import {
  assertRecipeCoverageUnchanged,
  parseRecipeCoverageSnapshot,
  parseRecipeSourceCoverage,
  recipeSourceFamilies,
  RecipeCoverageError,
  type RecipeCoverageSnapshot,
  type RecipeSourceCoverage,
  type RecipeSourceFamily,
} from "./recipe-source-coverage.js";
export interface RecipeCoverageOwnerRead {
  readonly coverage: RecipeSourceCoverage;
  readonly capturedAtUtc: string;
  readonly asOfUtc: string;
}
export interface RecipeCoverageAssemblyRequest {
  readonly actorReference: string;
  readonly purpose: "RecipeProjectionBuild";
  readonly observedAtUtc: string;
}
/** Source implementations hold current facts and authority through callback and transaction COMMIT. */
export interface RecipeCoverageOwnerSource {
  capture(request: unknown): Promise<RecipeCoverageOwnerRead>;
  withCurrent<T>(
    request: unknown,
    captured: unknown,
    work: (read: RecipeCoverageOwnerRead) => Promise<T>,
  ): Promise<T>;
}
/** This public lease must hold actual Tenant/Brand/Actor/purpose/phase/permission authority. */
export interface RecipeCoverageAssemblyAuthorization {
  withAuthorizedScope<T>(
    input: RecipeCoverageAssemblyRequest & {
      readonly tenantReference: string;
      readonly brandReference: string;
    },
    work: () => Promise<T>,
  ): Promise<T>;
}
export class RecipeCoverageAssemblyError extends Error {
  constructor(
    readonly code:
      | "RECIPE_ASSEMBLY_INPUT_INVALID"
      | "RECIPE_ASSEMBLY_INCOMPLETE"
      | "RECIPE_ASSEMBLY_UNAVAILABLE",
  ) {
    super("Recipe source assembly is unavailable");
    this.name = "RecipeCoverageAssemblyError";
  }
}
const fail = (code: RecipeCoverageAssemblyError["code"] = "RECIPE_ASSEMBLY_UNAVAILABLE"): never => {
  throw new RecipeCoverageAssemblyError(code);
};
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length
  )
    return fail();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !("value" in d)) return fail();
    result[key] = d.value;
  }
  return result;
}
function instant(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    new Date(value).toISOString() !== value
  )
    return fail();
  return value;
}
function request(value: unknown): RecipeCoverageAssemblyRequest {
  try {
    const raw = object(value, ["actorReference", "purpose", "observedAtUtc"]);
    if (raw.purpose !== "RecipeProjectionBuild") return fail();
    return Object.freeze({
      actorReference: parseRecipeReference(raw.actorReference),
      purpose: raw.purpose,
      observedAtUtc: instant(raw.observedAtUtc),
    });
  } catch {
    return fail("RECIPE_ASSEMBLY_INPUT_INVALID");
  }
}
/** Composes public owner capabilities only. No source capture by itself establishes coherence. */
export function createRecipeCoverageSourceAssembly(options: {
  readonly scope: { readonly tenantReference: string; readonly brandReference: string };
  readonly sources: Readonly<Partial<Record<RecipeSourceFamily, RecipeCoverageOwnerSource>>>;
  readonly authorization: RecipeCoverageAssemblyAuthorization;
}) {
  const raw = object(options.scope, ["tenantReference", "brandReference"]),
    tenant = parseRecipeReference(raw.tenantReference),
    brand = parseRecipeReference(raw.brandReference);
  const sources = new Map<RecipeSourceFamily, RecipeCoverageOwnerSource>();
  for (const family of recipeSourceFamilies) {
    const d = Object.getOwnPropertyDescriptor(options.sources, family);
    if (d?.enumerable && "value" in d && d.value !== undefined)
      sources.set(family, d.value as RecipeCoverageOwnerSource);
  }
  const authority = options.authorization;
  function read(value: unknown, family: RecipeSourceFamily, at: string): RecipeCoverageOwnerRead {
    const raw = object(value, ["coverage", "capturedAtUtc", "asOfUtc"]),
      coverage = parseRecipeSourceCoverage(raw.coverage),
      capturedAtUtc = instant(raw.capturedAtUtc),
      asOfUtc = instant(raw.asOfUtc);
    if (
      coverage.family !== family ||
      coverage.tenantReference !== tenant ||
      coverage.brandReference !== brand ||
      capturedAtUtc > asOfUtc ||
      asOfUtc !== at
    )
      return fail();
    if (!coverage.complete) return fail("RECIPE_ASSEMBLY_INCOMPLETE");
    return Object.freeze({ coverage, capturedAtUtc, asOfUtc });
  }
  async function coherent<T>(
    input: RecipeCoverageAssemblyRequest,
    work: (current: RecipeCoverageSnapshot) => Promise<T>,
    expected?: RecipeCoverageSnapshot,
  ): Promise<T> {
    if (sources.size !== recipeSourceFamilies.length) return fail("RECIPE_ASSEMBLY_INCOMPLETE");
    let callbackFailure:
      | RecipeCoverageError
      | RecipeCoverageAssemblyError
      | RecipeCoveragePublicationError
      | undefined;
    const preserve = (error: unknown) => {
      if (
        error instanceof RecipeCoverageError ||
        error instanceof RecipeCoverageAssemblyError ||
        error instanceof RecipeCoveragePublicationError
      )
        callbackFailure = error;
    };
    try {
      let authorityCalls = 0;
      const result = await authority.withAuthorizedScope(
        Object.freeze({ ...input, tenantReference: tenant, brandReference: brand }),
        async () => {
          if (++authorityCalls !== 1) return fail();
          const captured = new Map<RecipeSourceFamily, RecipeCoverageOwnerRead>();
          for (const family of recipeSourceFamilies) {
            const owner = sources.get(family);
            if (!owner) return fail("RECIPE_ASSEMBLY_INCOMPLETE");
            captured.set(family, read(await owner.capture(input), family, input.observedAtUtc));
          }
          async function hold(index: number, current: readonly RecipeSourceCoverage[]): Promise<T> {
            const family = recipeSourceFamilies[index];
            if (family === undefined) {
              const snapshot = parseRecipeCoverageSnapshot({
                tenantReference: tenant,
                brandReference: brand,
                sources: [...current],
              });
              try {
                if (expected) assertRecipeCoverageUnchanged(expected, snapshot);
                return await work(snapshot);
              } catch (error) {
                preserve(error);
                throw error;
              }
            }
            const owner = sources.get(family),
              before = captured.get(family);
            if (!owner || !before) return fail();
            let calls = 0;
            const result = await owner.withCurrent(input, before, async (value) => {
              if (++calls !== 1) return fail();
              let next: RecipeCoverageOwnerRead;
              try {
                next = read(value, family, input.observedAtUtc);
                // Use existing complete-snapshot equality contract to distinguish per-version conflicts.
                const beforeSources = recipeSourceFamilies.map((key) => {
                  const item = captured.get(key);
                  if (!item) return fail();
                  return item.coverage;
                });
                const beforeSnapshot = {
                  tenantReference: tenant,
                  brandReference: brand,
                  sources: beforeSources,
                };
                assertRecipeCoverageUnchanged(beforeSnapshot, {
                  ...beforeSnapshot,
                  sources: beforeSources.map((item) =>
                    item.family === family ? next.coverage : item,
                  ),
                });
                if (next.capturedAtUtc !== before.capturedAtUtc) return fail();
              } catch (error) {
                preserve(error);
                throw error;
              }
              return hold(index + 1, [...current, next.coverage]);
            });
            if (calls !== 1) return fail();
            return result;
          }
          return hold(0, []);
        },
      );
      if (authorityCalls !== 1) return fail();
      return result;
    } catch (error) {
      if (callbackFailure) throw callbackFailure;
      if (error instanceof RecipeCoverageError || error instanceof RecipeCoverageAssemblyError)
        throw error;
      return fail();
    }
  }
  return Object.freeze({
    async capture(value: unknown): Promise<RecipeCoverageSnapshot> {
      return coherent(request(value), async (current) => current);
    },
    /** Internal authorized service metadata read; retains the existing Build purpose contract. */
    async withCurrentCoverage<T>(
      value: unknown,
      work: (current: RecipeCoverageSnapshot) => Promise<T>,
    ): Promise<T> {
      return coherent(request(value), work);
    },
    async withAuthorizedCurrentCoverage<T>(
      value: unknown,
      work: (current: unknown) => Promise<T>,
    ): Promise<T> {
      let input: RecipeCoverageAssemblyRequest, expected: RecipeCoverageSnapshot;
      try {
        const raw = object(value, [
          "generationReference",
          "actorReference",
          "purpose",
          "expectedRevision",
          "builtAt",
          "coverage",
        ]);
        parseRecipeReference(raw.generationReference);
        if (
          typeof raw.expectedRevision !== "string" ||
          !/^(?:0|[1-9][0-9]{0,18})$/u.test(raw.expectedRevision) ||
          BigInt(raw.expectedRevision) > 9223372036854775806n
        )
          return fail();
        input = request({
          actorReference: raw.actorReference,
          purpose: raw.purpose,
          observedAtUtc: raw.builtAt,
        });
        expected = parseRecipeCoverageSnapshot(raw.coverage);
        if (expected.tenantReference !== tenant || expected.brandReference !== brand) return fail();
      } catch {
        return fail("RECIPE_ASSEMBLY_INPUT_INVALID");
      }
      return coherent(input, work, expected);
    },
  });
}

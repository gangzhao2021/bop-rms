import { parseRecipeReference } from "../../domain/recipe.js";
import { RecipeWorkflowError } from "../../application/recipe-service.js";
import {
  parseRecipeReferenceSourceInstant,
  parseRecipeReferenceSourceRequest,
  parseRecipeOptionPublicationOriginalClock,
  validateRecipeOptionPublicationActivation,
  type RecipeOptionPublicationOriginalClock,
} from "../../contracts/recipe-reference-source.js";
import {
  assessRecipeOptionConsumptionYields,
  parseRecipeOptionConsumptionPins,
  recipeOptionConsumptionYieldFields,
  yieldList,
  yieldRecord,
} from "../../contracts/option-consumption-yield-source.js";
import {
  createPostgresRecipeReferenceSourceStore,
  type RecipeReferenceSourceOptions,
  type RecipeReferenceTransaction,
} from "./recipe-reference-source-store.js";
type Request = ReturnType<typeof parseRecipeReferenceSourceRequest>;
type Tx = RecipeReferenceTransaction;
export interface RecipeOptionConsumptionYieldOptions extends RecipeReferenceSourceOptions {
  readonly originalPublicationClock?: RecipeOptionPublicationOriginalClock;
  readonly yieldAuthority: {
    holdUntilTransactionCompletes(
      tx: Tx,
      input: {
        readonly tenantReference: string;
        readonly request: Request;
        readonly requiredFields: typeof recipeOptionConsumptionYieldFields;
        readonly permission: "recipe.manage";
        readonly requiredScope: "FullBrandScope";
        readonly versionReferences: readonly string[];
        readonly observedAt: string;
      },
    ): Promise<void>;
  };
}
const fail = (): never => {
  throw new RecipeWorkflowError("RECIPE_DEPENDENCY_UNAVAILABLE");
};
/** Owning minimal yield fields under the existing complete Recipe metadata holder.
 * Caller must roll back its UoW on any refusal. No Recipe mutations in callback. */
export function createPostgresRecipeOptionConsumptionYieldSource(
  options: RecipeOptionConsumptionYieldOptions,
) {
  const originalClockField = Object.getOwnPropertyDescriptor(options, "originalPublicationClock");
  if (
    ("originalPublicationClock" in options && !originalClockField) ||
    (originalClockField && (!originalClockField.enumerable || !("value" in originalClockField)))
  )
    return fail();
  const originalPublicationClock =
    originalClockField?.value === undefined
      ? undefined
      : parseRecipeOptionPublicationOriginalClock(originalClockField.value);
  const now = options.clock.now.bind(options.clock),
    hold = options.yieldAuthority.holdUntilTransactionCompletes.bind(options.yieldAuthority),
    run = options.transactions.run.bind(options.transactions),
    metadataHold = options.authority.holdUntilTransactionCompletes.bind(options.authority),
    tenantReference = parseRecipeReference(options.tenantReference),
    brandReference = parseRecipeReference(options.brandReference),
    actorReference = parseRecipeReference(options.actorReference),
    active = new WeakSet<object>(),
    failed = new WeakSet<object>();
  return Object.freeze({
    async withCurrentYields<T>(
      input: Request,
      value: unknown,
      activationInput: string,
      work: (
        v: ReturnType<typeof assessRecipeOptionConsumptionYields> & {
          readonly validUntil: string;
        },
      ) => Promise<T>,
    ): Promise<T> {
      let ownedTx: Tx | undefined,
        enteredTx = false;
      try {
        const request = parseRecipeReferenceSourceRequest(input),
          pins = parseRecipeOptionConsumptionPins(value),
          activationAt = parseRecipeReferenceSourceInstant(activationInput);
        validateRecipeOptionPublicationActivation(
          request,
          parseRecipeReferenceSourceInstant(now()),
          activationAt,
          originalPublicationClock,
        );
        if (typeof work !== "function") return fail();
        let tx: Tx | undefined,
          query: Tx["query"] | undefined,
          until: string | undefined = originalPublicationClock?.validUntil,
          latest = parseRecipeReferenceSourceInstant(now()),
          entered = 0,
          completed = false,
          answer: T | undefined;
        const check = () => {
          const at = parseRecipeReferenceSourceInstant(now());
          if (
            (tx && failed.has(tx)) ||
            at < latest ||
            (until && at >= until) ||
            (tx && tx.query !== query)
          )
            return fail();
          latest = at;
          return at;
        };
        const source = createPostgresRecipeReferenceSourceStore({
          tenantReference,
          brandReference,
          actorReference,
          authority: { holdUntilTransactionCompletes: metadataHold },
          clock: { now: check },
          transactions: {
            run: async (action) =>
              run(async (actual) => {
                if (++entered !== 1 || active.has(actual) || failed.has(actual)) {
                  failed.add(actual);
                  return fail();
                }
                ownedTx = actual;
                active.add(actual);
                enteredTx = true;
                tx = actual;
                query = actual.query;
                return action(actual);
              }),
          },
        });
        const result = await source.withCurrentSnapshot(request, async (metadata) => {
          if (!tx || !query) return fail();
          const actual = tx,
            sql = query.bind(actual);
          until = new Date(
            Math.min(
              Date.parse(metadata.observedAt) + 5000,
              originalPublicationClock === undefined
                ? Infinity
                : Date.parse(originalPublicationClock.validUntil),
            ),
          ).toISOString();
          check();
          const versionReferences = Object.freeze(
            [...new Set(pins.map((p) => p.versionReference))].sort(),
          );
          const authorize = async () => {
            const at = check();
            await hold(
              actual,
              Object.freeze({
                tenantReference,
                request,
                requiredFields: recipeOptionConsumptionYieldFields,
                permission: "recipe.manage" as const,
                requiredScope: "FullBrandScope" as const,
                versionReferences,
                observedAt: at,
              }),
            );
            check();
          };
          await authorize();
          const read = async () => {
            check();
            const response = await sql(
              `SELECT jsonb_build_object('items',COALESCE(jsonb_agg(jsonb_build_object(
'recipeReference',v.recipe_id,'versionReference',v.recipe_version_id,'versionNumber',v.version_number::text,'snapshotDigest',v.snapshot_digest,
'yieldQuantityMicrounits',v.yield_quantity_microunits::text,'yieldUnitCode',v.yield_unit_code,'yieldDimension',v.yield_dimension,
'precise',date_trunc('milliseconds',v.created_at)=v.created_at AND v.created_at<=statement_timestamp()
) ORDER BY v.recipe_version_id),'[]'::jsonb)) AS yields
FROM rms_recipe.recipe_version v WHERE v.brand_id=$1 AND v.recipe_version_id=ANY($2::uuid[])`,
              [request.brandReference, versionReferences],
            );
            const rows = yieldList(response.rows);
            if (rows.length !== 1) return fail();
            const raw = yieldRecord(rows[0], ["yields"]),
              body = yieldRecord(raw.yields, ["items"]);
            return assessRecipeOptionConsumptionYields(
              pins,
              body.items,
              metadata,
              request,
              check(),
              activationAt,
              originalPublicationClock,
            );
          };
          const assessed = await read();
          await authorize();
          answer = await work(Object.freeze({ ...assessed, validUntil: until }));
          completed = true;
          check();
          await authorize();
          const current = await read();
          if (
            current.yieldSourceDigest !== assessed.yieldSourceDigest ||
            current.ownerSourceDigest !== assessed.ownerSourceDigest
          )
            return fail();
          check();
          return answer;
        });
        if (entered !== 1 || !completed || !Object.is(result, answer)) return fail();
        check();
        return result;
      } catch {
        if (ownedTx) failed.add(ownedTx);
        return fail();
      } finally {
        if (enteredTx && ownedTx) active.delete(ownedTx);
      }
    },
  });
}

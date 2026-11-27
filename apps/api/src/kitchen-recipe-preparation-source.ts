import type { ConsumerTransaction } from "@bop/eventing";
import {
  parseKitchenPreparationRequest,
  parseKitchenPreparationEvidenceSet,
  createKitchenPreparationEvidenceSetDigestBinding,
  parseKitchenTicketReference,
  parseKitchenTicketDigest,
  type ResolveRecipePreparationEvidenceInput,
} from "@rms/kitchen";
import type { createPostgresConfiguredRecipePreparationSource } from "@rms/recipe";

/** Same caller transaction must survive through Kitchen persistence; no driver or SQL here. */
export function createKitchenRecipePreparationSource(options: {
  readonly brandReference: string;
  readonly storeReference: string;
  readonly recipe: Pick<
    ReturnType<typeof createPostgresConfiguredRecipePreparationSource>,
    "resolve"
  >;
  readonly authorize: (
    tx: ConsumerTransaction,
    query: ResolveRecipePreparationEvidenceInput,
  ) => Promise<boolean>;
  readonly sha256: (value: string) => string;
  readonly deriveReference: (
    purpose: "RecipeKitchenPreparation" | "RecipeKitchenEvidence",
    identity: string,
  ) => string;
}) {
  const brand = parseKitchenTicketReference(options.brandReference);
  const store = parseKitchenTicketReference(options.storeReference);
  return Object.freeze({
    async resolve(transaction: ConsumerTransaction, value: ResolveRecipePreparationEvidenceInput) {
      try {
        const query = parseKitchenPreparationRequest(value);
        if (
          query.brandReference !== brand ||
          query.storeReference !== store ||
          !(await options.authorize(transaction, query))
        )
          return null;
        const items = [];
        for (const item of query.items) {
          const resolved = await options.recipe.resolve(transaction, {
            actorType: "System",
            actorReference: null,
            action: "ResolveConfiguredRecipePreparation",
            purpose: "CreateKitchenWork",
            brandReference: brand,
            storeReference: store,
            skuReference: item.skuReference,
            effectiveAt: query.effectiveAt,
            selectedOptions: item.selectedOptions,
          });
          if (
            String(resolved.brandReference) !== brand ||
            String(resolved.storeReference) !== store ||
            String(resolved.skuReference) !== item.skuReference ||
            resolved.effectiveAt !== query.effectiveAt
          )
            return null;
          const identity = JSON.stringify({
            brandReference: brand,
            storeReference: store,
            sourceEvidenceReference: query.sourceEvidenceReference,
            sourceEvidenceVersion: query.sourceEvidenceVersion,
            sourceEvidenceDigest: query.sourceEvidenceDigest,
            effectiveAt: query.effectiveAt,
            item,
            bindingReference: resolved.bindingReference,
            publicationReferences: resolved.publicationReferences,
            preparation: resolved.preparation,
            display: resolved.display,
          });
          items.push({
            ...item,
            preparationReference: parseKitchenTicketReference(
              options.deriveReference("RecipeKitchenPreparation", identity),
            ),
            preparationVersion: 1,
            preparationDigest: parseKitchenTicketDigest(options.sha256(identity)),
            instructions: resolved.display.instructions,
            requiredStationCapabilityReferences:
              resolved.display.requiredStationCapabilityReferences,
          });
        }
        const identity = JSON.stringify({
          brandReference: brand,
          storeReference: store,
          effectiveAt: query.effectiveAt,
          items,
        });
        const evidence = {
          evidenceReference: options.deriveReference("RecipeKitchenEvidence", identity),
          evidenceVersion: 1,
          evidenceDigest: options.sha256(identity),
          brandReference: brand,
          storeReference: store,
          effectiveAt: query.effectiveAt,
          items,
        };
        return parseKitchenPreparationEvidenceSet({
          ...evidence,
          evidenceDigest: options.sha256(
            createKitchenPreparationEvidenceSetDigestBinding(evidence),
          ),
        });
      } catch {
        return null;
      }
    },
  });
}

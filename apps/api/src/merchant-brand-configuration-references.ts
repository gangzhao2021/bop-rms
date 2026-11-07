import { canonicalizeRfc8785 } from "@bop/audit";
import { createPostgresPlatformTemplateBrandReferenceSource } from "@bop/publishing";
import { BrandConfigurationOperationError, type BrandConfigurationActorScope } from "@bop/tenant";
import {
  brandCatalogSourceRequiredFields,
  createPostgresBrandAdministrationCatalogSourceStore,
  parseBrandCatalogSourceScope,
  type BrandAdministrationCatalogSourceStoreOptions,
} from "@rms/catalog";
import type { MerchantBrandConfigurationOrdinaryOptions } from "./merchant-brand-configuration-ordinary.js";

const unavailable = (): never => {
  throw new BrandConfigurationOperationError("BRAND_CONFIGURATION_DEPENDENCY_UNAVAILABLE");
};
const equalScope = (left: BrandConfigurationActorScope, right: BrandConfigurationActorScope) =>
  left.tenantReference === right.tenantReference &&
  left.brandReference === right.brandReference &&
  left.actorReference === right.actorReference;

/** Concrete owning references for ordinary Brand configuration. Authority comes
 * from the actual current administrative host; no material/qualification port
 * can be supplied by a browser or substituted with a permissive result. */
export function createMerchantBrandConfigurationReferences(options: {
  readonly now: () => string;
}): MerchantBrandConfigurationOrdinaryOptions["configure"] {
  const now = options.now;
  if (typeof now !== "function") return unavailable();
  return (tx, inputScope, host) => {
    const scope = Object.freeze({ ...parseBrandCatalogSourceScope(inputScope) });
    const query = tx.query,
      hold = host.holdCurrentBrandAdministration,
      before = host.registerBeforeCommit,
      after = host.registerAfterCommit;
    let used = false,
      completed = false,
      failed = false;
    const check = () => {
      if (
        failed ||
        options.now !== now ||
        tx.query !== query ||
        !equalScope(scope, inputScope) ||
        host.holdCurrentBrandAdministration !== hold ||
        host.registerBeforeCommit !== before ||
        host.registerAfterCommit !== after
      )
        return unavailable();
    };
    const clock = Object.freeze({
      now: () => {
        check();
        return now.call(options);
      },
    });
    return {
      references: {
        async withCurrentReferences(actual, input, work) {
          try {
            check();
            if (used || actual !== tx || !equalScope(input.command, scope)) return unavailable();
            used = true;
            await before.call(
              host,
              tx,
              async () => {
                check();
                if (!completed) return unavailable();
              },
              check,
            );
            // A nonnull Theme requires its real owning material. Absence is
            // represented only when the actual configuration also selects null.
            if (input.configuration.mediaThemeReference !== null) return unavailable();
            const holdAuthority = async (
              actualTx: typeof tx,
              request: {
                readonly scope: BrandConfigurationActorScope;
                readonly purposeCode: string;
                readonly permission: string;
                readonly observedAt: string;
                readonly validUntil: string;
              },
            ) => {
              check();
              if (
                actualTx !== tx ||
                !equalScope(request.scope, scope) ||
                request.purposeCode !== "BRAND_ADMINISTRATION" ||
                request.permission !== "organization.manage" ||
                request.observedAt < input.observedAt ||
                request.validUntil > input.validUntil
              )
                return unavailable();
              const answer = await hold.call(host, tx, {
                scope,
                observedAt: request.observedAt,
                validUntil: request.validUntil,
              });
              check();
              return answer;
            };
            const register: typeof before = (actualTx, guard, final) => {
              check();
              if (actualTx !== tx) return unavailable();
              return before.call(host, tx, guard, final);
            };
            const templates = createPostgresPlatformTemplateBrandReferenceSource({
              transaction: tx,
              scope,
              clock,
              originalObservedAt: input.observedAt,
              originalValidUntil: input.validUntil,
              authority: { holdUntilTransactionCompletes: holdAuthority },
              registerBeforeCommit: register,
            });
            const catalogue = createPostgresBrandAdministrationCatalogSourceStore({
              ...scope,
              // Catalog's legacy transport type declares parsed rows; its owner
              // actually validates every unknown SQL result before use. Retain
              // this exact outer transaction, without wrapping or replacing it.
              transaction: tx as BrandAdministrationCatalogSourceStoreOptions["transaction"],
              clock,
              originalObservedAt: input.observedAt,
              originalValidUntil: input.validUntil,
              registerBeforeCommit: register,
              // This composition exposes only exact reads of the owning registry.
              nextReference: unavailable,
              appendAudit: async () => unavailable(),
              authority: {
                async holdUntilTransactionCompletes(actualTx, request) {
                  if (
                    request.mode !== "Read" ||
                    request.original !== null ||
                    canonicalizeRfc8785(request.requiredFields) !==
                      canonicalizeRfc8785(brandCatalogSourceRequiredFields)
                  )
                    return unavailable();
                  return holdAuthority(actualTx, { ...request, scope: request });
                },
              },
            });
            after.call(host, tx, () => templates.assertFinalized());
            after.call(host, tx, () => catalogue.assertFinalized());
            const selected = await templates.current({
              templateVersionReference: input.configuration.platformTemplateReference,
            });
            check();
            if (!selected.reference) {
              throw new BrandConfigurationOperationError("BRAND_CONFIGURATION_VERSION_CONFLICT");
            }
            const material = selected.reference.template;
            const catalog = await catalogue.exact(input.configuration.catalogSourceReference);
            check();
            const result = await work(
              Object.freeze({
                catalog,
                template: Object.freeze({
                  reference: material.templateVersionReference,
                  digest: material.contentDigest,
                  supportedLocales: material.content.supportedLocales,
                  overrideAllowedFieldCodes: material.content.overrideAllowedFieldCodes,
                  hardRequirementFieldCodes: material.content.hardRequirementFieldCodes,
                  effectiveFrom: material.content.effectiveFrom,
                  effectiveUntil: material.content.effectiveUntil,
                }),
                theme: null,
              }),
              tx,
            );
            check();
            completed = true;
            return result;
          } catch (error) {
            failed = true;
            throw error;
          }
        },
      },
    };
  };
}

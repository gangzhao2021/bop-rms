import { canonicalizeRfc8785 } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import { CatalogError, parseCatalogInstant, parseCatalogReference } from "@rms/catalog";
import { createCurrentPublishedProductOptionBindingSource } from "./current-published-product-option-binding-source.js";
import { currentProductPolicyFields } from "./current-product-publication-policy.js";
import type { ProductPublicationContentPolicyAuthorityInput } from "./current-product-publication-content-policy.js";
import {
  buildMerchantProductPublicationBusinessConfiguration,
  createMerchantProductPublicationBusinessPolicy,
} from "./merchant-product-publication-business-policy.js";
import {
  createMerchantProductPublicationSources,
  type MerchantProductPublicationSourcesConfiguration,
} from "./merchant-product-publication-sources.js";
import { createMerchantProductPublicationRuntimeAuthority } from "./merchant-product-publication-runtime-authority.js";
import type { MerchantProductPublicationSourceFactoryV2Input } from "./merchant-product-publication-command-v2.js";
import type { MerchantProductWarningAcknowledgementSourceFactoryInput } from "./merchant-product-publication-warning-acknowledgement-command.js";

type Host =
  | MerchantProductPublicationSourceFactoryV2Input
  | MerchantProductWarningAcknowledgementSourceFactoryInput;
type Factories = ReturnType<typeof createMerchantProductPublicationSources>;
export interface MerchantProductPublicationRuntimeSourcesOptions {
  readonly contentPolicy: Pick<
    MerchantProductPublicationSourcesConfiguration["contentPolicy"],
    "configurationVersionReference" | "expectedBrandVersion" | "policyReference" | "policyVersion"
  >;
  readonly evidenceReference: MerchantProductPublicationSourcesConfiguration["evidenceReference"];
  readonly reviewReference: MerchantProductPublicationSourcesConfiguration["reviewReference"];
}
const unavailable = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
const version = (value: unknown) => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 2147483647)
    return unavailable();
  return value;
};

/** Ordinary runtime composition. Selectors identify owning data; they are not
 * permission or proof of publication. Current User authorization comes only
 * from the command host, which also owns the Screen gate, including replay. */
export function createMerchantProductPublicationRuntimeSources(
  options: MerchantProductPublicationRuntimeSourcesOptions,
): Factories {
  const raw = readClosedRecord(options, ["contentPolicy", "evidenceReference", "reviewReference"]),
    selected = readClosedRecord(raw.contentPolicy, [
      "configurationVersionReference",
      "expectedBrandVersion",
      "policyReference",
      "policyVersion",
    ]);
  if (typeof raw.evidenceReference !== "function" || typeof raw.reviewReference !== "function")
    return unavailable();
  const contentPolicy = Object.freeze({
      configurationVersionReference: parseCatalogReference(selected.configurationVersionReference),
      expectedBrandVersion: version(selected.expectedBrandVersion),
      policyReference: parseCatalogReference(selected.policyReference),
      policyVersion: version(selected.policyVersion),
    }),
    evidenceReference = options.evidenceReference.bind(options),
    reviewReference = options.reviewReference.bind(options);
  function forHost(host: Host): Factories {
    if (
      typeof host.capability?.holdUntilCommit !== "function" ||
      typeof host.currentAuthorization?.authorizeActions !== "function" ||
      typeof host.currentAuthorization.withCurrentStoreScope !== "function" ||
      typeof host.currentAuthorization.assertCurrent !== "function" ||
      typeof host.clock?.now !== "function" ||
      typeof host.transaction?.query !== "function" ||
      typeof host.registerBeforeCommit !== "function"
    )
      return unavailable();
    const currentPublished = createCurrentPublishedProductOptionBindingSource({
        transaction: host.transaction,
        tenantReference: host.tenantReference,
        brandReference: host.brandReference,
        storeReference: host.storeReference,
        actorReference: host.actorReference,
        sessionReference: host.sessionReference,
        clock: host.clock,
        originalValidUntil: host.originalValidUntil,
        currentAuthorization: host.currentAuthorization,
        capability: host.capability,
        registerBeforeCommit: host.registerBeforeCommit,
        events: { generateReference: () => unavailable() },
      }),
      authority = createMerchantProductPublicationRuntimeAuthority(host),
      tx = host.transaction,
      query = tx.query,
      now = host.clock.now.bind(host.clock),
      command = canonicalizeRfc8785(host.command),
      hostDeadline = parseCatalogInstant(host.originalValidUntil),
      holdPolicy = authority.contentPolicy.policyAuthority.holdUntilTransactionCompletes.bind(
        authority.contentPolicy.policyAuthority,
      );
    let started = false,
      poisoned = false;
    const fail = (): never => {
      poisoned = true;
      return unavailable();
    };
    const businessPolicy = createMerchantProductPublicationBusinessPolicy({
      clock: { now },
      configurations: {
        async withCurrentConfiguration(actual, input, work) {
          if (started) return fail();
          started = true;
          let active = true,
            ready = false,
            guardComplete = false,
            guardCalls = 0,
            finalCalls = 0,
            latest = "",
            deadline = hostDeadline;
          const check = () => {
            let at: string;
            try {
              at = parseCatalogInstant(now());
            } catch {
              return fail();
            }
            if (poisoned || tx.query !== query || (latest !== "" && at < latest) || at >= deadline)
              return fail();
            latest = at;
            return at;
          };
          let packet: ProductPublicationContentPolicyAuthorityInput | undefined;
          const hold = async () => {
            check();
            if (!packet || (await holdPolicy(tx, packet)) !== undefined) return fail();
            check();
          };
          try {
            // This is registered with the business source's collected guards;
            // its host guard already poisons failures before this acquisition.
            await input.registerBeforeCommit(
              tx,
              async () => {
                try {
                  if (++guardCalls !== 1 || !ready || active) return fail();
                  await hold();
                  guardComplete = true;
                } catch (error) {
                  poisoned = true;
                  throw error;
                }
              },
              () => {
                if (++finalCalls !== 1 || guardCalls !== 1 || !guardComplete || !ready || active)
                  return fail();
                check();
              },
            );
            const { context, policy } = input;
            if (
              actual !== tx ||
              canonicalizeRfc8785(context.command) !== command ||
              context.tenantReference !== host.tenantReference ||
              context.brandReference !== host.brandReference ||
              context.actorReference !== host.actorReference ||
              context.actorKind !== "User"
            )
              return fail();
            latest = parseCatalogInstant(context.observedAt);
            deadline =
              [
                hostDeadline,
                parseCatalogInstant(context.validUntil),
                parseCatalogInstant(policy.validUntil),
              ].sort()[0] ?? fail();
            check();
            // The enclosing real content-policy source holds the immutable
            // Published policy and its family lock through this callback/COMMIT.
            // Fixed Catalog rule semantics remain explicit in their own digest;
            // no separate configuration UUID or persisted parameter is invented.
            const configuration = buildMerchantProductPublicationBusinessConfiguration({
              context,
              policy,
              configurationReference: policy.content.policyReference,
              configurationRevision: policy.content.policyVersion,
            });
            packet = Object.freeze({
              command: context.command,
              actorKind: context.actorKind,
              purposeCode: context.command.purposeCode,
              originalIntentDigest: context.originalIntentDigest,
              replacementIntentDigest: context.replacementIntentDigest,
              tenantReference: context.tenantReference,
              brandReference: context.brandReference,
              actorReference: context.actorReference,
              policyReference: policy.content.policyReference,
              policyVersion: policy.content.policyVersion,
              requiredFields: currentProductPolicyFields,
              observedAt: context.observedAt,
              validUntil: deadline,
            });
            await hold();
            const result = await work(
              Object.freeze({ ...configuration, validUntil: deadline }),
              tx,
            );
            await hold();
            active = false;
            ready = true;
            return result;
          } catch (error) {
            poisoned = true;
            if (error instanceof CatalogError) throw error;
            return unavailable();
          }
        },
      },
    });
    return createMerchantProductPublicationSources({
      ...authority,
      options: { ...authority.options, currentPublished },
      contentPolicy: { ...authority.contentPolicy, ...contentPolicy },
      evidenceReference,
      reviewReference,
      businessPolicy,
    });
  }
  return Object.freeze({
    publication: (host) => forHost(host).publication(host),
    acknowledgement: (host) => forHost(host).acknowledgement(host),
  });
}

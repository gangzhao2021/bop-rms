import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import { createPostgresTenantBrandConfigurationContentSource } from "@bop/tenant";
import {
  CatalogError,
  assessCatalogProductContentPolicy,
  copyCategoryPersistenceValue,
  parseCatalogInstant,
  parseCatalogReference,
  parseProductPublicationCommand,
  type CatalogCurrentProductValidationCandidate,
  type CatalogProductContentPolicyAssessment,
} from "@rms/catalog";
import { createCurrentBrandConfigurationContentSource } from "./current-brand-configuration-content.js";
import type { CurrentProductPublicationPolicy } from "./current-product-publication-policy.js";
type BrandOptions = Parameters<typeof createPostgresTenantBrandConfigurationContentSource>[0];
export interface HeldProductContentPolicyConfiguration {
  readonly configurationVersionReference: string;
  readonly expectedBrandVersion: number;
  readonly brandAuthority: BrandOptions["authority"];
}
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
/** Internal stage: caller retains actual Candidate and Policy owner callbacks
 * through the same outer COMMIT. Server selectors never supply source authority. */
export function createCurrentProductHeldContentPolicySource(
  configuration: HeldProductContentPolicyConfiguration,
  clock: { now(): string },
) {
  const reference = parseCatalogReference(configuration.configurationVersionReference),
    version = configuration.expectedBrandVersion;
  if (
    !Number.isSafeInteger(version) ||
    version < 1 ||
    version > 2147483647 ||
    typeof configuration.brandAuthority?.withCurrentContentRead !== "function" ||
    typeof configuration.brandAuthority?.isCurrent !== "function" ||
    typeof clock?.now !== "function"
  )
    return fail();
  const read = configuration.brandAuthority.withCurrentContentRead.bind(
      configuration.brandAuthority,
    ),
    current = configuration.brandAuthority.isCurrent.bind(configuration.brandAuthority),
    now = clock.now.bind(clock),
    failed = new WeakSet<object>(),
    active = new WeakSet<object>();
  return Object.freeze({
    async withHeldAssessment<T>(
      tx: Parameters<BrandOptions["authority"]["isCurrent"]>[0],
      commandValue: unknown,
      candidate: CatalogCurrentProductValidationCandidate,
      policy: CurrentProductPublicationPolicy,
      work: (value: CatalogProductContentPolicyAssessment) => Promise<T>,
    ): Promise<T> {
      let entered = false;
      try {
        if (
          !tx ||
          typeof tx !== "object" ||
          typeof tx.query !== "function" ||
          failed.has(tx) ||
          active.has(tx)
        )
          return fail();
        active.add(tx);
        entered = true;
        const command = parseProductPublicationCommand(copyCategoryPersistenceValue(commandValue)),
          heldPolicy = readClosedRecord(copyCategoryPersistenceValue(policy), [
            "content",
            "currentPublicationReference",
            "observedAt",
            "validUntil",
          ]) as unknown as CurrentProductPublicationPolicy,
          query = tx.query,
          observedAt = parseCatalogInstant(now());
        let latest = observedAt,
          deadline =
            [candidate.validUntil, heldPolicy.validUntil].map(parseCatalogInstant).sort()[0] ??
            fail();
        const check = () => {
          const at = parseCatalogInstant(now());
          if (failed.has(tx) || tx.query !== query || at < latest || at >= deadline) return fail();
          latest = at;
        };
        if (
          command.action !== "Validate" ||
          command.actorKind !== "User" ||
          candidate.profile !== "CatalogProductValidationCandidateV1" ||
          candidate.completeContent !== "Present" ||
          candidate.tenantReference !== command.tenantReference ||
          candidate.brandReference !== command.brandReference ||
          candidate.actorReference !== command.actorReference ||
          candidate.aggregate.productReference !== command.productReference ||
          candidate.aggregate.draft.versionReference !== command.versionReference ||
          candidate.aggregate.aggregateVersion !== command.expectedProductAggregateVersion ||
          candidate.contentDigest !== command.contentDigest ||
          candidate.configurationDigest !== command.configurationDigest ||
          candidate.originalIntentDigest !== "sha256:" + sha256Hex(canonicalizeRfc8785(command)) ||
          observedAt < candidate.observedAt ||
          observedAt < heldPolicy.observedAt ||
          heldPolicy.content.tenantReference !== command.tenantReference ||
          heldPolicy.content.brandReference !== command.brandReference
        )
          return fail();
        parseCatalogReference(heldPolicy.currentPublicationReference);
        const candidateStart = parseCatalogInstant(candidate.observedAt),
          policyStart = parseCatalogInstant(heldPolicy.observedAt),
          candidateUntil = parseCatalogInstant(candidate.validUntil),
          policyUntil = parseCatalogInstant(heldPolicy.validUntil);
        if (
          candidateUntil <= candidateStart ||
          policyUntil <= policyStart ||
          Date.parse(candidateUntil) - Date.parse(candidateStart) > 30000 ||
          Date.parse(policyUntil) - Date.parse(policyStart) > 30000
        )
          return fail();
        check();
        const source = createCurrentBrandConfigurationContentSource(
          createPostgresTenantBrandConfigurationContentSource({
            brandReference: command.brandReference,
            clock: () => {
              check();
              return latest;
            },
            transactions: { run: (work) => work(tx) },
            authority: { withCurrentContentRead: read, isCurrent: current },
          }),
        );
        let calls = 0,
          finished = false,
          completed: T | undefined;
        const result = await source.withCurrentContent(
          {
            tenantReference: command.tenantReference,
            brandReference: command.brandReference,
            actorReference: command.actorReference,
            purposeCode: "CATALOG_PRODUCT_CONTENT",
            configurationVersionReference: reference,
            expectedBrandVersion: version,
            originalIntentDigest: candidate.originalIntentDigest,
            observedAt,
            validUntil: deadline,
          },
          async (brand, actual) => {
            if (
              ++calls !== 1 ||
              actual !== tx ||
              brand.brandVersion !== version ||
              brand.configurationVersionReference !== reference
            )
              return fail();
            deadline = [deadline, parseCatalogInstant(brand.validUntil)].sort()[0] ?? fail();
            check();
            const assessment = assessCatalogProductContentPolicy(
              candidate.aggregate,
              {
                tenantReference: brand.tenantReference,
                brandReference: brand.brandReference,
                brandVersion: brand.brandVersion,
                configurationVersionReference: brand.configurationVersionReference,
                contentDigest: brand.contentDigest,
                currentPublicationReference: brand.currentPublicationReference,
                supportedLocales: brand.supportedLocales,
                originalIntentDigest: brand.originalIntentDigest,
                observedAt: brand.observedAt,
                validUntil: brand.validUntil,
              },
              heldPolicy.content,
              {
                tenantReference: command.tenantReference,
                productReference: command.productReference,
                versionReference: command.versionReference,
                expectedAggregateVersion: command.expectedProductAggregateVersion,
                contentDigest: command.contentDigest,
                configurationDigest: command.configurationDigest,
                originalIntentDigest: candidate.originalIntentDigest,
                observedAt,
                validUntil: deadline,
              },
            );
            deadline = assessment.validUntil;
            check();
            const value = await work(assessment);
            check();
            finished = true;
            completed = value;
            return value;
          },
        );
        if (calls !== 1 || !finished || !Object.is(result, completed)) return fail();
        check();
        return result;
      } catch (error) {
        if (tx && typeof tx === "object") failed.add(tx);
        if (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED")
          throw error;
        return fail();
      } finally {
        if (entered) active.delete(tx);
      }
    },
  });
}

import {
  parseTenantBrandConfigurationContentRequest,
  parseTenantRecordedBrandConfiguration,
  tenantBrandConfigurationContentDigest,
  type createPostgresTenantBrandConfigurationContentSource,
  type TenantBrandConfigurationContentRequest,
  type TenantBrandConfigurationTransaction,
} from "@bop/tenant";
import {
  createPostgresPublishingMutationStore,
  createPublishingScope,
  parsePublishingReference,
} from "@bop/publishing";

type Source = ReturnType<typeof createPostgresTenantBrandConfigurationContentSource>;
const unavailable = (): never => {
  throw new Error("CURRENT_BRAND_CONFIGURATION_UNAVAILABLE");
};
/** Compose owning public queries only; no private Tenant/Publishing access or permission default. */
export function createCurrentBrandConfigurationContentSource(recordedSource: Source) {
  return Object.freeze({
    async withCurrentContent<T>(
      input: TenantBrandConfigurationContentRequest,
      work: (
        content: CurrentBrandConfigurationContent,
        tx: TenantBrandConfigurationTransaction,
      ) => Promise<T>,
    ): Promise<T> {
      try {
        const request = parseTenantBrandConfigurationContentRequest(input);
        return await recordedSource.withRecordedConfiguration(request, async (recorded, tx) => {
          const c = parseTenantRecordedBrandConfiguration(recorded.configuration);
          if (
            recorded.profile !== "TenantRecordedBrandConfigurationV1" ||
            recorded.currentPublication !== "NotEvaluated" ||
            recorded.brandVersion !== request.expectedBrandVersion ||
            recorded.observedAt !== request.observedAt ||
            recorded.validUntil !==
              (c.effectiveUntil !== null && c.effectiveUntil < request.validUntil
                ? c.effectiveUntil
                : request.validUntil) ||
            c.brandReference !== request.brandReference ||
            c.configurationVersionReference !== request.configurationVersionReference ||
            c.lifecycle !== "Published" ||
            c.publicationReference === null ||
            c.approvedByReference === null ||
            c.approvalEvidenceReference === null ||
            recorded.contentDigest !== tenantBrandConfigurationContentDigest(c)
          )
            return unavailable();
          const owner = createPostgresPublishingMutationStore(
            { run: async (work) => work(tx) },
            request.tenantReference,
            createPublishingScope({
              kind: "Brand",
              brandReference: c.brandReference,
              storeReference: null,
            }),
          );
          const source = await owner.resolveCurrentReleaseForReference({
            publicationReference: c.publicationReference,
            configurationType: "BRAND_CONFIGURATION",
            purposeCode: "BRAND_CONFIGURATION",
            observedAt: request.observedAt,
          });
          if (
            source.recorded.release.snapshotReference !==
              parsePublishingReference(c.configurationVersionReference) ||
            source.recorded.validationEvidence.checkedAt < c.createdAt ||
            source.recorded.validationEvidence.checkedAt >
              source.recorded.approvalEvidence.approvedAt ||
            source.recorded.approvalEvidence.approvedAt > source.recorded.release.createdAt ||
            source.recorded.release.createdAt > c.updatedAt ||
            source.recorded.release.snapshotDigest !== recorded.contentDigest ||
            source.recorded.approvalEvidence.evidenceReference !==
              parsePublishingReference(c.approvalEvidenceReference) ||
            source.recorded.approvalEvidence.approvedActorReference !==
              parsePublishingReference(c.approvedByReference)
          )
            return unavailable();
          return await work(
            Object.freeze({
              profile: "CurrentBrandConfigurationContentV1",
              tenantReference: request.tenantReference,
              brandReference: c.brandReference,
              brandVersion: recorded.brandVersion,
              configurationVersionReference: c.configurationVersionReference,
              configurationVersion: c.configurationVersion,
              contentDigest: recorded.contentDigest,
              originalPublicationReference: c.publicationReference,
              currentPublicationReference: source.current.release.releaseId,
              defaultLocale: c.defaultLocale,
              supportedLocales: c.supportedLocales,
              overrideAllowedFieldCodes: c.overrideAllowedFieldCodes,
              hardRequirementFieldCodes: c.hardRequirementFieldCodes,
              catalogSourceReference: c.catalogSourceReference,
              platformTemplateReference: c.platformTemplateReference,
              effectiveFrom: c.effectiveFrom,
              effectiveUntil: c.effectiveUntil,
              originalIntentDigest: request.originalIntentDigest,
              observedAt: request.observedAt,
              validUntil: recorded.validUntil,
              eligibility: "NotEvaluated",
            }),
            tx,
          );
        });
      } catch {
        return unavailable();
      }
    },
  });
}
export interface CurrentBrandConfigurationContent {
  readonly profile: "CurrentBrandConfigurationContentV1";
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly brandVersion: number;
  readonly configurationVersionReference: string;
  readonly configurationVersion: number;
  readonly contentDigest: string;
  readonly originalPublicationReference: string;
  readonly currentPublicationReference: string;
  readonly defaultLocale: string;
  readonly supportedLocales: readonly string[];
  readonly overrideAllowedFieldCodes: readonly string[];
  readonly hardRequirementFieldCodes: readonly string[];
  readonly catalogSourceReference: string;
  readonly platformTemplateReference: string;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
  readonly originalIntentDigest: string;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly eligibility: "NotEvaluated";
}

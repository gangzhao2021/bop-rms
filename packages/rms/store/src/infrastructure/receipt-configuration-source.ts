import { createPostgresStoreBusinessDateSource } from "./persistence/business-date-source.js";
import { createPostgresCurrentStorePublicationProof } from "./current-publication-proof.js";
type ProofOptions = Parameters<typeof createPostgresCurrentStorePublicationProof>[0];
type Transaction = Parameters<ReturnType<typeof createPostgresCurrentStorePublicationProof>>[0];
type Proof = Awaited<ReturnType<ReturnType<typeof createPostgresCurrentStorePublicationProof>>>;

/** Resolves the current Store receipt binding, not a caller-picked historic configuration.
 * Store selection and Publishing/approval/Live Gate fences remain in the caller transaction.
 * This proves the configured template reference; template publication/rendering is separate.
 */
export function createPostgresStoreReceiptConfigurationSource(
  options: Omit<ProofOptions, "configurationReference"> & { readonly timeZone: string },
) {
  return async (transaction: Transaction, observedAt: string) => {
    try {
      let selected: Proof | undefined;
      const read = createPostgresStoreBusinessDateSource({
        brandReference: options.brandReference,
        storeReference: options.storeReference,
        timeZone: options.timeZone,
        authorize: options.authorize,
        publicationProof: async (tx, candidate, at) => {
          const proof = await createPostgresCurrentStorePublicationProof({
            ...options,
            configurationReference: candidate.configurationReference,
          })(tx, at);
          const configuration = proof.configuration;
          if (
            configuration.configurationReference !== candidate.configurationReference ||
            configuration.configurationVersion !== candidate.configurationVersion ||
            configuration.timeZone !== candidate.timeZone ||
            configuration.businessDayStartLocalTime !== candidate.businessDayStartLocalTime ||
            configuration.publicationReference !== candidate.publicationReference ||
            configuration.approvalEvidenceReference !== candidate.approvalEvidenceReference ||
            configuration.liveGateEvidenceReference !== candidate.liveGateEvidenceReference
          )
            throw new Error("STORE_RECEIPT_CONFIGURATION_UNAVAILABLE");
          selected = proof;
          return proof;
        },
      });
      await read(transaction, observedAt);
      if (!selected) throw new Error("STORE_RECEIPT_CONFIGURATION_UNAVAILABLE");
      const configuration = selected.configuration;
      return Object.freeze({
        brandReference: configuration.brandReference,
        storeReference: configuration.storeReference,
        configurationReference: configuration.configurationReference,
        configurationVersion: configuration.configurationVersion,
        templateReference: configuration.receiptReference,
        locale: configuration.defaultLocale,
        currencyCode: configuration.currencyCode,
        publicationReference: configuration.publicationReference,
        contentDigest: selected.contentDigest,
        observedAt: selected.observedAt,
      });
    } catch {
      throw new Error("STORE_RECEIPT_CONFIGURATION_UNAVAILABLE");
    }
  };
}

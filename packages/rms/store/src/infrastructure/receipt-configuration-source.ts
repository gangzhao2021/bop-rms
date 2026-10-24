import { createPostgresStoreBusinessDateSource } from "./persistence/business-date-source.js";
import { createPostgresCurrentStorePublicationProof } from "./current-publication-proof.js";
type ProofOptions = Parameters<typeof createPostgresCurrentStorePublicationProof>[0];
type Transaction = Parameters<ReturnType<typeof createPostgresCurrentStorePublicationProof>>[0];
type Proof = Awaited<ReturnType<ReturnType<typeof createPostgresCurrentStorePublicationProof>>>;
export type CurrentStoreConfigurationSourceOptions = Omit<
  ProofOptions,
  "configurationReference"
> & {
  readonly timeZone: string;
};

/**
 * The Store configuration published and in force at `observedAt`, proved against its current
 * Publishing release, or a throw. Store selection and Publishing/approval/Live Gate fences remain
 * in the caller transaction; the caller rewrites every failure as its own unavailable code.
 */
async function readCurrentStoreConfigurationProof(
  options: CurrentStoreConfigurationSourceOptions,
  transaction: Transaction,
  observedAt: string,
): Promise<Proof> {
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
        throw new Error("STORE_CONFIGURATION_UNAVAILABLE");
      selected = proof;
      return proof;
    },
  });
  await read(transaction, observedAt);
  if (!selected) throw new Error("STORE_CONFIGURATION_UNAVAILABLE");
  return selected;
}

/** Resolves the current Store receipt binding, not a caller-picked historic configuration.
 * Store selection and Publishing/approval/Live Gate fences remain in the caller transaction.
 * This proves the configured template reference; template publication/rendering is separate.
 */
export function createPostgresStoreReceiptConfigurationSource(
  options: CurrentStoreConfigurationSourceOptions,
) {
  return async (transaction: Transaction, observedAt: string) => {
    try {
      const selected = await readCurrentStoreConfigurationProof(options, transaction, observedAt);
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

/**
 * WP-2423 DEC-STORE-SETUP-PUBLICATION: the tax configuration reference the Store's configuration
 * published and in force at `observedAt` names (Store setup step 8 publishes it), proved against
 * its current Publishing release. Pricing owns the tax configuration itself; a quote resolves this
 * reference through Pricing's current tax configuration reader at the same instant. Never a
 * caller-picked historic configuration or a reference fixed in operating files.
 */
export function createPostgresStoreTaxConfigurationSource(
  options: CurrentStoreConfigurationSourceOptions,
) {
  return async (transaction: Transaction, observedAt: string) => {
    try {
      const selected = await readCurrentStoreConfigurationProof(options, transaction, observedAt);
      const configuration = selected.configuration;
      return Object.freeze({
        brandReference: configuration.brandReference,
        storeReference: configuration.storeReference,
        configurationReference: configuration.configurationReference,
        configurationVersion: configuration.configurationVersion,
        taxConfigurationReference: configuration.taxConfigurationReference,
        currencyCode: configuration.currencyCode,
        publicationReference: configuration.publicationReference,
        contentDigest: selected.contentDigest,
        observedAt: selected.observedAt,
      });
    } catch {
      throw new Error("STORE_TAX_CONFIGURATION_UNAVAILABLE");
    }
  };
}

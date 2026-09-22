import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import type { ConsumerTransaction } from "@bop/eventing";
import { parseOpaqueUuidV7, parseCanonicalInstant, readClosedRecord } from "@bop/identity";
import {
  createPostgresStoreBusinessDateSource,
  createPostgresCurrentStorePublicationProof,
} from "@rms/store";

type PublicationOptions = Parameters<typeof createPostgresCurrentStorePublicationProof>[0];
/** Public-owner composition for Payment's businessDate port. The configured
 * authorization callback must retain current Tenant/Store/purpose fences even
 * when occurredAt is a historical capture time. No client-selected time zone,
 * day boundary, configuration version or publication evidence is accepted. */
export function createMerchantOrdinaryRefundBusinessDate(
  options: Omit<PublicationOptions, "configurationReference" | "hashContent"> & {
    timeZone: string;
  },
) {
  const scope = {
    tenantReference: String(parseOpaqueUuidV7(options.tenantReference, "ACTOR_REFERENCE_INVALID")),
    brandReference: String(parseOpaqueUuidV7(options.brandReference, "ACTOR_REFERENCE_INVALID")),
    storeReference: String(parseOpaqueUuidV7(options.storeReference, "ACTOR_REFERENCE_INVALID")),
  };
  const source = createPostgresStoreBusinessDateSource({
    ...scope,
    timeZone: options.timeZone,
    authorize: options.authorize,
    publicationProof: async (tx, candidate, at) => {
      const proof = await createPostgresCurrentStorePublicationProof({
        ...options,
        ...scope,
        configurationReference: candidate.configurationReference,
        hashContent: (value) => "sha256:" + sha256Hex(canonicalizeRfc8785(value)),
      })(tx, at);
      return {
        contentDigest: proof.contentDigest,
        businessDayStartSource: proof.businessDayStartSource,
      };
    },
  });
  return async (tx: ConsumerTransaction, value: unknown): Promise<string> => {
    const raw = readClosedRecord(value, [
      "tenantReference",
      "brandReference",
      "storeReference",
      "occurredAt",
    ]);
    if (
      String(parseOpaqueUuidV7(raw.tenantReference, "ACTOR_REFERENCE_INVALID")) !==
        scope.tenantReference ||
      String(parseOpaqueUuidV7(raw.brandReference, "ACTOR_REFERENCE_INVALID")) !==
        scope.brandReference ||
      String(parseOpaqueUuidV7(raw.storeReference, "ACTOR_REFERENCE_INVALID")) !==
        scope.storeReference
    )
      throw new Error("ORDINARY_REFUND_BUSINESS_DATE_UNAVAILABLE");
    const at = parseCanonicalInstant(raw.occurredAt);
    return String((await source(tx, at)).businessDate);
  };
}

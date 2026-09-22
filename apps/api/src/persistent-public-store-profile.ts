import {
  createPostgresPublicStoreProfileAuthority,
  createPostgresPublicStoreProfileStore,
  createPostgresPublicStoreProfileTimingStore,
  createPublicStoreProfileService,
  parseGetPublicStoreRequest,
  parseStoreAdministrationReference,
  type GetPublicStoreRequest,
  type PublicStoreProfilePorts,
} from "@rms/store";
import { parseCanonicalInstant } from "@bop/tenant";
import { createConfiguredPublicStoreResolution } from "./public-store-resolution.js";
type ResolutionOptions = Parameters<typeof createConfiguredPublicStoreResolution>[0];
type AuthorityOptions = Parameters<typeof createPostgresPublicStoreProfileAuthority>[0];
type TimingOptions = Parameters<typeof createPostgresPublicStoreProfileTimingStore>[0];
type ProfileOptions = Parameters<typeof createPostgresPublicStoreProfileStore>[0];
type Transaction = ResolutionOptions["transaction"];

export interface PersistentPublicStoreProfileOptions {
  binding: ResolutionOptions["binding"];
  authorize: ResolutionOptions["authorize"];
  selection: Readonly<{ profileReference: string; profileVersion: number }>;
  hashContent: AuthorityOptions["hashContent"];
  hashSnapshot: ProfileOptions["hashSnapshot"];
  hashPeriod: TimingOptions["hashPeriod"];
  verifyMedia: AuthorityOptions["verifyMedia"];
  telemetry: PublicStoreProfilePorts["telemetry"];
}
const readOnly = async (): Promise<never> => {
  throw new Error("PUBLIC_STORE_READ_ONLY");
};

/** Construct once per request in the caller-retained transaction, using a trusted
 * evaluation clock. Internal scope and exact profile version are server configuration.
 * Never cache these ports across requests or commit before dependent entry reads.
 */
export function createPersistentPublicStoreProfilePorts(
  tx: Transaction,
  options: PersistentPublicStoreProfileOptions,
  request: Pick<GetPublicStoreRequest, "evaluatedAt" | "purpose">,
): PublicStoreProfilePorts {
  const at = parseCanonicalInstant(request.evaluatedAt);
  const purpose = request.purpose;
  if (purpose !== "CustomerEntry" && purpose !== "CustomerCart")
    throw new Error("PUBLIC_STORE_REQUEST_INVALID");
  const binding = Object.freeze({ ...options.binding });
  const reference = parseStoreAdministrationReference(options.selection.profileReference);
  const version = options.selection.profileVersion;
  if (!Number.isSafeInteger(version) || version < 1)
    throw new Error("PUBLIC_STORE_SELECTION_INVALID");
  const authorize = (transaction: Transaction, observedAt: string) =>
    options.authorize(transaction, binding, { evaluatedAt: observedAt, purpose });
  const scope = { brandReference: binding.brandReference, storeReference: binding.storeReference };
  const resolution = createConfiguredPublicStoreResolution({
    transaction: tx,
    binding,
    authorize: options.authorize,
  });
  const timing = createPostgresPublicStoreProfileTimingStore({
    ...scope,
    authorize,
    hashPeriod: options.hashPeriod,
    authorizeApproval: async () => false,
    appendAudit: readOnly,
  });
  const verifyCurrent = createPostgresPublicStoreProfileAuthority({
    ...scope,
    tenantReference: binding.tenantReference,
    authorize,
    hashContent: options.hashContent,
    verifyMedia: options.verifyMedia,
    verifyEffective: (transaction, profile, now) =>
      timing.verify(transaction, profile.effectiveVersion, now),
  });
  const profiles = createPostgresPublicStoreProfileStore({
    ...scope,
    authorize,
    verifyCurrent,
    hashSnapshot: options.hashSnapshot,
    appendAudit: readOnly,
  });
  return Object.freeze({
    resolution: {
      async resolve(input: Parameters<PublicStoreProfilePorts["resolution"]["resolve"]>[0]) {
        if (input.evaluatedAt !== at || input.purpose !== purpose) return null;
        return resolution.resolve(input);
      },
    },
    profiles: {
      async loadCandidates(input: { brandReference: string; storeReference: string }) {
        if (
          input.brandReference !== scope.brandReference ||
          input.storeReference !== scope.storeReference
        )
          throw new Error("PUBLIC_STORE_SCOPE_UNAVAILABLE");
        const profile = await profiles.loadExact(tx, reference, version, at);
        return profile === null ? [] : [profile];
      },
    },
    telemetry: options.telemetry,
  });
}

/** A complete read uses one database transaction. This reader can serve Cart;
 * entry assembly should instead use the request-scoped ports above in its transaction.
 */
export function createPersistentPublicStoreProfileReader(
  options: PersistentPublicStoreProfileOptions & {
    transactions: { run<T>(work: (tx: Transaction) => Promise<T>): Promise<T> };
  },
) {
  return Object.freeze({
    async getPublicStore(input: unknown) {
      let request: GetPublicStoreRequest;
      try {
        request = parseGetPublicStoreRequest(input);
      } catch {
        return { status: "InvalidRequest" } as const;
      }
      try {
        return await options.transactions.run((tx) =>
          createPublicStoreProfileService(
            createPersistentPublicStoreProfilePorts(tx, options, request),
          ).getPublicStore(request),
        );
      } catch {
        return { status: "StoreUnavailable" } as const;
      }
    },
  });
}

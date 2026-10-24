import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { createStoreConfigurationPublicationHash } from "@rms/store";

/**
 * WP-2423 DEC-STORE-SETUP-PUBLICATION: what every Store configuration publication proof needs to
 * verify both an installed configuration (V1, plain canonical digest) and one the Owner published
 * from Store setup (V2 semantic digest and setup provenance). The V2 hash returns the plain digest
 * for a V1 configuration, so one function serves both.
 */
const setupSnapshotReferences = Object.freeze({
  canonicalize: canonicalizeRfc8785,
  hashIntent: (canonical: string) => "sha256:" + sha256Hex(canonical),
});
export const storeConfigurationProofHashing = Object.freeze({
  setupSnapshotReferences,
  hashContent: createStoreConfigurationPublicationHash({
    canonicalize: canonicalizeRfc8785,
    hashIntent: (canonical: string) => "sha256:" + sha256Hex(canonical),
  }),
});

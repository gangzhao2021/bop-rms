import { canonicalizeRfc8785, sha256Hex } from "../../packages/bop/audit/src/index.ts";
import { createStoreConfigurationPublicationHash } from "../../packages/rms/store/src/index.ts";

/**
 * WP-2423 DEC-STORE-SETUP-PUBLICATION: the fixed checks every Store configuration published from a
 * setup draft (V2) carries as validation evidence. Readers of a V2 publication (operating status,
 * business date, merchant baselines) require exactly this inventory, so it is defined once here.
 */
export const storeConfigurationValidationCheckCodes = Object.freeze([
  "STORE_FEES_CLASSIFIED",
  "STORE_HOURS_VALID",
  "STORE_REFERENCES_CURRENT",
]);

export const storeConfigurationSetupSnapshotReferences = Object.freeze({
  canonicalize: canonicalizeRfc8785,
  hashIntent: (canonical) => "sha256:" + sha256Hex(canonical),
});

const v2Hash = createStoreConfigurationPublicationHash({
  canonicalize: canonicalizeRfc8785,
  hashIntent: (canonical) => "sha256:" + sha256Hex(canonical),
});
const plainHash = (value) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));

/**
 * The content digest of a Store configuration publication: a configuration that came from a setup
 * draft uses the V2 semantic digest; anything else (an installed V1 configuration, or an exception's
 * interval list the operating reader digests) keeps its plain canonical digest.
 */
export function storeConfigurationContentHash(value) {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.hasOwn(value, "setupBasis")
    ? v2Hash(value)
    : plainHash(value);
}

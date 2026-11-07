import {
  createStoreConfigurationVersion,
  StoreConfigurationAdministrationError,
  type StoreConfigurationVersion,
} from "./store-configuration-administration.js";

const excluded = Object.freeze([
  "lifecycle",
  "approvedByReference",
  "approvalEvidenceReference",
  "publicationReference",
  "liveGateEvidenceReference",
  "updatedAt",
] as const);
const fail = (): never => {
  throw new StoreConfigurationAdministrationError("STORE_CONFIGURATION_INPUT_INVALID");
};
/** V1 is its original full parsed envelope. V2 freezes authored configuration;
 * actual approval, release and Live Gate metadata must be checked separately. */
export function createStoreConfigurationPublicationContent(
  value: unknown,
): StoreConfigurationVersion | Readonly<Record<string, unknown>> {
  const configuration = createStoreConfigurationVersion(value);
  if (configuration.setupBasis === undefined) return configuration;
  return Object.freeze({
    profile: "StoreConfigurationContentV2",
    ...Object.fromEntries(
      Object.entries(configuration).filter(([key]) => !excluded.some((field) => field === key)),
    ),
  });
}
export interface StoreConfigurationPublicationHashReferences {
  canonicalize(value: unknown): string;
  hashIntent(canonical: string): string;
}
/** Uses captured owning canonical/hash ports; never changes a persisted V1 digest. */
export function createStoreConfigurationPublicationHash(
  references: StoreConfigurationPublicationHashReferences,
) {
  if (
    !references ||
    Object.getPrototypeOf(references) !== Object.prototype ||
    Reflect.ownKeys(references).length !== 2
  )
    return fail();
  const canonical = Object.getOwnPropertyDescriptor(references, "canonicalize"),
    hash = Object.getOwnPropertyDescriptor(references, "hashIntent");
  if (
    !canonical?.enumerable ||
    !("value" in canonical) ||
    typeof canonical.value !== "function" ||
    !hash?.enumerable ||
    !("value" in hash) ||
    typeof hash.value !== "function"
  )
    return fail();
  const canonicalize = references.canonicalize,
    hashIntent = references.hashIntent;
  const check = () => {
    const currentCanonical = Object.getOwnPropertyDescriptor(references, "canonicalize"),
      currentHash = Object.getOwnPropertyDescriptor(references, "hashIntent");
    if (
      Reflect.ownKeys(references).length !== 2 ||
      !currentCanonical?.enumerable ||
      !("value" in currentCanonical) ||
      currentCanonical.value !== canonicalize ||
      !currentHash?.enumerable ||
      !("value" in currentHash) ||
      currentHash.value !== hashIntent
    )
      return fail();
  };
  const order = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(order)
      : value !== null && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([left], [right]) => left.localeCompare(right, "en"))
              .map(([key, item]) => [key, order(item)]),
          )
        : value;
  return (value: unknown): string => {
    try {
      check();
      const content = createStoreConfigurationPublicationContent(value);
      const text = canonicalize.call(references, content);
      check();
      if (typeof text !== "string" || text.length > 4194304) return fail();
      const parsed: unknown = JSON.parse(text);
      if (
        JSON.stringify(order(parsed)) !== JSON.stringify(order(content)) ||
        canonicalize.call(references, parsed) !== text
      )
        return fail();
      check();
      const digest = hashIntent.call(references, text);
      check();
      return typeof digest === "string" && /^sha256:[0-9a-f]{64}$/u.test(digest) ? digest : fail();
    } catch {
      return fail();
    }
  };
}

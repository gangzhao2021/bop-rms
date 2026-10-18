import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { parseBrandReference } from "@bop/tenant";
import {
  createMediaScope,
  mediaPublicationReadFields,
  parseMediaPublicationReadRequest,
} from "@bop/media";
import {
  CatalogError,
  parseCatalogInstant,
  parseProductPublicationCommandV2,
  parseCatalogProductPublicationWarningAcknowledgementCommand,
} from "@rms/catalog";
import { createCurrentProductPublicationMediaSource } from "./current-product-publication-media.js";
import type { MerchantProductPublicationSourceFactoryV2Input } from "./merchant-product-publication-command-v2.js";
import type { MerchantProductWarningAcknowledgementSourceFactoryInput } from "./merchant-product-publication-warning-acknowledgement-command.js";

type Input = Omit<MerchantProductPublicationSourceFactoryV2Input, "command"> & {
  readonly command:
    | MerchantProductPublicationSourceFactoryV2Input["command"]
    | MerchantProductWarningAcknowledgementSourceFactoryInput["command"];
};
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
const equal = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);

/** Ordinary User composition. Its fixed authorizer is supplied by the actual
 * authenticated command host and re-reads held Brand Permission in that tx.
 * This creates one source for the full producer; it does not invent other checks. */
export function createMerchantProductPublicationMediaSource(input: Input) {
  const acknowledgement =
      input.command.purposeCode === "CATALOG_PRODUCT_PUBLICATION_WARNING_ACKNOWLEDGEMENT",
    command = acknowledgement
      ? parseCatalogProductPublicationWarningAcknowledgementCommand(input.command)
      : parseProductPublicationCommandV2(input.command),
    originalIntentDigest = "sha256:" + sha256Hex(canonicalizeRfc8785(command)),
    tx = input.transaction,
    query = tx.query,
    authorize = input.authorizeMediaAccess?.bind(input),
    now = input.clock.now.bind(input.clock),
    register = input.registerBeforeCommit.bind(input),
    originalValidUntil = parseCatalogInstant(input.originalValidUntil),
    observedAt = parseCatalogInstant(now()),
    scope = createMediaScope({
      kind: "Brand",
      brandReference: parseBrandReference(input.brandReference),
      storeReference: null,
    });
  if (
    typeof authorize !== "function" ||
    typeof query !== "function" ||
    command.actorKind !== "User" ||
    command.tenantReference !== input.tenantReference ||
    command.brandReference !== input.brandReference ||
    command.actorReference !== input.actorReference ||
    originalValidUntil <= observedAt ||
    Date.parse(originalValidUntil) - Date.parse(observedAt) > 5000
  )
    return fail();
  let failed = false,
    latest = observedAt;
  const check = () => {
    const at = parseCatalogInstant(now());
    if (failed || tx.query !== query || at < latest || at >= originalValidUntil) return fail();
    latest = at;
  };
  return createCurrentProductPublicationMediaSource({
    transaction: tx,
    scope,
    clock: {
      now: () => {
        check();
        return latest;
      },
    },
    registerBeforeCommit: register,
    authority: {
      async holdUntilTransactionCompletes(actual, value) {
        try {
          check();
          const request = parseMediaPublicationReadRequest(value.request);
          if (
            actual !== tx ||
            !equal(value.command, command) ||
            value.commandPurposeCode !== command.purposeCode ||
            value.originalIntentDigest !== originalIntentDigest ||
            request.originalIntentDigest !== originalIntentDigest ||
            value.requestObservedAt !== request.observedAt ||
            value.requestValidUntil !== request.validUntil ||
            value.action !== "media.asset.access" ||
            value.purposeCode !== "CATALOG_PRODUCT_PUBLICATION_MEDIA_READ" ||
            !equal(value.requiredFields, mediaPublicationReadFields) ||
            request.actorKind !== "User" ||
            request.actorReference !== command.actorReference ||
            request.tenantReference !== command.tenantReference ||
            !equal(request.scope, scope) ||
            request.operationReference !== command.operationReference ||
            request.productReference !== command.productReference ||
            request.versionReference !== command.versionReference ||
            request.intentKind !==
              (acknowledgement ? "WarningAcknowledgementV1" : "PublicationV2") ||
            request.observedAt < observedAt ||
            request.validUntil > originalValidUntil
          )
            return fail();
          await authorize();
          check();
          return Object.freeze({ observedAt: request.observedAt, validUntil: request.validUntil });
        } catch (error) {
          failed = true;
          throw error;
        }
      },
    },
  });
}

import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import type { ConsumerTransaction } from "@bop/eventing";
import { createPostgresStoreReceiptConfigurationSource } from "@rms/store";
import {
  createPostgresDigitalReceiptTemplateStore,
  createPostgresReceiptTemplatePublicationProof,
} from "@rms/printing-device";
import { DigitalReceiptError, parseOrderingReference } from "@rms/ordering";
import type { createReceiptIssuanceSources } from "./receipt-issuance-sources.js";
type Request = Parameters<Parameters<typeof createReceiptIssuanceSources>[0]["template"]>[1];
type StoreOptions = Parameters<typeof createPostgresStoreReceiptConfigurationSource>[0];
type PublicationOptions = Parameters<typeof createPostgresReceiptTemplatePublicationProof>[0];
/** Runtime composition of public owners. Family/reference mapping is explicit;
 * a newly configured but unbound template is unavailable until runtime is configured.
 */
export function createPublishedReceiptTemplateSource(options: {
  store: StoreOptions;
  templatePublication: Omit<PublicationOptions, "brandReference" | "storeReference"> & {
    templateReference: string;
  };
  authorize(transaction: ConsumerTransaction, request: Request): Promise<boolean>;
}) {
  if (
    String(parseOrderingReference(options.store.tenantReference)) !==
    String(parseOrderingReference(options.templatePublication.tenantReference))
  )
    throw new DigitalReceiptError("DIGITAL_RECEIPT_INPUT_INVALID");
  const scope = {
    brandReference: String(parseOrderingReference(options.store.brandReference)),
    storeReference: String(parseOrderingReference(options.store.storeReference)),
  };
  const templateReference = String(
    parseOrderingReference(options.templatePublication.templateReference),
  );
  const readStore = createPostgresStoreReceiptConfigurationSource(options.store);
  const readPublication = createPostgresReceiptTemplatePublicationProof({
    ...options.templatePublication,
    ...scope,
  });
  return async (transaction: ConsumerTransaction, request: Request) => {
    try {
      const authorize = async () => {
        if (
          request.brandReference !== scope.brandReference ||
          request.storeReference !== scope.storeReference ||
          (await options.authorize(transaction, request)) !== true
        )
          throw new DigitalReceiptError("DIGITAL_RECEIPT_PERMISSION_DENIED");
        return true;
      };
      await authorize();
      const binding = await readStore(transaction, request.observedAt);
      if (
        binding.templateReference !== templateReference ||
        binding.currencyCode !== request.currencyCode
      )
        throw new DigitalReceiptError("DIGITAL_RECEIPT_DEPENDENCY_UNAVAILABLE");
      const readTemplate = createPostgresDigitalReceiptTemplateStore({
        ...scope,
        authorize,
        validatePublication: async () => false,
        isCurrentPublication: async (_tx, version, at) =>
          (await readPublication(transaction, version, at)) !== null,
      });
      const version = await readTemplate.resolve(transaction, {
        templateReference,
        locale: binding.locale,
        observedAt: request.observedAt,
      });
      await authorize();
      return Object.freeze({
        template: Object.freeze({ ...scope, locale: binding.locale, version: version.versionCode }),
        evidenceReference: version.versionReference,
        evidenceDigest:
          "sha256:" +
          sha256Hex(canonicalizeRfc8785(JSON.parse(JSON.stringify({ binding, version })))),
      });
    } catch (error) {
      if (error instanceof DigitalReceiptError) throw error;
      throw new DigitalReceiptError("DIGITAL_RECEIPT_DEPENDENCY_UNAVAILABLE");
    }
  };
}

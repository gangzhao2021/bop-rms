import { createMerchantReceiptTemplatePublished } from "../../apps/api/dist/merchant-receipt-template-published.js";
import { createMerchantReceiptTemplateLifecycle } from "../../apps/api/dist/merchant-receipt-template-lifecycle.js";
import { createMerchantReceiptTemplateReview } from "../../apps/api/dist/merchant-receipt-template-review.js";
import { createMerchantReceiptTemplateSubmit } from "../../apps/api/dist/merchant-receipt-template-submit.js";
import { createMerchantReceiptTemplateDraft } from "../../apps/api/dist/merchant-receipt-template-draft.js";
import { createMerchantReceiptTemplateArtifacts } from "../../apps/api/dist/merchant-receipt-template-artifacts.js";
import { createMerchantStorePaymentConfiguration } from "../../apps/api/dist/merchant-store-payment-configuration.js";
import { createMerchantStoreSetupReferences } from "../../apps/api/dist/merchant-store-setup-references.js";
import { createMerchantStoreSetup } from "../../apps/api/dist/merchant-store-setup.js";
import {
  createInternalStoreConfigurationOrdinary,
  readPublishedStoreConfiguration,
} from "./pilot-store-publication.mjs";

/**
 * WP-2423 Q15/Q16: the Store setup part of the pilot merchant BFF (setup draft, address/contact,
 * payment configuration, receipt templates and fee classification choices).
 *
 * The fee classification read needs `storeSetupClock`; without it the BFF answered every step 5
 * read with 503 on v15. WP-2423 DEC-STORE-SETUP-PUBLICATION: Store configuration publication
 * (`storeConfigurationOrdinary`, step 8) is composed with in-product publication checks, so the
 * Owner publishes a setup draft as the Store's configuration.
 */
export async function createInternalStoreSetupBff(
  resources,
  { persistence, authentication, nextReference },
) {
  const storeConfigurationOrdinary = await createInternalStoreConfigurationOrdinary(resources, {
    persistence,
    authentication,
  });
  return {
    ...createInternalStoreSetupDraftBff({
      persistence,
      authentication,
      nextReference,
      // A setup saved before any recorded change builds on the configuration the Store runs.
      currentConfiguration: async (tx, at, authorize) =>
        (
          await readPublishedStoreConfiguration(
            resources.operating,
            tx,
            at,
            async (transaction, observedAt) =>
              (await authorize()) && (await resources.operating.authorize(transaction, observedAt)),
          )
        ).configuration.configurationReference,
    }),
    storeConfigurationOrdinary,
    storeConfigurationOrdinaryClock: Object.freeze({ now: persistence.now.bind(persistence) }),
  };
}

/** Store setup without configuration publication (setup draft, references, payment, receipts,
 * fee classification choices); the BFF then answers the publication panel with 404. */
export function createInternalStoreSetupDraftBff({
  persistence,
  authentication,
  nextReference,
  currentConfiguration,
}) {
  const ports = { persistence, authentication, nextReference };
  return {
    receiptTemplatePublished: createMerchantReceiptTemplatePublished({
      persistence,
      authentication,
    }),
    receiptTemplateReview: createMerchantReceiptTemplateReview({ persistence, authentication }),
    receiptTemplateLifecycle: createMerchantReceiptTemplateLifecycle(ports),
    receiptTemplateSubmit: createMerchantReceiptTemplateSubmit(ports),
    receiptTemplateDraft: createMerchantReceiptTemplateDraft(ports),
    receiptTemplateArtifacts: createMerchantReceiptTemplateArtifacts(ports),
    storePaymentConfiguration: createMerchantStorePaymentConfiguration(ports),
    storeSetupReferences: createMerchantStoreSetupReferences(ports),
    storeSetup: createMerchantStoreSetup(
      currentConfiguration === undefined ? ports : { ...ports, currentConfiguration },
    ),
    storeSetupClock: Object.freeze({ now: persistence.now.bind(persistence) }),
  };
}

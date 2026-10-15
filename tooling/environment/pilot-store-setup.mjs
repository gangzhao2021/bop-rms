import { createMerchantReceiptTemplatePublished } from "../../apps/api/dist/merchant-receipt-template-published.js";
import { createMerchantReceiptTemplateLifecycle } from "../../apps/api/dist/merchant-receipt-template-lifecycle.js";
import { createMerchantReceiptTemplateReview } from "../../apps/api/dist/merchant-receipt-template-review.js";
import { createMerchantReceiptTemplateSubmit } from "../../apps/api/dist/merchant-receipt-template-submit.js";
import { createMerchantReceiptTemplateDraft } from "../../apps/api/dist/merchant-receipt-template-draft.js";
import { createMerchantReceiptTemplateArtifacts } from "../../apps/api/dist/merchant-receipt-template-artifacts.js";
import { createMerchantStorePaymentConfiguration } from "../../apps/api/dist/merchant-store-payment-configuration.js";
import { createMerchantStoreSetupReferences } from "../../apps/api/dist/merchant-store-setup-references.js";
import { createMerchantStoreSetup } from "../../apps/api/dist/merchant-store-setup.js";

/**
 * WP-2423 Q15/Q16: the Store setup part of the pilot merchant BFF (setup draft, address/contact,
 * payment configuration, receipt templates and fee classification choices).
 *
 * The fee classification read needs `storeSetupClock`; without it the BFF answered every step 5
 * read with 503 on v15. Store configuration publication (`storeConfigurationOrdinary`) is not
 * composed: the pilot Store keeps its installed configuration (hours change through the Q4 flow),
 * so the BFF answers 404 and Store setup hides the publication panel.
 */
export function createInternalStoreSetupBff({ persistence, authentication, nextReference }) {
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
    storeSetup: createMerchantStoreSetup(ports),
    storeSetupClock: Object.freeze({ now: persistence.now.bind(persistence) }),
  };
}

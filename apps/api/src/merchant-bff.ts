import express, { type RequestHandler, type Router } from "express";
import type { MerchantBffRouterOptions } from "./merchant-bff-contract.js";
import { exactHeader, NO_STORE } from "./merchant-bff-http.js";
import {
  installMerchantStaffPinRoutes,
  staffPinFullSignInGate,
} from "./merchant-staff-pin-http.js";
import { installMerchantBffBodyParsers } from "./merchant-bff-body-parsers.js";
import { installMerchantSessionRoutes } from "./merchant-bff-session-routes.js";
import { installMerchantOperationsRoutes } from "./merchant-bff-operations-routes.js";
import { installMerchantReportRoutes } from "./merchant-bff-report-routes.js";
import { installMerchantExceptionRoutes } from "./merchant-bff-exception-routes.js";
import { installMerchantStoreConfigurationRoutes } from "./merchant-bff-store-configuration-routes.js";
import { installMerchantStoreSetupRoutes } from "./merchant-bff-store-setup-routes.js";
import { installMerchantOrganizationRoutes } from "./merchant-bff-organization-routes.js";
import { installMerchantTaxConfigRoutes } from "./merchant-bff-tax-config-routes.js";
import { installMerchantReceiptTemplateRoutes } from "./merchant-bff-receipt-template-routes.js";
import { installMerchantRefundRoutes } from "./merchant-bff-refund-routes.js";
import { installMerchantComboPartRoutes } from "./merchant-bff-combo-part-routes.js";
import { installMerchantKitchenRoutes } from "./merchant-bff-kitchen-routes.js";
import { installMerchantSupplyRoutes } from "./merchant-bff-supply-routes.js";
import { installMerchantCommerceRoutes } from "./merchant-bff-commerce-routes.js";
import { installMerchantPickupRoutes } from "./merchant-bff-pickup-routes.js";
import { installMerchantDiningRoutes } from "./merchant-bff-dining-routes.js";
import { installMerchantCatalogRoutes } from "./merchant-bff-catalog-routes.js";
import { installMerchantProductPublicationRoutes } from "./merchant-bff-product-publication-routes.js";
import { installMerchantOptionSetRoutes } from "./merchant-bff-option-set-routes.js";
import { installMerchantPricingRoutes } from "./merchant-bff-pricing-routes.js";
import { installMerchantOrderRoutes } from "./merchant-bff-order-routes.js";

export type {
  MerchantBffRouterOptions,
  MerchantBffService,
  MerchantNavigationItem,
  MerchantStoreConfigurationOrdinaryPort,
  MerchantWorkspaceSnapshot,
} from "./merchant-bff-contract.js";
export { merchantNavigationActions } from "./merchant-bff-contract.js";
export { parseMerchantWorkspaceSnapshot } from "./merchant-bff-workspace.js";

const defaultSignInEntry = Object.freeze({
  path: "/merchant/login?returnTo=/app",
  testOnly: false,
});

function trustedHost(options: MerchantBffRouterOptions): RequestHandler {
  return (request, response, next) => {
    if (exactHeader(request, "host") !== options.acceptedHost) {
      response.status(403).set("Cache-Control", NO_STORE).json({ error: "request_denied" });
      return;
    }
    next();
  };
}

export function createMerchantBffRouter(options: MerchantBffRouterOptions): Router {
  const router = express.Router();
  installMerchantBffBodyParsers(router, options);
  router.use(trustedHost(options));
  router.use((_request, response, next) => {
    response.set("Cache-Control", NO_STORE);
    next();
  });
  // WP-2423 Q18 option A: an unverified PIN session cannot do sensitive actions; the shared-tablet
  // PIN routes (lock screen, own PIN, tablets, reset).
  const staffPinRoutes = {
    exactOrigin: options.exactOrigin,
    fullSignIn: options.signInEntry ?? defaultSignInEntry,
    ...(options.staffPin === undefined ? {} : { staffPin: options.staffPin }),
  };
  router.use(staffPinFullSignInGate(staffPinRoutes));
  installMerchantStaffPinRoutes(router, staffPinRoutes);

  installMerchantSessionRoutes(router, options, staffPinRoutes);
  installMerchantOperationsRoutes(router, options);
  installMerchantReportRoutes(router, options);
  installMerchantExceptionRoutes(router, options);
  installMerchantStoreConfigurationRoutes(router, options);
  installMerchantStoreSetupRoutes(router, options);
  installMerchantOrganizationRoutes(router, options);
  installMerchantTaxConfigRoutes(router, options);
  installMerchantReceiptTemplateRoutes(router, options);
  installMerchantRefundRoutes(router, options);
  installMerchantKitchenRoutes(router, options);
  installMerchantComboPartRoutes(router, options);
  installMerchantSupplyRoutes(router, options);
  installMerchantCommerceRoutes(router, options);
  installMerchantPickupRoutes(router, options);
  installMerchantDiningRoutes(router, options);
  installMerchantCatalogRoutes(router, options);
  installMerchantProductPublicationRoutes(router, options);
  installMerchantOptionSetRoutes(router, options);
  installMerchantPricingRoutes(router, options);
  installMerchantOrderRoutes(router, options);

  return router;
}

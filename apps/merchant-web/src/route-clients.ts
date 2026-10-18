/**
 * WP-2423 C2: the source clients of screens that load on first use. They load with those screens,
 * not in the first download (see route-chunks.tsx).
 */
export { createAllergenClient } from "./allergen-declaration-pages.js";
export { createOpeningCountClient } from "./opening-count-pages.js";
export { createProductClient } from "./product-pages.js";
export { createRecipeClient } from "./recipe-pages.js";
export { createRoleAdministrationPageClient } from "./role-administration-pages.js";
export { createStaffPageClient } from "./staff-administration-pages.js";
export { createStockCountClient } from "./stock-count-pages.js";
export { createStockLocationClient } from "./stock-location-pages.js";
export { createAvailabilityClient } from "./store-availability-page.js";
export { createMenuClient } from "./store-menu-pages.js";
export { createOptionPriceClient } from "./store-option-prices-page.js";
export { createOptionRecipeClient } from "./store-option-recipes-page.js";
export { createOptionSetClient } from "./store-option-set-page.js";
export { createPriceClient } from "./store-price-pages.js";
export { createStoreReceiptClient } from "./store-receipt-pages.js";
export { createStoreWasteClient } from "./store-waste-pages.js";
export { createSupplyItemClient } from "./supply-item-pages.js";
export { createTaxClassificationClient } from "./tax-classification-page.js";
export { createTaxReviewClient } from "./StoreTaxReviewPage.js";

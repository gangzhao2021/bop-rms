import { t } from "./i18n/i18n.js";

/**
 * WP-2423 D3 (M122/M123): the reasons and units Inventory sends as codes, in the staff language.
 * A code this list does not know yet is shown as written (never hidden).
 */
const reasons: Readonly<Record<string, () => string>> = {
  // Waste
  EXPIRED: () => t("Expired"),
  SPOILED: () => t("Spoiled"),
  DAMAGED: () => t("Damaged"),
  DROPPED: () => t("Dropped or spilled"),
  PREPARATION_ERROR: () => t("Preparation mistake"),
  QUALITY: () => t("Not good enough to serve"),
  CUSTOMER_RETURN: () => t("Returned by the guest"),
  OTHER: () => t("Other"),
  REVIEWED_OK: () => t("Reviewed, OK"),
  NOT_ACTUALLY_WASTED: () => t("Not actually wasted"),
  KITCHEN_REMAKE_OPENED_BY_MISTAKE: () => t("Remake cancelled — opened by mistake"),
  // Receiving
  DAMAGED_IN_TRANSIT: () => t("Damaged on delivery"),
  WRONG_ITEM: () => t("Wrong item"),
  SHORT_DATED: () => t("Expiry date too close"),
  TEMPERATURE: () => t("Wrong temperature"),
  OVER_DELIVERED: () => t("More than ordered"),
  RETURNED_TO_SUPPLIER: () => t("Returned to supplier"),
  // Stock count differences
  PREVIOUS_COUNT_ERROR: () => t("The last count was wrong"),
  UNRECORDED_WASTE: () => t("Waste not recorded"),
  UNRECORDED_RECEIPT: () => t("Delivery not recorded"),
  RECIPE_USAGE_DIFFERENCE: () => t("Used more or less than the recipe"),
  DAMAGED_OR_SPOILED: () => t("Damaged or spoiled"),
  THEFT_OR_LOSS: () => t("Missing or stolen"),
  MISPLACED_STOCK: () => t("Kept in another place"),
  UNEXPLAINED: () => t("Reason not known"),
  // Voids (waste and receiving)
  ENTERED_IN_ERROR: () => t("Entered in error"),
  DUPLICATE_ENTRY: () => t("Duplicate entry"),
};

export function stockReasonText(code: string): string {
  const known = reasons[code];
  return known === undefined
    ? code.charAt(0) + code.slice(1).toLowerCase().replaceAll("_", " ")
    : known();
}

const units: Readonly<Record<string, () => string>> = {
  KG: () => t("Kilogram"),
  G: () => t("Gram"),
  L: () => t("Litre"),
  ML: () => t("Millilitre"),
  EA: () => t("Each"),
  PACK: () => t("Pack"),
};

/** A Store unit's name ("Kilogram" / "公斤"); the label Inventory sent when the code is new. */
export function stockUnitName(unitCode: string, label: string): string {
  return units[unitCode]?.() ?? label;
}

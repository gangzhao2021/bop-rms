import { t } from "./i18n/i18n.js";

/** Batch 41: a Brand's lifecycle as staff read it (the same words in English, 草稿 in Chinese). */
export function brandLifecycleLabel(lifecycle: "Draft" | "Active" | "Suspended" | "Archived") {
  return {
    Draft: t("Draft"),
    Active: t("Active"),
    Suspended: t("Suspended"),
    Archived: t("Archived"),
  }[lifecycle];
}

import {
  brandRoleTemplateActions,
  brandRoleTemplateCodes,
  brandRoleTemplateProfiles,
  storeRoleTemplateActions,
  storeRoleTemplateCodes,
  storeRoleTemplateProfiles,
} from "./store-permission-catalog.js";

/**
 * WP-2423 role presets (Owner request 2026-11-06): a role whose code is a released template is a
 * BOP preset. A Store may keep its own version of it; this is the preset's current content.
 */
export function rolePresetActions(
  roleCode: string,
  scope: "Store" | "Brand",
): readonly string[] | null {
  if (scope === "Store") {
    const template = storeRoleTemplateCodes.find(
      (code) => storeRoleTemplateProfiles[code].roleCode === roleCode,
    );
    return template === undefined ? null : storeRoleTemplateActions(template);
  }
  const template = brandRoleTemplateCodes.find(
    (code) => brandRoleTemplateProfiles[code].roleCode === roleCode,
  );
  return template === undefined ? null : brandRoleTemplateActions(template);
}

/** A preset's released name and description, or null when the code is not a preset. */
export function rolePresetProfile(
  roleCode: string,
  scope: "Store" | "Brand",
): { readonly displayName: string; readonly description: string } | null {
  const profiles: readonly { roleCode: string; displayName: string; description: string }[] =
    scope === "Store"
      ? storeRoleTemplateCodes.map((code) => storeRoleTemplateProfiles[code])
      : brandRoleTemplateCodes.map((code) => brandRoleTemplateProfiles[code]);
  const profile = profiles.find((item) => item.roleCode === roleCode);
  return profile === undefined
    ? null
    : { displayName: profile.displayName, description: profile.description };
}

/**
 * The Owner presets hold everything and are never edited, removed or restored, so an owner is
 * never locked out and never loses reports, settlement or audit.
 */
export const lockedRoleCodes: ReadonlySet<string> = new Set(["store_owner", "brand_owner"]);

/** Whether an action set is exactly a preset's current content (order does not matter). */
export function equalsPreset(actions: readonly string[], preset: readonly string[]): boolean {
  const mine = new Set(actions);
  return mine.size === preset.length && preset.every((action) => mine.has(action));
}

/** Merchant BFF workspace snapshot parsing (the browser's closed view of the current workspace). */
import {
  merchantNavigation,
  type MerchantNavigationItem,
  type MerchantWorkspaceSnapshot,
} from "./merchant-bff-contract.js";

const workspaceKeys = [
  "screenId",
  "selectedScope",
  "authorizedStores",
  "businessDate",
  "storeStatus",
  "freshness",
  "dashboardAvailability",
  "navigation",
] as const;

const scopeKeys = ["brandLabel", "storeLabel", "storeReference"] as const;

const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const safeLabel = /^[^\p{Cc}\p{Cf}]{1,100}$/u;

function closed(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key))
  )
    throw new Error("MERCHANT_WORKSPACE_DENIED");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      throw new Error("MERCHANT_WORKSPACE_DENIED");
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

export function targetStoreReference(value: unknown): unknown {
  return closed(value, ["targetStoreReference"]).targetStoreReference;
}

const ianaTimeZone = (value: unknown): value is string => {
  if (typeof value !== "string" || !/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/u.test(value))
    return false;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

/** WP-2423: the selected Store may carry its IANA time zone for store-local times and dates. */
function selectedScope(value: unknown) {
  const zoned = value !== null && typeof value === "object" && Object.hasOwn(value, "timeZone");
  if (!zoned) return scope(value);
  const input = closed(value, [...scopeKeys, "timeZone"]);
  if (!ianaTimeZone(input.timeZone)) throw new Error("MERCHANT_WORKSPACE_DENIED");
  const { brandLabel, storeLabel, storeReference } = input;
  return Object.freeze({
    ...scope({ brandLabel, storeLabel, storeReference }),
    timeZone: input.timeZone,
  });
}

function scope(value: unknown) {
  const input = closed(value, scopeKeys);
  if (
    typeof input.brandLabel !== "string" ||
    !safeLabel.test(input.brandLabel) ||
    typeof input.storeLabel !== "string" ||
    !safeLabel.test(input.storeLabel) ||
    typeof input.storeReference !== "string" ||
    !uuidV7.test(input.storeReference)
  )
    throw new Error("MERCHANT_WORKSPACE_DENIED");
  return Object.freeze({
    brandLabel: input.brandLabel,
    storeLabel: input.storeLabel,
    storeReference: input.storeReference,
  });
}

function navigationItem(value: unknown, selectedStoreReference: string): MerchantNavigationItem {
  const input = closed(value, ["screenId", "label", "href", "permission"]);
  if (input.screenId === "ORG-BRAND-DETAIL") {
    const prefix = "/app/organization/brands/";
    if (
      typeof input.label !== "string" ||
      !safeLabel.test(input.label) ||
      typeof input.href !== "string" ||
      !input.href.startsWith(prefix) ||
      !uuidV7.test(input.href.slice(prefix.length)) ||
      input.permission !== "organization.manage"
    )
      throw new Error("MERCHANT_WORKSPACE_DENIED");
    return Object.freeze({
      screenId: "ORG-BRAND-DETAIL",
      label: input.label,
      href: input.href,
      permission: "organization.manage",
    });
  }
  // WP-2423 Q4: the selected Store's hours and ordering (pause/resume) page.
  if (input.screenId === "STORE-HOURS-SERVICE") {
    const href = "/app/organization/stores/" + selectedStoreReference + "/service";
    if (
      typeof input.label !== "string" ||
      !safeLabel.test(input.label) ||
      input.href !== href ||
      input.permission !== "store.service.read"
    )
      throw new Error("MERCHANT_WORKSPACE_DENIED");
    return Object.freeze({
      screenId: "STORE-HOURS-SERVICE",
      label: input.label,
      href,
      permission: "store.service.read",
    });
  }
  if (input.screenId === "STORE-SETUP") {
    const href = "/app/organization/stores/" + selectedStoreReference + "/setup";
    if (
      typeof input.label !== "string" ||
      !safeLabel.test(input.label) ||
      input.href !== href ||
      input.permission !== "organization.manage"
    )
      throw new Error("MERCHANT_WORKSPACE_DENIED");
    return Object.freeze({
      screenId: "STORE-SETUP",
      label: input.label,
      href,
      permission: "organization.manage",
    });
  }
  if (
    typeof input.screenId !== "string" ||
    !Object.hasOwn(merchantNavigation, input.screenId) ||
    typeof input.label !== "string" ||
    !safeLabel.test(input.label)
  )
    throw new Error("MERCHANT_WORKSPACE_DENIED");
  const screenId = input.screenId as keyof typeof merchantNavigation;
  const expected = merchantNavigation[screenId];
  if (input.href !== expected[0] || input.permission !== expected[1])
    throw new Error("MERCHANT_WORKSPACE_DENIED");
  return Object.freeze({
    screenId,
    label: input.label,
    href: expected[0],
    permission: expected[1],
  });
}

export function parseMerchantWorkspaceSnapshot(value: unknown): MerchantWorkspaceSnapshot {
  const input = closed(value, workspaceKeys);
  const parsedBusinessDate =
    typeof input.businessDate === "string"
      ? Date.parse(`${input.businessDate}T00:00:00.000Z`)
      : Number.NaN;
  if (
    input.screenId !== "HOME-OVERVIEW" ||
    !Array.isArray(input.authorizedStores) ||
    input.authorizedStores.length < 1 ||
    input.authorizedStores.length > 100 ||
    typeof input.businessDate !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(input.businessDate) ||
    !Number.isFinite(parsedBusinessDate) ||
    new Date(parsedBusinessDate).toISOString().slice(0, 10) !== input.businessDate ||
    !["Open", "Closed", "Paused", "Unavailable"].includes(String(input.storeStatus)) ||
    (input.freshness !== "Current" && input.freshness !== "Stale") ||
    input.dashboardAvailability !== "UnavailableUntilWP1905" ||
    !Array.isArray(input.navigation) ||
    input.navigation.length > 40
  )
    throw new Error("MERCHANT_WORKSPACE_DENIED");
  const selected = selectedScope(input.selectedScope);
  const navigation = Object.freeze(
    input.navigation.map((value) => navigationItem(value, selected.storeReference)),
  );
  if (new Set(navigation.map((item) => item.screenId)).size !== navigation.length)
    throw new Error("MERCHANT_WORKSPACE_DENIED");
  const authorizedStores = Object.freeze(input.authorizedStores.map(scope));
  if (
    new Set(authorizedStores.map((item) => item.storeReference)).size !== authorizedStores.length ||
    !authorizedStores.some((item) => item.storeReference === selected.storeReference)
  )
    throw new Error("MERCHANT_WORKSPACE_DENIED");
  return Object.freeze({
    screenId: "HOME-OVERVIEW",
    selectedScope: selected,
    authorizedStores,
    businessDate: input.businessDate,
    storeStatus: input.storeStatus as MerchantWorkspaceSnapshot["storeStatus"],
    freshness: input.freshness,
    dashboardAvailability: "UnavailableUntilWP1905",
    navigation,
  });
}

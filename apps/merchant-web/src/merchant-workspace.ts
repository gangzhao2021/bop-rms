export interface MerchantStoreOption {
  readonly brandLabel: string;
  readonly storeLabel: string;
  readonly storeReference: string;
}

export interface MerchantWorkspaceSnapshot {
  readonly screenId: "HOME-OVERVIEW";
  readonly selectedScope: MerchantStoreOption;
  readonly authorizedStores: readonly MerchantStoreOption[];
  readonly businessDate: string;
  readonly storeStatus: "Open" | "Closed" | "Paused" | "Unavailable";
  readonly freshness: "Current" | "Stale";
  readonly dashboardAvailability: "UnavailableUntilWP1905";
  readonly navigation: readonly MerchantNavigationItem[];
}

export interface MerchantNavigationItem {
  readonly screenId:
    | "HOME-OVERVIEW"
    | "ORG-STORE-LIST"
    | "CAT-MENU-LIST"
    | "OPS-ORDER-QUEUE"
    | "KIT-KITCHEN-QUEUE"
    | "FUL-PICKUP-QUEUE"
    | "IAM-ROLE-LIST";
  readonly label: string;
  readonly href: string;
  readonly permission: string;
}

export interface MerchantSessionBootstrap {
  readonly csrf: string;
  readonly workspace: MerchantWorkspaceSnapshot;
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CREDENTIAL = /^[A-Za-z0-9_-]{43}$/u;
const SAFE_LABEL = /^[^\p{Cc}\p{Cf}]{1,100}$/u;
const NAVIGATION = Object.freeze({
  "HOME-OVERVIEW": ["/app", "merchant.access"],
  "ORG-STORE-LIST": ["/app/organization/stores", "organization.store.read"],
  "CAT-MENU-LIST": ["/app/commerce/menus", "catalog.read"],
  "OPS-ORDER-QUEUE": ["/operations/orders", "ordering.read"],
  "KIT-KITCHEN-QUEUE": ["/operations/kitchen", "kitchen.operate"],
  "FUL-PICKUP-QUEUE": ["/operations/pickup", "fulfillment.operate"],
  "IAM-ROLE-LIST": ["/app/organization/roles", "identity.manage"],
} as const);

function record(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key))
  )
    throw new Error("MERCHANT_WORKSPACE_INVALID");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      throw new Error("MERCHANT_WORKSPACE_INVALID");
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

function storeOption(value: unknown): MerchantStoreOption {
  const input = record(value, ["brandLabel", "storeLabel", "storeReference"]);
  if (
    typeof input.brandLabel !== "string" ||
    !SAFE_LABEL.test(input.brandLabel) ||
    typeof input.storeLabel !== "string" ||
    !SAFE_LABEL.test(input.storeLabel) ||
    typeof input.storeReference !== "string" ||
    !UUID_V7.test(input.storeReference)
  )
    throw new Error("MERCHANT_WORKSPACE_INVALID");
  return Object.freeze({
    brandLabel: input.brandLabel,
    storeLabel: input.storeLabel,
    storeReference: input.storeReference,
  });
}

function navigationItem(value: unknown): MerchantNavigationItem {
  const input = record(value, ["screenId", "label", "href", "permission"]);
  if (typeof input.screenId !== "string" || !(input.screenId in NAVIGATION))
    throw new Error("MERCHANT_WORKSPACE_INVALID");
  const screenId = input.screenId as MerchantNavigationItem["screenId"];
  const expected = NAVIGATION[screenId];
  if (
    typeof input.label !== "string" ||
    !SAFE_LABEL.test(input.label) ||
    input.href !== expected[0] ||
    input.permission !== expected[1]
  )
    throw new Error("MERCHANT_WORKSPACE_INVALID");
  return Object.freeze({
    screenId,
    label: input.label,
    href: expected[0],
    permission: expected[1],
  });
}

export function parseMerchantWorkspace(value: unknown): MerchantWorkspaceSnapshot {
  const input = record(value, [
    "screenId",
    "selectedScope",
    "authorizedStores",
    "businessDate",
    "storeStatus",
    "freshness",
    "dashboardAvailability",
    "navigation",
  ]);
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
    input.navigation.length > 20
  )
    throw new Error("MERCHANT_WORKSPACE_INVALID");
  const selectedScope = storeOption(input.selectedScope);
  const authorizedStores = Object.freeze(input.authorizedStores.map(storeOption));
  const navigation = Object.freeze(input.navigation.map(navigationItem));
  if (
    new Set(authorizedStores.map((item) => item.storeReference)).size !== authorizedStores.length ||
    !authorizedStores.some((item) => item.storeReference === selectedScope.storeReference) ||
    new Set(navigation.map((item) => item.screenId)).size !== navigation.length
  )
    throw new Error("MERCHANT_WORKSPACE_INVALID");
  return Object.freeze({
    screenId: "HOME-OVERVIEW",
    selectedScope,
    authorizedStores,
    businessDate: input.businessDate,
    storeStatus: input.storeStatus as MerchantWorkspaceSnapshot["storeStatus"],
    freshness: input.freshness,
    dashboardAvailability: "UnavailableUntilWP1905",
    navigation,
  });
}

export interface MerchantWorkspaceClient {
  bootstrap(): Promise<MerchantSessionBootstrap | null>;
  switchStore(csrf: string, targetStoreReference: string): Promise<MerchantSessionBootstrap>;
}

export function createMerchantWorkspaceClient(
  request: typeof fetch = globalThis.fetch,
): MerchantWorkspaceClient {
  const bootstrap = async (): Promise<MerchantSessionBootstrap | null> => {
    const response = await request("/merchant/session", {
      cache: "no-store",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (response.status === 401 || response.status === 403 || response.status === 404) return null;
    if (!response.ok) throw new Error("MERCHANT_WORKSPACE_UNAVAILABLE");
    const input = record(await response.json(), ["authenticated", "csrf", "workspace"]);
    if (
      input.authenticated !== true ||
      typeof input.csrf !== "string" ||
      !CREDENTIAL.test(input.csrf)
    )
      throw new Error("MERCHANT_WORKSPACE_INVALID");
    return Object.freeze({ csrf: input.csrf, workspace: parseMerchantWorkspace(input.workspace) });
  };
  return Object.freeze({
    bootstrap,
    async switchStore(csrf: string, targetStoreReference: string) {
      if (!CREDENTIAL.test(csrf) || !UUID_V7.test(targetStoreReference))
        throw new Error("MERCHANT_STORE_SWITCH_DENIED");
      const response = await request("/merchant/store-context", {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-BOP-CSRF": csrf,
        },
        body: JSON.stringify({ targetStoreReference }),
      });
      if (!response.ok) throw new Error("MERCHANT_STORE_SWITCH_DENIED");
      const input = record(await response.json(), ["workspace"]);
      const workspace = parseMerchantWorkspace(input.workspace);
      if (workspace.selectedScope.storeReference !== targetStoreReference)
        throw new Error("MERCHANT_STORE_SWITCH_DENIED");
      const refreshed = await bootstrap();
      if (
        refreshed === null ||
        refreshed.workspace.selectedScope.storeReference !== targetStoreReference
      )
        throw new Error("MERCHANT_STORE_SWITCH_DENIED");
      return refreshed;
    },
  });
}

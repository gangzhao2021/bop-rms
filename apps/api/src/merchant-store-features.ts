import { readClosedRecord } from "@bop/identity";
import {
  createPostgresPublishedMenuQueryStore,
  parseCatalogCode,
  parseCatalogInstant,
  parseCatalogReference,
} from "@rms/catalog";
import { skuRecipeUsesStock } from "@rms/recipe";
import {
  changeDiningServiceSetting,
  changeDiningTeaChargeSetting,
  DiningSessionError,
  loadDiningServiceSetting,
  loadDiningTeaChargeSetting,
  type DiningServiceSetting,
  type DiningTeaChargeSetting,
} from "@rms/dining";
import {
  changeStoreTipSetting,
  loadStoreTipSetting,
  StoreTipSettingConflictError,
  type StoreTipSetting,
} from "@rms/payment";
import {
  changeStoreFeatureSetting,
  loadStoreFeatureSetting,
  parseStoreAdministrationReference,
  StoreFeatureSettingConflictError,
  type StoreFeatureModules,
  type StoreFeatureSetting,
} from "@rms/store";
import type { CurrencyMetadataSnapshot } from "@rms/pricing";
import { createCustomerMenuStoreFacts } from "./customer-menu-store-facts.js";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

export type MerchantStoreFeaturesErrorCode =
  | "STORE_FEATURES_INPUT_INVALID"
  | "STORE_FEATURES_PERMISSION_DENIED"
  /** The setting changed since it was read: read it again. */
  | "STORE_FEATURES_CHANGED"
  /** WP-2423 item 8 ⑦ 4b-3: the tea charge item uses stock (a recipe); tea must not. */
  | "STORE_FEATURES_TEA_USES_STOCK"
  /** WP-2423 item 8 ⑦ (v15 2026-10-29): the tea item is not on the Store's listed dine-in menu. */
  | "STORE_FEATURES_TEA_NOT_LISTED"
  | "STORE_FEATURES_UNAVAILABLE";
export class MerchantStoreFeaturesError extends Error {
  constructor(readonly code: MerchantStoreFeaturesErrorCode) {
    super("store features " + code);
    this.name = "MerchantStoreFeaturesError";
  }
}
const fail = (code: MerchantStoreFeaturesErrorCode): never => {
  throw new MerchantStoreFeaturesError(code);
};
/** Who changes the Store's modules (the owner). */
export const storeFeaturesPermission = "organization.manage";

/**
 * Owner 2026-10-28 decision 6: the full-service template turns these off (pickup also closes
 * guests' pickup ordering).
 */
export const fullServiceTemplate = Object.freeze({
  counterOrder: false,
  pickup: false,
  inventory: false,
  loyalty: false,
  complianceDocuments: false,
});

/** The modules a pilot staff screen belongs to (screens of a module turned off are not listed). */
export const storeFeatureScreens: Readonly<Record<string, keyof StoreFeatureModules>> =
  Object.freeze({
    "OPS-ORDER-ENTRY": "counterOrder",
    "FUL-PICKUP-QUEUE": "pickup",
    "INV-ITEM-LIST": "inventory",
    "INV-LOCATION-LIST": "inventory",
    "INV-RECEIPT-LIST": "inventory",
    "INV-COUNT-LIST": "inventory",
    "INV-WASTE-RECORD": "inventory",
    "INV-OPENING-COUNT": "inventory",
    "RECIPE-LIST": "inventory",
    "RECIPE-OPTION-LIST": "inventory",
  });

/** The pilot navigation without the screens of modules the Store turned off. */
export function navigationForStoreFeatures<T extends { readonly screenId: string }>(
  navigation: readonly T[],
  setting: StoreFeatureModules,
  /**
   * Pickup orders Fulfillment still has to hand over (null: not known). While any wait, the
   * Pickup screen stays even with pickup and counter ordering off (v15 finding v).
   */
  pickupWaiting: number | null = 0,
): readonly T[] {
  return navigation.filter((item) => {
    // Counter orders are handed over on the Pickup screen too.
    if (item.screenId === "FUL-PICKUP-QUEUE")
      return setting.pickup || setting.counterOrder || pickupWaiting !== 0;
    const module = storeFeatureScreens[item.screenId];
    return module === undefined || setting[module];
  });
}

export interface StoreFeaturesView {
  readonly version: number;
  /** "FullService" when the modules are the full-service template's; null when never set. */
  readonly templateCode: StoreFeatureSetting["templateCode"];
  readonly modules: Pick<StoreFeatureModules, "counterOrder" | "pickup" | "inventory">;
  readonly changedAt: string | null;
  /** Owner decision 4: guests call staff, servers chase a dish (Dining's own switches). */
  readonly services: {
    readonly version: number;
    readonly staffCall: boolean;
    readonly chaseDish: boolean;
    /** Owner decision 2: staff record how many guests when opening a table. */
    readonly askPartySize: boolean;
    readonly changedAt: string | null;
  };
  /**
   * Owner decision 2 (4b-2): the menu item charged per guest at tables that pay at the end, or
   * none (Dining's own setting).
   */
  readonly teaCharge: {
    readonly version: number;
    readonly teaSellableReference: string | null;
    readonly changedAt: string | null;
  };
  /**
   * v15 2026-10-29: what the owner may choose as the tea: the items on the Store's listed dine-in
   * menu (hidden ones included; listing reviewed each with its price), by their own name.
   */
  readonly teaChoices: readonly {
    readonly sellableReference: string;
    readonly name: string;
    /**
     * Why it can't be the tea now (null: it can): not offered at this Store (hidden from it on
     * the menu), or no price here. A staff round could not sell it.
     */
    readonly unavailable: "NotOffered" | "NoPrice" | null;
  }[];
  /** Owner decision 11: the three tip percentages offered, or tips off (Payment's own setting). */
  readonly tips: {
    readonly version: number;
    readonly enabled: boolean;
    readonly tierPercents: readonly number[];
    readonly changedAt: string | null;
  };
  readonly canChange: boolean;
}

/**
 * WP-2423 item 8 ⑦ DEC-STORE-FEATURES: the Store's modules on the Store features page. The owner
 * (`organization.manage`) reads and changes them; a change takes effect at once and is recorded
 * as the next version (another change in between is a conflict). Loyalty and compliance
 * documents have no pilot screens, so the page neither shows nor changes them: they follow the
 * template, or stay as they were.
 */
export function createMerchantStoreFeatures(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  now(): string;
  /** Prices the tea choices at the Store (absent: listed items are taken as priced). */
  currencyMetadata?: CurrencyMetadataSnapshot;
}) {
  const resolve = createMerchantStoreScope(options.persistence);
  return async (input: {
    sessionCookie: unknown;
    csrf: unknown;
    command: unknown;
  }): Promise<StoreFeaturesView> => {
    const authenticated = await options.authentication.authorize(input);
    let serviceChange: null | {
      operationReference: string;
      expectedVersion: number;
      staffCall: boolean;
      chaseDish: boolean;
      askPartySize?: boolean;
    } = null;
    let teaChange: null | {
      operationReference: string;
      expectedVersion: number;
      teaSellableReference: string | null;
    } = null;
    let tipChange: null | {
      operationReference: string;
      expectedVersion: number;
      tipsEnabled: boolean;
      tierPercents: readonly number[];
    } = null;
    let change: null | {
      operationReference: string;
      expectedVersion: number;
      template: "FullService" | null;
      modules: Pick<StoreFeatureModules, "counterOrder" | "pickup" | "inventory"> | null;
    } = null;
    try {
      const action =
        input.command !== null && typeof input.command === "object"
          ? Object.getOwnPropertyDescriptor(input.command, "action")?.value
          : undefined;
      if (action === "Read") readClosedRecord(input.command, ["action"]);
      else if (action === "ChangeServices") {
        const raw = readClosedRecord(input.command, [
          "action",
          "operationReference",
          "expectedVersion",
          "staffCall",
          "chaseDish",
          // Absent (an older page): kept as it is.
          ...(Object.hasOwn(input.command as object, "askPartySize") ? ["askPartySize"] : []),
        ]);
        if (
          typeof raw.staffCall !== "boolean" ||
          typeof raw.chaseDish !== "boolean" ||
          (raw.askPartySize !== undefined && typeof raw.askPartySize !== "boolean") ||
          !Number.isSafeInteger(raw.expectedVersion) ||
          Number(raw.expectedVersion) < 0
        )
          return fail("STORE_FEATURES_INPUT_INVALID");
        serviceChange = {
          operationReference: String(parseStoreAdministrationReference(raw.operationReference)),
          expectedVersion: Number(raw.expectedVersion),
          staffCall: raw.staffCall,
          chaseDish: raw.chaseDish,
          ...(typeof raw.askPartySize === "boolean" ? { askPartySize: raw.askPartySize } : {}),
        };
      } else if (action === "ChangeTeaCharge") {
        const raw = readClosedRecord(input.command, [
          "action",
          "operationReference",
          "expectedVersion",
          "teaSellableReference",
        ]);
        if (!Number.isSafeInteger(raw.expectedVersion) || Number(raw.expectedVersion) < 0)
          return fail("STORE_FEATURES_INPUT_INVALID");
        teaChange = {
          operationReference: String(parseStoreAdministrationReference(raw.operationReference)),
          expectedVersion: Number(raw.expectedVersion),
          teaSellableReference:
            raw.teaSellableReference === null
              ? null
              : String(parseStoreAdministrationReference(raw.teaSellableReference)),
        };
      } else if (action === "ChangeTips") {
        const raw = readClosedRecord(input.command, [
          "action",
          "operationReference",
          "expectedVersion",
          "enabled",
          "tierPercents",
        ]);
        const tiers = raw.tierPercents;
        if (
          typeof raw.enabled !== "boolean" ||
          !Number.isSafeInteger(raw.expectedVersion) ||
          Number(raw.expectedVersion) < 0 ||
          !Array.isArray(tiers) ||
          tiers.length !== 3 ||
          tiers.some((n) => !Number.isSafeInteger(n) || Number(n) < 1 || Number(n) > 50) ||
          !(Number(tiers[0]) < Number(tiers[1]) && Number(tiers[1]) < Number(tiers[2]))
        )
          return fail("STORE_FEATURES_INPUT_INVALID");
        tipChange = {
          operationReference: String(parseStoreAdministrationReference(raw.operationReference)),
          expectedVersion: Number(raw.expectedVersion),
          tipsEnabled: raw.enabled,
          tierPercents: tiers.map(Number),
        };
      } else if (action === "ApplyTemplate") {
        const raw = readClosedRecord(input.command, [
          "action",
          "operationReference",
          "expectedVersion",
          "template",
        ]);
        if (
          raw.template !== "FullService" ||
          !Number.isSafeInteger(raw.expectedVersion) ||
          Number(raw.expectedVersion) < 0
        )
          return fail("STORE_FEATURES_INPUT_INVALID");
        change = {
          operationReference: String(parseStoreAdministrationReference(raw.operationReference)),
          expectedVersion: Number(raw.expectedVersion),
          template: "FullService",
          modules: null,
        };
      } else {
        const raw = readClosedRecord(input.command, [
          "action",
          "operationReference",
          "expectedVersion",
          "modules",
        ]);
        const modules = readClosedRecord(raw.modules, ["counterOrder", "pickup", "inventory"]);
        if (
          raw.action !== "Change" ||
          !Number.isSafeInteger(raw.expectedVersion) ||
          Number(raw.expectedVersion) < 0 ||
          Object.values(modules).some((value) => typeof value !== "boolean")
        )
          return fail("STORE_FEATURES_INPUT_INVALID");
        change = {
          operationReference: String(parseStoreAdministrationReference(raw.operationReference)),
          expectedVersion: Number(raw.expectedVersion),
          template: null,
          modules: {
            counterOrder: modules.counterOrder === true,
            pickup: modules.pickup === true,
            inventory: modules.inventory === true,
          },
        };
      }
    } catch (error) {
      if (error instanceof MerchantStoreFeaturesError) throw error;
      return fail("STORE_FEATURES_INPUT_INVALID");
    }
    try {
      return await options.persistence.transactions.run((tx) =>
        withMerchantTransactionAuthorization(
          {
            transaction: tx,
            resolve: async () => {
              const current = await resolve(
                tx,
                input.sessionCookie,
                storeFeaturesPermission,
                authenticated.sessionReference,
              ).catch(() => fail("STORE_FEATURES_PERMISSION_DENIED"));
              if ((await current.allowed()) !== true)
                return fail("STORE_FEATURES_PERMISSION_DENIED");
              return current;
            },
            recheck: async (current) => (await current.allowed()) === true,
            denied: () => fail("STORE_FEATURES_PERMISSION_DENIED"),
          },
          async (authority) => {
            const current = authority.scope;
            const scope = {
              tenantReference: String(current.selected.tenantReference),
              brandReference: String(current.context.brand.brandReference),
              storeReference: String(current.store.storeReference),
            };
            const runner = tx as unknown as Parameters<typeof loadStoreFeatureSetting>[0];
            let setting = await loadStoreFeatureSetting(runner, scope);
            if (change !== null)
              setting = await changeStoreFeatureSetting(runner, scope, {
                operationReference: change.operationReference,
                expectedVersion: change.expectedVersion,
                template: change.template,
                // The modules the page does not show stay as they are.
                modules: {
                  counterOrder: setting.counterOrder,
                  pickup: setting.pickup,
                  inventory: setting.inventory,
                  loyalty: setting.loyalty,
                  complianceDocuments: setting.complianceDocuments,
                  ...(change.template === "FullService" ? fullServiceTemplate : change.modules),
                },
                actorReference: String(current.actorReference),
                observedAt: new Date(Date.parse(options.now())).toISOString(),
              });
            const diningRunner = tx as unknown as Parameters<typeof loadDiningServiceSetting>[0];
            let services = await loadDiningServiceSetting(diningRunner, scope);
            if (serviceChange !== null)
              services = await changeDiningServiceSetting(diningRunner, scope, {
                ...serviceChange,
                actorReference: String(current.actorReference),
                observedAt: new Date(Date.parse(options.now())).toISOString(),
              });
            const paymentRunner = tx as unknown as Parameters<typeof loadStoreTipSetting>[0];
            let tips = await loadStoreTipSetting(paymentRunner, scope);
            if (tipChange !== null)
              tips = await changeStoreTipSetting(paymentRunner, scope, {
                ...tipChange,
                actorReference: String(current.actorReference),
                observedAt: new Date(Date.parse(options.now())).toISOString(),
              });
            let teaCharge = await loadDiningTeaChargeSetting(diningRunner, scope);
            const teaChoices = await listedTeaChoices(
              tx,
              scope,
              options.now(),
              options.currencyMetadata,
            );
            if (teaChange !== null && teaChange.teaSellableReference !== null) {
              const refused = await teaItemRefusal(
                tx,
                scope,
                teaChoices,
                teaChange.teaSellableReference,
              );
              if (refused !== null) return fail(refused);
            }
            if (teaChange !== null)
              teaCharge = await changeDiningTeaChargeSetting(diningRunner, scope, {
                ...teaChange,
                actorReference: String(current.actorReference),
                observedAt: new Date(Date.parse(options.now())).toISOString(),
              });
            return storeFeaturesView(setting, services, tips, teaCharge, teaChoices, true);
          },
        ),
      );
    } catch (error) {
      if (error instanceof MerchantStoreFeaturesError) throw error;
      if (
        error instanceof StoreFeatureSettingConflictError ||
        error instanceof StoreTipSettingConflictError ||
        (error instanceof DiningSessionError &&
          error.code === "DINING_SESSION_IDEMPOTENCY_CONFLICT")
      )
        throw new MerchantStoreFeaturesError("STORE_FEATURES_CHANGED");
      throw new MerchantStoreFeaturesError("STORE_FEATURES_UNAVAILABLE");
    }
  };
}

function storeFeaturesView(
  setting: StoreFeatureSetting,
  services: DiningServiceSetting,
  tips: StoreTipSetting,
  teaCharge: DiningTeaChargeSetting,
  teaChoices: StoreFeaturesView["teaChoices"],
  canChange: boolean,
): StoreFeaturesView {
  return Object.freeze({
    version: setting.version,
    templateCode: setting.templateCode,
    modules: Object.freeze({
      counterOrder: setting.counterOrder,
      pickup: setting.pickup,
      inventory: setting.inventory,
    }),
    changedAt: setting.changedAt,
    services: Object.freeze({
      version: services.version,
      staffCall: services.staffCall,
      chaseDish: services.chaseDish,
      askPartySize: services.askPartySize,
      changedAt: services.changedAt,
    }),
    teaCharge: Object.freeze({
      version: teaCharge.version,
      teaSellableReference: teaCharge.teaSellableReference,
      changedAt: teaCharge.changedAt,
    }),
    teaChoices: Object.freeze(teaChoices.map((item) => Object.freeze({ ...item }))),
    tips: Object.freeze({
      version: tips.version,
      enabled: tips.tipsEnabled,
      tierPercents: Object.freeze([...tips.tierPercents]),
      changedAt: tips.changedAt,
    }),
    canChange,
  });
}

interface QueryTransaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}

/**
 * v15 2026-10-29: why this item can't be the per-head tea, or null. Only an item a staff round can
 * sell — on the listed dine-in menu, offered at this Store, priced here — and never one whose
 * recipe uses stock (taking tea off an unpaid bill would have stock to return); a dish declared a
 * charge with no stock ingredients is fine. Exported for the restricted-role acceptance.
 */
export async function teaItemRefusal(
  tx: QueryTransaction,
  scope: { brandReference: string; storeReference: string },
  choices: StoreFeaturesView["teaChoices"],
  teaSellableReference: string,
): Promise<"STORE_FEATURES_TEA_NOT_LISTED" | "STORE_FEATURES_TEA_USES_STOCK" | null> {
  if (
    !choices.some(
      (item) => item.sellableReference === teaSellableReference && item.unavailable === null,
    )
  )
    return "STORE_FEATURES_TEA_NOT_LISTED";
  return (await skuRecipeUsesStock(
    tx as unknown as Parameters<typeof skuRecipeUsesStock>[0],
    scope,
    teaSellableReference,
  ))
    ? "STORE_FEATURES_TEA_USES_STOCK"
    : null;
}

/**
 * v15 2026-10-29: the items on the Store's current listed dine-in menu, hidden ones included (a
 * tea item is usually hidden from the guest menu), each by its own name — the menu listing
 * reviewed each one with its price. Restores the Brand and Store context the read changes.
 */
export async function listedTeaChoices(
  tx: QueryTransaction,
  scope: { brandReference: string; storeReference: string },
  at: string,
  currencyMetadata: CurrencyMetadataSnapshot | undefined,
): Promise<StoreFeaturesView["teaChoices"]> {
  const before = (
    (await tx.query(
      "SELECT current_setting('bop.brand_id',true) brand,current_setting('bop.store_id',true) store",
      [],
    )) as { rows?: { brand: string | null; store: string | null }[] } | undefined
  )?.rows?.[0];
  try {
    const requestedAt = parseCatalogInstant(new Date(Date.parse(at)).toISOString());
    const projections = await createPostgresPublishedMenuQueryStore(
      { run: (work) => work(tx as never) },
      scope,
    ).loadCandidates({
      brandReference: parseCatalogReference(scope.brandReference),
      storeReference: parseCatalogReference(scope.storeReference),
      channelCode: parseCatalogCode("CUSTOMER_PWA"),
      orderTypeCode: parseCatalogCode("DINE_IN"),
      requestedAt,
    });
    const items = new Map<string, string>();
    for (const projection of projections) {
      const locale = projection.snapshot.defaultLocale;
      for (const section of projection.snapshot.sections)
        for (const item of section.sellables) {
          if (item.configuredAvailability !== "Available") continue;
          const sku = String(item.sellableReference);
          const name = item.localizedNames[locale] ?? Object.values(item.localizedNames)[0] ?? "";
          const zh = Object.entries(item.localizedNames).find(
            ([key, value]) => key.startsWith("zh") && value !== name,
          )?.[1];
          if (!items.has(sku)) items.set(sku, zh === undefined ? name : `${name} ${zh}`);
        }
    }
    // Offered at this Store with its price, as a staff round (and the guest menu) reads it.
    const facts =
      currencyMetadata === undefined || items.size === 0
        ? null
        : await createCustomerMenuStoreFacts({
            transactions: { run: (work) => work(tx as never) },
            currencyMetadata,
            priceChannelCode: "CUSTOMER_WEB",
          }).load({
            brandReference: parseCatalogReference(scope.brandReference),
            storeReference: parseCatalogReference(scope.storeReference),
            channelCode: parseCatalogCode("CUSTOMER_PWA"),
            orderTypeCode: parseCatalogCode("DINE_IN"),
            requestedAt,
            sellableReferences: [...items.keys()].map((sku) => parseCatalogReference(sku)),
          });
    return [...items].map(([sellableReference, name]) => {
      const fact = facts?.get(parseCatalogReference(sellableReference));
      return {
        sellableReference,
        name,
        unavailable:
          facts === null
            ? null
            : fact === undefined || fact.availability === "NotOffered"
              ? ("NotOffered" as const)
              : fact.price === null
                ? ("NoPrice" as const)
                : null,
      };
    });
  } finally {
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      before?.brand ?? "",
      before?.store ?? "",
    ]);
  }
}
const allModules: StoreFeatureModules = Object.freeze({
  counterOrder: true,
  pickup: true,
  inventory: true,
  loyalty: true,
  complianceDocuments: true,
});

/**
 * The Store's modules inside another read (the workspace's navigation, a counter command), in a
 * savepoint that restores the Brand and Store context it changes. `unreadable` decides what an
 * unreadable setting means: the navigation keeps every screen, a command refuses.
 */
export async function readStoreFeatures(
  tx: QueryTransaction,
  scope: { brandReference: string; storeReference: string },
  unreadable: "AllModules" | "Refuse",
): Promise<StoreFeatureModules> {
  const before = (
    (await tx.query(
      "SELECT current_setting('bop.brand_id',true) brand,current_setting('bop.store_id',true) store",
      [],
    )) as { rows?: { brand: string | null; store: string | null }[] } | undefined
  )?.rows?.[0];
  await tx.query("SAVEPOINT store_feature_setting_read", []);
  try {
    const setting = await loadStoreFeatureSetting(
      tx as Parameters<typeof loadStoreFeatureSetting>[0],
      scope,
    );
    await tx.query("RELEASE SAVEPOINT store_feature_setting_read", []);
    return setting;
  } catch (error) {
    await tx.query("ROLLBACK TO SAVEPOINT store_feature_setting_read", []);
    await tx.query("RELEASE SAVEPOINT store_feature_setting_read", []);
    if (unreadable === "Refuse") throw error;
    return allModules;
  } finally {
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      before?.brand ?? "",
      before?.store ?? "",
    ]);
  }
}

/**
 * WP-2423 item 8 ⑦ 1b: what guests are offered now, given the Store's modules. A Store that turned
 * pickup off takes no guest pickup order: Pickup leaves the services offered and is named as
 * turned off, so a guest at a pickup code is told the Store takes dine-in orders only. An
 * unreadable setting offers no pickup (dine-in is not affected).
 */
export async function guestServiceModes<
  T extends { readonly availableServiceModes: readonly string[] },
>(
  tx: QueryTransaction,
  scope: { tenantReference: string; brandReference: string; storeReference: string },
  status: T,
): Promise<T & { readonly servicesTurnedOff: readonly "Pickup"[] }> {
  const pickup = await readStoreFeatures(tx, scope, "Refuse").then(
    (features) => features.pickup,
    () => false,
  );
  return Object.freeze({
    ...status,
    availableServiceModes: Object.freeze(
      pickup
        ? [...status.availableServiceModes]
        : status.availableServiceModes.filter((mode) => mode !== "Pickup"),
    ),
    servicesTurnedOff: Object.freeze(pickup ? [] : (["Pickup"] as const)),
  });
}

/** WP-2423 item 8 ⑦ (Owner decision 11): the tip a guest or staff member may choose now. */
export interface StoreTipChoices {
  readonly enabled: boolean;
  /** Three percentages of the subtotal before tax, ascending; "other amount" is always offered. */
  readonly tierPercents: readonly number[];
}
export type ChosenTip =
  | { readonly kind: "None" }
  | { readonly kind: "Percent"; readonly percent: number }
  | { readonly kind: "Amount"; readonly amountMinor: string };

/** A tip percentage as sent: a whole number 1–50 (the Store's own tiers are checked later). */
export const isTipPercent = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 50;

/**
 * The Store's tip choices inside another read or command (savepoint, the Brand and Store context
 * restored after). An unreadable setting refuses: no tip is charged on a guess.
 */
export async function readStoreTipChoices(
  tx: QueryTransaction,
  scope: { brandReference: string; storeReference: string },
  /** The choices in force at this instant (a payment recorded after an outage); null: now. */
  asOf: string | null = null,
): Promise<StoreTipChoices> {
  const before = (
    (await tx.query(
      "SELECT current_setting('bop.brand_id',true) brand,current_setting('bop.store_id',true) store",
      [],
    )) as { rows?: { brand: string | null; store: string | null }[] } | undefined
  )?.rows?.[0];
  await tx.query("SAVEPOINT store_tip_setting_read", []);
  try {
    const setting = await loadStoreTipSetting(
      tx as Parameters<typeof loadStoreTipSetting>[0],
      scope,
      asOf,
    );
    await tx.query("RELEASE SAVEPOINT store_tip_setting_read", []);
    return Object.freeze({
      enabled: setting.tipsEnabled,
      tierPercents: Object.freeze([...setting.tierPercents]),
    });
  } catch (error) {
    await tx.query("ROLLBACK TO SAVEPOINT store_tip_setting_read", []);
    await tx.query("RELEASE SAVEPOINT store_tip_setting_read", []);
    throw error;
  } finally {
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      before?.brand ?? "",
      before?.store ?? "",
    ]);
  }
}

/**
 * Why a chosen tip can't be taken now: tips are off (only no tip, or an amount of zero), or the
 * percentage is not one the Store offers any more (the screen read older choices). Null: taken.
 */
export function tipRefusal(
  choices: StoreTipChoices,
  tip: ChosenTip,
): "TipsOff" | "TipChoicesChanged" | null {
  const none = tip.kind === "None" || (tip.kind === "Amount" && tip.amountMinor === "0");
  if (!choices.enabled) return none ? null : "TipsOff";
  if (tip.kind === "Percent" && !choices.tierPercents.includes(tip.percent))
    return "TipChoicesChanged";
  return null;
}

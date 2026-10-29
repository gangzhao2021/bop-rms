import { readClosedRecord } from "@bop/identity";
import {
  changeDiningServiceSetting,
  DiningSessionError,
  loadDiningServiceSetting,
  type DiningServiceSetting,
} from "@rms/dining";
import {
  changeStoreFeatureSetting,
  loadStoreFeatureSetting,
  parseStoreAdministrationReference,
  StoreFeatureSettingConflictError,
  type StoreFeatureModules,
  type StoreFeatureSetting,
} from "@rms/store";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

export type MerchantStoreFeaturesErrorCode =
  | "STORE_FEATURES_INPUT_INVALID"
  | "STORE_FEATURES_PERMISSION_DENIED"
  /** The setting changed since it was read: read it again. */
  | "STORE_FEATURES_CHANGED"
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
): readonly T[] {
  return navigation.filter((item) => {
    // Counter orders are handed over on the Pickup screen too.
    if (item.screenId === "FUL-PICKUP-QUEUE") return setting.pickup || setting.counterOrder;
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
        ]);
        if (
          typeof raw.staffCall !== "boolean" ||
          typeof raw.chaseDish !== "boolean" ||
          !Number.isSafeInteger(raw.expectedVersion) ||
          Number(raw.expectedVersion) < 0
        )
          return fail("STORE_FEATURES_INPUT_INVALID");
        serviceChange = {
          operationReference: String(parseStoreAdministrationReference(raw.operationReference)),
          expectedVersion: Number(raw.expectedVersion),
          staffCall: raw.staffCall,
          chaseDish: raw.chaseDish,
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
            return storeFeaturesView(setting, services, true);
          },
        ),
      );
    } catch (error) {
      if (error instanceof MerchantStoreFeaturesError) throw error;
      if (
        error instanceof StoreFeatureSettingConflictError ||
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
      changedAt: services.changedAt,
    }),
    canChange,
  });
}

interface QueryTransaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
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

import { readClosedRecord } from "@bop/identity";
import {
  BrandGuestIntakeError,
  createPostgresMerchantOrganizationSource,
  readBrandGuestIntake,
  recordBrandGuestIntake,
} from "@bop/tenant";
import {
  changeStoreSupportPermission,
  listStoreSupportAccess,
  readActivePlatformSupportPerson,
  readStoreSupportPermission,
  recordStoreSupportAccess,
  StoreSupportPermissionError,
  type StoreSupportPermission,
} from "@bop/permission";
import { listBrandMenus } from "@rms/catalog";
import { readStoreKitchenLine } from "@rms/kitchen";
import { createPostgresMerchantOrderIndex, loadMerchantOrderListSummaries } from "@rms/ordering";
import { changeStoreFeatureSetting, loadStoreFeatureSetting } from "@rms/store";
import { applyStoreKitchenLine } from "./merchant-kitchen-setup.js";
import { createMerchantOrderQueueRead } from "./merchant-order-queue-read.js";
import { businessTransaction } from "./merchant-ordinary-refund-approval.js";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import { onlyRefusal } from "./merchant-failure.js";

/**
 * WP-2423 取舍 15 (Owner 2026-10-28): platform support staff. Not a Store role: this path never uses
 * a Store permission, and the database refuses a support person any role assignment (so none of the
 * Store's own commands, money and access among them, can reach them whatever a role says).
 * Viewing needs no consent each time, and every view is recorded in the same transaction as the
 * read. Changing is a closed list of settings, only while the Owner's permission is live, and is
 * recorded under the support person. Guest contact: a first initial at most, never phone or email.
 */
export class MerchantStoreSupportError extends Error {
  constructor(
    readonly code:
      | "Denied"
      | "NotAllowedByOwner"
      | "OwnerOnly"
      | "Invalid"
      /** Someone else paused or resumed the merchant since this was read: read it again. */
      | "Changed"
      | "Unavailable",
  ) {
    super("store support " + code);
    this.name = "MerchantStoreSupportError";
  }
}
/** Always the Owner's own to do: support guides them. Refused here whatever permission is live. */
export const ownerOnlySupportActions = Object.freeze([
  "CollectPayment",
  "Refund",
  "Comp",
  "Discount",
  "Void",
  "StaffAndRoles",
  "PaymentAccount",
] as const);
export const allowedSupportChanges = Object.freeze(["SetUpKitchenLine", "SetPickup"] as const);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const reference = (value: unknown): string =>
  typeof value === "string" && uuid.test(value)
    ? value
    : (() => {
        throw new MerchantStoreSupportError("Invalid");
      })();
/** Enough to tell two orders apart on a call: never the name, phone or email itself. */
export function maskGuestName(name: string | null): string | null {
  const first = name === null ? "" : (Array.from(name.trim())[0] ?? "");
  return first === "" ? null : first + "…";
}

export function createMerchantStoreSupport(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize"> &
    Required<Pick<MerchantBffService, "sessionBootstrap">>;
  /** The Stores this installation serves: support reaches no others. */
  stores(): readonly {
    readonly tenantReference: string;
    readonly brandReference: string;
    readonly storeReference: string;
  }[];
  nextReference(): string;
  locale: string;
  quoteVersion?: 1 | 2;
}) {
  const denied = (): never => {
    throw new MerchantStoreSupportError("Denied");
  };
  const now = () => new Date(Date.parse(options.persistence.now())).toISOString();
  const person = async (
    transaction: Parameters<typeof readActivePlatformSupportPerson>[0],
    actorReference: string | null,
    action: "platform.support.view" | "platform.support.change" | "platform.merchant.pause",
  ) => {
    if (actorReference === null) return denied();
    const found = await readActivePlatformSupportPerson(transaction, actorReference, now());
    return found !== null && found.actions.includes(action) ? found : denied();
  };
  const storeNamed = (storeReference: unknown) => {
    const wanted = reference(storeReference);
    return options.stores().find((store) => store.storeReference === wanted) ?? denied();
  };
  const mapped = (error: unknown): never => {
    if (error instanceof MerchantStoreSupportError) throw error;
    if (
      error !== null &&
      typeof error === "object" &&
      Object.getOwnPropertyDescriptor(error, "code")?.value ===
        "TENANT_DATABASE_TRANSACTION_CONFLICT"
    )
      throw error;
    throw new MerchantStoreSupportError("Unavailable");
  };
  const storeFacts = (tx: unknown, scope: { brandReference: string; storeReference: string }) =>
    createPostgresMerchantOrganizationSource(tx as never, {
      ...scope,
      observedAt: now(),
    }).getStore(scope.storeReference as never);
  const storeName = async (
    tx: unknown,
    scope: { brandReference: string; storeReference: string },
  ) => (await storeFacts(tx, scope))?.displayName ?? "—";
  return Object.freeze({
    /** Who is signed in, what they may do and which Stores they can pick. */
    async session(sessionCookie: unknown) {
      try {
        const current = await options.authentication.sessionBootstrap(sessionCookie);
        return await options.persistence.transactions.run(async (transaction) => {
          const tx = businessTransaction(transaction);
          const found = await person(
            tx as never,
            current.session.actor.actorReference,
            "platform.support.view",
          );
          const stores = [];
          for (const store of options.stores())
            stores.push({
              storeReference: store.storeReference,
              name: await storeName(tx, store),
            });
          return Object.freeze({
            csrf: String(current.csrf),
            name: found.displayName,
            canChange: found.actions.includes("platform.support.change"),
            // WP-2423 item 13 ②: may pause and resume a merchant's new guests.
            canPause: found.actions.includes("platform.merchant.pause"),
            stores,
          });
        });
      } catch (error) {
        return mapped(error);
      }
    },
    /**
     * WP-2423 item 13 ②: every merchant this installation serves, Store by Store: whether guests
     * can order yet and when its last order came. Recorded for each Store's Owner like any view.
     * One Store that can't be read says so; the others still show.
     */
    async overview(input: { sessionCookie: unknown; csrf: unknown }) {
      try {
        const authenticated = await options.authentication
          .authorize(input)
          .catch(onlyRefusal(denied));
        return await options.persistence.transactions.run(async (transaction) => {
          const tx = businessTransaction(transaction);
          const found = await person(
            tx as never,
            authenticated.actor.actorReference,
            "platform.support.view",
          );
          const at = now();
          const merchants = new Map<
            string,
            { name: string; stores: Readonly<Record<string, unknown>>[] }
          >();
          for (const scope of options.stores()) {
            await recordStoreSupportAccess(tx as never, scope, {
              logReference: options.nextReference(),
              supportActorReference: found.actorReference,
              kind: "Viewed",
              subjectCode: "MerchantOverview",
              occurredAt: at,
            });
            const organization = createPostgresMerchantOrganizationSource(tx as never, {
              ...scope,
              observedAt: at,
            });
            let store: Readonly<Record<string, unknown>>;
            let brandName = "—";
            await tx.query("SAVEPOINT support_overview_store", []);
            try {
              brandName =
                (await organization.getBrand(scope.brandReference as never))?.displayName ?? "—";
              const facts = await storeFacts(tx, scope);
              const kitchen = await readStoreKitchenLine(tx, scope);
              const menus = await listBrandMenus(tx as never, scope);
              const index = await createPostgresMerchantOrderIndex({
                brandReference: scope.brandReference,
                storeReference: scope.storeReference,
                authorize: async () => true,
              }).list({ transaction: tx, afterOrderReference: null, limit: 1, newestFirst: true });
              await tx.query("RELEASE SAVEPOINT support_overview_store", []);
              store = Object.freeze({
                storeReference: scope.storeReference,
                name: facts?.displayName ?? "—",
                timeZone: facts?.timeZone ?? null,
                readable: true,
                menuListed: menus.some((menu) => menu.publication?.state === "Published"),
                kitchenSetUp: kitchen.version > 0,
                lastOrderAt: index.items[0]?.submittedAt ?? null,
              });
            } catch {
              await tx.query("ROLLBACK TO SAVEPOINT support_overview_store", []);
              await tx.query("RELEASE SAVEPOINT support_overview_store", []);
              store = Object.freeze({
                storeReference: scope.storeReference,
                name: "—",
                timeZone: null,
                readable: false,
                menuListed: false,
                kitchenSetUp: false,
                lastOrderAt: null,
              });
            }
            const merchant = merchants.get(scope.brandReference) ?? { name: brandName, stores: [] };
            if (merchant.name === "—") merchant.name = brandName;
            merchant.stores.push(store);
            merchants.set(scope.brandReference, merchant);
          }
          // WP-2423 item 13 ②: whether each merchant takes new guests now (null: can't be read).
          const intakes = new Map<string, Readonly<Record<string, unknown>> | null>();
          for (const brandReference of merchants.keys()) {
            await tx.query("SAVEPOINT support_overview_intake", []);
            try {
              const intake = await readBrandGuestIntake(tx as never, brandReference);
              await tx.query("RELEASE SAVEPOINT support_overview_intake", []);
              intakes.set(brandReference, Object.freeze({ ...intake }));
            } catch {
              await tx.query("ROLLBACK TO SAVEPOINT support_overview_intake", []);
              await tx.query("RELEASE SAVEPOINT support_overview_intake", []);
              intakes.set(brandReference, null);
            }
          }
          return Object.freeze({
            observedAt: at,
            merchants: [...merchants.entries()].map(([brandReference, merchant]) =>
              Object.freeze({
                brandReference,
                ...merchant,
                guestIntake: intakes.get(brandReference) ?? null,
              }),
            ),
          });
        });
      } catch (error) {
        return mapped(error);
      }
    },
    /** One Store, read-only, recorded as viewed in this same transaction or not read at all. */
    async view(input: { sessionCookie: unknown; csrf: unknown; storeReference: unknown }) {
      try {
        const authenticated = await options.authentication
          .authorize(input)
          .catch(onlyRefusal(denied));
        const scope = storeNamed(input.storeReference);
        return await options.persistence.transactions.run(async (transaction) => {
          const tx = businessTransaction(transaction);
          const actor = authenticated.actor.actorReference;
          const found = await person(tx as never, actor, "platform.support.view");
          const at = now();
          await recordStoreSupportAccess(tx as never, scope, {
            logReference: options.nextReference(),
            supportActorReference: found.actorReference,
            kind: "Viewed",
            subjectCode: "StoreDetails",
            occurredAt: at,
          });
          const facts = await storeFacts(tx, scope);
          const permission = await readStoreSupportPermission(tx as never, scope, at);
          const kitchen = await readStoreKitchenLine(tx, scope);
          const features = await loadStoreFeatureSetting(tx as never, scope);
          const menus = await listBrandMenus(tx as never, scope);
          // The orders of this Store, then each one's state now from the queue's own read (what
          // staff see, from each fact's owner). One that can't be read says so, never a stale state.
          const index = await createPostgresMerchantOrderIndex({
            brandReference: scope.brandReference,
            storeReference: scope.storeReference,
            authorize: async () => true,
          }).list({ transaction: tx, afterOrderReference: null, limit: 20, newestFirst: true });
          const queue = createMerchantOrderQueueRead({
            transactions: { run: (work) => work(tx) },
            quoteVersion: options.quoteVersion ?? 2,
            now,
            authorize: async () => ({
              tenantReference: scope.tenantReference,
              brandReference: scope.brandReference,
              storeReference: scope.storeReference,
              sessionReference: authenticated.sessionReference,
            }),
          });
          const orders = [];
          for (const order of index.items) {
            await tx.query("SAVEPOINT support_order_state", []);
            let phase: string | null = null;
            try {
              const read = await queue({
                sessionCookie: input.sessionCookie,
                afterOrderReference: null,
                limit: 1,
                onlyOrderReference: order.orderReference,
              });
              const item = read.items[0];
              phase = item === undefined ? null : (item.kitchenPhase ?? item.currentPhase);
              await tx.query("RELEASE SAVEPOINT support_order_state", []);
            } catch {
              await tx.query("ROLLBACK TO SAVEPOINT support_order_state", []);
              await tx.query("RELEASE SAVEPOINT support_order_state", []);
            }
            await tx.query(
              "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
              [scope.brandReference, scope.storeReference],
            );
            orders.push({ ...order, phase });
          }
          const summaries = await loadMerchantOrderListSummaries(
            tx,
            scope,
            orders.map((order) => order.orderReference),
            options.locale,
          );
          return Object.freeze({
            name: facts?.displayName ?? "—",
            timeZone: facts?.timeZone ?? null,
            ownerAllowsChanges: found.actions.includes("platform.support.change")
              ? permission.changesAllowed
              : false,
            allowedUntil: permission.changesAllowed ? permission.allowedUntil : null,
            kitchenSetUp: kitchen.version > 0,
            kitchenSince: kitchen.effectiveFrom,
            kitchenVersion: kitchen.version,
            features: Object.freeze({ version: features.version, pickup: features.pickup }),
            menus: menus.slice(0, 50).map((menu) =>
              Object.freeze({
                name:
                  menu.localizedNames[options.locale] ??
                  Object.values(menu.localizedNames)[0] ??
                  menu.internalCode,
                listed: menu.publication?.state === "Published",
              }),
            ),
            orders: orders.map((order) => {
              const summary = summaries.get(order.orderReference);
              return Object.freeze({
                orderNumber: order.orderNumber,
                orderType: order.orderType,
                phase: order.phase,
                createdAt: order.submittedAt,
                lineCount: summary?.lineCount ?? null,
                guest: maskGuestName(summary?.pickupName ?? null),
              });
            }),
          });
        });
      } catch (error) {
        return mapped(error);
      }
    },
    async command(input: {
      sessionCookie: unknown;
      csrf: unknown;
      storeReference: unknown;
      command: unknown;
    }) {
      let raw: Record<string, unknown>;
      try {
        raw = readClosedRecord(
          input.command,
          Object.keys((input.command ?? {}) as object).includes("value")
            ? ["operationReference", "action", "expectedVersion", "value"]
            : ["operationReference", "action", "expectedVersion"],
        );
      } catch {
        throw new MerchantStoreSupportError("Invalid");
      }
      const action = String(raw.action);
      const operationReference = reference(raw.operationReference);
      if (!Number.isSafeInteger(raw.expectedVersion) || (raw.expectedVersion as number) < 0)
        throw new MerchantStoreSupportError("Invalid");
      const ownerOnly = (ownerOnlySupportActions as readonly string[]).includes(action);
      if (!ownerOnly && !(allowedSupportChanges as readonly string[]).includes(action))
        throw new MerchantStoreSupportError("Invalid");
      if (action === "SetPickup" && typeof raw.value !== "boolean")
        throw new MerchantStoreSupportError("Invalid");
      try {
        const authenticated = await options.authentication
          .authorize(input)
          .catch(onlyRefusal(denied));
        const scope = storeNamed(input.storeReference);
        // A refusal is recorded and committed; the error is thrown after the transaction.
        const outcome = await options.persistence.transactions.run(async (transaction) => {
          const tx = businessTransaction(transaction);
          const actor = authenticated.actor.actorReference;
          const found = await person(tx as never, actor, "platform.support.view");
          const at = now();
          const log = (kind: "Changed" | "Refused", subjectCode: string) =>
            recordStoreSupportAccess(tx as never, scope, {
              logReference: options.nextReference(),
              supportActorReference: found.actorReference,
              kind,
              subjectCode,
              occurredAt: at,
            });
          if (ownerOnly) {
            await log("Refused", action);
            return { refused: "OwnerOnly" as const };
          }
          const permission: StoreSupportPermission = await readStoreSupportPermission(
            tx as never,
            scope,
            at,
          );
          if (!found.actions.includes("platform.support.change") || !permission.changesAllowed) {
            await log("Refused", action);
            return { refused: "NotAllowedByOwner" as const };
          }
          if (action === "SetUpKitchenLine") {
            const result = await applyStoreKitchenLine(tx, {
              scope,
              actorReference: found.actorReference,
              operationReference,
              expectedVersion: raw.expectedVersion as number,
              recordedAt: at,
              nextReference: options.nextReference,
              authorize: async () => true,
              purposeCode: "PlatformSupportChange",
              permissionCode: "platform.support.change",
              reasonCode: "PLATFORM_SUPPORT_CHANGE",
            });
            if (result.status === "Recorded") await log("Changed", "KitchenLine");
            return { status: result.status };
          }
          const runner = tx as never;
          const setting = await loadStoreFeatureSetting(runner, scope);
          await changeStoreFeatureSetting(runner, scope, {
            operationReference,
            expectedVersion: raw.expectedVersion as number,
            template: null,
            modules: {
              counterOrder: setting.counterOrder,
              pickup: raw.value as boolean,
              inventory: setting.inventory,
              loyalty: setting.loyalty,
              alcohol: setting.alcohol,
              complianceDocuments: setting.complianceDocuments,
            },
            actorReference: found.actorReference,
            observedAt: at,
          });
          await log("Changed", "Pickup");
          return { status: "Recorded" as const };
        });
        if ("refused" in outcome) throw new MerchantStoreSupportError(outcome.refused);
        return Object.freeze({ status: outcome.status });
      } catch (error) {
        return mapped(error);
      }
    },
    /**
     * WP-2423 item 13 ② (Owner 2026-11-05 "就按这个做"): pause or resume a merchant's new guests,
     * against the version the support person saw, with a reason the merchant's staff see. Only a
     * support person holding `platform.merchant.pause`; recorded in the merchant's own append-only
     * record and in each of its Stores' support access log, in one transaction.
     */
    async changeGuestIntake(input: { sessionCookie: unknown; csrf: unknown; command: unknown }) {
      const raw = readClosedRecord(input.command, [
        "brandReference",
        "operationReference",
        "expectedVersion",
        "state",
        "reason",
      ]);
      const brandReference = reference(raw.brandReference);
      const operationReference = reference(raw.operationReference);
      const reason = typeof raw.reason === "string" ? raw.reason.trim() : "";
      if (
        (raw.state !== "Paused" && raw.state !== "Open") ||
        reason.length < 1 ||
        reason.length > 300 ||
        !Number.isSafeInteger(raw.expectedVersion) ||
        (raw.expectedVersion as number) < 0
      )
        throw new MerchantStoreSupportError("Invalid");
      try {
        const authenticated = await options.authentication
          .authorize(input)
          .catch(onlyRefusal(denied));
        const stores = options.stores().filter((store) => store.brandReference === brandReference);
        const first = stores[0] ?? denied();
        return await options.persistence.transactions.run(async (transaction) => {
          const tx = businessTransaction(transaction);
          const found = await person(
            tx as never,
            authenticated.actor.actorReference,
            "platform.merchant.pause",
          );
          const at = now();
          const recorded = await recordBrandGuestIntake(tx as never, {
            tenantReference: first.tenantReference,
            brandReference,
            expectedVersion: raw.expectedVersion as number,
            operationReference,
            state: raw.state as "Paused" | "Open",
            reason,
            actorReference: found.actorReference,
            recordedAt: at,
          });
          for (const store of stores)
            await recordStoreSupportAccess(tx as never, store, {
              logReference: options.nextReference(),
              supportActorReference: found.actorReference,
              kind: "Changed",
              subjectCode: "MerchantGuestIntake",
              occurredAt: at,
            });
          return Object.freeze({ ...recorded });
        });
      } catch (error) {
        if (error instanceof BrandGuestIntakeError && error.code !== "Unavailable")
          throw new MerchantStoreSupportError(error.code === "Changed" ? "Changed" : "Invalid");
        return mapped(error);
      }
    },
  });
}

/**
 * The Owner's side, in Store setup: whether support may change settings, for how long, and the log
 * of what support did. `organization.support_access.manage` (the Owner's template only).
 */
export function createMerchantStoreSupportAccess(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
}) {
  const resolveStore = createMerchantStoreScope(options.persistence);
  const action = "organization.support_access.manage";
  const denied = (): never => {
    throw new MerchantStoreSupportError("Denied");
  };
  const now = () => new Date(Date.parse(options.persistence.now())).toISOString();
  const mapped = (error: unknown): never => {
    if (error instanceof MerchantStoreSupportError) throw error;
    if (error instanceof StoreSupportPermissionError)
      throw new MerchantStoreSupportError(error.code === "Changed" ? "Unavailable" : "Invalid");
    if (error instanceof Error && error.message === "STORE_SERVICE_PERMISSION_DENIED")
      throw new MerchantStoreSupportError("Denied");
    throw new MerchantStoreSupportError("Unavailable");
  };
  const view = async (tx: unknown, scope: { brandReference: string; storeReference: string }) => {
    const at = now();
    const permission = await readStoreSupportPermission(tx as never, scope, at);
    return Object.freeze({
      version: permission.version,
      mode: permission.changesAllowed ? permission.mode : "Off",
      allowedUntil: permission.changesAllowed ? permission.allowedUntil : null,
      log: await listStoreSupportAccess(tx as never, scope),
    });
  };
  const run = <T>(
    sessionCookie: unknown,
    expectedSession: string | undefined,
    work: (
      tx: unknown,
      scope: { brandReference: string; storeReference: string },
      actor: string,
    ) => Promise<T>,
  ) =>
    options.persistence.transactions.run((transaction) =>
      withMerchantTransactionAuthorization(
        {
          transaction,
          resolve: async () => {
            const current = await resolveStore(transaction, sessionCookie, action, expectedSession);
            if (!(await current.allowed())) return denied();
            return current;
          },
          recheck: async (current) => (await current.allowed()) === true,
          denied,
        },
        async ({ scope: current }) =>
          work(
            businessTransaction(transaction),
            {
              brandReference: String(current.context.brand.brandReference),
              storeReference: String(current.store.storeReference),
            },
            String(current.actorReference),
          ),
      ),
    );
  return Object.freeze({
    async read(input: { sessionCookie: unknown }) {
      try {
        return await run(input.sessionCookie, undefined, (tx, scope) => view(tx, scope));
      } catch (error) {
        return mapped(error);
      }
    },
    async change(input: { sessionCookie: unknown; csrf: unknown; command: unknown }) {
      const authenticated = await options.authentication
        .authorize(input)
        .catch(onlyRefusal(denied));
      let raw: Record<string, unknown>;
      try {
        raw = readClosedRecord(input.command, [
          "operationReference",
          "expectedVersion",
          "mode",
          "hours",
        ]);
      } catch {
        throw new MerchantStoreSupportError("Invalid");
      }
      const mode = raw.mode;
      if (
        typeof raw.operationReference !== "string" ||
        !uuid.test(raw.operationReference) ||
        !Number.isSafeInteger(raw.expectedVersion) ||
        (mode !== "Off" && mode !== "Standing" && mode !== "Limited") ||
        (mode === "Limited" ? ![1, 4, 24].includes(raw.hours as number) : raw.hours !== null)
      )
        throw new MerchantStoreSupportError("Invalid");
      try {
        return await run(
          input.sessionCookie,
          authenticated.sessionReference,
          async (tx, scope, actorReference) => {
            const at = now();
            await changeStoreSupportPermission(tx as never, scope, {
              operationReference: raw.operationReference as string,
              expectedVersion: raw.expectedVersion as number,
              mode,
              allowedUntil:
                mode === "Limited"
                  ? new Date(Date.parse(at) + (raw.hours as number) * 3_600_000).toISOString()
                  : null,
              actorReference,
              occurredAt: at,
            });
            return view(tx, scope);
          },
        );
      } catch (error) {
        return mapped(error);
      }
    },
  });
}

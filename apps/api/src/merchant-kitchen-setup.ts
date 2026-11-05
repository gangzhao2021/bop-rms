import { createHash } from "node:crypto";
import type { ConsumerTransaction } from "@bop/eventing";
import { parseOpaqueUuidV7, readClosedRecord } from "@bop/identity";
import { listBrandSkuChoices } from "@rms/catalog";
import {
  KitchenRoutingConfigurationError,
  readStoreKitchenLine,
  recordStoreKitchenLine,
} from "@rms/kitchen";
import { listRecipeKitchenCapabilities } from "@rms/recipe";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import {
  approvalDerivedReference,
  businessTransaction,
} from "./merchant-ordinary-refund-approval.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import type { MerchantBffService } from "./merchant-bff.js";
import { onlyRefusal } from "./merchant-failure.js";

export class MerchantKitchenSetupError extends Error {
  constructor(readonly code: "Denied" | "Changed" | "NoChange" | "Invalid" | "Unavailable") {
    super("kitchen setup " + code);
    this.name = "MerchantKitchenSetupError";
  }
}
const sha256 = (value: string) => "sha256:" + createHash("sha256").update(value).digest("hex");

/**
 * A capability every Store of the Brand shares by default, when no recipe names one yet. Derived
 * from the Brand alone (never another Store's data), so recipes written at one of its Stores can be
 * made at the others.
 */
export function brandKitchenCapabilityReference(brandReference: string): string {
  const digest = createHash("sha256")
    .update("bop-rms/brand-kitchen-capability:" + brandReference)
    .digest("hex");
  return (
    brandReference.slice(0, 14) +
    "7" +
    digest.slice(0, 3) +
    "-" +
    ((parseInt(digest.slice(3, 4), 16) & 3) | 8).toString(16) +
    digest.slice(4, 7) +
    "-" +
    digest.slice(7, 19)
  );
}

/**
 * One kitchen line holding what the Brand's recipes at this Store need (or the Brand's own
 * capability), or what it holds plus what's missing. Recorded under whoever made the change.
 */
export async function applyStoreKitchenLine(
  tx: ConsumerTransaction,
  input: {
    readonly scope: { readonly brandReference: string; readonly storeReference: string };
    readonly actorReference: string;
    readonly operationReference: string;
    readonly expectedVersion: number;
    readonly recordedAt: string;
    readonly nextReference: () => string;
    authorize(tx: ConsumerTransaction): Promise<boolean>;
    readonly purposeCode?: string;
    readonly permissionCode?: string;
    readonly reasonCode?: string;
  },
) {
  const { scope, recordedAt: at } = input;
  const line = await readStoreKitchenLine(tx, scope);
  const required = await listRecipeKitchenCapabilities(tx as never, scope, at);
  const all = [...new Set([...required.values()].flat())];
  const uncovered = [...required.values()].some((capabilities) =>
    capabilities.some((capability) => !line.capabilityReferences.includes(capability)),
  );
  const capabilities = [...new Set([...line.capabilityReferences, ...all])];
  if (capabilities.length === 0)
    capabilities.push(brandKitchenCapabilityReference(scope.brandReference));
  // A retry of the same operation returns what it recorded (checked by the store).
  return recordStoreKitchenLine(tx, {
    ...scope,
    actorReference: input.actorReference,
    operationReference: input.operationReference,
    auditReference: approvalDerivedReference(input.operationReference, "kitchen-setup"),
    expectedVersion: input.expectedVersion,
    recordedAt: at,
    capabilityReferences: capabilities,
    sha256,
    nextReference: input.nextReference,
    authorize: input.authorize,
    onlyIfChanged: line.version === 0 || uncovered,
    ...(input.purposeCode === undefined ? {} : { purposeCode: input.purposeCode }),
    ...(input.permissionCode === undefined ? {} : { permissionCode: input.permissionCode }),
    ...(input.reasonCode === undefined ? {} : { reasonCode: input.reasonCode }),
  });
}

/**
 * WP-2423 item 11 (Owner 2026-11-01): the Store's kitchen setup, in Store setup. Reading needs
 * `organization.store.read`; setting up needs `organization.store.update` (Owner, Store Manager,
 * Area Manager). One kitchen line takes every dish (Owner 取舍 5, 9: one kitchen screen; dishes are
 * divided by kitchen sections), and "Apply" records it holding what the Brand's recipes at this
 * Store need, in effect from now. A dish whose recipe needs something the line lacks can't reach
 * the kitchen, so the read names it before an order strands.
 */
export function createMerchantKitchenSetup(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  nextReference(): string;
  locale: string;
}) {
  const resolveStore = createMerchantStoreScope(options.persistence);
  const denied = (): never => {
    throw new MerchantKitchenSetupError("Denied");
  };
  const mapError = (error: unknown): never => {
    if (error instanceof MerchantKitchenSetupError) throw error;
    if (
      error !== null &&
      typeof error === "object" &&
      Object.getOwnPropertyDescriptor(error, "code")?.value ===
        "TENANT_DATABASE_TRANSACTION_CONFLICT"
    )
      throw error;
    if (
      error instanceof KitchenRoutingConfigurationError &&
      error.code === "KITCHEN_ROUTING_CONFIGURATION_CONFLICT"
    )
      throw new MerchantKitchenSetupError("Changed");
    if (error instanceof Error && error.message === "STORE_SERVICE_PERMISSION_DENIED")
      throw new MerchantKitchenSetupError("Denied");
    throw new MerchantKitchenSetupError("Unavailable");
  };
  const name = (names: Readonly<Record<string, string>>, fallback: string) =>
    names[options.locale] ?? Object.values(names)[0] ?? fallback;
  /** What the Brand's recipes at this Store need, and the dishes the line lacks it for. */
  const needs = async (
    tx: ConsumerTransaction,
    scope: { brandReference: string; storeReference: string },
    at: string,
    held: readonly string[],
  ) => {
    const required = await listRecipeKitchenCapabilities(tx as never, scope, at);
    const uncovered = [...required].filter(([, capabilities]) =>
      capabilities.some((capability) => !held.includes(capability)),
    );
    const skus =
      uncovered.length === 0 ? [] : await listBrandSkuChoices(tx as never, { ...scope } as never);
    return {
      all: [...new Set([...required.values()].flat())],
      uncoveredDishes: uncovered.map(([skuReference]) => {
        const sku = skus.find((item) => item.skuReference === skuReference);
        return sku === undefined
          ? "—"
          : name(sku.productLocalizedNames, sku.skuCode) +
              " · " +
              name(sku.localizedNames, sku.skuCode);
      }),
    };
  };
  const read = async (input: { sessionCookie: unknown }) => {
    try {
      return await options.persistence.transactions.run((transaction) =>
        withMerchantTransactionAuthorization(
          {
            transaction,
            resolve: async () => {
              const current = await resolveStore(
                transaction,
                input.sessionCookie,
                "organization.store.read",
              );
              const decisions = await current.authorizeActions([
                "organization.store.read",
                "organization.store.update",
              ]);
              if (decisions.get("organization.store.read")?.effect !== "Allow") return denied();
              return {
                current,
                canChange: decisions.get("organization.store.update")?.effect === "Allow",
              };
            },
            recheck: async ({ current }) => (await current.allowed()) === true,
            denied,
          },
          async ({ scope: { current, canChange } }) => {
            const tx = businessTransaction(transaction);
            const scope = {
              brandReference: String(current.context.brand.brandReference),
              storeReference: String(current.store.storeReference),
            };
            const at = String(current.context.resolvedAt);
            const line = await readStoreKitchenLine(tx, scope);
            const { uncoveredDishes } = await needs(tx, scope, at, line.capabilityReferences);
            return Object.freeze({
              canChange,
              version: line.version,
              inEffectFrom: line.effectiveFrom,
              uncoveredDishes: line.version === 0 ? [] : uncoveredDishes,
            });
          },
        ),
      );
    } catch (error) {
      return mapError(error);
    }
  };
  const command = async (input: { sessionCookie: unknown; csrf: unknown; command: unknown }) => {
    const authenticated = await options.authentication
      .authorize(input)
      .catch(onlyRefusal(() => denied()));
    let operationReference: string, expectedVersion: number;
    try {
      const raw = readClosedRecord(input.command, ["operationReference", "expectedVersion"]);
      operationReference = String(
        parseOpaqueUuidV7(raw.operationReference, "ACTOR_REFERENCE_INVALID"),
      );
      if (
        typeof raw.expectedVersion !== "number" ||
        !Number.isSafeInteger(raw.expectedVersion) ||
        raw.expectedVersion < 0
      )
        throw new Error("invalid");
      expectedVersion = raw.expectedVersion;
    } catch {
      throw new MerchantKitchenSetupError("Invalid");
    }
    try {
      return await options.persistence.transactions.run((transaction) =>
        withMerchantTransactionAuthorization(
          {
            transaction,
            resolve: async () => {
              const current = await resolveStore(
                transaction,
                input.sessionCookie,
                "organization.store.update",
                authenticated.sessionReference,
              );
              if (!(await current.allowed())) return denied();
              return current;
            },
            recheck: async (current) => (await current.allowed()) === true,
            denied,
          },
          async (authority) => {
            const current = authority.scope;
            const tx = businessTransaction(transaction);
            authority.bind(tx);
            const scope = {
              brandReference: String(current.context.brand.brandReference),
              storeReference: String(current.store.storeReference),
            };
            const result = await applyStoreKitchenLine(tx, {
              scope,
              actorReference: String(current.actorReference),
              operationReference,
              expectedVersion,
              recordedAt: String(current.context.resolvedAt),
              nextReference: options.nextReference,
              authorize: async (t) => authority.guard(t),
            });
            if (result.status === "NoChange") throw new MerchantKitchenSetupError("NoChange");
            return Object.freeze({ status: result.status, version: result.version });
          },
        ),
      );
    } catch (error) {
      return mapError(error);
    }
  };
  return Object.assign(command, { read });
}

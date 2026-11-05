import { readClosedRecord } from "@bop/identity";
import {
  changeProductAlcoholMark,
  loadProductAlcoholMarks,
  ProductAlcoholMarkError,
} from "@rms/catalog";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import { onlyRefusal, withCause } from "./merchant-failure.js";

export type MerchantProductAlcoholErrorCode =
  | "PRODUCT_ALCOHOL_INPUT_INVALID"
  | "PRODUCT_ALCOHOL_PERMISSION_DENIED"
  /** Another change of the dish's mark came first: read it again. */
  | "PRODUCT_ALCOHOL_CHANGED"
  | "PRODUCT_ALCOHOL_UNAVAILABLE";
export class MerchantProductAlcoholError extends Error {
  constructor(readonly code: MerchantProductAlcoholErrorCode) {
    super("product alcohol " + code);
    this.name = "MerchantProductAlcoholError";
  }
}
const fail = (code: MerchantProductAlcoholErrorCode): never => {
  throw new MerchantProductAlcoholError(code);
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ref = (value: unknown) =>
  typeof value === "string" && uuid.test(value) ? value : fail("PRODUCT_ALCOHOL_INPUT_INVALID");

export interface MerchantProductAlcoholResult {
  readonly products: readonly {
    readonly productReference: string;
    readonly containsAlcohol: boolean;
    readonly version: number;
  }[];
}

/**
 * WP-2423 DEC-ALCOHOL (Owner 2026-11-04 "要卖酒"): on the menu, a dish that contains alcohol. "Read"
 * answers the marks of the dishes shown (`catalog.product.read`); "Change" sets or clears one
 * dish's mark against the version the editor saw (`catalog.product.manage`, as editing the dish).
 */
export function createMerchantProductAlcohol(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  now(): string;
}) {
  const resolve = createMerchantStoreScope(options.persistence);
  return async (input: {
    sessionCookie: unknown;
    csrf: unknown;
    command: unknown;
  }): Promise<MerchantProductAlcoholResult> => {
    const authenticated = await options.authentication.authorize(input);
    let command:
      | { action: "Read"; products: string[] }
      | {
          action: "Change";
          productReference: string;
          operationReference: string;
          expectedVersion: number;
          containsAlcohol: boolean;
        };
    try {
      const action =
        input.command !== null && typeof input.command === "object"
          ? Object.getOwnPropertyDescriptor(input.command, "action")?.value
          : undefined;
      if (action === "Read") {
        const raw = readClosedRecord(input.command, ["action", "productReferences"]);
        if (!Array.isArray(raw.productReferences) || raw.productReferences.length > 500)
          return fail("PRODUCT_ALCOHOL_INPUT_INVALID");
        command = { action, products: raw.productReferences.map(ref) };
      } else {
        const raw = readClosedRecord(input.command, [
          "action",
          "productReference",
          "operationReference",
          "expectedVersion",
          "containsAlcohol",
        ]);
        if (
          raw.action !== "Change" ||
          typeof raw.containsAlcohol !== "boolean" ||
          !Number.isSafeInteger(raw.expectedVersion) ||
          Number(raw.expectedVersion) < 0
        )
          return fail("PRODUCT_ALCOHOL_INPUT_INVALID");
        command = {
          action: "Change",
          productReference: ref(raw.productReference),
          operationReference: ref(raw.operationReference),
          expectedVersion: Number(raw.expectedVersion),
          containsAlcohol: raw.containsAlcohol,
        };
      }
    } catch (error) {
      if (error instanceof MerchantProductAlcoholError) throw error;
      return fail("PRODUCT_ALCOHOL_INPUT_INVALID");
    }
    const permission =
      command.action === "Read" ? "catalog.product.read" : "catalog.product.manage";
    try {
      return await options.persistence.transactions.run((tx) =>
        withMerchantTransactionAuthorization(
          {
            transaction: tx,
            resolve: async () => {
              const current = await resolve(
                tx,
                input.sessionCookie,
                permission,
                authenticated.sessionReference,
              ).catch(onlyRefusal(() => fail("PRODUCT_ALCOHOL_PERMISSION_DENIED")));
              if ((await current.allowed()) !== true)
                return fail("PRODUCT_ALCOHOL_PERMISSION_DENIED");
              return current;
            },
            recheck: async (current) => (await current.allowed()) === true,
            denied: () => fail("PRODUCT_ALCOHOL_PERMISSION_DENIED"),
          },
          async (authority) => {
            const current = authority.scope;
            const scope = {
              tenantReference: String(current.selected.tenantReference),
              brandReference: String(current.context.brand.brandReference),
            };
            const runner = tx as unknown as Parameters<typeof loadProductAlcoholMarks>[0];
            if (command.action === "Change")
              await changeProductAlcoholMark(runner, scope, {
                productReference: command.productReference,
                operationReference: command.operationReference,
                expectedVersion: command.expectedVersion,
                containsAlcohol: command.containsAlcohol,
                actorReference: String(current.actorReference),
                observedAt: new Date(Date.parse(options.now())).toISOString(),
              });
            const products =
              command.action === "Read" ? command.products : [command.productReference];
            const marks = await loadProductAlcoholMarks(runner, scope, products);
            return Object.freeze({
              products: Object.freeze(
                products.map((productReference) =>
                  Object.freeze({
                    productReference,
                    containsAlcohol: marks.get(productReference)?.containsAlcohol ?? false,
                    version: marks.get(productReference)?.version ?? 0,
                  }),
                ),
              ),
            });
          },
        ),
      );
    } catch (error) {
      if (error instanceof MerchantProductAlcoholError) throw error;
      if (error instanceof ProductAlcoholMarkError && error.code === "PRODUCT_ALCOHOL_MARK_CHANGED")
        throw new MerchantProductAlcoholError("PRODUCT_ALCOHOL_CHANGED");
      throw withCause(new MerchantProductAlcoholError("PRODUCT_ALCOHOL_UNAVAILABLE"), error);
    }
  };
}

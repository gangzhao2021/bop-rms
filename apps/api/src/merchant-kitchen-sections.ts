import { readClosedRecord } from "@bop/identity";
import {
  changeKitchenProductSection,
  changeKitchenSections,
  KitchenSectionError,
  loadKitchenProductSections,
  loadKitchenSections,
} from "@rms/kitchen";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

export type MerchantKitchenSectionsErrorCode =
  | "KITCHEN_SECTIONS_INPUT_INVALID"
  | "KITCHEN_SECTIONS_PERMISSION_DENIED"
  /** Another change came first: read it again. */
  | "KITCHEN_SECTIONS_CHANGED"
  /** The section chosen for a dish is no longer one of the Store's sections. */
  | "KITCHEN_SECTIONS_UNKNOWN"
  | "KITCHEN_SECTIONS_UNAVAILABLE";
export class MerchantKitchenSectionsError extends Error {
  constructor(readonly code: MerchantKitchenSectionsErrorCode) {
    super(code);
    this.name = "MerchantKitchenSectionsError";
  }
}
const fail = (code: MerchantKitchenSectionsErrorCode): never => {
  throw new MerchantKitchenSectionsError(code);
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ref = (value: unknown): string =>
  typeof value === "string" && uuid.test(value) ? value : fail("KITCHEN_SECTIONS_INPUT_INVALID");

export interface MerchantKitchenSectionsResult {
  readonly version: number;
  readonly sections: readonly { readonly sectionReference: string; readonly name: string }[];
  readonly products: readonly {
    readonly productReference: string;
    readonly sectionReference: string | null;
    readonly version: number;
  }[];
}

/**
 * WP-2423 item 8 ⑧ (Owner decision 5, coordinator 2026-10-30): the kitchen sections (档口) one
 * kitchen screen is filtered by. "Read" answers the Store's sections and the section of the dishes
 * shown (`catalog.product.read`); "ChangeSections" names the Store's sections and "ChangeDish"
 * marks one dish, each against the version the owner saw (`catalog.product.manage`, as editing a
 * dish). A dish with no section is shown in the kitchen as "no section".
 */
export function createMerchantKitchenSections(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  now(): string;
}) {
  const resolve = createMerchantStoreScope(options.persistence);
  return async (input: {
    sessionCookie: unknown;
    csrf: unknown;
    command: unknown;
  }): Promise<MerchantKitchenSectionsResult> => {
    const authenticated = await options.authentication.authorize(input);
    let command:
      | { action: "Read"; products: string[] }
      | {
          action: "ChangeSections";
          operationReference: string;
          expectedVersion: number;
          sections: { sectionReference: string; name: string }[];
        }
      | {
          action: "ChangeDish";
          productReference: string;
          operationReference: string;
          expectedVersion: number;
          sectionReference: string | null;
        };
    try {
      const action =
        input.command !== null && typeof input.command === "object"
          ? Object.getOwnPropertyDescriptor(input.command, "action")?.value
          : undefined;
      if (action === "Read") {
        const raw = readClosedRecord(input.command, ["action", "productReferences"]);
        if (!Array.isArray(raw.productReferences) || raw.productReferences.length > 500)
          return fail("KITCHEN_SECTIONS_INPUT_INVALID");
        command = { action, products: raw.productReferences.map(ref) };
      } else if (action === "ChangeSections") {
        const raw = readClosedRecord(input.command, [
          "action",
          "operationReference",
          "expectedVersion",
          "sections",
        ]);
        if (
          !Number.isSafeInteger(raw.expectedVersion) ||
          Number(raw.expectedVersion) < 0 ||
          !Array.isArray(raw.sections) ||
          raw.sections.length > 12
        )
          return fail("KITCHEN_SECTIONS_INPUT_INVALID");
        command = {
          action,
          operationReference: ref(raw.operationReference),
          expectedVersion: Number(raw.expectedVersion),
          sections: raw.sections.map((value: unknown) => {
            const section = readClosedRecord(value, ["sectionReference", "name"]);
            if (typeof section.name !== "string") return fail("KITCHEN_SECTIONS_INPUT_INVALID");
            return { sectionReference: ref(section.sectionReference), name: section.name.trim() };
          }),
        };
      } else {
        const raw = readClosedRecord(input.command, [
          "action",
          "productReference",
          "operationReference",
          "expectedVersion",
          "sectionReference",
        ]);
        if (
          raw.action !== "ChangeDish" ||
          !Number.isSafeInteger(raw.expectedVersion) ||
          Number(raw.expectedVersion) < 0
        )
          return fail("KITCHEN_SECTIONS_INPUT_INVALID");
        command = {
          action: "ChangeDish",
          productReference: ref(raw.productReference),
          operationReference: ref(raw.operationReference),
          expectedVersion: Number(raw.expectedVersion),
          sectionReference: raw.sectionReference === null ? null : ref(raw.sectionReference),
        };
      }
    } catch (error) {
      if (error instanceof MerchantKitchenSectionsError) throw error;
      return fail("KITCHEN_SECTIONS_INPUT_INVALID");
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
              ).catch(() => fail("KITCHEN_SECTIONS_PERMISSION_DENIED"));
              if ((await current.allowed()) !== true)
                return fail("KITCHEN_SECTIONS_PERMISSION_DENIED");
              return current;
            },
            recheck: async (current) => (await current.allowed()) === true,
            denied: () => fail("KITCHEN_SECTIONS_PERMISSION_DENIED"),
          },
          async (authority) => {
            const current = authority.scope;
            const scope = {
              tenantReference: String(current.selected.tenantReference),
              brandReference: String(current.context.brand.brandReference),
              storeReference: String(current.store.storeReference),
            };
            const runner = tx as unknown as Parameters<typeof loadKitchenSections>[0];
            const observedAt = new Date(Date.parse(options.now())).toISOString();
            const actorReference = String(current.actorReference);
            if (command.action === "ChangeSections")
              await changeKitchenSections(runner, scope, {
                operationReference: command.operationReference,
                expectedVersion: command.expectedVersion,
                sections: command.sections,
                actorReference,
                observedAt,
              });
            if (command.action === "ChangeDish")
              await changeKitchenProductSection(runner, scope, {
                productReference: command.productReference,
                operationReference: command.operationReference,
                expectedVersion: command.expectedVersion,
                sectionReference: command.sectionReference,
                actorReference,
                observedAt,
              });
            const list = await loadKitchenSections(runner, scope);
            const products =
              command.action === "Read"
                ? command.products
                : command.action === "ChangeDish"
                  ? [command.productReference]
                  : [];
            const marks = await loadKitchenProductSections(runner, scope, products);
            return Object.freeze({
              version: list.version,
              sections: list.sections,
              products: Object.freeze(
                products.map((productReference) =>
                  Object.freeze({
                    productReference,
                    sectionReference: marks.get(productReference)?.sectionReference ?? null,
                    version: marks.get(productReference)?.version ?? 0,
                  }),
                ),
              ),
            });
          },
        ),
      );
    } catch (error) {
      if (error instanceof MerchantKitchenSectionsError) throw error;
      if (error instanceof KitchenSectionError) {
        if (error.code === "KITCHEN_SECTION_CHANGED") return fail("KITCHEN_SECTIONS_CHANGED");
        if (error.code === "KITCHEN_SECTION_UNKNOWN") return fail("KITCHEN_SECTIONS_UNKNOWN");
        if (error.code === "KITCHEN_SECTION_INPUT_INVALID")
          return fail("KITCHEN_SECTIONS_INPUT_INVALID");
      }
      return fail("KITCHEN_SECTIONS_UNAVAILABLE");
    }
  };
}

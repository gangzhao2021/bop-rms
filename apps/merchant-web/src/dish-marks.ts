import { t } from "./i18n/i18n.js";
import { newOperationReference } from "./operation-reference.js";
import type { MenuClient } from "./store-menu-pages.js";

/**
 * WP-2423 item 3 E: what a new dish carries besides its menu fields. These are Kitchen's and
 * Catalog's own records, written right after the dish exists; a dish that exists saves them one by
 * one instead.
 */
export interface DishMarks {
  /** The owner's own answer; null: not decided (a charge does not go to the kitchen, a dish does). */
  readonly notPrepared: boolean | null;
  readonly sectionReference: string | null;
  readonly containsAlcohol: boolean;
}
export const noDishMarks: DishMarks = Object.freeze({
  notPrepared: null,
  sectionReference: null,
  containsAlcohol: false,
});

const entryOf = (value: unknown, productReference: string) => {
  const found = (value as { products?: unknown } | null)?.products;
  return Array.isArray(found)
    ? (found as Record<string, unknown>[]).find(
        (item) => item.productReference === productReference,
      )
    : undefined;
};

/** Another dish's marks, to copy: a mark it only has by default is not copied. */
export async function readDishMarks(
  client: Pick<MenuClient, "kitchenNotPrepared" | "kitchenSections" | "productAlcohol">,
  productReference: string,
): Promise<DishMarks> {
  const read = { action: "Read" as const, productReferences: [productReference] };
  const [kitchen, section, alcohol] = await Promise.all([
    client.kitchenNotPrepared?.(read),
    client.kitchenSections?.(read),
    client.productAlcohol?.(read),
  ]);
  const mark = entryOf(kitchen, productReference);
  const decided = mark?.decided === true || Number(mark?.version ?? 0) > 0;
  const sectionReference = entryOf(section, productReference)?.sectionReference;
  return {
    notPrepared: decided && typeof mark?.notPrepared === "boolean" ? mark.notPrepared : null,
    sectionReference: typeof sectionReference === "string" ? sectionReference : null,
    containsAlcohol: entryOf(alcohol, productReference)?.containsAlcohol === true,
  };
}

/**
 * Records a new dish's marks, each on its own. The dish stays saved whatever happens here; the
 * answer names, in staff words, any mark that could not be set.
 */
export async function applyDishMarks(
  client: Pick<MenuClient, "kitchenNotPrepared" | "kitchenSections" | "productAlcohol">,
  productReference: string,
  marks: DishMarks,
): Promise<readonly string[]> {
  const notSet: string[] = [];
  const attempt = async (name: string, work: () => Promise<unknown> | undefined) => {
    try {
      await work();
    } catch {
      notSet.push(name);
    }
  };
  const common = { productReference, expectedVersion: 0 };
  const notPrepared = marks.notPrepared;
  if (notPrepared !== null)
    await attempt(t("whether the kitchen prepares it"), () =>
      client.kitchenNotPrepared?.({
        ...common,
        action: "Change",
        operationReference: newOperationReference(),
        notPrepared,
      }),
    );
  if (marks.sectionReference !== null)
    await attempt(t("its kitchen section"), () =>
      client.kitchenSections?.({
        ...common,
        action: "ChangeDish",
        operationReference: newOperationReference(),
        sectionReference: marks.sectionReference,
      }),
    );
  if (marks.containsAlcohol)
    await attempt(t("its alcohol mark"), () =>
      client.productAlcohol?.({
        ...common,
        action: "Change",
        operationReference: newOperationReference(),
        containsAlcohol: true,
      }),
    );
  return notSet;
}

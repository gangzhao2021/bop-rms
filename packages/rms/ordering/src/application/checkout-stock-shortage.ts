import type { CheckoutLineRefusal } from "../domain/checkout-validation.js";
import type { CheckoutStockLine } from "./ports/checkout-validation-ports.js";

type Covers = (lines: readonly CheckoutStockLine[]) => Promise<boolean>;

/** The same item with the same options (option order does not matter). */
export function sameCheckoutStockConfiguration(a: CheckoutStockLine, b: CheckoutStockLine) {
  return configuration(a) === configuration(b);
}
function configuration(line: CheckoutStockLine): string {
  return JSON.stringify([
    line.sellableReference,
    [...line.optionSelections]
      .map((option) => [String(option.optionReference), option.quantity] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  ]);
}

interface Group {
  readonly lines: readonly CheckoutStockLine[];
  readonly ordered: number;
}

function groups(lines: readonly CheckoutStockLine[]): Group[] {
  const found = new Map<string, CheckoutStockLine[]>();
  for (const line of lines) {
    const key = configuration(line);
    const group = found.get(key);
    if (group === undefined) found.set(key, [line]);
    else group.push(line);
  }
  return [...found.values()].map((group) =>
    Object.freeze({
      lines: Object.freeze(group),
      ordered: group.reduce((sum, line) => sum + line.quantity, 0),
    }),
  );
}

/** The group's lines lowered to `quantity` in total (earlier lines first; none left out at 0). */
function lowered(group: Group, quantity: number): CheckoutStockLine[] {
  const result: CheckoutStockLine[] = [];
  let left = quantity;
  for (const line of group.lines) {
    if (left <= 0) break;
    const take = Math.min(line.quantity, left);
    result.push(Object.freeze({ ...line, quantity: take }));
    left -= take;
  }
  return result;
}

/** The most of `group` (below what was ordered) the stock covers next to `rest` (0: none). */
async function most(group: Group, rest: readonly CheckoutStockLine[], covers: Covers) {
  let low = 0,
    high = group.ordered - 1;
  // Stock demand grows with quantity, so the largest covered quantity is found by halving.
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (await covers([...rest, ...lowered(group, middle)])) low = middle;
    else high = middle - 1;
  }
  return low;
}

function refusal(group: Group, available: number, sharedStock: boolean): CheckoutLineRefusal {
  const first = group.lines[0] as CheckoutStockLine;
  return Object.freeze({ cartItemReference: first.cartItemReference, available, sharedStock });
}

/**
 * WP-2423: when the Store's stock cannot make a Cart as it stands, which item to tell the guest
 * about and how many of it can still be made. Ordering decides; `covers` is Inventory's answer for
 * a set of lines. Null when the Cart is covered. An item's lines with the same options count
 * together (two lines of one Flat White are two Flat Whites).
 *
 * An item that cannot be made in its ordered quantity on its own is reported first (the most
 * recently added such item), with how many of it the stock makes on its own; when the rest of the
 * Cart then still fits only with fewer of it, it is reported with that lower count and
 * `sharedStock` (lowering it to that count makes the Cart). When none of it fits beside the rest,
 * its own count is reported (it is not sold out; the guest changes it first and is then told what
 * the rest shares). Otherwise the Cart is short only because items share stock (two drinks using
 * the same milk), and the most recently added item that, lowered, lets the rest of the Cart through
 * is reported with `sharedStock`. When no single item explains it, the most recently added item is
 * reported with nothing available beside the rest.
 */
export async function findCheckoutStockShortage(
  lines: readonly CheckoutStockLine[],
  covers: Covers,
  /** Look at this line's item first (a line the Catalog already refused). */
  preferred: CheckoutStockLine["cartItemReference"] | null = null,
): Promise<CheckoutLineRefusal | null> {
  if (lines.length === 0 || (await covers(lines))) return null;
  const all = groups(lines).reverse();
  const ordered =
    preferred === null
      ? all
      : [
          ...all.filter((group) =>
            group.lines.some((line) => line.cartItemReference === preferred),
          ),
          ...all.filter(
            (group) => !group.lines.some((line) => line.cartItemReference === preferred),
          ),
        ];
  const restOf = (group: Group) => lines.filter((line) => !group.lines.includes(line));
  for (const group of ordered) {
    if (await covers(group.lines)) continue;
    const own = await most(group, [], covers);
    const rest = restOf(group);
    if (own === 0 || rest.length === 0 || !(await covers(rest))) return refusal(group, own, false);
    if (await covers([...rest, ...lowered(group, own)])) return refusal(group, own, false);
    const beside = await most(Object.freeze({ ...group, ordered: own }), rest, covers);
    return beside > 0 ? refusal(group, beside, true) : refusal(group, own, false);
  }
  for (const group of all) {
    const rest = restOf(group);
    if (!(await covers(rest))) continue;
    return refusal(group, await most(group, rest, covers), true);
  }
  return refusal(all[0] as Group, 0, true);
}

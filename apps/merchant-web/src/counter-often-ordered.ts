/**
 * What this tablet sends most, so the usual dishes are one tap away. Kept in this browser for each
 * Store: only dish references and counts, nothing about guests. Nothing depends on it: when it
 * can't be read, the menu simply has no "Often ordered" section.
 */
const keyFor = (storeReference: string) => `bop.counter.oftenOrdered.v1.${storeReference}`;
/** Enough sends that one unusual order doesn't put a dish on the list. */
export const OFTEN_ORDERED_MINIMUM = 3;
export const OFTEN_ORDERED_SHOWN = 8;

function counts(storeReference: string): Record<string, number> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(keyFor(storeReference)) ?? "{}");
    return value !== null && typeof value === "object" ? (value as Record<string, number>) : {};
  } catch {
    return {};
  }
}

/** The dishes to show, most ordered first; a tie keeps the order they were first sent in. */
export function loadOftenOrdered(storeReference: string): readonly string[] {
  return Object.entries(counts(storeReference))
    .filter(([, count]) => typeof count === "number" && count >= OFTEN_ORDERED_MINIMUM)
    .sort(([, left], [, right]) => right - left)
    .slice(0, OFTEN_ORDERED_SHOWN)
    .map(([reference]) => reference);
}

export function recordOrdered(
  storeReference: string,
  sent: readonly (readonly [reference: string, quantity: number])[],
) {
  const next = counts(storeReference);
  for (const [reference, quantity] of sent) next[reference] = (next[reference] ?? 0) + quantity;
  try {
    localStorage.setItem(keyFor(storeReference), JSON.stringify(next));
  } catch {
    // Private browsing or a full store: the list just doesn't grow.
  }
}

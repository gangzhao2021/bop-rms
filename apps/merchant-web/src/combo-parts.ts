/**
 * WP-2423 item 8 ⑥ part 4 (coordinator 2026-10-28 decision 3): the dishes chosen in a combo, each
 * made and served on its own — Chinese name first, under the combo.
 */
export interface ComboPartView {
  readonly optionReference: string;
  readonly nameZh: string;
  readonly name: string;
  /** The kitchen marked this dish done. */
  readonly done: boolean;
  /** Served at the table. */
  readonly served: boolean;
}
const reference = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const text = (value: unknown, required: boolean) =>
  typeof value === "string" &&
  value.length <= 200 &&
  (!required || value.trim() !== "") &&
  !Array.from(value).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);

export function parseComboParts(value: unknown): readonly ComboPartView[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20)
    throw new Error("COMBO_PARTS_INVALID");
  return Object.freeze(
    value.map((candidate: unknown) => {
      const part = candidate as Record<string, unknown> | null;
      if (
        part === null ||
        typeof part !== "object" ||
        Object.keys(part).sort().join(",") !== "done,name,nameZh,optionReference,served" ||
        typeof part.optionReference !== "string" ||
        !reference.test(part.optionReference) ||
        !text(part.name, true) ||
        !text(part.nameZh, false) ||
        typeof part.done !== "boolean" ||
        typeof part.served !== "boolean"
      )
        throw new Error("COMBO_PARTS_INVALID");
      return Object.freeze({
        optionReference: part.optionReference,
        nameZh: part.nameZh as string,
        name: part.name as string,
        done: part.done,
        served: part.served,
      });
    }),
  );
}

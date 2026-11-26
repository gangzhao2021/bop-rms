/**
 * Batch 65 (v15 b64 live, TM2 table R64 A): a staff round being taken at a table was lost when the
 * page reloaded or staff signed in again, with no word. The unsent round is kept on this device for
 * its Store and table until it is sent, the table's party changes (the table was closed), its
 * business day ends, or staff empty it; the page brings it back with a plain note and never sends
 * it by itself.
 *
 * Only what the menu says is kept (dishes, choices, quantities, the tip choice and the table's
 * party reference). A line's kitchen note may carry a guest's allergy or health fact, so it is
 * never written to the device: the page says how many notes to add again. Nothing depends on it:
 * when it can't be read or written the page behaves as before.
 */
const PREFIX = "bop.merchant.staffRoundDraft.v1.";
const keyFor = (storeReference: string, tableReference: string) =>
  `${PREFIX}${storeReference}.${tableReference}`;
/** A round left longer than a long service is from an earlier day, whatever the day read says. */
export const STAFF_ROUND_DRAFT_KEEP_MS = 16 * 60 * 60 * 1000;

export interface StaffRoundDraftLine {
  readonly key: string;
  readonly item: { readonly sellableReference: string; readonly name: string };
  readonly quantity: number;
  readonly options: readonly { optionReference: string; name: string; quantity: number }[];
}

export interface StaffRoundDraft<L extends StaffRoundDraftLine = StaffRoundDraftLine> {
  readonly savedAt: number;
  /** The Store business day it was taken on, when the page knew it. */
  readonly businessDate: string | null;
  /** The table's party (dining session) when its first dish went on; null: the table was free. */
  readonly party: { readonly session: string | null } | null;
  readonly lines: readonly L[];
  readonly tip: string;
  readonly customTip: string;
  /** How many lines had a kitchen note that was not kept. */
  readonly notesLeftOut: number;
}

const isLine = (value: unknown): value is StaffRoundDraftLine => {
  const line = value as Partial<StaffRoundDraftLine> | null;
  return (
    line !== null &&
    typeof line === "object" &&
    typeof line.key === "string" &&
    typeof line.item?.sellableReference === "string" &&
    typeof line.item.name === "string" &&
    Array.isArray((line.item as { rules?: unknown }).rules) &&
    Number.isSafeInteger(line.quantity) &&
    (line.quantity ?? 0) >= 1 &&
    Array.isArray(line.options) &&
    line.options.every(
      (option) =>
        typeof option?.optionReference === "string" &&
        typeof option.name === "string" &&
        Number.isSafeInteger(option.quantity),
    ) &&
    !Object.hasOwn(line, "note")
  );
};

/** The unsent round kept for this Store and table, or null (none, unreadable, or too old). */
export function loadStaffRoundDraft<L extends StaffRoundDraftLine>(
  storeReference: string,
  tableReference: string,
  nowMs: number = Date.now(),
): StaffRoundDraft<L> | null {
  try {
    const raw = globalThis.localStorage.getItem(keyFor(storeReference, tableReference));
    if (raw === null) return null;
    const value = JSON.parse(raw) as Partial<StaffRoundDraft> | null;
    const party = value?.party;
    if (
      value === null ||
      typeof value !== "object" ||
      typeof value.savedAt !== "number" ||
      nowMs - value.savedAt > STAFF_ROUND_DRAFT_KEEP_MS ||
      value.savedAt - nowMs > 60_000 ||
      !(value.businessDate === null || typeof value.businessDate === "string") ||
      !(
        party === null ||
        (typeof party === "object" &&
          party !== undefined &&
          (party.session === null || typeof party.session === "string"))
      ) ||
      !Array.isArray(value.lines) ||
      value.lines.length === 0 ||
      value.lines.length > 200 ||
      !value.lines.every(isLine) ||
      typeof value.tip !== "string" ||
      typeof value.customTip !== "string" ||
      !Number.isSafeInteger(value.notesLeftOut)
    ) {
      clearStaffRoundDraft(storeReference, tableReference);
      return null;
    }
    return {
      savedAt: value.savedAt,
      businessDate: value.businessDate,
      party: party === null ? null : { session: party?.session ?? null },
      lines: value.lines as unknown as readonly L[],
      tip: value.tip,
      customTip: value.customTip,
      notesLeftOut: value.notesLeftOut ?? 0,
    };
  } catch {
    return null;
  }
}

/** Keeps the round being taken (its lines without their notes). */
export function keepStaffRoundDraft(
  storeReference: string,
  tableReference: string,
  draft: Omit<
    StaffRoundDraft<StaffRoundDraftLine & { readonly note?: string | null | undefined }>,
    "notesLeftOut"
  > & { readonly notesLeftOut?: number },
): void {
  let notes = draft.notesLeftOut ?? 0;
  const lines = draft.lines.map(({ note, ...line }) => {
    if (note !== undefined && note !== null && note.trim() !== "") notes += 1;
    return line;
  });
  try {
    globalThis.localStorage.setItem(
      keyFor(storeReference, tableReference),
      JSON.stringify({ ...draft, lines, notesLeftOut: notes }),
    );
  } catch {
    // Private browsing or a full store: only this page holds the round.
  }
}

export function clearStaffRoundDraft(storeReference: string, tableReference: string): void {
  try {
    globalThis.localStorage.removeItem(keyFor(storeReference, tableReference));
  } catch {
    // Nothing kept, or it can't be reached: nothing to clear.
  }
}

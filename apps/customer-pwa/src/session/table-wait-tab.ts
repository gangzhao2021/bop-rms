import { tableWaitCheckDelaysSeconds } from "../entry/table-open-recheck.js";

/**
 * Batch 43 (v15 b42 verify): a guest waiting for staff to open the table who reloads Your table or
 * Cart (or whose phone discards the tab in the background) keeps waiting there, in this tab only.
 *
 * Kept: what the screen already shows (the Store's and brand's names, the table's name, the menu's
 * language), the Store's public reference the menu is read with, and when to give up. Never kept:
 * the table's code, a link or guest token, or anything that lets this browser in. After a reload
 * the "is it open now?" check asks about this browser's waiting scan, which the server holds in
 * its own HttpOnly cookie (`{resume:true}`).
 *
 * It expires once the waiting page's checks would have stopped (15 minutes after the last answer
 * that said the table isn't open), and is removed by any other entry answer and once this phone
 * has a visit. Storage that can't be used (a private window, blocked site data) only means a
 * reload asks the guest to go back to the start, as before.
 */
export interface KeptTableWait {
  readonly kind: "NotOpen" | "BeingCleaned";
  readonly tableLabel: string | null;
  readonly publicStoreReference: string;
  readonly brandDisplayName: string;
  readonly storeDisplayName: string;
  readonly locale: string;
}

const key = "bop.customer.table-wait";
/** How long the waiting page's checks run (3 s, then 10 s, then 30 s, for 15 minutes). */
export const keptTableWaitMilliseconds =
  tableWaitCheckDelaysSeconds.reduce((total, seconds) => total + seconds, 0) * 1000;

const referencePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const localePattern = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|\d{3})?$/u;
const labelForbidden = /[\p{Cc}\p{Cf}<>{}[\]`*_#]/u;
const label = (value: unknown, longest: number): value is string =>
  typeof value === "string" &&
  value.length >= 1 &&
  value.length <= longest &&
  value === value.normalize("NFC") &&
  value === value.trim() &&
  !labelForbidden.test(value);

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function keepTableWait(wait: KeptTableWait, now: number = Date.now()): void {
  try {
    storage()?.setItem(
      key,
      JSON.stringify({
        schemaVersion: 1,
        kind: wait.kind,
        tableLabel: wait.tableLabel,
        publicStoreReference: wait.publicStoreReference,
        brandDisplayName: wait.brandDisplayName,
        storeDisplayName: wait.storeDisplayName,
        locale: wait.locale,
        until: now + keptTableWaitMilliseconds,
      }),
    );
  } catch {
    /* Storage refused: a reload sends the guest back to the start, as before. */
  }
}

export function forgetTableWait(): void {
  try {
    storage()?.removeItem(key);
  } catch {
    /* Nothing kept to forget. */
  }
}

/** The wait this tab kept, while it lasts and reads back exactly (else null, and it is removed). */
export function readKeptTableWait(now: number = Date.now()): KeptTableWait | null {
  let raw: string | null;
  try {
    raw = storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== "object" || Array.isArray(value))
      throw new TypeError("kept wait");
    const kept = value as Record<string, unknown>;
    if (
      Object.keys(kept).length !== 8 ||
      kept.schemaVersion !== 1 ||
      (kept.kind !== "NotOpen" && kept.kind !== "BeingCleaned") ||
      !(kept.tableLabel === null || label(kept.tableLabel, 120)) ||
      typeof kept.publicStoreReference !== "string" ||
      !referencePattern.test(kept.publicStoreReference) ||
      !label(kept.brandDisplayName, 120) ||
      !label(kept.storeDisplayName, 120) ||
      typeof kept.locale !== "string" ||
      !localePattern.test(kept.locale) ||
      typeof kept.until !== "number" ||
      !Number.isFinite(kept.until) ||
      now >= kept.until ||
      kept.until - now > keptTableWaitMilliseconds
    )
      throw new TypeError("kept wait");
    return Object.freeze({
      kind: kept.kind,
      tableLabel: kept.tableLabel,
      publicStoreReference: kept.publicStoreReference,
      brandDisplayName: kept.brandDisplayName,
      storeDisplayName: kept.storeDisplayName,
      locale: kept.locale,
    });
  } catch {
    forgetTableWait();
    return null;
  }
}

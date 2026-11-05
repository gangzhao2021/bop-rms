import { createContext } from "react";

/**
 * WP-2423 item 14: the one read that decides whether a Store is still a first Store: Home's opening
 * list and the Store setup page both go by it. True only once the Store has a published configuration
 * made from Store setup; a configuration it started with, or an hours change on that, is not one.
 */
export interface OpeningListRead {
  readonly setupPublished: boolean;
  readonly allergenList: boolean;
  readonly menuListed: boolean;
  /** Absent from an older server: not known. */
  readonly taxRatesSet?: boolean;
}
export async function loadOpeningListRead(
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<OpeningListRead> {
  const response = await fetcher("/merchant/store/opening-list", {
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) throw new Error("OPENING_LIST_UNAVAILABLE");
  const raw = (await response.json()) as Record<string, unknown> | null;
  if (raw === null || typeof raw !== "object" || typeof raw.setupPublished !== "boolean")
    throw new Error("OPENING_LIST_UNAVAILABLE");
  return Object.freeze({
    setupPublished: raw.setupPublished,
    allergenList: raw.allergenList === true,
    menuListed: raw.menuListed === true,
    ...(typeof raw.taxRatesSet === "boolean" ? { taxRatesSet: raw.taxRatesSet } : {}),
  });
}
/**
 * While a Store is still a first Store: called when its name and address are published from the
 * folded panel, so Store setup's own address and contact follow. Null otherwise: after that the two
 * records are separate decisions.
 */
export const StoreProfilePublishedContext = createContext<(() => void) | null>(null);

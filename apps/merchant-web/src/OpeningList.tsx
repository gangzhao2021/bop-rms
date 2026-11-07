import { useEffect, useState } from "react";
import { Link } from "react-router";
import { t } from "./i18n/i18n.js";
import { createStoreKitchenSetupClient } from "./store-kitchen-setup-client.js";
import { createStorePublicProfileClient } from "./store-public-profile-client.js";
import { createStoreReceiptProfileClient } from "./store-receipt-profile-client.js";
import { loadOpeningListRead } from "./store-opening-list-client.js";
import { createTableQrClient } from "./table-qr-client.js";

/**
 * WP-2423 item 13 ③: a new merchant's Owner opens on their own from this list on Home: what is still
 * to do before guests can order, in order, each step linking to where it is done. A step that can't
 * be read isn't shown as done or as to do. Once everything is done the list goes away for good on
 * this device (a Store already open never sees it).
 *
 * WP-2423 item 14: the Store's details, kitchen, receipts and published setup are one row: one page
 * and one action do them all. While BOP support still has the tax rates to set, the row says so.
 */
export interface OpeningFacts {
  readonly details: boolean | null;
  readonly kitchen: boolean | null;
  readonly receipts: boolean | null;
  readonly setupPublished: boolean | null;
  readonly allergenList: boolean | null;
  readonly menuListed: boolean | null;
  readonly tableCode: boolean | null;
  /** False: BOP support has yet to set this Store's tax rates. Null or absent: not known. */
  readonly taxRatesSet?: boolean | null;
}
export interface OpeningStep {
  readonly key: "store" | "allergenList" | "menuListed" | "tableCode";
  readonly label: string;
  readonly href: string;
  readonly done: boolean;
  /** Not the Owner's to do now: said instead of a link. */
  readonly waiting?: string;
}
/** Several facts as one row: not done if any is not; unknown if none is not but one can't be read. */
const allOf = (...facts: readonly (boolean | null)[]): boolean | null =>
  facts.some((fact) => fact === false) ? false : facts.some((fact) => fact === null) ? null : true;
export function openingSteps(facts: OpeningFacts, storeReference: string): readonly OpeningStep[] {
  const setup = `/app/organization/stores/${storeReference}/setup#store-opening`;
  const store = allOf(facts.details, facts.kitchen, facts.receipts, facts.setupPublished);
  const all: readonly (Omit<OpeningStep, "done"> & { readonly done: boolean | null })[] = [
    {
      key: "store",
      label: t("Store details and settings"),
      href: setup,
      done: store,
      // The Owner has done their part; the tax rates are set by BOP support for their province.
      ...(store === false &&
      facts.details === true &&
      facts.kitchen === true &&
      facts.receipts === true &&
      facts.taxRatesSet === false
        ? { waiting: t("Waiting for BOP support to set your tax rates") }
        : {}),
    },
    {
      key: "allergenList",
      label: t("Allergen list approved"),
      href: "/app/compliance/allergens",
      done: facts.allergenList,
      // Publishing the Store's setup does it when the Owner approves alone, and otherwise it comes
      // right after: until then this row must not send anyone to approve a list nobody else can.
      ...(store === false && facts.allergenList === false
        ? { waiting: t("After your store setup") }
        : {}),
    },
    {
      key: "menuListed",
      label: t("Menu listed"),
      href: "/app/commerce/menus",
      done: facts.menuListed,
    },
    {
      key: "tableCode",
      label: t("A table with its code"),
      href: "/app/operations/tables",
      done: facts.tableCode,
    },
  ];
  return all.flatMap((step) =>
    step.done === null ? [] : [Object.freeze({ ...step, done: step.done })],
  );
}
const finishedKey = (storeReference: string) => "bop-opening-finished:" + storeReference;
const alreadyFinished = (storeReference: string) => {
  try {
    return window.localStorage.getItem(finishedKey(storeReference)) === "1";
  } catch {
    return false;
  }
};
const known = async <T,>(read: Promise<T>, fact: (value: T) => boolean) => {
  try {
    return fact(await read);
  } catch {
    return null;
  }
};
async function loadOpeningFacts(csrf: string, fetcher: typeof fetch): Promise<OpeningFacts> {
  const clients = { csrf, fetcher };
  const server = loadOpeningListRead(fetcher);
  const [details, kitchen, receipts, setupPublished, allergenList, menuListed, tableCode, tax] =
    await Promise.all([
      known(createStorePublicProfileClient(clients).load(), (view) => view.current !== null),
      known(createStoreKitchenSetupClient(clients).load(), (view) => view.version > 0),
      known(createStoreReceiptProfileClient(clients).load(), (view) => view.recordedAt !== null),
      known(server, (view) => view.setupPublished === true),
      known(server, (view) => view.allergenList === true),
      known(server, (view) => view.menuListed === true),
      known(createTableQrClient(csrf, fetcher).overview(), (view) =>
        view.rows.some((row) => row.codeState === "Active"),
      ),
      known(server, (view) => view.taxRatesSet !== false),
    ]);
  return {
    details,
    kitchen,
    receipts,
    setupPublished,
    allergenList,
    menuListed,
    tableCode,
    taxRatesSet: tax,
  };
}

export function OpeningListView({ steps }: { readonly steps: readonly OpeningStep[] }) {
  if (steps.length === 0 || steps.every((step) => step.done)) return null;
  // What is next is the first row not done. If that is not the Owner's to do yet, nothing is: the
  // Store's own page has told them nothing else is needed from them now.
  const first = steps.find((step) => !step.done);
  const next = first?.waiting === undefined ? first : undefined;
  return (
    <section className="opening-list" aria-labelledby="opening-list-heading">
      <h2 id="opening-list-heading">{t("Getting ready to open")}</h2>
      <p>{t("Guests can order once these are done.")}</p>
      <ol>
        {steps.map((step) => (
          <li key={step.key}>
            <span>{step.label}</span>
            {step.done ? (
              <span>{t("Done")}</span>
            ) : step.waiting !== undefined ? (
              <span>{step.waiting}</span>
            ) : (
              <Link to={step.href} data-next={step === next ? "true" : undefined}>
                {step === next ? t("Do this next") : t("Set this up")}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

export function OpeningList({
  csrf,
  storeReference,
  fetcher = fetch,
}: {
  readonly csrf: string;
  readonly storeReference: string;
  readonly fetcher?: typeof fetch | undefined;
}) {
  const [steps, setSteps] = useState<readonly OpeningStep[]>([]);
  useEffect(() => {
    if (alreadyFinished(storeReference)) return;
    let active = true;
    void loadOpeningFacts(csrf, fetcher).then((facts) => {
      if (!active) return;
      const next = openingSteps(facts, storeReference);
      setSteps(next);
      // Every fact known and done; a row that could not be read never finishes the list.
      if (next.length === 4 && next.every((step) => step.done))
        try {
          window.localStorage.setItem(finishedKey(storeReference), "1");
        } catch {
          // Only a convenience: the list reads again next time and stays hidden.
        }
    });
    return () => {
      active = false;
    };
  }, [csrf, fetcher, storeReference]);
  return <OpeningListView steps={steps} />;
}

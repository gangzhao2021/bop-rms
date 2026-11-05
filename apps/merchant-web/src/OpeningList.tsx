import { useEffect, useState } from "react";
import { Link } from "react-router";
import { t } from "./i18n/i18n.js";
import { createStoreKitchenSetupClient } from "./store-kitchen-setup-client.js";
import { createStorePublicProfileClient } from "./store-public-profile-client.js";
import { createStoreReceiptProfileClient } from "./store-receipt-profile-client.js";
import { createTableQrClient } from "./table-qr-client.js";

/**
 * WP-2423 item 13 ③: a new merchant's Owner opens on their own from this list on Home: what is still
 * to do before guests can order, in order, each step linking to where it is done. A step that can't
 * be read isn't shown as done or as to do. Once everything is done the list goes away for good on
 * this device (a Store already open never sees it).
 */
export interface OpeningFacts {
  readonly details: boolean | null;
  readonly kitchen: boolean | null;
  readonly receipts: boolean | null;
  readonly setupPublished: boolean | null;
  readonly allergenList: boolean | null;
  readonly menuListed: boolean | null;
  readonly tableCode: boolean | null;
}
export interface OpeningStep {
  readonly key: keyof OpeningFacts;
  readonly label: string;
  readonly href: string;
  readonly done: boolean;
}
export function openingSteps(facts: OpeningFacts, storeReference: string): readonly OpeningStep[] {
  const setup = `/app/organization/stores/${storeReference}/setup`;
  const all: readonly (Omit<OpeningStep, "done"> & { readonly done: boolean | null })[] = [
    {
      key: "details",
      label: t("Store name and address guests see"),
      href: setup,
      done: facts.details,
    },
    { key: "kitchen", label: t("Kitchen line"), href: setup, done: facts.kitchen },
    { key: "receipts", label: t("Business name on receipts"), href: setup, done: facts.receipts },
    {
      key: "setupPublished",
      label: t("Store setup published: hours, tax and payment"),
      href: setup,
      done: facts.setupPublished,
    },
    {
      key: "allergenList",
      label: t("Allergen list approved"),
      href: "/app/compliance/allergens",
      done: facts.allergenList,
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
  const server = fetcher("/merchant/store/opening-list", {
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
  }).then(async (response) => {
    if (!response.ok) throw new Error("OPENING_LIST_UNAVAILABLE");
    return (await response.json()) as {
      readonly setupPublished: boolean;
      readonly allergenList: boolean;
      readonly menuListed: boolean;
    };
  });
  const [details, kitchen, receipts, setupPublished, allergenList, menuListed, tableCode] =
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
    ]);
  return { details, kitchen, receipts, setupPublished, allergenList, menuListed, tableCode };
}

export function OpeningListView({ steps }: { readonly steps: readonly OpeningStep[] }) {
  if (steps.length === 0 || steps.every((step) => step.done)) return null;
  const next = steps.find((step) => !step.done);
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
      if (next.length === 7 && next.every((step) => step.done))
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

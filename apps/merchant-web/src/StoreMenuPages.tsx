import { t } from "./i18n/i18n.js";
import { noAccessHeading, pageAccessDeniedText } from "./access-denied.js";
import { AppFrame, StatePanel } from "@bop-rms/ui";
import { WorkspacePage } from "./WorkspacePage.js";
import { SourceTime, StaffTime } from "./StoreTime.js";
import type { AvailabilityClient } from "./store-availability-page.js";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { newOperationReference } from "./operation-reference.js";
import { moveTo, useDragReorder } from "./reorder.js";
import { SoleOperatorSelfApproval } from "./SoleOperatorSelfApproval.js";
import { OneStoreMenuPage } from "./OneStoreMenuPage.js";
import {
  MenuPageError,
  channelText,
  customerViewChangeSummary,
  descriptionChangeText,
  photoChangeText,
  itemsNotOfferedHere,
  mayDiscardDraft,
  menuReviewProblemText,
  menuRevisionAction,
  menuStage,
  orderTypeText,
  parseMenuBuilderView,
  parseMenuListView,
  parseMenuRouteReference,
  priceText,
  sectionCode,
  unavailableMenuClient,
  type MenuBuilderView,
  type MenuClient,
  type MenuCommand,
  type MenuErrorCode,
  type MenuCustomerPhoto,
  type MenuCustomerView,
  type MenuListView,
  menuDraftFingerprint,
  menuDraftStore,
  type MenuDraftContent,
  type StoredMenuDraft,
} from "./store-menu-pages.js";

/** WP-2423 / DEC-MENU-REVISION: Brand menus — edit, review, publish and revise. */
export const menuErrorText: Record<MenuErrorCode | "Loading", string> = {
  Loading: t("Loading menus…"),
  PermissionDenied: t("You do not have permission for this menu action at Brand level."),
  NotFound: t("This menu does not exist for the Brand."),
  Conflict: t("The menu changed since you opened it. Refresh and check again."),
  Frozen: t(
    "This version was submitted for review and can no longer change. Refresh, then withdraw it or start a revision to change it.",
  ),
  NotRevisable: t("Only a submitted or published version can be revised; keep editing this one."),
  NotDiscardable: t(
    "Only a draft that is not in review, of a menu that has been published, can be discarded. Refresh and check again.",
  ),
  ReviewBlocked: t(
    "The review could not be prepared. Every item needs a published recipe whose ingredients all have current allergen declarations (see Allergens and Recipes), and the Brand allergen list must be approved.",
  ),
  OptionPriceMissing: t(
    "Some options on this menu's items have no published price, so customers could not order them. Set and publish them under Option prices, then submit again.",
  ),
  TaxNotCovered: t(
    "Some items on this menu have no tax rate for one of its order types at this Store (see Tax review), so their price could not be quoted. Fix the product's tax class or the Store's tax configuration, then submit again.",
  ),
  OptionRecipeMissing: t(
    "Some options on this menu's items have no published recipe change (what they do to stock, kitchen and allergens). Set, review and publish them under Option recipes, then submit again.",
  ),
  ApprovalRequired: t(
    "Approval needs someone other than the person who submitted the menu, holding menu approval.",
  ),
  Lifecycle: t("This step is not possible in the menu's current state."),
  Invalid: t(
    "The menu is not valid. Each section needs a distinct name, and an item may appear once per section.",
  ),
  Offline: t("Offline. Nothing was confirmed; retry sends the same request again."),
  Unavailable: t("Menus are unavailable."),
  SoleOperatorNotInEffect: t(
    "Someone else now holds menu approval, so they must approve this version. Refresh to see who.",
  ),
  NeedsReverification: t("Confirm it is you with your authenticator code, then approve again."),
  NotSingleStore: t(
    "This Brand has more than one store, so a menu is reviewed by someone else before it is listed.",
  ),
  RegistryMissing: t(
    "The Brand's allergen list is not approved yet. Approve it under Allergens, then declare the dish's allergens.",
  ),
  NoKitchenStation: t(
    "This store has no kitchen station yet. Set one up under Kitchen, then declare the dish's allergens.",
  ),
  RealRecipe: t(
    "This dish has a recipe, so its allergens come from the recipe's ingredients. Change them on the recipe.",
  ),
  OthersPending: t(
    "Someone else's price changes are waiting to be listed. They list them first, then try again.",
  ),
  NoSection: t("That section is no longer on the menu. Read the menu again and choose a section."),
  ManySizes: t("This dish has more than one size. Change it on the Products page."),
  NotADish: t("A combo can only offer dishes on sale, not another combo. Choose its dishes again."),
  StoppedPartWay: t(
    "Saving stopped part-way. What was saved stays; guests see nothing new. Save it again to finish, and tell the manager if it stops again.",
  ),
  DishAllergensMissing: t(
    "A dish in this combo has no allergens declared yet. Declare its allergens (Edit the dish), then save the combo.",
  ),
  DishHasRecipe: t(
    "A dish in this combo has a recipe. For now a combo offers dishes whose allergens staff declared; choose another dish.",
  ),
  DishUnavailable: t(
    "A dish in a combo is no longer on sale. Edit the combo and choose its dishes again, then list it.",
  ),
};
const stageText = {
  Editing: t("Draft — being edited"),
  InReview: t("In review"),
  Approved: t("Approved — ready to publish"),
  Published: t("Published"),
  Archived: t("Archived"),
} as const;
type State<V> =
  { readonly kind: "Loading" | MenuErrorCode } | { readonly kind: "Found"; readonly view: V };
function useMenuView<V>(
  client: MenuClient,
  menuReference: string | null,
  parse: (value: unknown) => V,
) {
  const [state, setState] = useState<State<V>>({ kind: "Loading" });
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => setGeneration((value) => value + 1), []);
  useEffect(() => {
    let active = true;
    void client
      .load(menuReference)
      .then((value) => {
        if (active) setState({ kind: "Found", view: parse(value) });
      })
      .catch((error: unknown) => {
        if (active) setState({ kind: error instanceof MenuPageError ? error.code : "Unavailable" });
      });
    return () => {
      active = false;
    };
  }, [client, menuReference, parse, generation]);
  return { state, reload };
}
function Failure({ code }: { readonly code: MenuErrorCode | "Loading" }) {
  return (
    <WorkspacePage title={t("Menus")}>
      <StatePanel
        heading={
          code === "PermissionDenied"
            ? noAccessHeading
            : code === "Loading"
              ? t("Loading")
              : t("Unavailable")
        }
        tone={code === "Loading" ? "neutral" : "error"}
        status
      >
        <p>{code === "PermissionDenied" ? pageAccessDeniedText : menuErrorText[code]}</p>
      </StatePanel>
    </WorkspacePage>
  );
}

export function StoreMenuListPage({
  client = unavailableMenuClient,
  availability,
}: {
  readonly client?: MenuClient;
  /** WP-2423 item 8 ⑥: with it, a single store's one menu opens as the one-page menu. */
  readonly availability?: AvailabilityClient;
}) {
  const { state } = useMenuView(client, null, parseMenuListView);
  const [multiStore, setMultiStore] = useState(false);
  const showList = useCallback(() => setMultiStore(true), []);
  if (state.kind !== "Found") return <Failure code={state.kind} />;
  const view: MenuListView = state.view;
  const only = view.menus.length === 1 ? view.menus[0] : undefined;
  if (only !== undefined && availability !== undefined && !multiStore)
    return (
      <OneStoreMenuPage
        menuReference={only.menuReference}
        client={client}
        availability={availability}
        onMultiStore={showList}
      />
    );
  return (
    <WorkspacePage
      title={t("Menus")}
      meta={
        <>
          {t("Source as of")} <SourceTime instant={view.sourceAsOf} />
        </>
      }
    >
      <p className="bop-muted">
        {t(
          "A menu lists what customers can order, by section. Changes are reviewed by someone else before they are published; a published menu is changed through a revision.",
        )}
      </p>
      <table>
        <thead>
          <tr>
            <th>{t("Menu")}</th>
            <th>{t("Current version")}</th>
            <th>{t("Items")}</th>
            <th>{t("Last published")}</th>
          </tr>
        </thead>
        <tbody>
          {view.menus.map((menu) => (
            <tr key={menu.menuReference}>
              <td>
                <Link to={`/app/commerce/menus/${menu.menuReference}`}>
                  {Object.values(menu.localizedNames)[0] ?? menu.internalCode}
                </Link>
              </td>
              <td data-label={t("Version")}>{stageText[menuStage(menu.publication)]}</td>
              <td data-label={t("Items")}>{menu.placements}</td>
              <td data-label={t("Last published")}>
                {menu.latestRelease ? <StaffTime instant={menu.latestRelease.createdAt} /> : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </WorkspacePage>
  );
}

export function StoreMenuBuilderPage({
  client = unavailableMenuClient,
  csrf,
  availability,
}: {
  readonly client?: MenuClient;
  /** For the second-factor check of a sole operator's own approval. */
  readonly csrf?: string;
  /** Item availability at this Store, to offer menu items customers here cannot see yet. */
  readonly availability?: AvailabilityClient;
}) {
  const params = useParams();
  const reference = parseMenuRouteReference(params.id);
  if (reference === null) return <Failure code="NotFound" />;
  return (
    <MenuBuilder
      key={reference}
      client={client}
      menuReference={reference}
      csrf={csrf}
      availability={availability}
    />
  );
}

function CustomerPhoto({ photo }: { readonly photo: MenuCustomerPhoto }) {
  return (
    <figure className="menu-customer-view__photo">
      <img src={photo.url} alt={photo.altText} width={photo.width} height={photo.height} />
      <figcaption>
        {photo.altText === ""
          ? t("Photo not described.")
          : t("Photo description: {altText}", { altText: photo.altText })}
      </figcaption>
    </figure>
  );
}

/**
 * WP-2423 (v15 run of cb3f6f2a): before approving, the reviewer sees exactly what customers will see
 * for each item (frozen in the review snapshot), with changes against the published menu marked.
 */
function MenuCustomerViewSection({
  view,
  published,
}: {
  readonly view: MenuCustomerView;
  readonly published: boolean;
}) {
  const summary = customerViewChangeSummary(view);
  return (
    <section className="detail-section menu-customer-view" aria-labelledby="menu-customer-view">
      <h3 id="menu-customer-view">
        {published ? t("What customers see") : t("What customers will see")}
      </h3>
      <p>
        {t("Each item's description and photo exactly as fixed for review on")}{" "}
        <StaffTime instant={view.frozenAt} />
        {t(". Changes made to products after that appear only in a new version.")}
      </p>
      {view.comparedWithPublishedAt !== null ? (
        <p className="menu-customer-view__summary">
          {t("Compared with the menu customers see now (published")}{" "}
          <StaffTime instant={view.comparedWithPublishedAt} />
          ): {summary}
        </p>
      ) : published ? null : (
        <p className="menu-customer-view__summary">
          {t("Not published before: customers see all of this for the first time.")}
        </p>
      )}
      <ul className="menu-customer-view__items">
        {view.items.map((item) => {
          const changes = [
            item.newOnMenu ? t("New on the menu") : null,
            item.descriptionChange ? descriptionChangeText[item.descriptionChange] : null,
            item.photoChange ? photoChangeText[item.photoChange] : null,
          ].filter((change): change is string => change !== null);
          return (
            <li
              key={item.placementReference}
              className="menu-customer-view__item"
              data-changed={changes.length > 0 ? "true" : undefined}
            >
              {item.photo ? (
                <CustomerPhoto photo={item.photo} />
              ) : (
                <p className="menu-customer-view__no-photo">{t("No photo")}</p>
              )}
              <div className="menu-customer-view__text">
                <h4>{item.name}</h4>
                <p className="menu-customer-view__section">{item.sectionName}</p>
                {changes.length > 0 ? (
                  <ul className="menu-customer-view__changes" aria-label={t("Changes")}>
                    {changes.map((change) => (
                      <li key={change}>{change}</li>
                    ))}
                  </ul>
                ) : null}
                <p>{item.description ?? t("No description.")}</p>
                {item.before ? (
                  <div className="menu-customer-view__before">
                    <p className="menu-customer-view__before-label">{t("Customers see now:")}</p>
                    {item.descriptionChange ? (
                      <p>{item.before.description ?? t("No description.")}</p>
                    ) : null}
                    {item.photoChange ? (
                      item.before.photo ? (
                        <CustomerPhoto photo={item.before.photo} />
                      ) : (
                        <p>{t("No photo.")}</p>
                      )
                    ) : null}
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      {view.removedFromMenu.length > 0 ? (
        <p>
          {t("Removed from the menu (customers no longer see them): {value}.", {
            value: view.removedFromMenu.map((item) => item.name).join(", "),
          })}
        </p>
      ) : null}
    </section>
  );
}

interface EditableSection {
  readonly key: string;
  readonly sectionReference: string | null;
  readonly code: string | null;
  name: string;
  /** Owner 2026-10-23: the Simplified Chinese name customers see ("" when none). */
  nameZh: string;
  items: { skuReference: string; featured: boolean }[];
}
let sectionKey = 0;

/** WP-2423 Q31: what the server holds for this menu, in the shape the editor compares. */
function savedMenuContent(menu: MenuBuilderView["menu"]): MenuDraftContent {
  return {
    name: menu.name,
    sections: menu.sections.map((section) => ({
      sectionReference: section.sectionReference,
      code: section.code,
      name: section.name,
      nameZh: section.nameZh ?? "",
      items: section.items.map((item) => ({
        skuReference: item.skuReference,
        featured: item.featured,
      })),
    })),
  };
}

function MenuBuilder({
  client,
  menuReference,
  csrf,
  availability,
}: {
  readonly client: MenuClient;
  readonly menuReference: string;
  readonly csrf: string | undefined;
  readonly availability: AvailabilityClient | undefined;
}) {
  const { state, reload } = useMenuView(client, menuReference, parseMenuBuilderView);
  const [name, setName] = useState("");
  const [sections, setSections] = useState<EditableSection[]>([]);
  const [loadedVersion, setLoadedVersion] = useState<number | null>(null);
  const [pending, setPending] = useState<MenuCommand | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [message, setMessage] = useState<{ tone: "error" | "neutral"; text: string } | null>(null);
  // WP-2423 Q31: unsaved changes kept on this device, offered back when the page is opened again.
  const [kept, setKept] = useState<StoredMenuDraft | "Outdated" | null>(null);
  useEffect(() => {
    if (state.kind !== "Found") return;
    const menu = state.view.menu;
    if (loadedVersion === menu.aggregateVersion) return;
    setLoadedVersion(menu.aggregateVersion);
    const stored = menuDraftStore.read(menuReference);
    setKept(
      stored === null ||
        menuDraftFingerprint(stored) === menuDraftFingerprint(savedMenuContent(menu))
        ? null
        : stored.aggregateVersion === menu.aggregateVersion
          ? stored
          : "Outdated",
    );
    setName(menu.name);
    setSections(
      menu.sections.map((section) => ({
        key: "s" + ++sectionKey,
        sectionReference: section.sectionReference,
        code: section.code,
        name: section.name,
        nameZh: section.nameZh ?? "",
        items: section.items.map((item) => ({
          skuReference: item.skuReference,
          featured: item.featured,
        })),
      })),
    );
  }, [state, loadedVersion, menuReference]);
  const found = state.kind === "Found" ? state.view : null;
  const editing =
    found !== null &&
    loadedVersion === found.menu.aggregateVersion &&
    menuStage(found.publication) === "Editing" &&
    found.permissions.mayEdit;
  const current = menuDraftFingerprint({ name, sections });
  const dirty =
    editing && found !== null && current !== menuDraftFingerprint(savedMenuContent(found.menu));
  const keptPending = kept !== null;
  useEffect(() => {
    // Until the cook decides about changes kept earlier, nothing overwrites them.
    if (!editing || keptPending || found === null) return;
    if (dirty)
      menuDraftStore.write(menuReference, {
        name,
        sections,
        aggregateVersion: found.menu.aggregateVersion,
        keptAt: new Date().toISOString(),
      });
    else menuDraftStore.clear(menuReference);
  }, [editing, keptPending, dirty, current, found, menuReference, name, sections]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const drag = useDragReorder((list, from, to) => {
    if (list === "sections") setSections((current) => [...moveTo(current, from, to)]);
    else updateSectionItems(list, (items) => [...moveTo(items, from, to)]);
  });
  const updateSectionItems = (
    key: string,
    change: (items: EditableSection["items"]) => EditableSection["items"],
  ) =>
    setSections((current) =>
      current.map((section) =>
        section.key === key ? { ...section, items: change(section.items) } : section,
      ),
    );
  if (state.kind !== "Found") return <Failure code={state.kind} />;
  const view: MenuBuilderView = state.view;
  const menu = view.menu;
  const stage = menuStage(view.publication);
  const editable = stage === "Editing" && view.permissions.mayEdit;
  const restoreKept = () => {
    if (kept === null || kept === "Outdated") return;
    setName(kept.name);
    setSections(
      kept.sections.map((section) => ({
        key: "s" + ++sectionKey,
        sectionReference: section.sectionReference,
        code: section.code,
        name: section.name,
        nameZh: section.nameZh,
        items: section.items.map((item) => ({ ...item })),
      })),
    );
    setKept(null);
  };
  const dropKept = () => {
    menuDraftStore.clear(menuReference);
    setKept(null);
  };
  const revision = menuRevisionAction(stage, view.latestRelease !== null);
  const discardable = mayDiscardDraft(view);
  const sellables = new Map(view.sellables.map((item) => [item.skuReference, item]));
  const label = (sku: string) => {
    const item = sellables.get(sku);
    if (!item) return "Item " + sku.slice(-4);
    return item.sizeName === item.productName
      ? item.productName
      : `${item.productName} — ${item.sizeName}`;
  };
  const send = async (fresh: MenuCommand, done: string) => {
    if (!client.command) return;
    const command = pending !== null && pending.action === fresh.action ? pending : fresh;
    setBusy(true);
    setMessage(null);
    setPending(command);
    try {
      await client.command(command);
      // WP-2423 Q31: once saved or discarded on the server, nothing is kept on this device.
      if (command.action === "SaveDraft" || command.action === "DiscardDraft") {
        menuDraftStore.clear(menuReference);
        setKept(null);
      }
      setPending(null);
      setMessage({ tone: "neutral", text: done });
      setLoadedVersion(null);
      reload();
    } catch (error) {
      const code = error instanceof MenuPageError ? error.code : "Unavailable";
      if (code !== "Offline" && code !== "Unavailable") setPending(null);
      const problem = error instanceof MenuPageError ? error.problem : null;
      setMessage({
        tone: "error",
        text: problem === null ? menuErrorText[code] : menuReviewProblemText(problem),
      });
    } finally {
      setBusy(false);
    }
  };
  const used = new Set(
    sections.flatMap((section) => section.items.map((item) => item.skuReference)),
  );
  const unpriced = [...used].filter((sku) => sellables.get(sku)?.priceMinor == null);
  const valid =
    name.trim().length > 0 &&
    sections.length > 0 &&
    sections.every((section) => section.name.trim() && sectionCode(section.name)) &&
    new Set(sections.map((section) => section.name.trim().toLowerCase())).size === sections.length;
  const updateSection = (key: string, change: (section: EditableSection) => EditableSection) =>
    setSections((current) =>
      current.map((section) => (section.key === key ? change(section) : section)),
    );
  // WP-2423 (v15 2026-10-16): items on this menu that customers at this Store cannot see because
  // they are not offered here yet (Item availability). Publishing never claims they are shown.
  const hidden = itemsNotOfferedHere(view);
  const hiddenNames = hidden
    .map((item) =>
      item.sizeName === item.productName
        ? item.productName
        : `${item.productName} — ${item.sizeName}`,
    )
    .join(", ");
  const offerCommand = availability?.command?.bind(availability);
  const mayOffer = view.mayOfferHere === true && offerCommand !== undefined;
  const offerHidden = async () => {
    if (offerCommand === undefined || hidden.length === 0) return;
    setBusy(true);
    setMessage(null);
    let offered = 0;
    try {
      for (const item of hidden) {
        await offerCommand({
          action: "Offer",
          operationReference: newOperationReference(),
          skuReference: item.skuReference,
        });
        offered += 1;
      }
      setMessage({
        tone: "neutral",
        text: t(
          "{offered} item{value} now offered at this Store. Customers here see {value2} on the published menu.",
          {
            offered: offered,
            value: offered === 1 ? " is" : "s are",
            value2: offered === 1 ? "it" : "them",
          },
        ),
      });
    } catch {
      setMessage({
        tone: "error",
        text:
          (offered > 0
            ? t("{offered} of {length} items were offered. ", {
                offered: offered,
                length: hidden.length,
              })
            : "") +
          t(
            "The rest could not be offered. Refresh and try again, or offer them under Item availability.",
          ),
      });
    } finally {
      setBusy(false);
      setLoadedVersion(null);
      reload();
    }
  };
  const publishedText =
    hidden.length === 0
      ? t("Published. Customers at this Store now see this menu.")
      : t(
          "Published. Customers at this Store see this menu, except {length} item{value} not offered here yet: {hiddenNames}.",
          {
            length: hidden.length,
            value: hidden.length === 1 ? "" : "s",
            hiddenNames: hiddenNames,
          },
        );
  const publication = view.publication;
  const mayApproveHere =
    view.permissions.mayApprove && view.submittedBy !== null && view.submittedBy !== view.viewer;
  return (
    <AppFrame className="menu-builder-page" title={menu.name} description={t("Menu")}>
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">{t("Menu · Brand")}</p>
          <h2>{menu.name}</h2>
          <p>
            {stageText[stage]} · {channelText(menu.channelCodes)} ·{" "}
            {orderTypeText(menu.orderTypeCodes)}
            {view.latestRelease ? (
              <>
                {" "}
                {t("· last published")} <StaffTime instant={view.latestRelease.createdAt} />
              </>
            ) : null}
          </p>
        </div>
        <Link to="/app/commerce/menus">{t("Back to menus")}</Link>
      </header>
      {message ? (
        <StatePanel
          heading={message.tone === "error" ? t("Not done") : t("Done")}
          tone={message.tone}
          status
        >
          <p>{message.text}</p>
        </StatePanel>
      ) : null}
      {kept !== null && editable ? (
        <StatePanel heading={t("Unsaved changes on this device")} status>
          {kept === "Outdated" ? (
            <p>
              {t(
                "Changes made earlier on this device were not brought back, because the menu has been saved since. Check the menu below and make them again if they are still needed.",
              )}
            </p>
          ) : (
            <p>
              {t("Changes to this menu made on this device were not saved. Last change:")}{" "}
              <StaffTime instant={kept.keptAt} />
            </p>
          )}
          <p>
            {kept === "Outdated" ? null : (
              <>
                <button type="button" onClick={restoreKept}>
                  {t("Bring back unsaved changes")}
                </button>{" "}
              </>
            )}
            <button type="button" onClick={dropKept}>
              {kept === "Outdated" ? t("OK") : t("Discard them")}
            </button>
          </p>
        </StatePanel>
      ) : null}
      {hidden.length > 0 ? (
        <StatePanel heading={t("Not offered at this Store")} status>
          <p>
            {stage === "Published"
              ? t(
                  "Customers at this Store don't see these items on the published menu until they are offered here: ",
                )
              : t(
                  "When this menu is published, customers at this Store won't see these items until they are offered here: ",
                )}
            {hiddenNames}.
          </p>
          <p>
            {mayOffer ? (
              <>
                <button type="button" disabled={busy} onClick={() => void offerHidden()}>
                  {t("Offer {value} at this Store now", {
                    value: hidden.length === 1 ? "this item" : `these ${hidden.length} items`,
                  })}
                </button>{" "}
              </>
            ) : (
              t("Someone who manages item availability can offer them. ")
            )}
            <Link to="/app/commerce/availability">{t("Item availability")}</Link>
          </p>
        </StatePanel>
      ) : null}
      {unpriced.length > 0 ? (
        <StatePanel heading={t("Missing prices")} status>
          <p>
            {t(
              "These items have no price in the price book this Store uses; customers cannot be quoted for them: {value}.",
              { value: unpriced.map(label).join(", ") },
            )}
          </p>
        </StatePanel>
      ) : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!editable || !valid || busy) return;
          void send(
            {
              action: "SaveDraft",
              operationReference: newOperationReference(),
              menuReference: menu.menuReference,
              expectedAggregateVersion: menu.aggregateVersion,
              name: name.trim(),
              sections: sections.map((section) => ({
                sectionReference: section.sectionReference,
                code: section.code ?? sectionCode(section.name),
                name: section.name.trim(),
                nameZh: section.nameZh.trim(),
                items: section.items,
              })),
            },
            t("Menu saved."),
          );
        }}
      >
        <fieldset disabled={!editable || busy}>
          <legend>{t("Menu")}</legend>
          <label>
            {t("Menu name")}
            <input value={name} maxLength={120} onChange={(event) => setName(event.target.value)} />
          </label>
        </fieldset>
        {sections.map((section, sectionIndex) => {
          const available = view.sellables.filter(
            (item) =>
              item.active && !section.items.some((i) => i.skuReference === item.skuReference),
          );
          return (
            <fieldset
              key={section.key}
              ref={drag.row("sections", sectionIndex)}
              className="menu-builder-section"
              disabled={!editable || busy}
            >
              <legend>
                {editable ? (
                  <span
                    className="drag-handle"
                    aria-hidden="true"
                    title={t("Drag to move this section")}
                    {...drag.handle("sections", sectionIndex)}
                  >
                    ⠿
                  </span>
                ) : null}
                {t("Section {value}", { value: sectionIndex + 1 })}
              </legend>
              <label>
                {t("Section name")}
                <input
                  value={section.name}
                  maxLength={80}
                  onChange={(event) =>
                    updateSection(section.key, (s) => ({ ...s, name: event.target.value }))
                  }
                />
              </label>
              <label>
                {t("Chinese name (中文名称, optional)")}
                <input
                  lang="zh-Hans"
                  value={section.nameZh}
                  maxLength={80}
                  placeholder="咖啡"
                  onChange={(event) =>
                    updateSection(section.key, (s) => ({ ...s, nameZh: event.target.value }))
                  }
                />
              </label>
              <table>
                <thead>
                  <tr>
                    <th>{t("Item")}</th>
                    <th>{t("Price here")}</th>
                    <th>{t("Featured")}</th>
                    {editable ? <th aria-label={t("Order")} /> : null}
                  </tr>
                </thead>
                <tbody>
                  {section.items.map((item, index) => (
                    <tr key={item.skuReference} ref={drag.row(section.key, index)}>
                      <td>
                        {editable ? (
                          <span
                            className="drag-handle"
                            aria-hidden="true"
                            title={t("Drag to move this item")}
                            {...drag.handle(section.key, index)}
                          >
                            ⠿
                          </span>
                        ) : null}
                        {label(item.skuReference)}
                      </td>
                      <td>
                        {priceText(sellables.get(item.skuReference)?.priceMinor ?? null) ??
                          t("No price")}
                      </td>
                      <td>
                        {!editable ? (
                          item.featured ? (
                            t("Featured")
                          ) : (
                            "—"
                          )
                        ) : (
                          <input
                            type="checkbox"
                            aria-label={t("Feature {skuReference}", {
                              skuReference: label(item.skuReference),
                            })}
                            checked={item.featured}
                            onChange={(event) =>
                              updateSection(section.key, (s) => ({
                                ...s,
                                items: s.items.map((i) =>
                                  i.skuReference === item.skuReference
                                    ? { ...i, featured: event.target.checked }
                                    : i,
                                ),
                              }))
                            }
                          />
                        )}
                      </td>
                      {editable ? (
                        <td className="menu-builder-order">
                          {(
                            [
                              ["first", "⤒", t("Move {skuReference} to the top"), 0],
                              ["up", "↑", t("Move {skuReference} up"), index - 1],
                              ["down", "↓", t("Move {skuReference} down"), index + 1],
                              [
                                "last",
                                "⤓",
                                t("Move {skuReference} to the bottom"),
                                section.items.length - 1,
                              ],
                            ] as const
                          ).map(([key, symbol, text, to]) => (
                            <button
                              key={key}
                              type="button"
                              disabled={
                                key === "first" || key === "up"
                                  ? index === 0
                                  : index === section.items.length - 1
                              }
                              aria-label={text.replace("{skuReference}", label(item.skuReference))}
                              onClick={() =>
                                updateSectionItems(section.key, (items) => [
                                  ...moveTo(items, index, to),
                                ])
                              }
                            >
                              {symbol}
                            </button>
                          ))}
                          <button
                            type="button"
                            onClick={() =>
                              updateSection(section.key, (s) => ({
                                ...s,
                                items: s.items.filter((i) => i.skuReference !== item.skuReference),
                              }))
                            }
                          >
                            {t("Remove")}
                          </button>
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
              {editable && available.length > 0 ? (
                <label>
                  {t("Add item")}
                  <select
                    value=""
                    onChange={(event) => {
                      const sku = event.target.value;
                      if (sku)
                        updateSection(section.key, (s) => ({
                          ...s,
                          items: [...s.items, { skuReference: sku, featured: false }],
                        }));
                    }}
                  >
                    <option value="">{t("Choose…")}</option>
                    {available.map((item) => (
                      <option key={item.skuReference} value={item.skuReference}>
                        {`${item.productName} — ${item.sizeName}`}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {editable ? (
                <p>
                  {(
                    [
                      ["first", t("Move section to the top"), 0],
                      ["up", t("Move section up"), sectionIndex - 1],
                      ["down", t("Move section down"), sectionIndex + 1],
                      ["last", t("Move section to the bottom"), sections.length - 1],
                    ] as const
                  ).map(([key, text, to]) => (
                    <button
                      key={key}
                      type="button"
                      disabled={
                        key === "first" || key === "up"
                          ? sectionIndex === 0
                          : sectionIndex === sections.length - 1
                      }
                      onClick={() =>
                        setSections((current) => [...moveTo(current, sectionIndex, to)])
                      }
                    >
                      {text}
                    </button>
                  ))}{" "}
                  {section.items.length === 0 ? (
                    <button
                      type="button"
                      onClick={() =>
                        setSections((current) => current.filter((s) => s.key !== section.key))
                      }
                    >
                      {t("Remove section")}
                    </button>
                  ) : null}
                </p>
              ) : null}
            </fieldset>
          );
        })}
        {editable ? (
          <p>
            <button
              type="button"
              onClick={() =>
                setSections((current) => [
                  ...current,
                  {
                    key: "s" + ++sectionKey,
                    sectionReference: null,
                    code: null,
                    name: "",
                    nameZh: "",
                    items: [],
                  },
                ])
              }
            >
              {t("Add section")}
            </button>{" "}
            <button type="submit" disabled={!valid || busy}>
              {pending?.action === "SaveDraft" ? t("Retry") : t("Save menu")}
            </button>
            {dirty ? (
              <span className="menu-builder-unsaved" role="status">
                {" "}
                {t("Unsaved changes — kept on this device until you save.")}
              </span>
            ) : null}
          </p>
        ) : null}
      </form>
      {view.customerView ? (
        <MenuCustomerViewSection view={view.customerView} published={stage === "Published"} />
      ) : stage === "InReview" || stage === "Approved" ? (
        <StatePanel heading={t("Customer view not shown")} tone="error" status>
          <p>
            {t(
              "What customers will see for this version could not be shown. Refresh before approving or publishing.",
            )}
          </p>
        </StatePanel>
      ) : null}
      <section className="detail-section" aria-labelledby="publication">
        <h3 id="publication">{t("Review and publication")}</h3>
        {stage === "Editing" ? (
          <>
            <p>
              {t(
                "Submitting fixes this version and checks each item's recipe allergens against the Brand allergen list; someone else then approves it.{value}",
                {
                  value: view.allergenRegistry
                    ? ""
                    : t(" The Brand allergen list must be approved first."),
                },
              )}
            </p>
            {view.permissions.maySubmit ? (
              <button
                type="button"
                disabled={busy || used.size === 0}
                onClick={() =>
                  void send(
                    {
                      action: "Submit",
                      operationReference: newOperationReference(),
                      menuReference: menu.menuReference,
                    },
                    t("Submitted for review."),
                  )
                }
              >
                {pending?.action === "Submit" ? t("Retry submit") : t("Submit for review")}
              </button>
            ) : null}
          </>
        ) : null}
        {stage === "InReview" && publication ? (
          mayApproveHere ? (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void send(
                  {
                    action: "Approve",
                    operationReference: newOperationReference(),
                    menuReference: menu.menuReference,
                    menuVersionReference: menu.versionReference,
                    expectedVersion: publication.lifecycleVersion,
                    snapshotDigest: publication.snapshotDigest,
                  },
                  "Approved.",
                )
              }
            >
              {pending?.action === "Approve" ? t("Retry approve") : t("Approve")}
            </button>
          ) : view.submittedBy === view.viewer && view.permissions.mayApprove ? (
            <SoleOperatorSelfApproval
              gate={view.soleOperator}
              csrf={csrf}
              what={t("this menu version")}
              permissionName={t("menu approval")}
              busy={busy}
              actionLabel={
                pending?.action === "Approve" ? t("Retry approve") : t("Approve on my own")
              }
              summary={
                <p>
                  {t(
                    "{name} · {length} section{value}, {value2} items. Once approved it can be published to customers.",
                    {
                      name: menu.name,
                      length: menu.sections.length,
                      value: menu.sections.length === 1 ? "" : "s",
                      value2: menu.sections.reduce(
                        (count, section) => count + section.items.length,
                        0,
                      ),
                    },
                  )}
                </p>
              }
              onApprove={() =>
                void send(
                  {
                    action: "Approve",
                    operationReference: newOperationReference(),
                    menuReference: menu.menuReference,
                    menuVersionReference: menu.versionReference,
                    expectedVersion: publication.lifecycleVersion,
                    snapshotDigest: publication.snapshotDigest,
                    approvalMode: "SoleOperator",
                  },
                  "Approved.",
                )
              }
            />
          ) : (
            <p>
              {view.submittedBy === view.viewer
                ? t("You submitted this version: someone else must approve it.")
                : t("Waiting for approval by someone holding menu approval.")}
            </p>
          )
        ) : null}
        {stage === "Approved" && publication && view.permissions.mayPublish ? (
          <>
            <p>
              {t(
                "Publishing makes this version the menu customers order from, starting now{value}",
                {
                  value:
                    hidden.length > 0
                      ? t(
                          " (customers at this Store see the {value} listed above only once offered here).",
                          { value: hidden.length === 1 ? "item" : "items" },
                        )
                      : ".",
                },
              )}
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void send(
                  {
                    action: "Publish",
                    operationReference: newOperationReference(),
                    menuReference: menu.menuReference,
                    menuVersionReference: menu.versionReference,
                    expectedVersion: publication.lifecycleVersion,
                    snapshotDigest: publication.snapshotDigest,
                  },
                  publishedText,
                )
              }
            >
              {pending?.action === "Publish" ? t("Retry publish") : t("Publish")}
            </button>
          </>
        ) : null}
        {revision && view.permissions.mayEdit ? (
          <p>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void send(
                  {
                    action: "Revise",
                    operationReference: newOperationReference(),
                    menuReference: menu.menuReference,
                    expectedAggregateVersion: menu.aggregateVersion,
                  },
                  revision.done,
                )
              }
            >
              {pending?.action === "Revise" ? t("Retry") : revision.label}
            </button>{" "}
            {revision.note}
          </p>
        ) : null}
        {discardable ? (
          confirmDiscard || pending?.action === "DiscardDraft" ? (
            <div role="group" aria-labelledby="discard-draft-question">
              <p id="discard-draft-question">
                {t(
                  "Discard this draft? The menu goes back to its published version and the changes in this draft are set aside (they stay in the menu's history). Customers keep seeing the published menu; nothing changes for them.",
                )}
              </p>
              <p>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    void send(
                      {
                        action: "DiscardDraft",
                        operationReference: newOperationReference(),
                        menuReference: menu.menuReference,
                        expectedAggregateVersion: menu.aggregateVersion,
                      },
                      t("Draft discarded. The menu is back to its published version."),
                    ).then(() => setConfirmDiscard(false));
                  }}
                >
                  {pending?.action === "DiscardDraft" ? t("Retry discard") : t("Discard draft")}
                </button>{" "}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setConfirmDiscard(false);
                    if (pending?.action === "DiscardDraft") setPending(null);
                  }}
                >
                  {t("Keep the draft")}
                </button>
              </p>
            </div>
          ) : (
            <p>
              <button type="button" disabled={busy} onClick={() => setConfirmDiscard(true)}>
                {t("Discard this draft")}
              </button>{" "}
              {t("Not making changes after all? Go back to the published menu.")}
            </p>
          )
        ) : null}
      </section>
    </AppFrame>
  );
}

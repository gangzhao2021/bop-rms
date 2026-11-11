import { clauseSeparator, listSeparator, sentenceEnd, t } from "../i18n/i18n.js";
import {
  activeMenuOptionRules,
  defaultMenuOptionSelections,
  requiredGroupNotOffered,
  selectedMenuOptions,
} from "./option-configuration.js";
import { createBrowserPickupCartClient } from "../cart/pickup-cart-client.js";
import { CustomerPage } from "../journey/CustomerPage.js";
import { SlowAddNotice } from "../slow-wait.js";
import { formatDecimalMoney, formatMoney } from "../journey/format.js";
import {
  cartIssueMessage,
  participationEndedText,
  specificCartIssues,
} from "../journey/messages.js";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { FormEvent } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { createBrowserCustomerCartClient } from "../cart/cart-client.js";
import {
  checkoutInProgressMessage,
  orderProcessingMessage,
  type CartItemDraft,
  type CartView,
} from "../cart/types.js";
import {
  createConfigureController,
  type ConfigureController,
  type ConfigureState,
} from "./configure-state.js";
import { createCustomerMenuClient, normalizeMenuSearch } from "./menu-client.js";
import {
  allergensForChoice,
  comboDishAllergens,
  missingComboPart,
  compactAllergenLine,
  configuredItemTotal,
  familyAllergens,
  familyDescription,
  familyPhoto,
  familyPriceText,
  familySoldOut,
  findMenuFamily,
  groupMenuFamilies,
  primaryVariant,
  type MenuFamily,
  type MenuVariant,
} from "./menu-families.js";
import {
  createStoreProfileClient,
  type StoreProfileLoader,
} from "../store/store-profile-client.js";
import {
  KitchenStatementLine,
  OrdersStoppedNotice,
  StoreInfoSection,
  StoreStatusStrip,
  useStoreService,
} from "../store/StoreIdentity.js";
import { takesNewOrders } from "../store/store-service.js";
import { nextOpeningText } from "../store/store-hours-text.js";
import { TableOrderedProvider, useTableOrderedCount } from "../dining/table-ordered.js";
import type { DiningSessionClient } from "../dining/dining-session-client.js";
import { cartLinePrices, cartLinesSubtotal } from "./menu-line-prices.js";
import type {
  CustomerMenuClient,
  MenuAllergenItem,
  MenuClosedStore,
  MenuJourneyContext,
  MenuLoadResult,
  MenuOptionRule,
  MenuPhoto,
  MenuSellable,
  MenuView,
} from "./types.js";

type ScreenState =
  | Readonly<{ kind: "MissingContext" }>
  | Readonly<{ kind: "IdleSearch" }>
  | Readonly<{ kind: "Loading" }>
  | MenuLoadResult;

/** The guest's current cart in one line: how many items and, when every line is priced, the subtotal. */
export interface MenuCartSummary {
  readonly count: number;
  /** "$14.75" before tax; null when any line can't be priced before checkout. */
  readonly subtotal: string | null;
}

/** The guest's current cart; null when there is none or it can't be read. */
export type CartSummaryLoader = () => Promise<CartView | null>;

interface MenuPageProps {
  readonly context?: MenuJourneyContext | undefined;
  readonly client?: CustomerMenuClient | undefined;
  readonly readOnlyNotice?: React.ReactNode | undefined;
  /** Injected for previews; the browser loader reads the Store cart otherwise. */
  readonly cartSummary?: CartSummaryLoader | undefined;
  /** The Store's hours and address; null shows none (previews), absent reads the Store. */
  readonly storeProfile?: StoreProfileLoader | null | undefined;
}

const browserStoreProfile: StoreProfileLoader = createStoreProfileClient();

/**
 * Count and pre-tax subtotal of a cart: the current quote's subtotal when there is one, otherwise
 * each line at the Store's price or, before the Store prices it, at the published price the guest
 * saw on the item page. Null subtotal when any line can't be priced that way.
 */
export function summarizeCart(
  view: CartView | null,
  menu: MenuView | null = null,
): MenuCartSummary {
  if (view === null || view.cart.lifecycle.status !== "Active") return { count: 0, subtotal: null };
  const { cart } = view;
  const count = cart.items.reduce((total, item) => total + item.quantity, 0);
  if (count === 0) return { count, subtotal: null };
  if (cart.quote !== null && cart.quote.cartVersion === cart.version)
    return {
      count,
      subtotal: formatMoney(cart.quote.subtotal.amountMinor, cart.quote.subtotal.currency),
    };
  const subtotal = cartLinesSubtotal(cartLinePrices(cart.items, menu));
  return {
    count,
    subtotal: subtotal === null ? null : formatMoney(subtotal.amountMinor, subtotal.currency),
  };
}

const browserCartSummary: CartSummaryLoader = async () => {
  const view = await createBrowserCustomerCartClient().loadCurrent();
  return view;
};

function useClient(
  context: MenuJourneyContext | undefined,
  client: CustomerMenuClient | undefined,
) {
  return useMemo(() => {
    if (client !== undefined) return client;
    if (context === undefined) return null;
    return createCustomerMenuClient(context, {
      fetch: globalThis.fetch.bind(globalThis),
      online: () => globalThis.navigator?.onLine ?? true,
    });
  }, [client, context]);
}

/**
 * WP-2423 live minor 26: once per page load, a menu opened with no Store known (a reload of the
 * menu reached from "Look at the menu first" at a table not open, where no visit exists yet) goes
 * to the entry page, which replays this browser's waiting scan and shows that table's page again;
 * with no waiting scan the entry page asks for a scan, as this page would. Never twice, so a menu
 * that still knows no Store after that says so instead of going round.
 */
let entryReplayTried = false;
export function resetEntryReplayForTest(): void {
  entryReplayTried = false;
}
function useEntryReplay(missing: boolean): void {
  const navigate = useNavigate();
  useEffect(() => {
    if (!missing || entryReplayTried) return;
    entryReplayTried = true;
    void navigate("/", { replace: true });
  }, [missing, navigate]);
}

function useMenuLoad(
  client: CustomerMenuClient | null,
  input: Readonly<{ searchTerm?: string; sectionReference?: string }> | null = {},
) {
  useEntryReplay(client === null);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<ScreenState>(() =>
    client === null
      ? { kind: "MissingContext" }
      : input === null
        ? { kind: "IdleSearch" }
        : { kind: "Loading" },
  );
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (client === null) {
      setState({ kind: "MissingContext" });
      return;
    }
    if (input === null) {
      setState({ kind: "IdleSearch" });
      return;
    }
    let current = true;
    setState({ kind: "Loading" });
    void client.load(input).then((next) => {
      if (current) setState(next);
    });
    return () => {
      current = false;
    };
  }, [client, input, revision]);
  // M94: a menu that could not open (offline, being refreshed, unavailable) opens again by itself
  // when the phone is back online; a menu already shown is not read again.
  const shownKind = useRef(state.kind);
  shownKind.current = state.kind;
  useEffect(() => {
    if (typeof window === "undefined") return;
    const online = () => {
      if (
        shownKind.current === "Offline" ||
        shownKind.current === "Stale" ||
        shownKind.current === "Unavailable"
      )
        setRevision((value) => value + 1);
    };
    window.addEventListener("online", online);
    return () => window.removeEventListener("online", online);
  }, []);
  useEffect(() => {
    // Owner 2026-11-03 walkthrough: moving the focus never moves the guest off where they were.
    if (state.kind !== "Loading") heading.current?.focus({ preventScroll: true });
  }, [state.kind]);
  // WP-2423 (cart-unsellable-dishes): read the menu again in place (no loading screen), so
  // a choice turned off since it was shown greys out while the guest keeps their page. Stable
  // across renders, so a consumer's effect does not fire again when the menu it read arrives.
  const refresh = useCallback(() => {
    if (client === null || input === null) return;
    void client.load(input).then((next) => {
      if (next.kind === "Found") setState(next);
    });
  }, [client, input]);
  return {
    state,
    heading,
    retry: () => setRevision((value) => value + 1),
    refresh,
  };
}

/** One choice only: shown as radio buttons. */
const singleChoice = (rule: MenuOptionRule) =>
  rule.maximumSelections === 1 && rule.options.every((option) => option.maximumQuantity === 1);
/** "Required", "Optional · up to 3", "Choose 1 to 2". */
function choiceText(rule: MenuOptionRule): string {
  const { minimumSelections: min, maximumSelections: max } = rule;
  if (min === max) return max === 1 ? t("Required") : t("Required · choose {max}", { max });
  if (min === 0) return max === 1 ? t("Optional") : t("Optional · up to {max}", { max });
  return t("Choose {min} to {max}", { min, max });
}
/**
 * "+ $0.75", or a note that the quote will price it. A choice that costs nothing has no text at all
 * (null): a guest choosing sugar level reads a clean list and "+ $0.75" stands out, and silence
 * always means free, because a price not set yet still says so.
 */
function optionPriceText(price: MenuOptionRule["options"][number]["price"]): string | null {
  if (price === null) return t("Priced at checkout");
  if (/^0+(\.0+)?$/u.test(price.amount)) return null;
  const amount = formatDecimalMoney(price.amount, price.currency);
  return amount === null ? t("Priced at checkout") : `+ ${amount}`;
}

/** M116: "Closed now · opens tomorrow at 11:00 a.m.", and a way to ask again. */
function ClosedStoreNotice({ closed }: { readonly closed: MenuClosedStore }) {
  return (
    <>
      <p className="menu-closed-notice__line">
        {closed.paused
          ? t("Ordering is paused for a short while")
          : closed.nextOpening === null
            ? t("Closed now")
            : t("Closed now") +
              " · " +
              nextOpeningText(closed.nextOpening, closed.localDate, "Line")}
      </p>
      <p>
        {closed.paused
          ? t("You can look at the menu. You can order once ordering starts again.")
          : t("You can look at the menu. You can order once the store opens.")}
      </p>
      <Link className="menu-action" to="/">
        {t("Check again")}
      </Link>
    </>
  );
}

export function MenuBrowsePage({
  context,
  client,
  readOnlyNotice,
  cartSummary,
  storeProfile,
}: MenuPageProps) {
  const resolvedClient = useClient(context, client);
  const input = useMemo(() => ({}), []);
  const loaded = useMenuLoad(resolvedClient, input);
  return (
    <MenuScreen
      context={context}
      headingRef={loaded.heading}
      mode="browse"
      onRetry={loaded.retry}
      readOnlyNotice={readOnlyNotice}
      cartSummary={cartSummary}
      storeProfile={storeProfile}
      state={loaded.state}
    />
  );
}

export function MenuSearchPage({
  context,
  client,
  readOnlyNotice,
  cartSummary,
  storeProfile,
}: MenuPageProps) {
  const resolvedClient = useClient(context, client);
  const [draft, setDraft] = useState("");
  const [sectionDraft, setSectionDraft] = useState("");
  const [term, setTerm] = useState<string | null>(null);
  const [section, setSection] = useState<string | null>(null);
  const sectionInput = useMemo(() => ({}), []);
  const sections = useMenuLoad(resolvedClient, sectionInput);
  const input = useMemo(() => {
    if (term === null && section === null) return null;
    return {
      ...(term === null ? {} : { searchTerm: term }),
      ...(section === null ? {} : { sectionReference: section }),
    };
  }, [section, term]);
  const loaded = useMenuLoad(resolvedClient, input);
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const normalized = normalizeMenuSearch(draft);
    if (normalized !== null || sectionDraft !== "") {
      setTerm(normalized);
      setSection(sectionDraft || null);
    }
  };
  return (
    <MenuScreen
      context={context}
      headingRef={loaded.heading}
      mode="search"
      onRetry={loaded.retry}
      readOnlyNotice={readOnlyNotice}
      cartSummary={cartSummary}
      storeProfile={storeProfile}
      search={
        <section className="menu-search-view">
          <form className="menu-search" role="search" onSubmit={submit}>
            <label className="sr-only" htmlFor="menu-search-input">
              {t("Search the menu")}
            </label>
            <div className="menu-search-primary">
              <input
                id="menu-search-input"
                maxLength={100}
                placeholder={t("Search menu items")}
                value={draft}
                onChange={(event) => setDraft(event.currentTarget.value)}
              />
              <button
                type="submit"
                disabled={normalizeMenuSearch(draft) === null && sectionDraft === ""}
              >
                {t("Search")}
              </button>
              <button
                type="button"
                onClick={() => {
                  setDraft("");
                  setSectionDraft("");
                  setTerm(null);
                  setSection(null);
                }}
              >
                {t("Clear")}
              </button>
            </div>
            <div className="menu-search-section">
              <label htmlFor="menu-search-section">{t("Menu section")}</label>
              <select
                id="menu-search-section"
                value={sectionDraft}
                disabled={sections.state.kind !== "Found"}
                onChange={(event) => setSectionDraft(event.currentTarget.value)}
              >
                <option value="">{t("All sections")}</option>
                {sections.state.kind === "Found"
                  ? sections.state.menu.sections.map((item) => (
                      <option key={item.sectionReference} value={item.sectionReference}>
                        {item.name}
                      </option>
                    ))
                  : null}
              </select>
            </div>
            <p className="menu-search-boundary">
              {t(
                "Dietary tags are not provided by this menu. Availability is shown on each result; ask staff for dietary help.",
              )}
            </p>
          </form>
        </section>
      }
      searchTerm={term}
      state={loaded.state}
    />
  );
}

export function SellableDetailPage({
  context,
  client,
  readOnlyNotice,
  storeProfile,
}: MenuPageProps) {
  const resolvedClient = useClient(context, client);
  const input = useMemo(() => ({}), []);
  const loaded = useMenuLoad(resolvedClient, input);
  const { sellableId = "" } = useParams();
  let state = loaded.state;
  let sellable: MenuSellable | null = null;
  let family: MenuFamily | null = null;
  if (state.kind === "Found") {
    family = findMenuFamily(state.menu, sellableId);
    sellable =
      family?.variants.find((variant) => variant.sellable.sellableReference === sellableId)
        ?.sellable ?? null;
    if (sellable === null) state = { kind: "NotFound" };
  }
  return (
    <MenuScreen
      context={context}
      detail={sellable}
      detailFamily={family}
      headingRef={loaded.heading}
      mode="detail"
      onRetry={loaded.retry}
      onRefresh={loaded.refresh}
      readOnlyNotice={readOnlyNotice}
      storeProfile={storeProfile}
      state={state}
    />
  );
}

export interface MenuScreenProps {
  readonly context?: MenuJourneyContext | undefined;
  readonly detail?: MenuSellable | null | undefined;
  /** The sizes offered with the detail item; a single-size item when omitted. */
  readonly detailFamily?: MenuFamily | null | undefined;
  readonly headingRef?: React.RefObject<HTMLHeadingElement | null> | undefined;
  readonly mode: "browse" | "search" | "detail";
  readonly onRetry?: (() => void) | undefined;
  /** WP-2423 (cart-unsellable-dishes): re-read the menu in place after a refused add. */
  readonly onRefresh?: (() => void) | undefined;
  readonly readOnlyNotice?: React.ReactNode | undefined;
  readonly cartSummary?: CartSummaryLoader | undefined;
  readonly storeProfile?: StoreProfileLoader | null | undefined;
  /** WP-2423 item 8 ③ (decision 13): the table's rounds, for "already ordered" (tests inject). */
  readonly tableOrderedClient?: DiningSessionClient | undefined;
  readonly search?: React.ReactNode | undefined;
  readonly searchTerm?: string | null | undefined;
  readonly state: ScreenState;
}

export function MenuScreen({
  context,
  detail,
  detailFamily,
  headingRef,
  mode,
  onRetry,
  onRefresh,
  readOnlyNotice: givenReadOnlyNotice,
  cartSummary,
  storeProfile: givenStoreProfile,
  tableOrderedClient,
  search,
  searchTerm,
  state,
}: MenuScreenProps) {
  // The page title never changes when the menu arrives, so a long item name cannot wrap late and
  // push the page down; the item's own heading carries its name.
  const title = mode === "search" ? t("Search menu") : t("Menu");
  const browseFound = mode === "browse" && state.kind === "Found";
  // M116: a Store not taking orders now shows its menu to look at, with no cart and no adding.
  const closed = context?.closed;
  const readOnlyNotice =
    givenReadOnlyNotice ??
    (closed === undefined ? undefined : <ClosedStoreNotice closed={closed} />);
  // Its hours come from the entry answer: this phone may have no visit, or one at another Store.
  const storeProfile = closed === undefined ? givenStoreProfile : null;
  const withCart = context !== undefined && mode !== "detail" && closed === undefined;
  const justAdded = useBackOnMenu(browseFound);
  const [quickMessage, setQuickMessage] = useState<string | null>(null);
  const [cartReads, setCartReads] = useState(0);
  useEffect(() => {
    if (quickMessage === null) return;
    const timer = window.setTimeout(() => setQuickMessage(null), 3000);
    return () => window.clearTimeout(timer);
  }, [quickMessage]);
  const channel = context?.channel;
  // WP-2423 store-service-controls (v15 M34): read live, so a menu left open across last orders
  // or into a pause stops offering the one-tap add by itself (the dish page still explains).
  const service = useStoreService(
    context === undefined ? null : storeProfile === undefined ? browserStoreProfile : storeProfile,
  );
  const taking = takesNewOrders(service.phase);
  const quickAdd = useMemo(
    () =>
      channel === undefined || readOnlyNotice !== undefined || !taking
        ? null
        : {
            channel,
            onAdded: (message: string) => {
              setQuickMessage(message);
              setCartReads((value) => value + 1);
            },
          },
    [channel, readOnlyNotice, taking],
  );
  return (
    // WP-2423 item 8 ③ (decision 13): at a table, a dish the table already ordered says so.
    <TableOrderedProvider enabled={context?.channel === "DineIn"} client={tableOrderedClient}>
      <MenuQuickAdd.Provider value={quickAdd}>
        <CustomerPage
          step="menu"
          browseOnly={closed !== undefined}
          className={`customer-menu-screen customer-menu-screen--${mode}`}
          store={
            context
              ? {
                  storeName: context.storeDisplayName,
                  brandName: context.brandDisplayName,
                  serviceMode: context.channel,
                }
              : undefined
          }
        >
          <div className={`menu-layout${withCart ? " menu-layout--with-cart" : ""}`}>
            <div className="menu-layout__main">
              {closed !== undefined && mode !== "detail" ? (
                <div className="menu-readonly-boundary menu-closed-notice" role="status">
                  {readOnlyNotice}
                </div>
              ) : null}
              {mode === "browse" && context !== undefined ? (
                <StoreStatusStrip
                  load={storeProfile === undefined ? browserStoreProfile : storeProfile}
                />
              ) : null}
              {/* Follow-up: after last orders, said before the guest chooses anything. */}
              {mode !== "search" && context !== undefined ? (
                <OrdersStoppedNotice
                  load={storeProfile === undefined ? browserStoreProfile : storeProfile}
                  channel={context.channel === "Pickup" ? "Pickup" : "DineIn"}
                />
              ) : null}
              {mode === "detail" ? (
                <h2 className="sr-only">{title}</h2>
              ) : (
                <div className={`menu-page-intro menu-page-intro--${mode}`}>
                  {/* Figma v1: browsing shows the search field first; the journey bar already says
                  "Menu", so its heading is for assistive technology only. */}
                  {browseFound ? (
                    <h2 className="sr-only" ref={headingRef} tabIndex={-1}>
                      {title}
                    </h2>
                  ) : (
                    <h2 className={mode === "browse" ? "sr-only" : undefined}>{title}</h2>
                  )}
                  <nav className="menu-navigation" aria-label={t("Menu")}>
                    {mode === "search" ? (
                      <div className="menu-navigation__links menu-navigation__links--search">
                        <Link to="/menu">{t("← Back to menu")}</Link>
                      </div>
                    ) : (
                      <Link className="menu-navigation__search" to="/menu/search">
                        {t("Search menu")}
                      </Link>
                    )}
                  </nav>
                </div>
              )}
              {/* Above the menu from the start (also while it loads), so it never pushes the menu down. */}
              {mode === "search" &&
              state.kind !== "PermissionDenied" &&
              state.kind !== "MissingContext" ? (
                <AllergenHelp />
              ) : null}
              {mode === "browse" &&
              state.kind !== "PermissionDenied" &&
              state.kind !== "MissingContext" ? (
                <AllergenHelpLine />
              ) : null}
              {/* WP-2423 (M178): what the kitchen says about cross-contact. */}
              {mode !== "detail" &&
              context !== undefined &&
              state.kind !== "PermissionDenied" &&
              state.kind !== "MissingContext" ? (
                <KitchenStatementLine
                  load={storeProfile === undefined ? browserStoreProfile : storeProfile}
                />
              ) : null}
              {state.kind === "MissingContext" ? null : search}
              {state.kind === "Found" && mode === "search" ? (
                <section className="menu-search-summary" aria-label={t("Search results")}>
                  <h2>{t("Search results")}</h2>
                  {searchTerm ? (
                    <p>
                      {t("Matched term ·")} {searchTerm}
                    </p>
                  ) : null}
                </section>
              ) : null}
              <div className="menu-content" aria-live="polite" aria-busy={state.kind === "Loading"}>
                <MenuState
                  key={
                    context
                      ? `${context.publicStoreReference}:${context.channel}`
                      : "missing-context"
                  }
                  channel={context?.channel}
                  detail={detail}
                  detailFamily={detailFamily}
                  headingRef={headingRef}
                  mode={mode}
                  onRetry={onRetry}
                  onRefresh={onRefresh}
                  readOnlyNotice={readOnlyNotice}
                  state={state}
                />
              </div>
              {/* An item's page adds it under the loaded item, never under the short loading notice
              where the arriving item would push it down. */}
              {mode === "detail" &&
              state.kind !== "PermissionDenied" &&
              state.kind !== "Loading" ? (
                <AllergenHelp />
              ) : null}
              {/* WP-2423 item 8 ③ (decision 16): the Store's hours, holidays, address and phone,
                once the menu has loaded or failed (when its phone matters most), never above a
                loading menu that would then push it down. */}
              {mode === "browse" && context !== undefined && state.kind !== "Loading" ? (
                <StoreInfoSection
                  load={storeProfile === undefined ? browserStoreProfile : storeProfile}
                />
              ) : null}
            </div>
            {justAdded || quickMessage !== null ? (
              <p className="menu-added-toast" role="status">
                {quickMessage ?? t("Added to your cart.")}
              </p>
            ) : null}
            {withCart ? (
              <MenuCart
                reads={cartReads}
                load={cartSummary ?? browserCartSummary}
                menu={state.kind === "Found" && mode === "browse" ? state.menu : null}
              />
            ) : null}
          </div>
        </CustomerPage>
      </MenuQuickAdd.Provider>
    </TableOrderedProvider>
  );
}

/**
 * U6: the cart is one tap away from anywhere on the menu. Wide screens keep an order summary beside
 * the menu; phones get a bar along the bottom once something is in the cart. Nothing is shown until
 * the Store's cart has been read, and nothing at all if it can't be.
 */
function MenuCart({
  load,
  menu,
  reads = 0,
}: {
  readonly load: CartSummaryLoader;
  /** Counts dishes added from the list: each one reads the cart again. */
  readonly reads?: number;
  /** The published menu shown, so lines the Store hasn't priced yet use the prices shown here. */
  readonly menu: MenuView | null;
}) {
  const [cart, setCart] = useState<{ readonly view: CartView | null } | null>(null);
  useEffect(() => {
    let active = true;
    load()
      .then((view) => {
        if (active) setCart({ view });
      })
      .catch(() => {
        if (active) setCart(null);
      });
    return () => {
      active = false;
    };
  }, [load, reads]);
  if (cart === null) return null;
  const summary = summarizeCart(cart.view, menu);
  const items = summary.count === 1 ? t("1 item") : t("{count} items", { count: summary.count });
  return (
    <>
      <aside className="menu-cart-panel" aria-labelledby="menu-cart-heading">
        <h2 id="menu-cart-heading">{t("Your order")}</h2>
        {summary.count === 0 ? (
          <p className="menu-cart-panel__empty">
            {t("Your cart is empty. Choose an item to start.")}
          </p>
        ) : (
          <>
            <dl className="menu-cart-panel__facts">
              <div>
                <dt>{t("Items")}</dt>
                <dd>{summary.count}</dd>
              </div>
              {summary.subtotal === null ? null : (
                <div>
                  <dt>{t("Subtotal before tax")}</dt>
                  <dd>{summary.subtotal}</dd>
                </div>
              )}
            </dl>
            <p className="menu-cart-panel__note">
              {summary.subtotal === null
                ? t("Some items are priced at checkout, with tax.")
                : t("Tax is added at checkout.")}
            </p>
            <Link className="menu-cart-panel__link" to="/cart">
              {t("View cart")}
            </Link>
          </>
        )}
      </aside>
      {summary.count === 0 ? null : (
        <div className="menu-cart-bar">
          {/* Figma v1: what is in the cart on the left, one black action on the right. */}
          <p className="menu-cart-bar__summary">
            <span className="menu-cart-bar__count">{items}</span>
            {summary.subtotal === null ? null : (
              <span className="menu-cart-bar__total">
                {t("{amount} before tax", { amount: summary.subtotal })}
              </span>
            )}
          </p>
          <Link className="menu-cart-bar__link" to="/cart">
            {t("View cart")}
          </Link>
        </div>
      )}
    </>
  );
}

function Heading({
  children,
  headingRef,
}: {
  readonly children: React.ReactNode;
  readonly headingRef?: React.RefObject<HTMLHeadingElement | null> | undefined;
}) {
  return (
    <h2 ref={headingRef} tabIndex={-1}>
      {children}
    </h2>
  );
}

function Retry({ onRetry }: { readonly onRetry?: (() => void) | undefined }) {
  return onRetry ? (
    <button className="menu-action" type="button" onClick={onRetry}>
      {t("Try again")}
    </button>
  ) : null;
}

function MenuState({
  channel,
  detail,
  detailFamily,
  headingRef,
  mode,
  onRetry,
  onRefresh,
  readOnlyNotice,
  state,
}: Omit<MenuScreenProps, "context" | "search" | "searchTerm"> & {
  readonly channel?: MenuJourneyContext["channel"] | undefined;
}) {
  if (state.kind === "MissingContext")
    return (
      <section className="menu-state" role="alert">
        <Heading headingRef={headingRef}>{t("Scan the location QR code")}</Heading>
        <p>
          {t(
            "We don’t know which location you’re ordering from. Scan the QR code again to open the menu.",
          )}
        </p>
        <Link className="menu-action" to="/">
          {t("Return to entry")}
        </Link>
      </section>
    );
  if (state.kind === "IdleSearch")
    return (
      <section className="menu-state menu-state--idle-search" role="status">
        <Heading headingRef={headingRef}>{t("Search this menu")}</Heading>
        <p>{t("Type an item name to find it on today’s menu.")}</p>
      </section>
    );
  if (state.kind === "Loading")
    return (
      <section className="menu-state menu-state--loading" role="status">
        <Heading headingRef={headingRef}>{t("Loading the current menu")}</Heading>
        <p>{t("Checking the latest published items…")}</p>
        <MenuSkeleton detail={mode === "detail"} />
      </section>
    );
  if (state.kind === "PermissionDenied")
    return (
      <section
        className="menu-state menu-state--warning menu-state--permission-denied"
        role="alert"
      >
        <Heading headingRef={headingRef}>{t("This menu can’t be opened")}</Heading>
        <p>
          {t(
            "Your current session can’t access this menu. Scan the location QR code again or ask staff for help.",
          )}
        </p>
        <Link className="menu-action" to="/">
          {t("Return to entry")}
        </Link>
      </section>
    );
  if (state.kind === "Offline")
    return (
      <section className="menu-state menu-state--warning" role="alert">
        <Heading headingRef={headingRef}>{t("You’re offline")}</Heading>
        <p>
          {t(
            "The menu can’t open without a connection. It opens again by itself when you’re back online. Nothing was ordered.",
          )}
        </p>
        <Retry onRetry={onRetry} />
      </section>
    );
  if (state.kind === "Stale")
    return (
      <section className="menu-state menu-state--warning" role="alert">
        <Heading headingRef={headingRef}>{t("Menu is being refreshed")}</Heading>
        <p>{t("We won’t show an out-of-date menu. Try again shortly.")}</p>
        <Retry onRetry={onRetry} />
      </section>
    );
  if (state.kind === "Unavailable")
    return (
      <section className="menu-state menu-state--error" role="alert">
        <Heading headingRef={headingRef}>{t("Menu is unavailable")}</Heading>
        <p>{t("No item or order was submitted. Try again or ask staff for help.")}</p>
        <Retry onRetry={onRetry} />
      </section>
    );
  if (state.kind === "NotFound")
    return (
      <section className="menu-state" role="status">
        <Heading headingRef={headingRef}>
          {mode === "detail" ? t("Item not found") : t("No menu found")}
        </Heading>
        <p>
          {mode === "detail"
            ? t("This item is not in the current published menu.")
            : t("There are no matching published items right now.")}
        </p>
        <Link className="menu-action" to="/menu">
          {t("Browse menu")}
        </Link>
      </section>
    );
  if (detail)
    return (
      <SellableDetail
        channel={channel}
        family={detailFamily ?? singleFamily(detail)}
        sellable={detail}
        headingRef={headingRef}
        readOnlyNotice={readOnlyNotice}
        onRefresh={onRefresh}
      />
    );
  return <MenuContents menu={state.menu} headingRef={headingRef} mode={mode} />;
}

function singleFamily(sellable: MenuSellable): MenuFamily {
  return {
    key: sellable.sellableReference,
    name: sellable.name,
    variants: [{ label: sellable.name, sellable }],
  };
}

/** Grey placeholder blocks in the shape of the content, so the page doesn't jump when it arrives. */
function MenuSkeleton({ detail }: { readonly detail: boolean }) {
  return (
    <div className={`menu-skeleton${detail ? " menu-skeleton--detail" : ""}`} aria-hidden="true">
      {(detail ? [0] : [0, 1, 2, 3]).map((index) => (
        <span className="menu-skeleton__card" key={index}>
          <span />
          <span />
          <span />
        </span>
      ))}
    </div>
  );
}

function sectionAnchor(sectionReference: string): string {
  return `section-${sectionReference}`;
}

/**
 * The section bar stays at the top while the guest scrolls and marks the section in view, so the
 * menu reads like a store's printed board: always clear where you are and one tap to elsewhere.
 */
function SectionTabs({ sections }: { readonly sections: MenuView["sections"] }) {
  const [active, setActive] = useState(sections[0]?.sectionReference ?? "");
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const visible = new Map<string, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const reference = entry.target.getAttribute("data-section") ?? "";
          if (entry.isIntersecting) visible.set(reference, entry.boundingClientRect.top);
          else visible.delete(reference);
        }
        const first = sections.find((section) => visible.has(section.sectionReference));
        if (first) setActive(first.sectionReference);
      },
      { rootMargin: "-96px 0px -55% 0px" },
    );
    for (const section of sections) {
      const element = document.getElementById(
        sectionAnchor(section.sectionReference),
      )?.parentElement;
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [sections]);
  if (sections.length < 2) return null;
  return (
    <nav className="menu-sections" aria-label={t("Menu sections")}>
      {sections.map((section) => (
        <a
          key={section.sectionReference}
          href={`#${sectionAnchor(section.sectionReference)}`}
          aria-current={active === section.sectionReference ? "true" : undefined}
          onClick={() => setActive(section.sectionReference)}
        >
          {section.name}
        </a>
      ))}
    </nav>
  );
}

function MenuContents({
  menu,
  mode,
}: {
  readonly menu: MenuView;
  readonly headingRef?: React.RefObject<HTMLHeadingElement | null> | undefined;
  readonly mode: MenuScreenProps["mode"];
}) {
  const count = menu.sections.reduce((total, section) => total + section.sellables.length, 0);
  if (count === 0)
    return (
      <section className="menu-state menu-state--empty">
        <h2>{t("No items available")}</h2>
        <p>{t("The current published menu has no matching items.")}</p>
      </section>
    );
  return (
    <>
      {mode === "browse" ? <SectionTabs sections={menu.sections} /> : null}
      {menu.sections.map((section) => (
        <section
          className="menu-section"
          key={section.sectionReference}
          data-section={section.sectionReference}
          aria-label={
            mode === "search" ? t("Results in {name}", { name: section.name }) : undefined
          }
          aria-labelledby={mode === "browse" ? sectionAnchor(section.sectionReference) : undefined}
        >
          {mode === "browse" ? (
            <h3 id={sectionAnchor(section.sectionReference)}>{section.name}</h3>
          ) : null}
          <div className="menu-grid">
            {groupMenuFamilies(section.sellables).map((family) => (
              <MenuItemCard
                key={family.key}
                family={family}
                {...(mode === "search" ? { sectionName: section.name } : {})}
              />
            ))}
          </div>
        </section>
      ))}
    </>
  );
}

/** Where the guest was on the menu when they opened a dish, for coming back to the same place. */
let menuScrollWhenLeft: number | null = null;

/** Owner 2026-11-03 walkthrough: back on the menu after adding a dish, where the guest left it. */
function useBackOnMenu(found: boolean): boolean {
  const location = useLocation();
  const navigate = useNavigate();
  const added = (location.state as { readonly added?: unknown } | null)?.added === true;
  useLayoutEffect(() => {
    if (!found || menuScrollWhenLeft === null) return;
    window.scrollTo(0, menuScrollWhenLeft);
    menuScrollWhenLeft = null;
  }, [found]);
  useEffect(() => {
    if (!added) return;
    const timer = window.setTimeout(
      () => void navigate(location.pathname, { replace: true, state: null }),
      3000,
    );
    return () => window.clearTimeout(timer);
  }, [added, location.pathname, navigate]);
  return added;
}

/**
 * Owner 2026-11-03 walkthrough: a dish with nothing to choose goes on the order with one tap from
 * the list. Anything else, or a guest who can't order yet, opens the dish's page, which says why.
 */
const MenuQuickAdd = createContext<{
  readonly channel: MenuJourneyContext["channel"];
  readonly onAdded: (message: string) => void;
} | null>(null);

export function quickAddable(family: MenuFamily): boolean {
  const { sellable } = primaryVariant(family);
  return (
    family.variants.length === 1 &&
    sellable.optionRules.length === 0 &&
    sellable.availability === "Available" &&
    // WP-2423 DEC-ALCOHOL: a guest reads the age notice on the dish before adding it.
    sellable.alcohol === undefined
  );
}

function QuickAddButton({ family }: { readonly family: MenuFamily }) {
  const quick = useContext(MenuQuickAdd);
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  if (quick === null || !quickAddable(family)) return null;
  const { sellable } = primaryVariant(family);
  const add = async () => {
    if (busy) return;
    setBusy(true);
    const controller = createConfigureController({
      client:
        quick.channel === "Pickup"
          ? createBrowserPickupCartClient()
          : createBrowserCustomerCartClient(),
    });
    await controller.submit(
      sellable.sellableReference,
      Object.freeze({ quantity: 1, optionSelections: [], customerNote: null }),
    );
    const state = controller.getState();
    setBusy(false);
    if (state.status === "added")
      quick.onAdded(
        state.earlierCartCleared === true
          ? t("Added to your cart.") +
              " " +
              t(
                "Your table's earlier cart timed out, so items that hadn't been ordered were cleared. Orders already placed are not affected.",
              )
          : t("Added to your cart."),
      );
    else if (state.status === "outcome-unknown")
      quick.onAdded(t("We couldn't confirm that. Check your cart before adding it again."));
    else if (state.status === "offline") quick.onAdded(t("You’re offline. Nothing was added."));
    else {
      menuScrollWhenLeft = window.scrollY;
      void navigate(`/menu/items/${sellable.sellableReference}`);
    }
  };
  return (
    <button
      type="button"
      className="menu-card__quick-add"
      aria-label={t("Add {name} to your cart", { name: family.name })}
      aria-busy={busy}
      disabled={busy}
      onClick={() => void add()}
    >
      +
    </button>
  );
}

function MenuItemCard({
  family,
  sectionName,
}: {
  readonly family: MenuFamily;
  readonly sectionName?: string | undefined;
}) {
  const soldOut = familySoldOut(family);
  const [photo, photoFailed] = useShownPhoto(familyPhoto(family));
  const opens = primaryVariant(family).sellable;
  const description = familyDescription(family);
  const allergens = compactAllergenLine(familyAllergens(family));
  const price = familyPriceText(family);
  const role = opens.presentationRole;
  const alreadyOrdered = useTableOrderedCount(
    family.variants.map((variant) => variant.sellable.sellableReference),
  );
  return (
    <article
      className={`menu-card${soldOut ? " menu-card--sold-out" : ""}${photo === null ? "" : " menu-card--with-photo"}`}
    >
      <Link
        aria-label={t("View {name}", { name: family.name })}
        className="menu-card__link"
        to={`/menu/items/${opens.sellableReference}`}
        onClick={() => {
          menuScrollWhenLeft = window.scrollY;
        }}
      >
        <span className="menu-card__body">
          <span className="menu-card__title">
            <h4>{family.name}</h4>
            {role !== "Standard" ? (
              <span className="menu-badge">
                {role === "Sponsored"
                  ? t("Sponsored")
                  : role === "Promotional"
                    ? t("Promotion")
                    : t("Featured")}
              </span>
            ) : null}
            {primaryVariant(family).sellable.alcohol === undefined ? null : (
              <span className="menu-badge">{t("Alcohol 19+")}</span>
            )}
          </span>
          {description === null ? null : (
            <span className="menu-card__description">{description}</span>
          )}
          {family.variants.length > 1 ? (
            <span className="menu-card__sizes">
              {family.variants.map((variant) => variant.label).join(" · ")}
            </span>
          ) : null}
          {sectionName ? (
            <span className="menu-result-section">
              <span>{t("Section")}</span>
              {sectionName}
            </span>
          ) : null}
          <span className="menu-card__aside">
            <span
              className={`menu-card__price${price === null ? " menu-card__price--pending" : ""}`}
            >
              {price ?? t("Priced at checkout")}
            </span>
            {soldOut ? (
              <span className="menu-sold-out">
                {primaryVariant(family).sellable.alcohol === "OutsideHours"
                  ? t("Served 9 am to 2 am")
                  : t("Sold out")}
              </span>
            ) : primaryVariant(family).sellable.alcohol === "LastCall" ? (
              <span className="menu-sold-out">{t("Last call · until 2:00")}</span>
            ) : null}
          </span>
          {alreadyOrdered > 0 ? (
            <span className="menu-card__table-ordered">
              {t("Your table ordered {count}", { count: alreadyOrdered })}
            </span>
          ) : null}
          {allergens === null ? null : <span className="menu-card__allergens">{allergens}</span>}
        </span>
        {photo === null ? null : (
          <MenuPhotoPicture
            className="menu-card__media"
            decorative
            onError={photoFailed}
            photo={photo}
            sizes="88px"
            widths={[320, 640]}
          />
        )}
      </Link>
      <QuickAddButton family={family} />
    </article>
  );
}

function srcSet(photo: MenuPhoto, contentType: string, widths: readonly number[]): string {
  return photo.renditions
    .filter((item) => item.contentType === contentType && widths.includes(item.width))
    .map((item) => `${item.url} ${item.width}w`)
    .join(listSeparator());
}

/**
 * The photo to show, or null when there is none, it has no JPEG fallback, or it failed to load.
 * A failed photo is dropped with its layout (no empty box, no broken-image icon); a menu reload
 * brings new photo objects and so tries again.
 */
function useShownPhoto(photo: MenuPhoto | null): readonly [MenuPhoto | null, () => void] {
  const [failed, setFailed] = useState<MenuPhoto | null>(null);
  const shown =
    photo !== null &&
    photo !== failed &&
    photo.renditions.some((item) => item.contentType === "image/jpeg")
      ? photo
      : null;
  return [shown, () => setFailed(photo)];
}

/** The published product photo in a fixed aspect-ratio box, so nothing shifts while it loads. */
function MenuPhotoPicture({
  photo,
  className,
  sizes,
  widths,
  onError,
  decorative = false,
  priority = false,
}: {
  readonly photo: MenuPhoto;
  readonly className: string;
  readonly sizes: string;
  readonly widths: readonly number[];
  readonly onError: () => void;
  readonly decorative?: boolean;
  readonly priority?: boolean;
}) {
  const jpegs = photo.renditions.filter(
    (item) => item.contentType === "image/jpeg" && widths.includes(item.width),
  );
  const fallback = jpegs[0] ?? photo.renditions.find((item) => item.contentType === "image/jpeg");
  if (fallback === undefined) return null;
  const webp = srcSet(photo, "image/webp", widths);
  const jpeg = srcSet(photo, "image/jpeg", widths);
  return (
    <span className={className} {...(decorative ? { "aria-hidden": true } : {})}>
      <picture>
        {webp === "" ? null : <source type="image/webp" srcSet={webp} sizes={sizes} />}
        <img
          alt={decorative ? "" : photo.altText}
          decoding="async"
          height={photo.height}
          loading={priority ? "eager" : "lazy"}
          sizes={sizes}
          src={fallback.url}
          srcSet={jpeg === "" ? undefined : jpeg}
          width={photo.width}
          onError={onError}
          {...(priority ? { fetchPriority: "high" as const } : {})}
        />
      </picture>
    </span>
  );
}

/** WP-2423 8.6: the size's own base price; options and tax are added in the final quote. */
function priceLine(sellable: MenuSellable): string {
  if (sellable.price === null) return t("Priced at checkout");
  // Decimal text from the server; never converted to a binary number.
  return (
    formatDecimalMoney(sellable.price.amount, sellable.price.currency) ?? t("Priced at checkout")
  );
}

function SellableDetail({
  channel,
  family,
  sellable,
  headingRef,
  readOnlyNotice,
  onRefresh,
}: {
  readonly channel?: MenuJourneyContext["channel"] | undefined;
  readonly family: MenuFamily;
  readonly sellable: MenuSellable;
  readonly headingRef?: React.RefObject<HTMLHeadingElement | null> | undefined;
  readonly readOnlyNotice?: React.ReactNode | undefined;
  readonly onRefresh?: (() => void) | undefined;
}) {
  const [photo, photoFailed] = useShownPhoto(sellable.photo ?? familyPhoto(family));
  const sized = family.variants.length > 1;
  const description = sellable.description ?? familyDescription(family);
  return (
    <article className={`sellable-detail${photo === null ? "" : " sellable-detail--with-photo"}`}>
      <Link className="sellable-detail__back" to="/menu">
        {t("← Back to menu")}
      </Link>
      {photo === null ? null : (
        <MenuPhotoPicture
          className="sellable-detail__media"
          onError={photoFailed}
          photo={photo}
          priority
          sizes="(min-width: 960px) 45vw, (min-width: 736px) 640px, calc(100vw - 64px)"
          widths={[640, 1280]}
        />
      )}
      <div className="sellable-detail__content">
        <div className="sellable-detail__heading">
          <Heading headingRef={headingRef}>{family.name}</Heading>
          <p className="sellable-detail__price">
            {sized ? (
              <span className="sellable-detail__size">{currentLabel(family, sellable)} · </span>
            ) : null}
            {priceLine(sellable)}
            {sellable.price === null ? null : <span> {t("plus tax")}</span>}
          </p>
        </div>
        {description === null ? null : (
          <p className="sellable-detail__description">{description}</p>
        )}
        {sellable.alcohol === undefined ? null : (
          <p className="sellable-detail__description" role="note">
            {t(
              "This contains alcohol. You must be 19 or older to order it, and staff may ask for ID when they serve it.",
            )}
          </p>
        )}
        {sellable.alcohol === "OutsideHours" ? (
          <p className="menu-sold-out">{t("Alcohol is served from 9 am to 2 am.")}</p>
        ) : sellable.alcohol === "LastCall" ? (
          // WP-2423 (M93, Owner decision 18): 30 minutes before the cutoff.
          <p className="menu-sold-out" role="note">
            {t("Last call for alcohol: orders close at 2:00.")}
          </p>
        ) : sellable.availability === "SoldOut" ? (
          <p className="menu-sold-out">{sized ? t("This size is sold out") : t("Sold out")}</p>
        ) : null}
        <AllergenSummary sellable={sellable} />
        {readOnlyNotice ? (
          <div className="menu-readonly-boundary" role="status">
            {readOnlyNotice}
          </div>
        ) : sellable.alcohol === "OutsideHours" ? null : sellable.availability === "SoldOut" &&
          !sized ? (
          <p role="status">{t("Sold out at this store right now. Please choose another item.")}</p>
        ) : (
          <SellableConfigurator
            channel={channel}
            key={family.key}
            sellable={sellable}
            variants={family.variants}
            onRefresh={onRefresh}
          />
        )}
      </div>
    </article>
  );
}

function currentLabel(family: MenuFamily, sellable: MenuSellable): string {
  return (
    family.variants.find(
      (variant) => variant.sellable.sellableReference === sellable.sellableReference,
    )?.label ?? sellable.name
  );
}

function configurationIssues(
  sellable: MenuSellable,
  selected: ReadonlyMap<string, number>,
  quantity: number,
  note: string,
): readonly string[] {
  const issues: string[] = [];
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100)
    issues.push(t("Quantity must be between 1 and 100."));
  const activeRules = activeMenuOptionRules(sellable.optionRules, selected);
  const activeReferences = new Set(
    activeRules.flatMap((rule) => rule.options.map((option) => option.optionReference)),
  );
  activeRules.forEach((rule, index) => {
    const count = rule.options.reduce(
      (total, option) => total + (selected.get(option.optionReference) ?? 0),
      0,
    );
    // A combo part still to choose in is named on the button instead (not an error yet).
    if (count < rule.minimumSelections && rule.comboPart !== true)
      issues.push(
        t("{value1} requires at least {minimumSelections}.", {
          value1: rule.name ?? t("Choice group {value1}", { value1: index + 1 }),
          minimumSelections: rule.minimumSelections,
        }),
      );
    if (count > rule.maximumSelections)
      issues.push(
        t("{value1} allows at most {maximumSelections}.", {
          value1: rule.name ?? t("Choice group {value1}", { value1: index + 1 }),
          maximumSelections: rule.maximumSelections,
        }),
      );
    rule.options.forEach((option) => {
      const optionQuantity = selected.get(option.optionReference) ?? 0;
      if (
        selected.has(option.optionReference) &&
        (!Number.isSafeInteger(optionQuantity) || optionQuantity < 1)
      )
        issues.push(t("Selected option quantities must be positive whole numbers."));
      if (optionQuantity > Math.min(option.maximumQuantity, 100))
        issues.push(
          t("{name} allows at most {value1}.", {
            name: option.name,
            value1: Math.min(option.maximumQuantity, 100),
          }),
        );
      if (
        optionQuantity > 0 &&
        option.conflictOptionReferences.some(
          (reference) => activeReferences.has(reference) && (selected.get(reference) ?? 0) > 0,
        )
      )
        issues.push(t("{name} conflicts with another selected choice.", { name: option.name }));
      // WP-2423 (cart-unsellable-dishes): chosen before it was turned off.
      if (optionQuantity > 0 && option.offeredNow === false)
        issues.push(
          t("{option} isn't available right now. Please choose another.", { option: option.name }),
        );
    });
  });
  if (note !== note.normalize("NFC") || note.length > 500)
    issues.push(t("Preparation note must be 500 characters or fewer."));
  if (/\b(?:allerg(?:y|ic|ies)|anaphyla\w*|medical|medication|celiac|intoleran\w*)\b/iu.test(note))
    issues.push(t("Do not put allergy or medical information in the preparation note; ask staff."));
  return Object.freeze(issues);
}

export function ConfigureStatus({
  state,
  controller,
}: {
  readonly state: ConfigureState;
  readonly controller: ConfigureController;
}) {
  if (state.status === "idle") return null;
  if (state.status === "pending")
    return (
      <p className="configure-status" role="status">
        {state.stage === "locate"
          ? t("Checking your current cart…")
          : state.stage === "create"
            ? t("Starting your cart…")
            : t("Adding the item…")}
      </p>
    );
  if (state.status === "added")
    return (
      <div className="configure-status configure-status--success" role="status">
        <p>{t("Added to your cart.")}</p>
        {state.earlierCartCleared === true ? (
          <p>
            {t(
              "Your table's earlier cart timed out, so items that hadn't been ordered were cleared. Orders already placed are not affected.",
            )}
          </p>
        ) : null}
        <Link className="menu-action" to="/cart">
          {t("View cart")}
        </Link>
        <Link to="/menu">{t("Keep browsing")}</Link>
      </div>
    );
  const copy = {
    offline: t("You’re offline. Nothing was queued or replayed."),
    "session-expired": t("Your Store session expired. Scan the location QR code again."),
    conflict: t("Your cart changed. Review the current cart before trying again."),
    validation: t("This item can’t be ordered as selected. Review your choices."),
    "rate-limited":
      "retryAfterSeconds" in state && state.retryAfterSeconds !== null
        ? t("Please wait {seconds} seconds before trying again.", {
            seconds: state.retryAfterSeconds,
          })
        : t("Please wait before trying again."),
    expired: t(
      "Your table’s cart timed out and a new one couldn’t be started just now. Wait a moment, then add the item again.",
    ),
    abandoned: t("This cart is closed and cannot accept another item."),
    "order-processing": orderProcessingMessage(
      "retryAfterSeconds" in state ? state.retryAfterSeconds : null,
    ),
    "checkout-in-progress": checkoutInProgressMessage(
      "retryAfterSeconds" in state ? state.retryAfterSeconds : null,
    ),
    "table-checking-out": t(
      "Your table is checking out, so new dishes can’t be sent. To add more, ask a staff member.",
    ),
    "not-seated": t("You can order once staff seat you. Ask a staff member, then scan again."),
    "participation-ended": participationEndedText().join(" "),
    "table-start-refused": t(
      "This table can’t be started just now. Pick another table or ask staff. Your choices are kept here.",
    ),
    "table-in-use": t(
      "People have just sat down at this table. If you’re with them, go back and join them. Your choices are kept here.",
    ),
    "table-question": t("First tell us if you’re with the people at this table."),
    unavailable: t("We couldn’t add this right now. Please try again."),
    "outcome-unknown": t("The connection dropped before we could confirm. Retry to check."),
  } as const;
  // WP-2423 (M154): a refusal that says exactly what happened is the headline; the general
  // sentence is left out. A dish that can't be had offers the way back to the menu.
  const issueCodes = "issueCodes" in state ? state.issueCodes : [];
  const specific = issueCodes.some((code) => specificCartIssues.includes(code));
  const backToMenu = issueCodes.some(
    (code) => code === "CATALOG_ITEM_UNAVAILABLE" || code === "CATALOG_ITEM_SOLD_OUT",
  );
  return (
    <div className="configure-status configure-status--error" role="alert">
      {state.status === "validation" && specific ? null : <p>{copy[state.status]}</p>}
      {issueCodes
        .map(cartIssueMessage)
        .filter((issue): issue is string => issue !== null)
        .map((issue) => (
          <p key={issue}>{issue}</p>
        ))}
      {state.status === "validation" && backToMenu ? (
        <Link to="/menu">{t("Back to menu")}</Link>
      ) : null}
      {state.canRetry ? (
        <button
          type="button"
          disabled={state.status === "offline"}
          onClick={() => void controller.retry()}
        >
          {t("Retry the same operation")}
        </button>
      ) : null}
      {state.status === "conflict" ? <Link to="/cart">{t("Review cart")}</Link> : null}
      {state.status === "session-expired" ? <Link to="/">{t("Return to entry")}</Link> : null}
      {state.status === "participation-ended" ? (
        <Link to="/dine-in/session">{t("Your table")}</Link>
      ) : null}
      {state.status === "table-question" ? <Link to="/">{t("Back to the question")}</Link> : null}
      {state.status === "table-in-use" ? <Link to="/">{t("Back to this table")}</Link> : null}
    </div>
  );
}

/**
 * The guest's choices carried to another size: anything the new size also offers stays chosen;
 * groups the new size changes start from its own defaults.
 */
function carryOverSelections(
  selected: ReadonlyMap<string, number>,
  rules: readonly MenuOptionRule[],
): ReadonlyMap<string, number> {
  const next = new Map<string, number>();
  for (const rule of rules) {
    const offered = rule.options.filter((option) => option.offeredNow !== false);
    const kept = offered.filter((option) => selected.has(option.optionReference));
    const options = kept.length > 0 ? kept : offered.filter((option) => option.selectedByDefault);
    for (const option of options)
      next.set(
        option.optionReference,
        kept.length > 0
          ? Math.min(selected.get(option.optionReference) ?? 1, option.maximumQuantity)
          : (option.defaultQuantity ?? 1),
      );
  }
  return next;
}

export function SellableConfigurator({
  channel,
  sellable,
  variants,
  controller: provided,
  onRefresh,
}: {
  readonly channel?: MenuJourneyContext["channel"] | undefined;
  readonly sellable: MenuSellable;
  /** The sizes to choose between; the size is the sellable added. */
  readonly variants?: readonly MenuVariant[] | undefined;
  readonly controller?: ConfigureController | undefined;
  /** WP-2423 (cart-unsellable-dishes): re-read the menu in place after a refused add. */
  readonly onRefresh?: (() => void) | undefined;
}) {
  const navigate = useNavigate();
  const [controller] = useState(
    () =>
      provided ??
      createConfigureController({
        client:
          channel === "Pickup"
            ? createBrowserPickupCartClient()
            : createBrowserCustomerCartClient(),
      }),
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getState,
    controller.getState,
  );
  const [quantity, setQuantity] = useState(1);
  const [note, setNote] = useState("");
  const alreadyOrdered = useTableOrderedCount(
    (variants ?? []).length > 0
      ? (variants ?? []).map((variant) => variant.sellable.sellableReference)
      : [sellable.sellableReference],
  );
  const [selected, setSelected] = useState<ReadonlyMap<string, number>>(() =>
    defaultMenuOptionSelections(sellable.optionRules),
  );
  // A different size keeps the quantity, the note and every choice the new size also offers.
  const [selectionsFor, setSelectionsFor] = useState(sellable.sellableReference);
  let current = selected;
  if (selectionsFor !== sellable.sellableReference) {
    current = carryOverSelections(selected, sellable.optionRules);
    setSelectionsFor(sellable.sellableReference);
    setSelected(current);
  }
  const activeRules = activeMenuOptionRules(sellable.optionRules, current);
  const issues = configurationIssues(sellable, current, quantity, note);
  const busy = state.status === "pending";
  const unresolved = state.status === "outcome-unknown" || state.status === "offline";
  const locked = busy || unresolved || state.status === "added";
  // WP-2423 (cart-unsellable-dishes): a required choice group with nothing offered right now.
  const notNow = requiredGroupNotOffered(sellable.optionRules);
  const soldOut = sellable.availability === "SoldOut" || notNow;
  const total =
    issues.length === 0 ? configuredItemTotal(sellable, activeRules, current, quantity) : null;
  useEffect(() => {
    const offline = () => controller.setOnline(false);
    const online = () => controller.setOnline(true);
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    return () => {
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
    };
  }, [controller]);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (issues.length > 0 || locked || soldOut || missingComboPart(sellable, current) !== null)
      return;
    const draft: CartItemDraft = Object.freeze({
      quantity,
      optionSelections: selectedMenuOptions(sellable.optionRules, current),
      customerNote: note.trim() === "" ? null : note.normalize("NFC").trim(),
    });
    void controller.submit(sellable.sellableReference, draft);
  };
  // WP-2423 (cart-unsellable-dishes): the add was refused because a choice or the dish is not
  // offered now: read the menu again once per refusal, so the page shows what can be chosen.
  // Keyed on the refusal itself, so a re-render (a new menu, a new callback) never reads again.
  const refreshedFor = useRef<typeof state | null>(null);
  useEffect(() => {
    if (
      state.status === "validation" &&
      refreshedFor.current !== state &&
      state.issueCodes.some((code) => specificCartIssues.includes(code))
    ) {
      refreshedFor.current = state;
      onRefresh?.();
    }
  }, [state, onRefresh]);
  // Owner 2026-11-03 walkthrough: added, the guest goes on choosing. A cart that was cleared has
  // something to say, so that one stays.
  useEffect(() => {
    if (state.status === "added" && state.earlierCartCleared !== true)
      void navigate("/menu", { state: { added: true } });
  }, [state, navigate]);
  const sizes = variants !== undefined && variants.length > 1 ? variants : null;
  return (
    <form className="sellable-configurator" aria-labelledby="configure-heading" onSubmit={submit}>
      <h3 id="configure-heading" className="sr-only">
        {sellable.optionRules.length === 0 && sizes === null
          ? t("Add to your order")
          : t("Make it yours")}
      </h3>
      {sizes === null ? null : (
        <fieldset className="configure-group">
          <legend>
            <span className="configure-group__name">{t("Size")}</span>
            <span className="configure-group__rule">{t("Required")}</span>
          </legend>
          {sizes.map((variant) => {
            const variantSoldOut = variant.sellable.availability === "SoldOut";
            return (
              <label className="configure-option" key={variant.sellable.sellableReference}>
                <input
                  type="radio"
                  name="configure-size"
                  checked={variant.sellable.sellableReference === sellable.sellableReference}
                  disabled={locked || (variantSoldOut && variant.sellable !== sellable)}
                  onChange={() =>
                    navigate(`/menu/items/${variant.sellable.sellableReference}`, {
                      replace: true,
                    })
                  }
                />
                <span className="configure-option__name">{variant.label}</span>
                <span className="configure-option__price">
                  {variantSoldOut ? t("Sold out") : priceLine(variant.sellable)}
                </span>
              </label>
            );
          })}
        </fieldset>
      )}
      {activeRules.map((rule, groupIndex) => (
        <fieldset
          className="configure-group"
          key={`${rule.minimumSelections}-${rule.maximumSelections}-${groupIndex}`}
        >
          <legend>
            <span className="configure-group__name">
              {rule.name ?? t("Choice group {value1}", { value1: groupIndex + 1 })}
            </span>
            <span className="configure-group__rule">{choiceText(rule)}</span>
            {((left) =>
              // WP-2423 (M22, M24): a required group down to its last choice today says so.
              rule.minimumSelections > 0 &&
              left.length === 1 &&
              rule.options.some((option) => option.soldOut === true) ? (
                <span className="configure-group__rule">
                  {t("Only {name} is left today", { name: left[0]?.name ?? "" })}
                </span>
              ) : null)(rule.options.filter((option) => option.offeredNow !== false))}
          </legend>
          {rule.options.map((option, optionIndex) => {
            const price = optionPriceText(option.price);
            // Indexes, never the option's reference: references stay out of the markup.
            const priceId = price === null ? null : `configure-price-${groupIndex}-${optionIndex}`;
            // WP-2423 (M166): a choice that adds allergens of its own says so ("Adds: Egg").
            const adds =
              rule.comboPart === true
                ? null
                : (sellable.allergensByOption?.[option.optionReference] ?? null);
            const allergensId =
              rule.comboPart === true || (adds !== null && adds.length > 0)
                ? `configure-allergens-${groupIndex}-${optionIndex}`
                : null;
            // A screen reader gets what a sighted guest reads beside the choice: its price, and for
            // a combo dish what it contains.
            const described = [priceId, allergensId].filter((id) => id !== null).join(" ");
            return (
              <div className="configure-option configure-option--row" key={option.optionReference}>
                <label className="configure-option__choice">
                  <input
                    type={singleChoice(rule) ? "radio" : "checkbox"}
                    name={`configure-group-${groupIndex}`}
                    checked={current.has(option.optionReference)}
                    disabled={
                      locked ||
                      (option.offeredNow === false && !current.has(option.optionReference))
                    }
                    {...(described === "" ? {} : { "aria-describedby": described })}
                    onChange={() => {
                      const next = new Map(current);
                      if (singleChoice(rule)) {
                        // Choosing one replaces the group's other choice.
                        for (const other of rule.options) next.delete(other.optionReference);
                        next.set(option.optionReference, 1);
                      } else if (next.has(option.optionReference))
                        next.delete(option.optionReference);
                      else next.set(option.optionReference, 1);
                      setSelected(next);
                    }}
                  />
                  <span className="configure-option__name">{option.name}</span>
                </label>
                {option.offeredNow === false ? (
                  <span className="configure-option__price">
                    {option.soldOut === true ? t("Sold out today") : t("Not available now")}
                  </span>
                ) : priceId === null ? null : (
                  <span id={priceId} className="configure-option__price">
                    {price}
                  </span>
                )}
                {/* WP-2423 item 8 ⑥ part 4: each dish of a combo part with its allergens. */}
                {allergensId === null ? null : (
                  <span id={allergensId} className="configure-option__allergens">
                    {adds !== null && adds.length > 0
                      ? t("Adds: {allergens}", {
                          allergens: adds.map((allergen) => allergen.name).join(listSeparator()),
                        })
                      : dishAllergenText(comboDishAllergens(sellable, option.optionReference))}
                  </span>
                )}
                {current.has(option.optionReference) && option.maximumQuantity > 1 ? (
                  <label className="configure-option__quantity">
                    {t("How many")} {option.name}
                    <input
                      type="number"
                      min={1}
                      max={Math.min(option.maximumQuantity, 100)}
                      inputMode="numeric"
                      value={current.get(option.optionReference)}
                      disabled={locked}
                      onChange={(event) => {
                        const next = new Map(current);
                        next.set(option.optionReference, event.currentTarget.valueAsNumber);
                        setSelected(next);
                      }}
                    />
                  </label>
                ) : null}
              </div>
            );
          })}
        </fieldset>
      ))}
      <div className="configure-note">
        <label htmlFor="configure-note">{t("Preparation note (optional)")}</label>
        <textarea
          id="configure-note"
          maxLength={500}
          rows={2}
          value={note}
          disabled={locked}
          aria-describedby="configure-note-help"
          onChange={(event) => setNote(event.currentTarget.value)}
        />
        <p id="configure-note-help">
          {t(
            "Plain preparation requests only. Do not enter allergy, medical or other sensitive details; ask staff for assistance.",
          )}
        </p>
      </div>
      {issues.length > 0 ? (
        <div className="configure-issues" role="alert">
          {issues.map((issue) => (
            <p key={issue}>{issue}</p>
          ))}
        </div>
      ) : null}
      {soldOut ? (
        <p className="configure-sold-out" role="status">
          {notNow
            ? t("{name} isn't available right now.", { name: sellable.name })
            : t("This size is sold out right now. Please choose another size.")}
        </p>
      ) : null}
      <ConfigureStatus state={state} controller={controller} />
      {alreadyOrdered > 0 ? (
        <p className="configure-table-ordered" role="note">
          {t("This table already ordered {count} of these.", { count: alreadyOrdered })}
        </p>
      ) : null}
      <div className="configure-actions">
        <div className="configure-stepper">
          <button
            type="button"
            aria-label={t("Decrease quantity")}
            disabled={locked || !(quantity > 1)}
            onClick={() => setQuantity((value) => Math.max(1, Math.min(100, (value || 1) - 1)))}
          >
            −
          </button>
          <label htmlFor="configure-quantity" className="sr-only">
            {t("Quantity")}
          </label>
          <input
            id="configure-quantity"
            type="number"
            min={1}
            max={100}
            inputMode="numeric"
            value={quantity}
            disabled={locked}
            onChange={(event) => setQuantity(event.currentTarget.valueAsNumber)}
          />
          <button
            type="button"
            aria-label={t("Increase quantity")}
            disabled={locked || !(quantity < 100)}
            onClick={() => setQuantity((value) => Math.max(1, Math.min(100, (value || 0) + 1)))}
          >
            +
          </button>
        </div>
        <button
          className="menu-action configure-actions__submit"
          type="submit"
          disabled={
            issues.length > 0 || locked || soldOut || missingComboPart(sellable, current) !== null
          }
        >
          {/* A combo says which part the guest still has to choose in. */}
          {((part) => (part === null ? t("Add to cart") : t("Choose {part}", { part })))(
            missingComboPart(sellable, current),
          )}
        </button>
        <SlowAddNotice busy={busy} />
        <p className="configure-actions__total" aria-live="polite">
          {total === null ? (
            t("Price confirmed at checkout")
          ) : (
            <>
              <strong>{total}</strong> {t("plus tax")}
            </>
          )}
        </p>
      </div>
      {issues.length === 0 && sellable.optionRules.length > 0 ? (
        <ChoiceAllergens
          allergens={allergensForChoice(
            sellable,
            selectedMenuOptions(sellable.optionRules, current)
              .filter((option) => option.quantity > 0)
              .map((option) => option.optionReference),
          )}
        />
      ) : null}
    </form>
  );
}

/** WP-2423 item 8 ⑥ part 4: one combo dish's allergens, in a few words (never a free-from claim). */
export function dishAllergenText(allergens: readonly MenuAllergenItem[] | null): string {
  if (allergens === null) return t("Ask staff about allergens");
  // Not hidden when empty: silence would read as safe. Never a free-from claim.
  if (allergens.length === 0) return t("No allergens listed");
  const contains = allergens.filter((item) => item.classification === "Contains");
  const may = allergens.filter((item) => item.classification !== "Contains");
  return [
    contains.length === 0
      ? null
      : t("Contains {value1}", {
          value1: contains.map((item) => item.name).join(listSeparator()),
        }),
    may.length === 0
      ? null
      : t("May contain {value1}", { value1: may.map((item) => item.name).join(listSeparator()) }),
  ]
    .filter(Boolean)
    .join(clauseSeparator());
}

/**
 * WP-2423 ⑪: what this drink contains with the choices made so far, as reviewed for the menu.
 * Never an allergen-free claim; nothing is shown when the menu has no per-choice disclosure.
 */
function ChoiceAllergens({
  allergens,
}: {
  readonly allergens: readonly MenuAllergenItem[] | null;
}) {
  if (allergens === null) return null;
  const contains = allergens.filter((item) => item.classification === "Contains");
  const may = allergens.filter((item) => item.classification !== "Contains");
  return (
    <p className="configure-allergens" aria-live="polite">
      <span>{t("With your choices:")} </span>
      {allergens.length === 0
        ? t("no allergens listed. Ask staff if you have an allergy.")
        : [
            contains.length === 0
              ? null
              : t("contains {value1}", {
                  value1: contains.map((item) => item.name).join(listSeparator()),
                }),
            may.length === 0
              ? null
              : t("may contain {value1}", {
                  value1: may.map((item) => item.name).join(listSeparator()),
                }),
          ]
            .filter(Boolean)
            .join(clauseSeparator()) + sentenceEnd()}
    </p>
  );
}

function AllergenSummary({ sellable }: { readonly sellable: MenuSellable }) {
  const contains = sellable.allergens.filter((item) => item.classification === "Contains");
  const may = sellable.allergens.filter((item) => item.classification !== "Contains");
  return (
    <div className="menu-allergens">
      <p className="menu-allergen-heading">
        {sellable.allergensByChoice === undefined
          ? t("Allergen information")
          : t("Allergen information (all choices)")}
      </p>
      {sellable.allergens.length === 0 ? (
        <p>{t("No allergen-free claim is made. Ask staff before ordering.")}</p>
      ) : (
        <dl>
          {contains.length === 0 ? null : (
            <div>
              <dt>{t("Contains")}</dt>
              <dd>{contains.map((item) => item.name).join(listSeparator())}</dd>
            </div>
          )}
          {may.length === 0 ? null : (
            <div>
              <dt>{t("Cross-contact possible")}</dt>
              <dd>{may.map((item) => item.name).join(listSeparator())}</dd>
            </div>
          )}
        </dl>
      )}
      {sellable.allergensJustUpdated === true ? (
        <p className="menu-allergens-updated" role="note">
          {t("Allergen info was just updated. Ask staff if unsure.")}
        </p>
      ) : null}
    </div>
  );
}

/** Owner 2026-11-03 walkthrough: one line above the list; the full words are on each dish. */
function AllergenHelpLine() {
  return (
    <p className="menu-help-line" role="note">
      {t("Allergies? Ask a staff member before you order.")}
    </p>
  );
}

function AllergenHelp() {
  return (
    <aside className="menu-help" aria-labelledby="menu-help-heading">
      <h2 id="menu-help-heading">{t("Allergies or accessibility?")}</h2>
      <p>
        {t(
          "Ask staff before ordering. The menu never promises that an item is allergen-free, and staff can take your order another way.",
        )}
      </p>
    </aside>
  );
}

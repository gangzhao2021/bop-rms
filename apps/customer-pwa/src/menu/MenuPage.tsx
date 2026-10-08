import {
  activeMenuOptionRules,
  defaultMenuOptionSelections,
  selectedMenuOptions,
} from "./option-configuration.js";
import { createBrowserPickupCartClient } from "../cart/pickup-cart-client.js";
import { AppFrame } from "@bop-rms/ui";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { FormEvent } from "react";
import { Link, useParams } from "react-router";
import { createBrowserCustomerCartClient } from "../cart/cart-client.js";
import type { CartItemDraft } from "../cart/types.js";
import {
  createConfigureController,
  type ConfigureController,
  type ConfigureState,
} from "./configure-state.js";
import { createCustomerMenuClient, normalizeMenuSearch } from "./menu-client.js";
import type {
  CustomerMenuClient,
  MenuJourneyContext,
  MenuLoadResult,
  MenuOptionRule,
  MenuSellable,
  MenuView,
} from "./types.js";

type ScreenState =
  | Readonly<{ kind: "MissingContext" }>
  | Readonly<{ kind: "IdleSearch" }>
  | Readonly<{ kind: "Loading" }>
  | MenuLoadResult;

interface MenuPageProps {
  readonly context?: MenuJourneyContext | undefined;
  readonly client?: CustomerMenuClient | undefined;
  readonly readOnlyNotice?: React.ReactNode | undefined;
}

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

function useMenuLoad(
  client: CustomerMenuClient | null,
  input: Readonly<{ searchTerm?: string; sectionReference?: string }> | null = {},
) {
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
  useEffect(() => {
    if (state.kind !== "Loading") heading.current?.focus();
  }, [state.kind]);
  return { state, heading, retry: () => setRevision((value) => value + 1) };
}

/** One choice only: shown as radio buttons. */
const singleChoice = (rule: MenuOptionRule) =>
  rule.maximumSelections === 1 && rule.options.every((option) => option.maximumQuantity === 1);
/** "choose 1", "choose up to 3 (optional)", "choose 1 to 2". */
function choiceText(rule: MenuOptionRule): string {
  const { minimumSelections: min, maximumSelections: max } = rule;
  if (min === max) return `choose ${max}`;
  if (min === 0) return `optional, up to ${max}`;
  return `choose ${min} to ${max}`;
}
/** "+ CAD 0.75", "No extra charge", or a note that the quote will price it. */
function optionPriceText(price: MenuOptionRule["options"][number]["price"]): string {
  if (price === null) return "Price shown in your final quote";
  return /^0+(\.0+)?$/u.test(price.amount)
    ? "No extra charge"
    : `+ ${price.currency} ${price.amount}`;
}

export function MenuBrowsePage({ context, client, readOnlyNotice }: MenuPageProps) {
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
      state={loaded.state}
    />
  );
}

export function MenuSearchPage({ context, client, readOnlyNotice }: MenuPageProps) {
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
      search={
        <section className="menu-search-view">
          <form className="menu-search" role="search" onSubmit={submit}>
            <label className="sr-only" htmlFor="menu-search-input">
              Search the menu
            </label>
            <div className="menu-search-primary">
              <input
                id="menu-search-input"
                maxLength={100}
                placeholder="Search menu items"
                value={draft}
                onChange={(event) => setDraft(event.currentTarget.value)}
              />
              <button
                type="submit"
                disabled={normalizeMenuSearch(draft) === null && sectionDraft === ""}
              >
                Search
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
                Clear
              </button>
            </div>
            <div className="menu-search-section">
              <label htmlFor="menu-search-section">Menu section</label>
              <select
                id="menu-search-section"
                value={sectionDraft}
                disabled={sections.state.kind !== "Found"}
                onChange={(event) => setSectionDraft(event.currentTarget.value)}
              >
                <option value="">All sections</option>
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
              Dietary tags are not provided by this menu. Availability is shown on each result; ask
              staff for dietary help.
            </p>
          </form>
        </section>
      }
      searchTerm={term}
      state={loaded.state}
    />
  );
}

export function SellableDetailPage({ context, client, readOnlyNotice }: MenuPageProps) {
  const resolvedClient = useClient(context, client);
  const input = useMemo(() => ({}), []);
  const loaded = useMenuLoad(resolvedClient, input);
  const { sellableId = "" } = useParams();
  let state = loaded.state;
  let sellable: MenuSellable | null = null;
  if (state.kind === "Found") {
    sellable =
      state.menu.sections
        .flatMap((section) => section.sellables)
        .find((item) => item.sellableReference === sellableId) ?? null;
    if (sellable === null) state = { kind: "NotFound" };
  }
  return (
    <MenuScreen
      context={context}
      detail={sellable}
      headingRef={loaded.heading}
      mode="detail"
      onRetry={loaded.retry}
      readOnlyNotice={readOnlyNotice}
      state={state}
    />
  );
}

export interface MenuScreenProps {
  readonly context?: MenuJourneyContext | undefined;
  readonly detail?: MenuSellable | null | undefined;
  readonly headingRef?: React.RefObject<HTMLHeadingElement | null> | undefined;
  readonly mode: "browse" | "search" | "detail";
  readonly onRetry?: (() => void) | undefined;
  readonly readOnlyNotice?: React.ReactNode | undefined;
  readonly search?: React.ReactNode | undefined;
  readonly searchTerm?: string | null | undefined;
  readonly state: ScreenState;
}

export function MenuScreen({
  context,
  detail,
  headingRef,
  mode,
  onRetry,
  readOnlyNotice,
  search,
  searchTerm,
  state,
}: MenuScreenProps) {
  const title =
    mode === "search" ? "Search menu" : mode === "detail" && detail ? detail.name : "Menu";
  return (
    <AppFrame
      className={`customer-menu-screen customer-menu-screen--${mode}`}
      title={context?.storeDisplayName ?? title}
      description={
        context
          ? `${context.brandDisplayName} · ${context.channel === "DineIn" ? "Dine-in" : "Pickup"}`
          : "A location QR code is required"
      }
    >
      <div className="menu-page-intro">
        <h2>{title}</h2>
        {context ? <span>{context.channel === "DineIn" ? "Dine-in" : "Pickup"}</span> : null}
      </div>
      <nav className="menu-navigation" aria-label="Menu">
        {mode === "search" ? (
          <div className="menu-navigation__links menu-navigation__links--search">
            <Link to="/menu">← Back to menu</Link>
            <Link to="/cart">Cart</Link>
          </div>
        ) : (
          <>
            <Link aria-label="Search menu" className="menu-navigation__search" to="/menu/search">
              Search menu
            </Link>
            <div className="menu-navigation__links">
              <Link to="/menu" aria-current="page">
                Browse menu
              </Link>
              <Link to="/cart">Cart</Link>
            </div>
          </>
        )}
      </nav>
      {state.kind === "MissingContext" ? null : search}
      {state.kind === "Found" && mode === "search" ? (
        <section className="menu-search-summary" aria-label="Search results">
          <h2>Search results</h2>
          {searchTerm ? <p>Matched term · {searchTerm}</p> : null}
        </section>
      ) : null}
      <div className="menu-content" aria-live="polite" aria-busy={state.kind === "Loading"}>
        <MenuState
          key={context ? `${context.publicStoreReference}:${context.channel}` : "missing-context"}
          channel={context?.channel}
          detail={detail}
          headingRef={headingRef}
          mode={mode}
          onRetry={onRetry}
          readOnlyNotice={readOnlyNotice}
          state={state}
        />
      </div>
      {state.kind === "PermissionDenied" ? null : <AllergenHelp />}
    </AppFrame>
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
      Try again
    </button>
  ) : null;
}

function MenuState({
  channel,
  detail,
  headingRef,
  mode,
  onRetry,
  readOnlyNotice,
  state,
}: Omit<MenuScreenProps, "context" | "search" | "searchTerm"> & {
  readonly channel?: MenuJourneyContext["channel"] | undefined;
}) {
  if (state.kind === "MissingContext")
    return (
      <section className="menu-state" role="alert">
        <Heading headingRef={headingRef}>Scan the location QR code</Heading>
        <p>Your Store and service context is not available. Scan again to open the current menu.</p>
        <Link className="menu-action" to="/">
          Return to entry
        </Link>
      </section>
    );
  if (state.kind === "IdleSearch")
    return (
      <section className="menu-state menu-state--idle-search" role="status">
        <Heading headingRef={headingRef}>Search this menu</Heading>
        <p>Enter a published item name or approved search term.</p>
      </section>
    );
  if (state.kind === "Loading")
    return (
      <section className="menu-state" role="status">
        <Heading headingRef={headingRef}>Loading the current menu</Heading>
        <p>Checking the latest published items…</p>
      </section>
    );
  if (state.kind === "PermissionDenied")
    return (
      <section
        className="menu-state menu-state--warning menu-state--permission-denied"
        role="alert"
      >
        <Heading headingRef={headingRef}>This menu can’t be opened</Heading>
        <p>
          The current Store session can’t access this menu. Scan the location QR code again or ask
          staff for help.
        </p>
        <Link className="menu-action" to="/">
          Return to entry
        </Link>
      </section>
    );
  if (state.kind === "Offline")
    return (
      <section className="menu-state menu-state--warning" role="alert">
        <Heading headingRef={headingRef}>You’re offline</Heading>
        <p>No cached menu is available. No item or order was submitted.</p>
        <Retry onRetry={onRetry} />
      </section>
    );
  if (state.kind === "Stale")
    return (
      <section className="menu-state menu-state--warning" role="alert">
        <Heading headingRef={headingRef}>Menu is being refreshed</Heading>
        <p>We won’t show an out-of-date menu. Try again shortly.</p>
        <Retry onRetry={onRetry} />
      </section>
    );
  if (state.kind === "Unavailable")
    return (
      <section className="menu-state menu-state--error" role="alert">
        <Heading headingRef={headingRef}>Menu is unavailable</Heading>
        <p>No item or order was submitted. Try again or ask staff for help.</p>
        <Retry onRetry={onRetry} />
      </section>
    );
  if (state.kind === "NotFound")
    return (
      <section className="menu-state" role="status">
        <Heading headingRef={headingRef}>
          {mode === "detail" ? "Item not found" : "No menu found"}
        </Heading>
        <p>
          {mode === "detail"
            ? "This item is not in the current published menu."
            : "There are no matching published items right now."}
        </p>
        <Link className="menu-action" to="/menu">
          Browse menu
        </Link>
      </section>
    );
  if (detail)
    return (
      <SellableDetail
        channel={channel}
        sellable={detail}
        headingRef={headingRef}
        readOnlyNotice={readOnlyNotice}
      />
    );
  return <MenuContents menu={state.menu} headingRef={headingRef} mode={mode} />;
}

function MenuContents({
  menu,
  headingRef,
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
        <Heading headingRef={headingRef}>No items available</Heading>
        <p>The current published menu has no matching items.</p>
      </section>
    );
  return (
    <>
      {mode === "browse" ? <Heading headingRef={headingRef}>{menu.name}</Heading> : null}
      {mode === "browse" ? (
        <nav className="menu-sections" aria-label="Menu sections">
          {menu.sections.map((section) => (
            <a key={section.sectionReference} href={`#section-${section.sectionReference}`}>
              {section.name}
            </a>
          ))}
        </nav>
      ) : null}
      {mode === "browse" ? (
        <p className="menu-filter-boundary">
          <strong>Showing available items only.</strong> Dietary filters are not available in this
          published menu; review allergen disclosures and ask staff for assistance.
        </p>
      ) : null}
      {menu.sections.map((section) => (
        <section
          className="menu-section"
          key={section.sectionReference}
          aria-label={mode === "search" ? `Results in ${section.name}` : undefined}
          aria-labelledby={mode === "browse" ? `section-${section.sectionReference}` : undefined}
        >
          {mode === "browse" ? (
            <h3 id={`section-${section.sectionReference}`}>{section.name}</h3>
          ) : null}
          <div className="menu-grid">
            {section.sellables.map((item) => (
              <SellableCard
                key={item.sellableReference}
                sellable={item}
                {...(mode === "search" ? { sectionName: section.name } : {})}
              />
            ))}
          </div>
        </section>
      ))}
    </>
  );
}

function SellableCard({
  sellable,
  sectionName,
}: {
  readonly sellable: MenuSellable;
  readonly sectionName?: string | undefined;
}) {
  return (
    <article className="menu-card">
      <div className="menu-media" aria-label="Image not available">
        Image not available
      </div>
      <h4>{sellable.name}</h4>
      {sellable.presentationRole !== "Standard" ? (
        <p className="menu-badge">
          {sellable.presentationRole === "Sponsored"
            ? "Sponsored item"
            : sellable.presentationRole === "Promotional"
              ? "Promotional item"
              : "Featured item"}
        </p>
      ) : null}
      <AvailabilityLine sellable={sellable} />
      <p>{priceLine(sellable)}</p>
      {sectionName ? (
        <p className="menu-result-section">
          <span>Section</span>
          {sectionName}
        </p>
      ) : null}
      <AllergenSummary sellable={sellable} />
      <Link
        aria-label={`View ${sellable.name}`}
        className="menu-action"
        to={`/menu/items/${sellable.sellableReference}`}
      >
        View item
      </Link>
    </article>
  );
}

/** WP-2423 8.6: the Store's base price; options and tax are added in the final quote. */
function priceLine(sellable: MenuSellable): string {
  if (sellable.price === null) return "Price confirmed in your final quote";
  // Decimal text from the server; never converted to a binary number.
  const amount =
    (sellable.price.currency === "CAD" ? "$" : sellable.price.currency + " ") +
    sellable.price.amount;
  return sellable.optionRules.length === 0
    ? `${amount} plus tax`
    : `From ${amount} plus tax; options may add to it`;
}
function AvailabilityLine({ sellable }: { readonly sellable: MenuSellable }) {
  return sellable.availability === "SoldOut" ? (
    <p className="menu-sold-out">Sold out</p>
  ) : (
    <p className="menu-available">Available now</p>
  );
}

function SellableDetail({
  channel,
  sellable,
  headingRef,
  readOnlyNotice,
}: {
  readonly channel?: MenuJourneyContext["channel"] | undefined;
  readonly sellable: MenuSellable;
  readonly headingRef?: React.RefObject<HTMLHeadingElement | null> | undefined;
  readonly readOnlyNotice?: React.ReactNode | undefined;
}) {
  const [configuring, setConfiguring] = useState(false);
  return (
    <article className="sellable-detail">
      <Link to="/menu">← Back to menu</Link>
      <div className="menu-media menu-media--detail" aria-label="Image not available">
        Image not available
      </div>
      <Heading headingRef={headingRef}>{sellable.name}</Heading>
      <AvailabilityLine sellable={sellable} />
      <dl>
        <div>
          <dt>Price</dt>
          <dd>{sellable.price === null ? "Confirmed in your final quote" : priceLine(sellable)}</dd>
        </div>
        <div>
          <dt>Tax</dt>
          <dd>Calculated in your final quote</dd>
        </div>
        <div>
          <dt>Portion or variant</dt>
          <dd>No published detail available</dd>
        </div>
        <div>
          <dt>Options</dt>
          <dd>
            {sellable.optionRules.length === 0
              ? "No choices required"
              : `${sellable.optionRules.length} option group${sellable.optionRules.length === 1 ? "" : "s"}`}
            {sellable.optionRules.length > 0 ? (
              <ul>
                {sellable.optionRules.map((rule, index) => (
                  <li key={`${rule.minimumSelections}-${rule.maximumSelections}-${index}`}>
                    Choose {rule.minimumSelections}–{rule.maximumSelections} from{" "}
                    {rule.options.length}
                    {rule.options.some((option) => option.selectedByDefault)
                      ? `; ${rule.options.reduce((sum, option) => sum + (option.defaultQuantity ?? (option.selectedByDefault ? 1 : 0)), 0)} selected by default`
                      : ""}
                  </li>
                ))}
              </ul>
            ) : null}
          </dd>
        </div>
      </dl>
      <AllergenSummary sellable={sellable} />
      {readOnlyNotice ? (
        <div className="menu-readonly-boundary" role="status">
          {readOnlyNotice}
        </div>
      ) : sellable.availability === "SoldOut" ? (
        <p role="status">Sold out at this store right now. Please choose another item.</p>
      ) : configuring ? (
        <SellableConfigurator
          channel={channel}
          key={sellable.sellableReference}
          sellable={sellable}
        />
      ) : (
        <button className="menu-action" type="button" onClick={() => setConfiguring(true)}>
          {sellable.optionRules.length === 0 ? "Add to cart" : "Configure and add"}
        </button>
      )}
    </article>
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
    issues.push("Quantity must be between 1 and 100.");
  const activeRules = activeMenuOptionRules(sellable.optionRules, selected);
  const activeReferences = new Set(
    activeRules.flatMap((rule) => rule.options.map((option) => option.optionReference)),
  );
  activeRules.forEach((rule, index) => {
    const count = rule.options.reduce(
      (total, option) => total + (selected.get(option.optionReference) ?? 0),
      0,
    );
    if (count < rule.minimumSelections)
      issues.push(
        `${rule.name ?? `Choice group ${index + 1}`} requires at least ${rule.minimumSelections}.`,
      );
    if (count > rule.maximumSelections)
      issues.push(
        `${rule.name ?? `Choice group ${index + 1}`} allows at most ${rule.maximumSelections}.`,
      );
    rule.options.forEach((option) => {
      const optionQuantity = selected.get(option.optionReference) ?? 0;
      if (
        selected.has(option.optionReference) &&
        (!Number.isSafeInteger(optionQuantity) || optionQuantity < 1)
      )
        issues.push("Selected option quantities must be positive whole numbers.");
      if (optionQuantity > Math.min(option.maximumQuantity, 100))
        issues.push(`${option.name} allows at most ${Math.min(option.maximumQuantity, 100)}.`);
      if (
        optionQuantity > 0 &&
        option.conflictOptionReferences.some(
          (reference) => activeReferences.has(reference) && (selected.get(reference) ?? 0) > 0,
        )
      )
        issues.push(`${option.name} conflicts with another selected choice.`);
    });
  });
  if (note !== note.normalize("NFC") || note.length > 500)
    issues.push("Preparation note must be 500 characters or fewer.");
  if (/\b(?:allerg(?:y|ic|ies)|anaphyla\w*|medical|medication|celiac|intoleran\w*)\b/iu.test(note))
    issues.push("Do not put allergy or medical information in the preparation note; ask Staff.");
  return Object.freeze(issues);
}

function ConfigureStatus({
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
          ? "Checking your current cart…"
          : state.stage === "create"
            ? "Starting your cart…"
            : "Adding the item…"}
      </p>
    );
  if (state.status === "added")
    return (
      <div className="configure-status configure-status--success" role="status">
        <p>Added to the server cart.</p>
        <Link className="menu-action" to="/cart">
          Review cart
        </Link>
      </div>
    );
  const copy = {
    offline: "You’re offline. Nothing was queued or replayed.",
    "session-expired": "Your Store session expired. Scan the location QR code again.",
    conflict: "Your cart changed. Review the current cart before trying again.",
    validation: "The server rejected this changed, conflicting or unavailable configuration.",
    "rate-limited": `Please wait${"retryAfterSeconds" in state && state.retryAfterSeconds !== null ? ` ${state.retryAfterSeconds} seconds` : ""} before trying again.`,
    expired:
      "This cart expired and cannot accept more items. Ask staff for help continuing your order.",
    abandoned: "This cart is closed and cannot accept another item.",
    unavailable: "Cart service is unavailable. No success was assumed.",
    "outcome-unknown": "The network ended before the server outcome was confirmed.",
  } as const;
  return (
    <div className="configure-status configure-status--error" role="alert">
      <p>{copy[state.status]}</p>
      {"issueCodes" in state
        ? state.issueCodes.map((issue) => <p key={issue}>Issue: {issue}</p>)
        : null}
      {state.canRetry ? (
        <button
          type="button"
          disabled={state.status === "offline"}
          onClick={() => void controller.retry()}
        >
          Retry the same operation
        </button>
      ) : null}
      {state.status === "conflict" ? <Link to="/cart">Review cart</Link> : null}
      {state.status === "session-expired" ? <Link to="/">Return to entry</Link> : null}
    </div>
  );
}

export function SellableConfigurator({
  channel,
  sellable,
  controller: provided,
}: {
  readonly channel?: MenuJourneyContext["channel"] | undefined;
  readonly sellable: MenuSellable;
  readonly controller?: ConfigureController | undefined;
}) {
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
  const [selected, setSelected] = useState<ReadonlyMap<string, number>>(() =>
    defaultMenuOptionSelections(sellable.optionRules),
  );
  const activeRules = activeMenuOptionRules(sellable.optionRules, selected);
  const issues = configurationIssues(sellable, selected, quantity, note);
  const busy = state.status === "pending";
  const unresolved = state.status === "outcome-unknown" || state.status === "offline";
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
    if (issues.length > 0 || busy || unresolved || state.status === "added") return;
    const draft: CartItemDraft = Object.freeze({
      quantity,
      optionSelections: selectedMenuOptions(sellable.optionRules, selected),
      customerNote: note.trim() === "" ? null : note.normalize("NFC").trim(),
    });
    void controller.submit(sellable.sellableReference, draft);
  };
  return (
    <form className="sellable-configurator" aria-labelledby="configure-heading" onSubmit={submit}>
      <h3 id="configure-heading">Configure {sellable.name}</h3>
      <p>
        Prices shown are what each choice adds now; your final total, with tax, comes from the quote
        at checkout.
      </p>
      <label htmlFor="configure-quantity">Quantity</label>
      <input
        id="configure-quantity"
        type="number"
        min={1}
        max={100}
        inputMode="numeric"
        value={quantity}
        disabled={busy || unresolved || state.status === "added"}
        onChange={(event) => setQuantity(event.currentTarget.valueAsNumber)}
      />
      {activeRules.map((rule, groupIndex) => (
        <fieldset key={`${rule.minimumSelections}-${rule.maximumSelections}-${groupIndex}`}>
          <legend>
            {rule.name ?? `Choice group ${groupIndex + 1}`} — {choiceText(rule)}
          </legend>
          {rule.options.map((option) => (
            <div className="configure-option" key={option.optionReference}>
              <label>
                <input
                  type={singleChoice(rule) ? "radio" : "checkbox"}
                  name={`configure-group-${groupIndex}`}
                  checked={selected.has(option.optionReference)}
                  disabled={busy || unresolved || state.status === "added"}
                  onChange={() => {
                    const next = new Map(selected);
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
                {option.name}
                {option.selectedByDefault ? " (default)" : ""}
              </label>
              {selected.has(option.optionReference) && option.maximumQuantity > 1 ? (
                <label>
                  Quantity for {option.name}
                  <input
                    type="number"
                    min={1}
                    max={Math.min(option.maximumQuantity, 100)}
                    inputMode="numeric"
                    value={selected.get(option.optionReference)}
                    disabled={busy || unresolved || state.status === "added"}
                    onChange={(event) => {
                      const next = new Map(selected);
                      next.set(option.optionReference, event.currentTarget.valueAsNumber);
                      setSelected(next);
                    }}
                  />
                </label>
              ) : null}
              <span>{optionPriceText(option.price)}</span>
            </div>
          ))}
        </fieldset>
      ))}
      <label htmlFor="configure-note">Preparation note (optional)</label>
      <textarea
        id="configure-note"
        maxLength={500}
        value={note}
        disabled={busy || unresolved || state.status === "added"}
        aria-describedby="configure-note-help"
        onChange={(event) => setNote(event.currentTarget.value)}
      />
      <p id="configure-note-help">
        Plain preparation requests only. Do not enter allergy, medical or other sensitive details;
        ask Staff for assistance.
      </p>
      {issues.length > 0 ? (
        <div className="configure-issues" role="alert">
          {issues.map((issue) => (
            <p key={issue}>{issue}</p>
          ))}
        </div>
      ) : null}
      <button
        className="menu-action"
        type="submit"
        disabled={issues.length > 0 || busy || unresolved || state.status === "added"}
      >
        Add to cart
      </button>
      <ConfigureStatus state={state} controller={controller} />
    </form>
  );
}

function AllergenSummary({ sellable }: { readonly sellable: MenuSellable }) {
  return (
    <div className="menu-allergens">
      <p className="menu-allergen-heading">Allergen information</p>
      {sellable.allergens.length === 0 ? (
        <p>No allergen-free claim is made. Ask staff before ordering.</p>
      ) : (
        <ul>
          {sellable.allergens.map((item) => (
            <li key={`${item.classification}-${item.name}`}>
              {item.classification === "Contains" ? "Contains" : "Cross-contact possible"}:{" "}
              {item.name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AllergenHelp() {
  return (
    <aside className="menu-help" aria-labelledby="menu-help-heading">
      <h2 id="menu-help-heading">Accessibility and allergen help</h2>
      <p>
        Ask staff for an accessible ordering option or allergen assistance. The menu never promises
        that an item is allergen-free.
      </p>
    </aside>
  );
}

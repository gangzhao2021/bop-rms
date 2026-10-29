import { t } from "./i18n/i18n.js";
import { StatePanel } from "@bop-rms/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { WorkspacePage } from "./WorkspacePage.js";
import { newOperationReference } from "./operation-reference.js";
import { orderMoney } from "./order-money.js";
import { moveTo, useDragReorder } from "./reorder.js";
import {
  dishesNotOnMenu,
  filterRows,
  menuFilters,
  listingPending,
  listingUnderway,
  menuRows,
  readListingMarker,
  writeListingMarker,
  newSectionCode,
  orderKey,
  sectionInputs,
  type MenuDish,
  type MenuSize,
  type MenuFilter,
  type MenuSectionRow,
} from "./one-store-menu.js";
import {
  AvailabilityPageError,
  parseStoreAvailabilityView,
  type AvailabilityClient,
  type AvailabilityCommand,
  type StoreAvailabilityView,
} from "./store-availability-page.js";
import { menuErrorText } from "./StoreMenuPages.js";
import { allergenSummary } from "./DishAllergenEditor.js";
import { DishEditor } from "./DishEditor.js";
import { ComboEditor, comboDishChoices } from "./ComboEditor.js";
import {
  MenuPageError,
  menuReviewProblemText,
  menuStage,
  parseMenuBuilderView,
  parseMenuCombos,
  type MenuBuilderView,
  type MenuClient,
  type MenuCombo,
} from "./store-menu-pages.js";

const filterText: Record<MenuFilter, string> = {
  get SoldOut() {
    return t("Sold out");
  },
  get NoPrice() {
    return t("No price");
  },
  get Hidden() {
    return t("Hidden");
  },
  get MissingName() {
    return t("Missing a name");
  },
  get NoAllergens() {
    return t("Allergens not declared");
  },
};

const price = (minor: string | null) =>
  minor === null ? null : orderMoney({ amountMinor: minor, currencyCode: "CAD" });

/**
 * WP-2423 item 8 ⑥ DEC-SINGLE-STORE-MENU part 1: a single store's menu on one page. Sections and
 * dishes in the order guests see them (drag to reorder; Move buttons for the keyboard), both names,
 * the price, sold out today and hidden here; search by either name and filter. Sold out and hidden
 * take effect at once (the Store's item availability); a new order is saved to the menu draft and
 * shows to guests when the menu is listed.
 */
export function OneStoreMenuPage({
  menuReference,
  client,
  availability,
  onMultiStore,
}: {
  readonly menuReference: string;
  readonly client: MenuClient;
  readonly availability: AvailabilityClient;
  /** The menu serves more than one Store: the review flow applies (the menu list is shown). */
  readonly onMultiStore: () => void;
}) {
  const [view, setView] = useState<MenuBuilderView | null>(null);
  // WP-2423 item 8 ⑥ part 4: the combos (each compiled into a dish on the menu).
  const [combos, setCombos] = useState<readonly MenuCombo[]>([]);
  // The combos could not be read: the menu still shows; combos cannot be edited until they are.
  const [combosFailed, setCombosFailed] = useState(false);
  const [stock, setStock] = useState<StoreAvailabilityView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [rows, setRows] = useState<readonly MenuSectionRow[]>([]);
  const [saved, setSaved] = useState("");
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<ReadonlySet<MenuFilter>>(new Set());
  const [busy, setBusy] = useState(false);
  // The dish open in its editor (one at a time; "new" for a new dish).
  const [editing, setEditing] = useState<string | null>(null);
  const [newSection, setNewSection] = useState<{ name: string; nameZh: string } | null>(null);
  // One listing reference per intended listing, kept until it is answered (a retry continues it).
  const [listing, setListing] = useState<string | null>(null);
  const newListing = () => {
    const reference = newOperationReference();
    setListing(reference);
    return reference;
  };
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => setGeneration((value) => value + 1), []);
  // v15 finding e: a listing in progress — this tab's request, or one started before a reload.
  const [listingSince, setListingSince] = useState<number | null>(() =>
    readListingMarker(menuReference, Date.now()),
  );
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    let active = true;
    void Promise.all([
      client.load(menuReference),
      availability.load(),
      client.combos === undefined
        ? null
        : client.combos().then(parseMenuCombos, () => "failed" as const),
    ])
      .then(([menu, items, comboList]) => {
        if (!active) return;
        const builder = parseMenuBuilderView(menu);
        if (builder.menu.storeReferences.length !== 1) {
          onMultiStore();
          return;
        }
        const found = parseStoreAvailabilityView(items);
        const next = menuRows(builder, found.items);
        setView(builder);
        setCombos(comboList === null || comboList === "failed" ? [] : comboList);
        setCombosFailed(comboList === "failed");
        setStock(found);
        setRows(next);
        setSaved(orderKey(next));
        setFailed(null);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setFailed(
          (error instanceof MenuPageError || error instanceof AvailabilityPageError) &&
            error.code === "PermissionDenied"
            ? t("You do not have permission to see the menu.")
            : t("The menu could not be read. Check the connection and try again."),
        );
      });
    return () => {
      active = false;
    };
  }, [client, availability, menuReference, onMultiStore, generation]);
  const drag = useDragReorder((list, from, to) => {
    if (list === "sections") setRows((current) => moveTo(current, from, to));
    else
      setRows((current) =>
        current.map((row) =>
          row.sectionReference === list ? { ...row, dishes: moveTo(row.dishes, from, to) } : row,
        ),
      );
  });
  // While a listing started before a reload (or the server shows one part-way) is in progress,
  // read the menu again every few seconds until it is listed.
  const polling = (listingSince !== null || (view !== null && listingUnderway(view))) && !busy;
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => {
      const now = Date.now();
      setClock(now);
      if (readListingMarker(menuReference, now) === null) {
        setListingSince(null);
        writeListingMarker(menuReference, null);
      }
      reload();
    }, 3000);
    return () => clearInterval(timer);
  }, [polling, menuReference, reload]);
  useEffect(() => {
    if (busy && listingSince !== null) {
      const timer = setInterval(() => setClock(Date.now()), 1000);
      return () => clearInterval(timer);
    }
    return undefined;
  }, [busy, listingSince]);
  useEffect(() => {
    // Finished elsewhere (the server says listed): stop showing progress.
    if (view !== null && listingSince !== null && !busy && !listingPending(view)) {
      setListingSince(null);
      writeListingMarker(menuReference, null);
    }
  }, [view, listingSince, busy, menuReference]);
  const shown = useMemo(() => filterRows(rows, search, filters), [rows, search, filters]);
  const unplaced = useMemo(
    () => (view === null || stock === null ? [] : dishesNotOnMenu(view, stock.items)),
    [view, stock],
  );
  if (failed !== null)
    return (
      <WorkspacePage title={t("Menu")}>
        <StatePanel heading={t("Unavailable")} tone="error" status>
          <p>{failed}</p>
          <button type="button" onClick={reload}>
            {t("Try again")}
          </button>
        </StatePanel>
      </WorkspacePage>
    );
  if (view === null || stock === null)
    return (
      <WorkspacePage title={t("Menu")}>
        <p role="status">{t("Reading the menu…")}</p>
      </WorkspacePage>
    );
  const underway = listingUnderway(view);
  const listingInProgress = listingSince !== null || (busy && listing !== null);
  const narrowing = search.trim() !== "" || filters.size > 0;
  const reordering = !narrowing && view.permissions.mayEdit;
  const changedOrder = orderKey(rows) !== saved;
  const stage = menuStage(view.publication);
  // The menu as saved is not what guests see: never listed, edited since, or listing unfinished.
  // A combo with saved changes is listed with the menu.
  const orderPending = listingPending(view) || combos.some((c) => c.state === "Waiting");
  const comboOf = (skuReference: string) => combos.find((c) => c.skuReference === skuReference);

  // One or more commands (a dish's sizes), one after another.
  const availabilityCommand = async (
    command: AvailabilityCommand | readonly AvailabilityCommand[],
    done: string,
  ) => {
    if (availability.command === undefined || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      for (const each of Array.isArray(command) ? command : [command])
        await availability.command(each as AvailabilityCommand);
      setProblem(done);
      reload();
    } catch (error) {
      setProblem(
        error instanceof AvailabilityPageError && error.code === "Offline"
          ? t("Offline. Nothing was confirmed; try again when you are back online.")
          : t("That didn't go through. Read the menu again and retry."),
      );
    } finally {
      setBusy(false);
    }
  };
  const saveOrder = async () => {
    if (client.command === undefined || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      let current = view;
      // A listed menu is changed through a new draft (the published one stays for guests).
      if (stage !== "Editing") {
        await client.command({
          action: "Revise",
          operationReference: newOperationReference(),
          menuReference,
          expectedAggregateVersion: current.menu.aggregateVersion,
        });
        current = parseMenuBuilderView(await client.load(menuReference));
      }
      const references = new Map(current.menu.sections.map((s) => [s.code, s.sectionReference]));
      await client.command({
        action: "SaveDraft",
        operationReference: newOperationReference(),
        menuReference,
        expectedAggregateVersion: current.menu.aggregateVersion,
        name: current.menu.name,
        sections: sectionInputs(rows).map((section) => ({
          ...section,
          sectionReference: references.get(section.code) ?? section.sectionReference,
        })),
      });
      setProblem(t("New order saved. Guests see it when the menu is listed."));
      reload();
    } catch (error) {
      setProblem(
        error instanceof MenuPageError && error.code === "Conflict"
          ? t("Someone changed the menu meanwhile. Read it again, then move the dishes again.")
          : t("That didn't go through. Read the menu again and retry."),
      );
    } finally {
      setBusy(false);
    }
  };
  const mayList =
    view.permissions.maySubmit && view.permissions.mayApprove && view.permissions.mayPublish;
  // WP-2423 item 8 ⑥ part 2: "List it" — the menu as saved takes effect for guests, no review.
  const listMenu = async () => {
    if (client.command === undefined || busy) return;
    setBusy(true);
    setProblem(null);
    const started = Date.now();
    setListingSince(started);
    writeListingMarker(menuReference, started);
    try {
      const operationReference = listing ?? newListing();
      // The open price book and waiting choice prices are listed with the menu.
      if (client.oneStore !== undefined)
        await client.oneStore({ action: "ListAll", operationReference, menuReference });
      else await client.command({ action: "List", operationReference, menuReference });
      setListing(null);
      setListingSince(null);
      writeListingMarker(menuReference, null);
      setProblem(t("Listed. Guests see the menu as it is now."));
      reload();
    } catch (error) {
      // No answer (offline, or the page is going away): the listing may still be running on the
      // server, so it stays shown in progress until the menu says listed (or three minutes pass).
      if (!(error instanceof MenuPageError) || error.code !== "Offline") {
        setListing(null);
        setListingSince(null);
        writeListingMarker(menuReference, null);
      }
      setProblem(
        error instanceof MenuPageError
          ? error.problem !== null
            ? menuReviewProblemText(error.problem)
            : menuErrorText[error.code]
          : t("That didn't go through. Read the menu again and retry."),
      );
      reload();
    } finally {
      setBusy(false);
    }
  };
  const permissions = stock.permissions;
  const choices = view.allergenChoices ?? [];
  const mayEditDishes = mayList && client.oneStore !== undefined;
  const addSection = async () => {
    if (client.command === undefined || busy || newSection === null || !newSection.name.trim())
      return;
    setBusy(true);
    setProblem(null);
    try {
      let current = view;
      if (stage !== "Editing") {
        await client.command({
          action: "Revise",
          operationReference: newOperationReference(),
          menuReference,
          expectedAggregateVersion: current.menu.aggregateVersion,
        });
        current = parseMenuBuilderView(await client.load(menuReference));
      }
      await client.command({
        action: "SaveDraft",
        operationReference: newOperationReference(),
        menuReference,
        expectedAggregateVersion: current.menu.aggregateVersion,
        name: current.menu.name,
        sections: [
          ...current.menu.sections.map((section) => ({
            sectionReference: section.sectionReference,
            code: section.code,
            name: section.name,
            nameZh: section.nameZh ?? "",
            items: section.items.map((item) => ({
              skuReference: item.skuReference,
              featured: item.featured,
            })),
          })),
          {
            sectionReference: null,
            code: newSectionCode(
              newSection.name,
              current.menu.sections.map((section) => section.code),
            ),
            name: newSection.name.trim(),
            nameZh: newSection.nameZh.trim(),
            items: [],
          },
        ],
      });
      setNewSection(null);
      setProblem(t("Section added. Guests see it when the menu is listed."));
      reload();
    } catch (error) {
      setProblem(
        error instanceof MenuPageError
          ? menuErrorText[error.code]
          : t("That didn't go through. Read the menu again and retry."),
      );
    } finally {
      setBusy(false);
    }
  };
  // `named`: a size inside a dish row says which size it is to assistive technology.
  const soldOutButton = (size: MenuSize, label: string, named = false) =>
    !permissions.mayMarkSoldOut || size.hidden ? null : size.soldOut ? (
      <button
        key={"back-" + size.skuReference}
        type="button"
        disabled={busy}
        {...(named ? { "aria-label": t("Back in stock: {item}", { item: label }) } : {})}
        onClick={() =>
          void availabilityCommand(
            {
              action: "BackInStock",
              operationReference: newOperationReference(),
              skuReference: size.skuReference,
            },
            t("{item} is back in stock.", { item: label }),
          )
        }
      >
        {t("Back in stock")}
      </button>
    ) : (
      <button
        key={"soldout-" + size.skuReference}
        type="button"
        disabled={busy}
        {...(named ? { "aria-label": t("Sold out today: {item}", { item: label }) } : {})}
        onClick={() =>
          void availabilityCommand(
            {
              action: "SoldOut",
              operationReference: newOperationReference(),
              skuReference: size.skuReference,
              until: "EndOfDay",
            },
            t("{item} is sold out for today.", { item: label }),
          )
        }
      >
        {t("Sold out today")}
      </button>
    );
  const dishActions = (dish: MenuDish) => {
    const label = dish.nameZh ? `${dish.name} ${dish.nameZh}` : dish.name;
    const actions = [];
    if (mayEditDishes && (dish.productReference !== null || comboOf(dish.skuReference)))
      actions.push(
        <button
          key="edit"
          type="button"
          aria-expanded={editing === dish.skuReference}
          aria-label={t("Edit {item}", { item: label })}
          onClick={() =>
            setEditing((current) => (current === dish.skuReference ? null : dish.skuReference))
          }
        >
          {t("Edit")}
        </button>,
      );
    // One size: sold out on the dish; several: on each size inside the row.
    const only = dish.sizes.length === 1 ? dish.sizes[0] : undefined;
    if (only !== undefined) {
      const button = soldOutButton(only, label);
      if (button !== null) actions.push(button);
    }
    if (permissions.mayOffer)
      actions.push(
        <button
          key="hide"
          type="button"
          disabled={busy}
          onClick={() =>
            void availabilityCommand(
              // Hide and show act on the whole dish: every size.
              dish.sizes
                .filter((size) => size.hidden === dish.hidden)
                .map((size) => ({
                  action: dish.hidden ? ("Offer" as const) : ("StopOffering" as const),
                  operationReference: newOperationReference(),
                  skuReference: size.skuReference,
                })),
              dish.hidden
                ? t("{item} shows to guests again.", { item: label })
                : t("{item} is hidden from guests.", { item: label }),
            )
          }
        >
          {dish.hidden ? t("Show to guests") : t("Hide")}
        </button>,
      );
    return actions;
  };
  const dishRow = (dish: MenuDish, list: string | null, index: number, count: number) => (
    <li
      key={dish.skuReference}
      className="one-menu__dish"
      ref={list === null ? undefined : drag.row(list, index)}
    >
      {list !== null && reordering ? (
        <span
          className="drag-handle"
          aria-hidden="true"
          title={t("Drag to move this dish")}
          {...drag.handle(list, index)}
        >
          ⠿
        </span>
      ) : null}
      <span className="one-menu__names">
        <span className="one-menu__name">
          {dish.name || <em>{t("No English name")}</em>}
          {dish.sizeName ? ` — ${dish.sizeName}` : ""}
        </span>
        <span className="one-menu__name-zh" lang="zh-Hans">
          {dish.nameZh || <em>{t("No Chinese name")}</em>}
        </span>
      </span>
      {dish.sizes.length === 1 ? (
        <span className="one-menu__price">
          {price(dish.priceMinor) ?? t("No price")}
          {dish.pendingPriceMinor !== null ? (
            <span className="one-menu__pending-price">
              {" "}
              {t("→ {price} when listed", { price: price(dish.pendingPriceMinor) ?? "" })}
            </span>
          ) : null}
        </span>
      ) : (
        <ul className="one-menu__sizes" aria-label={t("Sizes of {item}", { item: dish.name })}>
          {dish.sizes.map((size) => {
            const sizeLabel = `${dish.name} — ${size.sizeName ?? ""}`;
            return (
              <li key={size.skuReference}>
                <span className="one-menu__size-name">{size.sizeName}</span>
                <span className="one-menu__size-price">
                  {price(size.priceMinor) ?? t("No price")}
                  {size.pendingPriceMinor !== null ? (
                    <span className="one-menu__pending-price">
                      {" "}
                      {t("→ {price} when listed", {
                        price: price(size.pendingPriceMinor) ?? "",
                      })}
                    </span>
                  ) : null}
                </span>
                <span className="one-menu__size-state">
                  {size.hidden ? t("Hidden") : size.soldOut ? t("Sold out today") : ""}
                </span>
                {soldOutButton(size, sizeLabel, true)}
              </li>
            );
          })}
        </ul>
      )}
      <span className="one-menu__allergens">
        {((combo) =>
          combo === undefined
            ? allergenSummary(dish, choices)
            : t("Combo: {parts} · allergens by choice", {
                parts: combo.slots
                  .map((slot) =>
                    t("{part} choose {count}", {
                      part: slot.nameZh || slot.name,
                      count: slot.maximum,
                    }),
                  )
                  .join(" · "),
              }))(comboOf(dish.skuReference))}
      </span>
      <span className="one-menu__state">
        {dish.hidden ? t("Hidden") : dish.soldOut ? t("Sold out today") : ""}
      </span>
      <span className="one-menu__actions">
        {dishActions(dish)}
        {list !== null && reordering ? (
          <>
            <button
              type="button"
              disabled={busy || index === 0}
              aria-label={t("Move {item} up", { item: dish.name || dish.nameZh })}
              onClick={() =>
                setRows((current) =>
                  current.map((row) =>
                    row.sectionReference === list
                      ? { ...row, dishes: moveTo(row.dishes, index, index - 1) }
                      : row,
                  ),
                )
              }
            >
              ↑
            </button>
            <button
              type="button"
              disabled={busy || index === count - 1}
              aria-label={t("Move {item} down", { item: dish.name || dish.nameZh })}
              onClick={() =>
                setRows((current) =>
                  current.map((row) =>
                    row.sectionReference === list
                      ? { ...row, dishes: moveTo(row.dishes, index, index + 1) }
                      : row,
                  ),
                )
              }
            >
              ↓
            </button>
          </>
        ) : null}
      </span>
      {editing === dish.skuReference && comboOf(dish.skuReference) !== undefined ? (
        <ComboEditor
          menuReference={menuReference}
          combo={comboOf(dish.skuReference) ?? null}
          dishes={comboDishChoices(rows, combos)}
          sections={rows}
          sectionCode={
            rows.find((row) => row.dishes.some((d) => d.skuReference === dish.skuReference))
              ?.code ??
            rows[0]?.code ??
            ""
          }
          client={client}
          onSaved={(message) => {
            setEditing(null);
            setProblem(message);
            reload();
          }}
          onClose={() => setEditing(null)}
        />
      ) : editing === dish.skuReference ? (
        <DishEditor
          menuReference={menuReference}
          dish={dish}
          sections={rows}
          sectionCode={
            rows.find((row) => row.dishes.some((d) => d.skuReference === dish.skuReference))
              ?.code ??
            rows[0]?.code ??
            ""
          }
          allergenChoices={choices}
          keepsStock={view.keepsStock === true}
          client={client}
          onSaved={(message) => {
            setEditing(null);
            setProblem(message);
            reload();
          }}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </li>
  );
  return (
    <WorkspacePage className="one-menu" title={t("Menu")} meta={view.menu.name}>
      <div className="one-menu__tools">
        <label className="one-menu__search">
          <span>{t("Search dishes")}</span>
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("English or Chinese name")}
          />
        </label>
        <div className="one-menu__filters" role="group" aria-label={t("Show only")}>
          {menuFilters.map((filter) => (
            <button
              key={filter}
              type="button"
              aria-pressed={filters.has(filter)}
              onClick={() =>
                setFilters((current) => {
                  const next = new Set(current);
                  if (next.has(filter)) next.delete(filter);
                  else next.add(filter);
                  return next;
                })
              }
            >
              {filterText[filter]}
            </button>
          ))}
        </div>
      </div>
      {mayEditDishes ? (
        <div className="one-menu__add">
          <button
            type="button"
            aria-expanded={editing === "new"}
            onClick={() => setEditing((current) => (current === "new" ? null : "new"))}
          >
            {t("New dish")}
          </button>
          {client.combos !== undefined && !combosFailed ? (
            <button
              type="button"
              aria-expanded={editing === "new-combo"}
              onClick={() =>
                setEditing((current) => (current === "new-combo" ? null : "new-combo"))
              }
            >
              {t("New combo")}
            </button>
          ) : null}
          <button
            type="button"
            aria-expanded={newSection !== null}
            onClick={() =>
              setNewSection((current) => (current === null ? { name: "", nameZh: "" } : null))
            }
          >
            {t("New section")}
          </button>
        </div>
      ) : null}
      {newSection !== null ? (
        <form
          className="dish-editor"
          aria-label={t("New section")}
          onSubmit={(event) => {
            event.preventDefault();
            void addSection();
          }}
        >
          <div className="dish-editor__grid">
            <label className="dish-editor__field">
              <span>{t("English name")}</span>
              <input
                required
                maxLength={80}
                value={newSection.name}
                onChange={(event) =>
                  setNewSection((current) => current && { ...current, name: event.target.value })
                }
              />
            </label>
            <label className="dish-editor__field">
              <span>{t("Chinese name")}</span>
              <input
                lang="zh-Hans"
                maxLength={80}
                value={newSection.nameZh}
                onChange={(event) =>
                  setNewSection((current) => current && { ...current, nameZh: event.target.value })
                }
              />
            </label>
          </div>
          <div className="dish-editor__actions">
            <button type="submit" className="one-menu__primary" disabled={busy}>
              {t("Add section")}
            </button>
            <button type="button" disabled={busy} onClick={() => setNewSection(null)}>
              {t("Close")}
            </button>
          </div>
        </form>
      ) : null}
      {editing === "new" && rows.length > 0 ? (
        <DishEditor
          menuReference={menuReference}
          dish={null}
          sections={rows}
          sectionCode={rows[0]?.code ?? ""}
          allergenChoices={choices}
          keepsStock={view.keepsStock === true}
          client={client}
          onSaved={(message) => {
            setEditing(null);
            setProblem(message);
            reload();
          }}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {editing === "new-combo" && rows.length > 0 ? (
        <ComboEditor
          menuReference={menuReference}
          combo={null}
          dishes={comboDishChoices(rows, combos)}
          sections={rows}
          sectionCode={rows[rows.length - 1]?.code ?? ""}
          client={client}
          onSaved={(message) => {
            setEditing(null);
            setProblem(message);
            reload();
          }}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {combosFailed ? (
        <p className="one-menu__note" role="status">
          {t("The combos could not be read. Read the menu again to edit or add combos.")}{" "}
          <button type="button" onClick={reload}>
            {t("Read again")}
          </button>
        </p>
      ) : null}
      {narrowing && view.permissions.mayEdit ? (
        <p className="one-menu__note">{t("Clear the search and filters to reorder dishes.")}</p>
      ) : null}
      {listingInProgress && !changedOrder ? (
        <div className="one-menu__pending" role="status">
          <p>
            {t(
              "Listing… Prices, choices and the menu go live together; this can take up to a minute. Guests see the changes when it finishes.",
            )}{" "}
            {listingSince !== null
              ? t("{seconds} s", {
                  seconds: Math.max(0, Math.round((clock - listingSince) / 1000)),
                })
              : null}
          </p>
        </div>
      ) : orderPending || changedOrder ? (
        <div className="one-menu__pending" role="status">
          <p>
            {changedOrder
              ? t("You moved dishes. Save the new order; guests see it when the menu is listed.")
              : underway
                ? t(
                    "A listing is under way or stopped part-way. Guests still see the menu as it was. If nothing changes in a minute, continue it.",
                  )
                : view.latestRelease === null
                  ? t("This menu has not been listed yet. Guests do not see it.")
                  : t("There are saved changes not listed yet. Guests still see the listed menu.")}
          </p>
          {changedOrder ? (
            <div className="one-menu__pending-actions">
              <button
                type="button"
                className="one-menu__primary"
                disabled={busy}
                onClick={() => void saveOrder()}
              >
                {t("Save order")}
              </button>
              <button type="button" disabled={busy} onClick={reload}>
                {t("Undo")}
              </button>
            </div>
          ) : mayList ? (
            <div className="one-menu__pending-actions">
              <button
                type="button"
                className="one-menu__primary"
                disabled={busy}
                onClick={() => void listMenu()}
              >
                {underway ? t("Continue listing") : t("List it")}
              </button>
            </div>
          ) : (
            <p className="one-menu__note">
              {t("A manager or the owner lists the menu.")}{" "}
              <Link to={`/app/commerce/menus/${menuReference}`}>{t("Open the menu")}</Link>
            </p>
          )}
        </div>
      ) : null}
      {problem ? (
        <p className="one-menu__message" role="status">
          {problem}
        </p>
      ) : null}
      {shown.length === 0 ? <p className="one-menu__note">{t("No dishes match.")}</p> : null}
      <ol className="one-menu__sections">
        {shown.map((row, sectionIndex) => (
          <li
            key={row.sectionReference}
            className="one-menu__section"
            ref={reordering ? drag.row("sections", sectionIndex) : undefined}
          >
            <h2>
              {reordering ? (
                <span
                  className="drag-handle"
                  aria-hidden="true"
                  title={t("Drag to move this section")}
                  {...drag.handle("sections", sectionIndex)}
                >
                  ⠿
                </span>
              ) : null}
              {row.name}
              {row.nameZh ? (
                <span className="one-menu__name-zh" lang="zh-Hans">
                  {" "}
                  {row.nameZh}
                </span>
              ) : null}
            </h2>
            <ul className="one-menu__dishes" aria-label={row.name}>
              {row.dishes.map((dish, index) =>
                dishRow(dish, row.sectionReference, index, row.dishes.length),
              )}
            </ul>
          </li>
        ))}
      </ol>
      {!narrowing && unplaced.length > 0 ? (
        <section className="one-menu__section" aria-label={t("Not on the menu")}>
          <h2>{t("Not on the menu")}</h2>
          <ul className="one-menu__dishes">
            {unplaced.map((dish, index) => dishRow(dish, null, index, unplaced.length))}
          </ul>
        </section>
      ) : null}
    </WorkspacePage>
  );
}

import { AppFrame, StatePanel } from "@bop-rms/ui";
import { WorkspacePage } from "./WorkspacePage.js";
import { SourceTime } from "./StoreTime.js";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { newOperationReference } from "./RoleAdministrationPages.js";
import {
  MenuPageError,
  menuStage,
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
  type MenuListView,
} from "./store-menu-pages.js";

/** WP-2423 / DEC-MENU-REVISION: Brand menus — edit, review, publish and revise. */
const copy: Record<MenuErrorCode | "Loading", string> = {
  Loading: "Loading menus…",
  PermissionDenied: "You do not have permission for this menu action at Brand level.",
  NotFound: "This menu does not exist for the Brand.",
  Conflict: "The menu changed since you opened it. Refresh and check again.",
  Frozen: "This version was submitted for review and can no longer change. Start a revision.",
  NotRevisable: "Only a submitted or published version can be revised; keep editing this one.",
  ReviewBlocked:
    "The review could not be prepared. Every item needs a published recipe whose ingredients all have current allergen declarations (see Allergens and Recipes), and the Brand allergen list must be approved.",
  OptionPriceMissing:
    "Some options on this menu's items have no published price, so customers could not order them. Set and publish them under Option prices, then submit again.",
  TaxNotCovered:
    "Some items on this menu have no tax rate for one of its order types at this Store (see Tax review), so their price could not be quoted. Fix the product's tax class or the Store's tax configuration, then submit again.",
  OptionRecipeMissing:
    "Some options on this menu's items have no published recipe change (what they do to stock, kitchen and allergens). Set, review and publish them under Option recipes, then submit again.",
  ApprovalRequired:
    "Approval needs someone other than the person who submitted the menu, holding menu approval.",
  Lifecycle: "This step is not possible in the menu's current state.",
  Invalid:
    "The menu is not valid. Each section needs a distinct name, and an item may appear once per section.",
  Offline: "Offline. Nothing was confirmed; retry sends the same request again.",
  Unavailable: "Menus are unavailable.",
};
const stageText = {
  Editing: "Draft — being edited",
  InReview: "In review",
  Approved: "Approved — ready to publish",
  Published: "Published",
  Archived: "Archived",
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
    <WorkspacePage title="Menus">
      <StatePanel
        heading={code === "Loading" ? "Loading" : "Unavailable"}
        tone={code === "Loading" ? "neutral" : "error"}
        status
      >
        <p>{copy[code]}</p>
      </StatePanel>
    </WorkspacePage>
  );
}
const when = (instant: string) => instant.replace("T", " ").slice(0, 16) + " UTC";

export function StoreMenuListPage({
  client = unavailableMenuClient,
}: {
  readonly client?: MenuClient;
}) {
  const { state } = useMenuView(client, null, parseMenuListView);
  if (state.kind !== "Found") return <Failure code={state.kind} />;
  const view: MenuListView = state.view;
  return (
    <WorkspacePage
      title="Menus"
      meta={
        <>
          Source as of <SourceTime instant={view.sourceAsOf} />
        </>
      }
    >
      <p className="bop-muted">
        A menu lists what customers can order, by section. Changes are reviewed by someone else
        before they are published; a published menu is changed through a revision.
      </p>
      <table>
        <thead>
          <tr>
            <th>Menu</th>
            <th>Current version</th>
            <th>Items</th>
            <th>Last published</th>
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
              <td data-label="Version">{stageText[menuStage(menu.publication)]}</td>
              <td data-label="Items">{menu.placements}</td>
              <td data-label="Last published">
                {menu.latestRelease ? when(menu.latestRelease.createdAt) : "—"}
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
}: {
  readonly client?: MenuClient;
}) {
  const params = useParams();
  const reference = parseMenuRouteReference(params.id);
  if (reference === null) return <Failure code="NotFound" />;
  return <MenuBuilder key={reference} client={client} menuReference={reference} />;
}

interface EditableSection {
  readonly key: string;
  readonly sectionReference: string | null;
  readonly code: string | null;
  name: string;
  items: { skuReference: string; featured: boolean }[];
}
let sectionKey = 0;

function MenuBuilder({
  client,
  menuReference,
}: {
  readonly client: MenuClient;
  readonly menuReference: string;
}) {
  const { state, reload } = useMenuView(client, menuReference, parseMenuBuilderView);
  const [name, setName] = useState("");
  const [sections, setSections] = useState<EditableSection[]>([]);
  const [loadedVersion, setLoadedVersion] = useState<number | null>(null);
  const [pending, setPending] = useState<MenuCommand | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "error" | "neutral"; text: string } | null>(null);
  useEffect(() => {
    if (state.kind !== "Found") return;
    const menu = state.view.menu;
    if (loadedVersion === menu.aggregateVersion) return;
    setLoadedVersion(menu.aggregateVersion);
    setName(menu.name);
    setSections(
      menu.sections.map((section) => ({
        key: "s" + ++sectionKey,
        sectionReference: section.sectionReference,
        code: section.code,
        name: section.name,
        items: section.items.map((item) => ({
          skuReference: item.skuReference,
          featured: item.featured,
        })),
      })),
    );
  }, [state, loadedVersion]);
  if (state.kind !== "Found") return <Failure code={state.kind} />;
  const view: MenuBuilderView = state.view;
  const menu = view.menu;
  const stage = menuStage(view.publication);
  const editable = stage === "Editing" && view.permissions.mayEdit;
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
      setPending(null);
      setMessage({ tone: "neutral", text: done });
      setLoadedVersion(null);
      reload();
    } catch (error) {
      const code = error instanceof MenuPageError ? error.code : "Unavailable";
      if (code !== "Offline" && code !== "Unavailable") setPending(null);
      setMessage({ tone: "error", text: copy[code] });
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
  const move = <T,>(list: T[], index: number, delta: number) => {
    const next = [...list];
    const target = index + delta;
    if (target < 0 || target >= next.length) return list;
    [next[index], next[target]] = [next[target] as T, next[index] as T];
    return next;
  };
  const publication = view.publication;
  const mayApproveHere =
    view.permissions.mayApprove && view.submittedBy !== null && view.submittedBy !== view.viewer;
  return (
    <AppFrame title={menu.name} description="CAT-MENU-BUILDER">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">CAT-MENU-BUILDER · Brand</p>
          <h2>{menu.name}</h2>
          <p>
            {stageText[stage]} · {menu.channelCodes.join(", ")} · {menu.orderTypeCodes.join(", ")}
            {view.latestRelease ? ` · last published ${when(view.latestRelease.createdAt)}` : ""}
          </p>
        </div>
        <Link to="/app/commerce/menus">Back to menus</Link>
      </header>
      {message ? (
        <StatePanel
          heading={message.tone === "error" ? "Not done" : "Done"}
          tone={message.tone}
          status
        >
          <p>{message.text}</p>
        </StatePanel>
      ) : null}
      {unpriced.length > 0 ? (
        <StatePanel heading="Missing prices" status>
          <p>
            These items have no price in the price book this Store uses; customers cannot be quoted
            for them: {unpriced.map(label).join(", ")}.
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
                items: section.items,
              })),
            },
            "Menu saved.",
          );
        }}
      >
        <fieldset disabled={!editable || busy}>
          <legend>Menu</legend>
          <label>
            Menu name
            <input value={name} maxLength={120} onChange={(event) => setName(event.target.value)} />
          </label>
        </fieldset>
        {sections.map((section, sectionIndex) => {
          const available = view.sellables.filter(
            (item) =>
              item.active && !section.items.some((i) => i.skuReference === item.skuReference),
          );
          return (
            <fieldset key={section.key} disabled={!editable || busy}>
              <legend>Section {sectionIndex + 1}</legend>
              <label>
                Section name
                <input
                  value={section.name}
                  maxLength={80}
                  onChange={(event) =>
                    updateSection(section.key, (s) => ({ ...s, name: event.target.value }))
                  }
                />
              </label>
              <table>
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Price here</th>
                    <th>Featured</th>
                    <th aria-label="Order" />
                  </tr>
                </thead>
                <tbody>
                  {section.items.map((item, index) => (
                    <tr key={item.skuReference}>
                      <td>{label(item.skuReference)}</td>
                      <td>
                        {priceText(sellables.get(item.skuReference)?.priceMinor ?? null) ??
                          "No price"}
                      </td>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Feature ${label(item.skuReference)}`}
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
                      </td>
                      <td>
                        <button
                          type="button"
                          aria-label={`Move ${label(item.skuReference)} up`}
                          onClick={() =>
                            updateSection(section.key, (s) => ({
                              ...s,
                              items: move(s.items, index, -1),
                            }))
                          }
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          aria-label={`Move ${label(item.skuReference)} down`}
                          onClick={() =>
                            updateSection(section.key, (s) => ({
                              ...s,
                              items: move(s.items, index, 1),
                            }))
                          }
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            updateSection(section.key, (s) => ({
                              ...s,
                              items: s.items.filter((i) => i.skuReference !== item.skuReference),
                            }))
                          }
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {editable && available.length > 0 ? (
                <label>
                  Add item
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
                    <option value="">Choose…</option>
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
                  <button
                    type="button"
                    onClick={() => setSections((current) => move(current, sectionIndex, -1))}
                  >
                    Move section up
                  </button>{" "}
                  {section.items.length === 0 ? (
                    <button
                      type="button"
                      onClick={() =>
                        setSections((current) => current.filter((s) => s.key !== section.key))
                      }
                    >
                      Remove section
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
                    items: [],
                  },
                ])
              }
            >
              Add section
            </button>{" "}
            <button type="submit" disabled={!valid || busy}>
              {pending?.action === "SaveDraft" ? "Retry" : "Save menu"}
            </button>
          </p>
        ) : null}
      </form>
      <section className="detail-section" aria-labelledby="publication">
        <h3 id="publication">Review and publication</h3>
        {stage === "Editing" ? (
          <>
            <p>
              Submitting fixes this version and checks each item's recipe allergens against the
              Brand allergen list; someone else then approves it.
              {view.allergenRegistry ? "" : " The Brand allergen list must be approved first."}
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
                    "Submitted for review.",
                  )
                }
              >
                {pending?.action === "Submit" ? "Retry submit" : "Submit for review"}
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
              {pending?.action === "Approve" ? "Retry approve" : "Approve"}
            </button>
          ) : (
            <p>
              {view.submittedBy === view.viewer
                ? "You submitted this version: someone else must approve it."
                : "Waiting for approval by someone holding menu approval."}
            </p>
          )
        ) : null}
        {stage === "Approved" && publication && view.permissions.mayPublish ? (
          <>
            <p>Publishing makes this version the menu customers order from, starting now.</p>
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
                  "Published. Customers now see this menu.",
                )
              }
            >
              {pending?.action === "Publish" ? "Retry publish" : "Publish"}
            </button>
          </>
        ) : null}
        {stage !== "Editing" && view.permissions.mayEdit ? (
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
                  "A new version was started from this one; edit it and submit it for review.",
                )
              }
            >
              {pending?.action === "Revise" ? "Retry" : "Start a revision"}
            </button>{" "}
            Customers keep seeing the published menu until the revision is published.
          </p>
        ) : null}
      </section>
    </AppFrame>
  );
}

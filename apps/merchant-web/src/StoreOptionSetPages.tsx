import { AppFrame, StatePanel } from "@bop-rms/ui";
import { SourceTime } from "./StoreTime.js";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { newOperationReference } from "./RoleAdministrationPages.js";
import {
  OptionSetPageError,
  choiceRule,
  parseOptionSetEditView,
  parseOptionSetListView,
  unavailableOptionSetClient,
  type OptionChoiceKind,
  type OptionSetClient,
  type OptionSetCommand,
  type OptionSetEditView,
  type OptionSetErrorCode,
  type OptionSetListView,
  type OptionSetRow,
} from "./store-option-set-page.js";

/**
 * WP-2423 slice 4: Brand option sets — the choices a customer makes on an item (milk, extra shot).
 * Options are never deleted (orders refer to them); an option can stop being offered instead.
 */
const copy: Record<OptionSetErrorCode | "Loading", string> = {
  Loading: "Loading options…",
  PermissionDenied: "You do not have permission to change the Brand's options.",
  NotFound: "This option set does not exist for the Brand.",
  Conflict: "The option set changed since you opened it. Refresh and check again.",
  Invalid:
    "The option set is not valid. It needs a name, at least one option, different option names, and limits that customers can meet with the options offered.",
  Offline: "Offline. Nothing was confirmed; retry sends the same request again.",
  Unavailable: "Options are unavailable.",
};
type State<V> =
  { readonly kind: "Loading" | OptionSetErrorCode } | { readonly kind: "Found"; readonly view: V };
function useView<V>(load: () => Promise<unknown>, parse: (value: unknown) => V, key: string) {
  const [state, setState] = useState<State<V>>({ kind: "Loading" });
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => setGeneration((value) => value + 1), []);
  useEffect(() => {
    let active = true;
    void load()
      .then((value) => {
        if (active) setState({ kind: "Found", view: parse(value) });
      })
      .catch((error: unknown) => {
        if (active)
          setState({ kind: error instanceof OptionSetPageError ? error.code : "Unavailable" });
      });
    return () => {
      active = false;
    };
    // load is recreated per render; the key names what it loads.
  }, [key, generation]);
  return { state, reload };
}
function Failure({ code }: { readonly code: OptionSetErrorCode | "Loading" }) {
  return (
    <StatePanel heading="Options" tone={code === "Loading" ? "neutral" : "error"} status>
      <p>{copy[code]}</p>
    </StatePanel>
  );
}
const offeredNames = (set: OptionSetRow) => {
  const names = set.options.filter((option) => option.offered).map((option) => option.name);
  return names.length === 0 ? "None offered" : names.join(", ");
};

export function StoreOptionSetListPage({
  client = unavailableOptionSetClient,
}: {
  readonly client?: OptionSetClient;
}) {
  const { state } = useView(() => client.list(), parseOptionSetListView, "list");
  if (state.kind !== "Found") return <Failure code={state.kind} />;
  const view: OptionSetListView = state.view;
  const current = view.optionSets.filter((set) => !set.archived);
  return (
    <AppFrame title="Options" description="CAT-OPTIONSET-LIST">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">CAT-OPTIONSET-LIST · Brand</p>
          <h2>Options</h2>
          <p>
            Choices customers make on an item, such as milk or an extra shot. Add a set to a product
            on the product page; customers see it once a menu with that product is published. Source
            as of <SourceTime instant={view.sourceAsOf} />
          </p>
        </div>
        {view.permissions.mayEdit ? (
          <Link to="/app/commerce/option-sets/new">New option set</Link>
        ) : null}
      </header>
      {current.length === 0 ? (
        <StatePanel heading="No option sets yet" status>
          <p>Create a set for each choice customers make, for example Milk or Extra shot.</p>
        </StatePanel>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Option set</th>
              <th>Customer chooses</th>
              <th>Options offered</th>
            </tr>
          </thead>
          <tbody>
            {current.map((set) => (
              <tr key={set.optionSetReference}>
                <td>
                  <Link to={`/app/commerce/option-sets/${set.optionSetReference}`}>{set.name}</Link>
                </td>
                <td data-label="Customer chooses">{choiceRule(set)}</td>
                <td data-label="Options offered">{offeredNames(set)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </AppFrame>
  );
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export function StoreOptionSetEditPage({
  client = unavailableOptionSetClient,
}: {
  readonly client?: OptionSetClient;
}) {
  const params = useParams();
  const creating = params.optionSetId === undefined || params.optionSetId === "new";
  const reference = creating ? null : (params.optionSetId ?? "");
  if (reference !== null && !uuid.test(reference)) return <Failure code="NotFound" />;
  return <OptionSetEditor key={reference ?? "new"} client={client} reference={reference} />;
}

interface EditableOption {
  readonly key: string;
  readonly optionReference: string | null;
  name: string;
  offered: boolean;
  defaultChoice: boolean;
}
let optionKey = 0;
const nextKey = () => "option-" + ++optionKey;
const blank = (): EditableOption => ({
  key: nextKey(),
  optionReference: null,
  name: "",
  offered: true,
  defaultChoice: false,
});

function OptionSetEditor({
  client,
  reference,
}: {
  readonly client: OptionSetClient;
  readonly reference: string | null;
}) {
  const navigate = useNavigate();
  const { state, reload } = useView<OptionSetListView | OptionSetEditView>(
    () => (reference === null ? client.list() : client.load(reference)),
    reference === null ? parseOptionSetListView : parseOptionSetEditView,
    reference ?? "new",
  );
  const [name, setName] = useState("");
  const [kind, setKind] = useState<OptionChoiceKind>("One");
  const [minimum, setMinimum] = useState(1);
  const [maximum, setMaximum] = useState<number | null>(1);
  const [perOption, setPerOption] = useState(1);
  const [rows, setRows] = useState<EditableOption[]>([blank(), blank()]);
  const [loadedVersion, setLoadedVersion] = useState<number | null>(null);
  const [pending, setPending] = useState<OptionSetCommand | null>(null);
  const [message, setMessage] = useState<{ tone: "error" | "neutral"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [latest, setLatest] = useState<OptionSetRow | null>(null);
  const shown = (view: OptionSetListView | OptionSetEditView) =>
    view.screenId !== "CAT-OPTIONSET-EDIT"
      ? null
      : latest !== null && latest.aggregateVersion > view.optionSet.aggregateVersion
        ? latest
        : view.optionSet;

  useEffect(() => {
    if (state.kind !== "Found") return;
    const set = shown(state.view);
    if (set === null || loadedVersion === set.aggregateVersion) return;
    setLoadedVersion(set.aggregateVersion);
    setName(set.name);
    setKind(set.kind);
    setMinimum(set.minimum);
    setMaximum(set.maximum);
    setPerOption(set.perOptionMaximum);
    setRows(
      set.options.map((option) => ({
        key: nextKey(),
        optionReference: option.optionReference,
        name: option.name,
        offered: option.offered,
        defaultChoice: option.defaultChoice,
      })),
    );
  }, [state, latest, loadedVersion]);

  if (state.kind !== "Found") return <Failure code={state.kind} />;
  const view = state.view;
  const set = shown(view);
  const mayEdit = view.permissions.mayEdit && !(set?.archived ?? false);
  const effectiveMaximum = kind === "One" ? 1 : maximum;
  const effectiveMinimum = kind === "One" ? Math.min(minimum, 1) : minimum;
  const effectivePerOption = kind === "Quantity" ? perOption : 1;
  const offered = rows.filter((row) => row.offered).length;
  const problems: string[] = [];
  if (name.trim() === "") problems.push("Give the set a name.");
  if (rows.length === 0 || rows.some((row) => row.name.trim() === ""))
    problems.push("Every option needs a name.");
  if (new Set(rows.map((row) => row.name.trim().toLowerCase())).size !== rows.length)
    problems.push("Option names must differ.");
  if (effectiveMaximum !== null && effectiveMaximum < effectiveMinimum)
    problems.push("The most a customer can choose must not be less than the least.");
  if (effectiveMinimum > offered * effectivePerOption)
    problems.push("Customers could not meet the minimum with the options offered.");
  if (kind === "One" && rows.filter((row) => row.defaultChoice).length > 1)
    problems.push("Only one option can be the default when customers choose one.");

  const body = () => ({
    name: name.trim(),
    kind,
    minimum: effectiveMinimum,
    maximum: effectiveMaximum,
    perOptionMaximum: effectivePerOption,
    options: rows.map((row) => ({
      optionReference: row.optionReference,
      name: row.name.trim(),
      offered: row.offered,
      defaultChoice: row.defaultChoice,
    })),
  });
  const send = async (command: OptionSetCommand) => {
    if (!client.command) return;
    setBusy(true);
    setMessage(null);
    setPending(command);
    try {
      const result = (await client.command(command)) as { optionSet?: OptionSetRow };
      setPending(null);
      if (command.action === "Create" && result.optionSet?.optionSetReference) {
        void navigate(`/app/commerce/option-sets/${result.optionSet.optionSetReference}`);
        return;
      }
      if (command.action === "Archive") {
        void navigate("/app/commerce/option-sets");
        return;
      }
      setMessage({ tone: "neutral", text: "Saved." });
      if (result.optionSet) setLatest(result.optionSet);
      reload();
    } catch (error) {
      const code = error instanceof OptionSetPageError ? error.code : "Unavailable";
      // Only an unconfirmed attempt is retried with the same operation; a refusal is final.
      if (code !== "Offline" && code !== "Unavailable") setPending(null);
      setMessage({ tone: "error", text: copy[code] });
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    void send(
      pending && pending.action !== "Archive"
        ? pending
        : set === null
          ? { action: "Create", operationReference: newOperationReference(), ...body() }
          : {
              action: "Save",
              operationReference: newOperationReference(),
              optionSetReference: set.optionSetReference,
              expectedAggregateVersion: set.aggregateVersion,
              ...body(),
            },
    );
  const archive = () =>
    set &&
    void send(
      pending && pending.action === "Archive"
        ? pending
        : {
            action: "Archive",
            operationReference: newOperationReference(),
            optionSetReference: set.optionSetReference,
            expectedAggregateVersion: set.aggregateVersion,
          },
    );
  const update = (key: string, change: Partial<EditableOption>) =>
    setRows((current) =>
      current.map((row) =>
        row.key === key
          ? { ...row, ...change }
          : change.defaultChoice && kind === "One"
            ? { ...row, defaultChoice: false }
            : row,
      ),
    );
  const move = (index: number, by: number) =>
    setRows((current) => {
      const next = [...current];
      const [row] = next.splice(index, 1);
      if (row) next.splice(index + by, 0, row);
      return next;
    });
  const title = set ? set.name : "New option set";
  return (
    <AppFrame title={title} description={set ? "CAT-OPTIONSET-EDIT" : "CAT-OPTIONSET-CREATE"}>
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">
            {set ? "CAT-OPTIONSET-EDIT" : "CAT-OPTIONSET-CREATE"} · Brand
          </p>
          <h2>{title}</h2>
          <p>
            {set
              ? `${set.archived ? "Archived" : "In use"} · version ${set.aggregateVersion}`
              : "Name the choice, say how customers choose, and list the options."}
          </p>
          <p>
            Changes reach customers when a menu with a product that uses this set is next published.
            Each option needs a price (it can be 0) before customers can choose it.
          </p>
        </div>
        <Link to="/app/commerce/option-sets">Back to options</Link>
      </header>
      {message ? (
        <StatePanel
          heading={message.tone === "error" ? "Not saved" : "Done"}
          tone={message.tone}
          status
        >
          <p>{message.text}</p>
        </StatePanel>
      ) : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (problems.length === 0 && !busy && mayEdit) save();
        }}
      >
        <fieldset disabled={!mayEdit || busy}>
          <legend>Choice</legend>
          <label>
            Name
            <input
              value={name}
              maxLength={80}
              required
              placeholder="Milk"
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            Customers
            <select
              value={kind}
              onChange={(event) => {
                const next = event.target.value as OptionChoiceKind;
                setKind(next);
                if (next === "One") {
                  setMaximum(1);
                  setMinimum((value) => Math.min(value, 1));
                } else if (maximum === 1) setMaximum(null);
                if (next !== "Quantity") setPerOption(1);
                else if (perOption === 1) setPerOption(3);
              }}
            >
              <option value="One">Choose one option</option>
              <option value="Any">Choose several options</option>
              <option value="Quantity">Choose a quantity of each option</option>
            </select>
          </label>
          {kind === "One" ? (
            <label>
              <input
                type="checkbox"
                checked={minimum >= 1}
                onChange={(event) => setMinimum(event.target.checked ? 1 : 0)}
              />
              A choice is required
            </label>
          ) : (
            <>
              <label>
                Least in total
                <input
                  type="number"
                  min={0}
                  max={20}
                  value={minimum}
                  onChange={(event) => setMinimum(Math.max(0, Number(event.target.value) || 0))}
                />
              </label>
              <label>
                Most in total (empty for no limit)
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={maximum ?? ""}
                  onChange={(event) =>
                    setMaximum(
                      event.target.value === ""
                        ? null
                        : Math.max(1, Number(event.target.value) || 1),
                    )
                  }
                />
              </label>
              {kind === "Quantity" ? (
                <label>
                  Most of one option
                  <input
                    type="number"
                    min={1}
                    max={20}
                    value={perOption}
                    onChange={(event) => setPerOption(Math.max(1, Number(event.target.value) || 1))}
                  />
                </label>
              ) : null}
            </>
          )}
          <p>
            Customers see:{" "}
            {choiceRule({
              kind,
              minimum: effectiveMinimum,
              maximum: effectiveMaximum,
              perOptionMaximum: effectivePerOption,
            })}
          </p>
        </fieldset>
        <fieldset disabled={!mayEdit || busy}>
          <legend>Options</legend>
          <table>
            <thead>
              <tr>
                <th>Option</th>
                <th>Offered</th>
                <th>Default</th>
                <th aria-label="Order" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={row.key}>
                  <td>
                    <input
                      aria-label={`Option ${index + 1} name`}
                      value={row.name}
                      maxLength={80}
                      placeholder={index === 0 ? "Whole milk" : index === 1 ? "Oat milk" : ""}
                      onChange={(event) => update(row.key, { name: event.target.value })}
                    />
                  </td>
                  <td data-label="Offered">
                    <input
                      type="checkbox"
                      aria-label={`Offer ${row.name || `option ${index + 1}`}`}
                      checked={row.offered}
                      onChange={(event) => update(row.key, { offered: event.target.checked })}
                    />
                  </td>
                  <td data-label="Default">
                    <input
                      type="checkbox"
                      aria-label={`${row.name || `Option ${index + 1}`} is chosen by default`}
                      checked={row.defaultChoice}
                      onChange={(event) => update(row.key, { defaultChoice: event.target.checked })}
                    />
                  </td>
                  <td>
                    {index > 0 ? (
                      <button type="button" onClick={() => move(index, -1)}>
                        Up
                      </button>
                    ) : null}
                    {index < rows.length - 1 ? (
                      <button type="button" onClick={() => move(index, 1)}>
                        Down
                      </button>
                    ) : null}
                    {row.optionReference === null && rows.length > 1 ? (
                      <button
                        type="button"
                        onClick={() =>
                          setRows((current) => current.filter((item) => item.key !== row.key))
                        }
                      >
                        Remove
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            An option that has been saved cannot be removed, because orders refer to it; clear
            “Offered” to stop customers choosing it.
          </p>
          {rows.length < 50 ? (
            <button type="button" onClick={() => setRows((current) => [...current, blank()])}>
              Add option
            </button>
          ) : null}
        </fieldset>
        {problems.length > 0 && mayEdit ? (
          <ul aria-label="Before saving">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        ) : null}
        {mayEdit ? (
          <button type="submit" disabled={problems.length > 0 || busy}>
            {pending && pending.action !== "Archive"
              ? "Retry"
              : set
                ? "Save changes"
                : "Create option set"}
          </button>
        ) : null}
      </form>
      {set && mayEdit ? (
        <section className="detail-section" aria-labelledby="archive-set">
          <h3 id="archive-set">Archive</h3>
          <p>
            Archived sets cannot be added to products. Products already using it keep it until you
            remove it from them.
          </p>
          <button type="button" disabled={busy} onClick={archive}>
            {pending && pending.action === "Archive" ? "Retry archive" : "Archive option set"}
          </button>
        </section>
      ) : null}
    </AppFrame>
  );
}

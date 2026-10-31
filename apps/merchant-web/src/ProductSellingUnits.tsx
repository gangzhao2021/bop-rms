import { useEffect, useRef, useState } from "react";
import { createSellingUnitRecovery } from "./selling-unit-recovery.js";
import { serviceOperationReference } from "./service-control-client.js";
import {
  createProductSellingUnitsClient,
  ProductSellingUnitsError,
  type ProductSellingUnitsView,
} from "./product-selling-units-client.js";
interface ProposedUnit {
  rowReference: string;
  code: string;
  name: string;
  meaning: string;
  precision: string;
  confirmed: boolean;
}
export function ProductSellingUnits({
  action,
  brandReference,
  storeReference,
  csrf,
  locale,
  locked = false,
  onView,
  onPending,
}: {
  readonly action: "Create" | "ReplaceDraft";
  readonly brandReference: string;
  readonly storeReference: string;
  readonly csrf: string;
  readonly locale: string;
  readonly locked?: boolean;
  readonly onView: (view: ProductSellingUnitsView | null) => void;
  readonly onPending: (pending: boolean) => void;
}) {
  const [client] = useState(() => createProductSellingUnitsClient());
  const active = useRef(true),
    flight = useRef<AbortController | null>(null),
    original = useRef<ReturnType<typeof client.prepare> | null>(null),
    callbacks = useRef({ onView, onPending });
  callbacks.current = { onView, onPending };
  const identity = JSON.stringify([action, brandReference, storeReference, csrf]);
  const scope = useRef({ identity, epoch: 0 });
  const originalScope = useRef<string | null>(null);
  const [recovery] = useState(() =>
    createSellingUnitRecovery({
      currentContext: () => (active.current ? scope.current.epoch : -1),
    }),
  );
  const [recoveryChecked, setRecoveryChecked] = useState(false);
  if (scope.current.identity !== identity)
    scope.current = { identity, epoch: scope.current.epoch + 1 };
  const [view, setView] = useState<ProductSellingUnitsView | null>(null),
    [rows, setRows] = useState<ProposedUnit[]>([]),
    [busy, setBusy] = useState(false),
    [pending, setPending] = useState(false),
    [state, setState] = useState(
      "Load current registered units to inspect labels, meanings and quantity precision.",
    );
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      flight.current?.abort();
      callbacks.current.onView(null);
      callbacks.current.onPending(false);
    };
  }, []);
  useEffect(() => {
    flight.current?.abort();
    flight.current = null;
    setView(null);
    setRows([]);
    callbacks.current.onView(null);
    if (original.current) {
      setPending(true);
      callbacks.current.onPending(true);
      setState(
        "An original unit registration belongs to the previous scope. Keep this page open and restore that scope before retrying; no new registration is allowed.",
      );
    } else {
      setPending(false);
      callbacks.current.onPending(true);
      setState(
        "Check the original unit registration before inspecting definitions or saving a Product.",
      );
    }
    setRecoveryChecked(false);
    void run("Check");
  }, [identity]);
  useEffect(() => {
    if (!view) return;
    const observedScope = { ...scope.current };
    const timer = setTimeout(
      () => {
        if (
          active.current &&
          scope.current.epoch === observedScope.epoch &&
          scope.current.identity === observedScope.identity &&
          !original.current
        )
          setState(
            "Registered unit observation expired. Refresh before selecting units or registering definitions.",
          );
      },
      Math.max(0, Date.parse(view.validUntil) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [view]);
  useEffect(() => {
    if (!pending) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [pending]);
  async function run(mode: "Check" | "Inspect" | "Register" | "Retry" | "Resolve") {
    if (
      flight.current ||
      !active.current ||
      !navigator.onLine ||
      document.visibilityState === "hidden" ||
      (original.current &&
        originalScope.current !== identity &&
        mode !== "Check" &&
        mode !== "Resolve") ||
      (locked && mode !== "Retry" && mode !== "Resolve" && mode !== "Check")
    )
      return;
    const captured = { ...scope.current };
    const request = new AbortController();
    const admitted = () =>
      active.current &&
      scope.current.identity === captured.identity &&
      scope.current.epoch === captured.epoch &&
      !request.signal.aborted;
    flight.current = request;
    setBusy(true);
    if (mode === "Register" || mode === "Retry" || mode === "Resolve") {
      setPending(true);
      callbacks.current.onPending(true);
    }
    try {
      if (mode === "Check" || mode === "Inspect") {
        await recovery.inspect(action, { brandReference, storeReference }, csrf, request.signal);
        if (!admitted()) return;
        const current = recovery.view();
        setRecoveryChecked(current.checked);
        setPending(current.pending);
        callbacks.current.onPending(!current.checked || current.pending);
        if (current.pending) {
          setView(null);
          callbacks.current.onView(null);
          setState(
            "An original unit registration remains stored. Resolve it before another registration or Product save. Only its operation identity is stored in this browser.",
          );
          return;
        }
        if (mode === "Check") {
          setState(
            "Original unit registration storage checked. Refresh current registered units before selecting definitions.",
          );
          return;
        }
      }
      if (mode === "Resolve") {
        const resolved = await recovery.resolve(
          action,
          { brandReference, storeReference },
          csrf,
          request.signal,
        );
        if (!admitted()) return;
        original.current = null;
        originalScope.current = null;
        const current = recovery.view();
        setRecoveryChecked(current.checked);
        setPending(current.pending);
        callbacks.current.onPending(!current.checked || current.pending);
        setView(null);
        callbacks.current.onView(null);
        setRows([]);
        setState(
          current.pending
            ? "Original unit registration resolved, but its browser marker could not be removed. Resolve the retained marker before another registration or Product save."
            : resolved.outcome === "Committed"
              ? "Original unit registration confirmed by its recorded receipt. Refresh current registered units before selecting a new SKU unit."
              : "The original unit registration was permanently ended without applying. Refresh current registered units before a new proposal.",
        );
        return;
      }
      if (mode === "Inspect") {
        if (original.current) return;
        callbacks.current.onView(null);
        const read = await client.inspect(
          action,
          { brandReference, storeReference },
          csrf,
          request.signal,
        );
        if (!admitted()) return;
        setView(read);
        callbacks.current.onView(read);
        setState(
          read.presence === "Absent"
            ? "No registered unit dictionary. Review any recorded assignment history before registering explicit meanings."
            : "Current registered units loaded. Only Active definitions can be selected for new SKUs.",
        );
      } else {
        if (mode === "Register") {
          if (
            !recoveryChecked ||
            recovery.view().pending ||
            original.current ||
            !view ||
            rows.length === 0
          )
            throw new ProductSellingUnitsError("Invalid");
          const read = await client.inspect(
            action,
            { brandReference, storeReference },
            csrf,
            request.signal,
          );
          if (!admitted()) return;
          setView(read);
          callbacks.current.onView(read);
          if (
            read.presence !== view.presence ||
            read.historyDigest !== view.historyDigest ||
            read.definitionsDigest !== view.definitionsDigest ||
            read.defaultLocale !== view.defaultLocale
          ) {
            setRows((old) => old.map((row) => ({ ...row, confirmed: false })));
            throw new ProductSellingUnitsError("Conflict");
          }
          const required = read.presence === "Absent" ? read.assignedHistory : [];
          if (
            required.some(
              (history) => !rows.some((row) => row.code === history.unitCode && row.confirmed),
            )
          )
            throw new ProductSellingUnitsError("Invalid");
          const defaultLocale = read.defaultLocale ?? locale;
          const proposed = rows.map((row) => {
            if (!/^[0-6]$/u.test(row.precision)) throw new ProductSellingUnitsError("Invalid");
            return {
              unitReference: null,
              code: row.code,
              semanticDefinition: row.meaning,
              quantityDecimalPlaces: Number(row.precision),
              localizedNames: { [defaultLocale]: row.name },
              lifecycle: "Active" as const,
            };
          });
          originalScope.current = captured.identity;
          original.current = client.prepare(
            {
              action,
              operationReference: serviceOperationReference(),
              expectedRegistryVersion: read.registryVersion,
              defaultLocale,
              units: [...read.units, ...proposed],
              ...(required.length
                ? {
                    bootstrapConfirmation: {
                      historyDigest: read.historyDigest,
                      confirmations: required.map((history) => {
                        const row = rows.find((row) => row.code === history.unitCode);
                        if (!row?.confirmed) throw new ProductSellingUnitsError("Invalid");
                        return {
                          unitCode: row.code,
                          semanticDefinition: row.meaning,
                          confirmed: true as const,
                        };
                      }),
                    },
                  }
                : {}),
            },
            { brandReference, storeReference },
          );
        }
        if (!original.current) throw new ProductSellingUnitsError("Unavailable");
        setPending(true);
        callbacks.current.onPending(true);
        callbacks.current.onView(null);
        await recovery.execute(original.current, csrf, request.signal);
        if (!admitted()) return;
        original.current = null;
        originalScope.current = null;
        const completed = recovery.view();
        setRecoveryChecked(completed.checked);
        setPending(completed.pending);
        callbacks.current.onPending(!completed.checked || completed.pending);
        setRows([]);
        setView(null);
        setState(
          completed.pending
            ? "Original unit registration confirmed, but its browser marker could not be removed. Resolve the retained marker before another registration or Product save."
            : "Original unit registration confirmed. Refresh current units before selecting a new SKU unit.",
        );
      }
    } catch (error) {
      if (!admitted()) {
        if (active.current && original.current) {
          setPending(true);
          callbacks.current.onPending(true);
          setState(
            "An original unit registration belongs to the previous scope. Keep this page open and restore that scope before retrying; no new registration is allowed.",
          );
        }
        return;
      }
      const code = error instanceof ProductSellingUnitsError ? error.code : "Unavailable";
      const retained = recovery.view();
      setRecoveryChecked(retained.checked);
      if (code === "OutcomeUnknown" || retained.pending) {
        setPending(true);
        callbacks.current.onPending(true);
        setState(
          code === "OutcomeUnknown"
            ? "Unit registration outcome is unknown. Retry the original unchanged request or resolve its stored identity before another registration or Product save."
            : `Unit registration not confirmed: ${code}. Resolve the stored original before another registration or Product save.`,
        );
      } else {
        original.current = null;
        originalScope.current = null;
        setPending(false);
        callbacks.current.onPending(!retained.checked);
        setState(
          `Selling units unavailable: ${code}. Refresh current units and review the proposal.`,
        );
      }
      callbacks.current.onView(null);
    } finally {
      if (flight.current === request) {
        flight.current = null;
        if (active.current) setBusy(false);
      }
    }
  }
  const edit = (index: number, change: Partial<ProposedUnit>) =>
    setRows((old) =>
      old.map((row, i) =>
        i === index ? { ...row, ...change, confirmed: change.confirmed ?? false } : row,
      ),
    );
  return (
    <section aria-label="Registered selling units">
      <h3>Selling units</h3>
      <p role="status">{busy ? "Checking current selling unit authority…" : state}</p>
      <button
        type="button"
        disabled={locked || busy || pending || !recoveryChecked}
        onClick={() => void run("Inspect")}
      >
        Refresh registered selling units
      </button>
      {!recoveryChecked && (
        <button type="button" disabled={busy} onClick={() => void run("Check")}>
          Check original unit registration
        </button>
      )}
      {pending && (
        <button type="button" disabled={busy} onClick={() => void run("Resolve")}>
          Resolve stored unit registration
        </button>
      )}
      {pending && original.current && (
        <button
          type="button"
          disabled={busy || originalScope.current !== identity}
          onClick={() => void run("Retry")}
        >
          Retry original unit registration
        </button>
      )}
      {view && (
        <>
          <ul>
            {view.units.map((unit) => (
              <li key={unit.unitReference}>
                {unit.localizedNames[locale] ?? unit.localizedNames[view.defaultLocale ?? ""]} ·{" "}
                {unit.code} · {unit.lifecycle} · up to {unit.quantityDecimalPlaces} decimal places.{" "}
                {unit.semanticDefinition}
              </li>
            ))}
          </ul>
          {view.assignedHistory.length > 0 && (
            <div>
              <h4>Recorded unit assignments</h4>
              <ul>
                {view.assignedHistory.map((history) => (
                  <li key={history.unitCode}>
                    {history.unitCode}: {history.currentSkuCount} current SKUs,{" "}
                    {history.historicalAssignmentCount} historical assignments. Recorded quantities:{" "}
                    {history.quantities.join(", ")}
                  </li>
                ))}
              </ul>
              <p>
                For the first dictionary, explicitly confirm each recorded code's meaning. Existing
                quantities are retained.
              </p>
            </div>
          )}
          <fieldset disabled={locked || busy || pending || !recoveryChecked}>
            <legend>Register explicit unit definitions</legend>
            <p>
              Registration locale:{" "}
              {(view.defaultLocale ?? locale) || "Choose the Product default locale first"}.
              Describe the meaning; no unit meaning is supplied automatically.
            </p>
            {rows.map((row, index) => (
              <div key={row.rowReference}>
                <label>
                  New unit {index + 1} code
                  <input
                    value={row.code}
                    maxLength={64}
                    onChange={(e) => edit(index, { code: e.currentTarget.value })}
                  />
                </label>
                <label>
                  New unit {index + 1} name
                  <input
                    value={row.name}
                    maxLength={120}
                    onChange={(e) => edit(index, { name: e.currentTarget.value })}
                  />
                </label>
                <label>
                  New unit {index + 1} meaning
                  <input
                    value={row.meaning}
                    maxLength={240}
                    onChange={(e) => edit(index, { meaning: e.currentTarget.value })}
                  />
                </label>
                <label>
                  New unit {index + 1} decimal places
                  <input
                    value={row.precision}
                    inputMode="numeric"
                    maxLength={1}
                    onChange={(e) => edit(index, { precision: e.currentTarget.value })}
                  />
                </label>
                {view.presence === "Absent" &&
                  view.assignedHistory.some((history) => history.unitCode === row.code) && (
                    <label>
                      <input
                        type="checkbox"
                        checked={row.confirmed}
                        onChange={(e) => edit(index, { confirmed: e.currentTarget.checked })}
                      />
                      I confirm this exact meaning for recorded {row.code} assignments.
                    </label>
                  )}
                <button
                  type="button"
                  onClick={() => setRows((old) => old.filter((_, i) => i !== index))}
                >
                  Remove unit definition {index + 1}
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() =>
                setRows((old) => [
                  ...old,
                  {
                    rowReference: serviceOperationReference(),
                    code: "",
                    name: "",
                    meaning: "",
                    precision: "",
                    confirmed: false,
                  },
                ])
              }
            >
              Add unit definition
            </button>
            <button type="button" disabled={rows.length === 0} onClick={() => void run("Register")}>
              Register unit definitions
            </button>
          </fieldset>
        </>
      )}
    </section>
  );
}

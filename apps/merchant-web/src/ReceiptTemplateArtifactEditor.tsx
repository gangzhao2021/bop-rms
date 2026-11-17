import { t } from "./i18n/i18n.js";
import { useReadAgainWhenOnline } from "./reconnect-read.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  releaseOriginalWhenRefused,
  StoreSetupClientError,
  type StoreSetupScope,
} from "./store-setup-client.js";
import { serviceOperationReference } from "./service-control-client.js";
import {
  createReceiptTemplateArtifactClient,
  receiptTemplateArtifactRequiredFields,
  type ReceiptTemplateArtifactKind,
  type ReceiptTemplateArtifactCursor,
  type ReceiptTemplateArtifactsCurrent,
} from "./receipt-template-artifact-client.js";
import {
  createReceiptTemplateArtifactPendingJournal,
  type ReceiptTemplateArtifactPendingJournal,
} from "./receipt-template-artifact-pending-journal.js";
type Client = ReturnType<typeof createReceiptTemplateArtifactClient>;
interface Common {
  client: Client;
  journal: ReceiptTemplateArtifactPendingJournal;
  csrf: string;
  signal: AbortSignal;
  isCurrent?: () => boolean;
}
const check = (input: Common) => {
  if (input.signal.aborted || input.isCurrent?.() === false)
    throw new StoreSetupClientError("ScopeChanged");
};
export async function dispatchReceiptTemplateArtifact(
  input: Common & {
    scope: StoreSetupScope;
    artifactKind: ReceiptTemplateArtifactKind;
    baseline: ReceiptTemplateArtifactsCurrent;
    onReserved: (cursor: ReceiptTemplateArtifactCursor) => void;
    /** b25: the server refused the save outright, so its original was let go. */
    onReleased?: (cursor: ReceiptTemplateArtifactCursor) => void;
  },
) {
  const fresh = await input.client.load({
    storeReference: input.scope.storeReference,
    expectedScope: input.scope,
    signal: input.signal,
  });
  check(input);
  const selected = input.artifactKind === "Layout" ? fresh.layout : fresh.compliance;
  const original =
    input.artifactKind === "Layout" ? input.baseline.layout : input.baseline.compliance;
  if (
    selected?.artifactReference !== original?.artifactReference ||
    selected?.revision !== original?.revision
  )
    throw new StoreSetupClientError("Conflict");
  const content =
    input.artifactKind === "Layout"
      ? {
          profile: "AccessibleDigitalReceiptLayoutV1",
          dataContractVersion: 1,
          renderEngineVersion: 1,
          outputProfile: "AccessibleDigitalReceipt",
          requiredFields: receiptTemplateArtifactRequiredFields,
        }
      : {
          profile: "DigitalReceiptRequiredFieldRuleV1",
          dataContractVersion: 1,
          requiredFields: receiptTemplateArtifactRequiredFields,
          professionalReviewStatus: "NotEvaluated",
          legalConclusion: "NotEvaluated",
        };
  const prepared = await input.client.prepare({
    expectedScope: input.scope,
    artifactKind: input.artifactKind,
    operationReference: serviceOperationReference(),
    expectedArtifactReference: selected?.artifactReference ?? null,
    expectedRevision: selected?.revision ?? 0,
    content,
  });
  check(input);
  await input.journal.reserve(prepared.cursor);
  input.onReserved(prepared.cursor);
  check(input);
  const receipt = await releaseOriginalWhenRefused(
    input.journal,
    prepared.cursor,
    () => input.client.execute(prepared, { csrf: input.csrf, signal: input.signal }),
    input.onReleased,
  );
  check(input);
  const current = await input.client.load({
    storeReference: input.scope.storeReference,
    expectedScope: input.scope,
    signal: input.signal,
  });
  check(input);
  await input.journal.complete(prepared.cursor, receipt, current);
  check(input);
  return { receipt, current };
}
export async function recoverReceiptTemplateArtifact(
  input: Common & { cursor: ReceiptTemplateArtifactCursor },
) {
  const receipt = await input.client.resolve(input.cursor, {
    csrf: input.csrf,
    signal: input.signal,
  });
  check(input);
  const current = await input.client.load({
    storeReference: input.cursor.scope.storeReference,
    expectedScope: input.cursor.scope,
    signal: input.signal,
  });
  check(input);
  await input.journal.complete(input.cursor, receipt, current);
  check(input);
  return { receipt, current };
}
export interface ReceiptTemplateArtifactEditorProps {
  readonly scope: StoreSetupScope;
  readonly csrf: string;
  readonly hidden?: boolean;
  readonly disabled?: boolean;
  /** b25: a preset was saved, so the template draft below offers it without a refresh. */
  readonly onSaved?: () => void;
  readonly client?: Client;
  readonly journalFactory?: (
    scope: StoreSetupScope,
    kind: ReceiptTemplateArtifactKind,
  ) => ReceiptTemplateArtifactPendingJournal;
}
export function ReceiptTemplateArtifactEditor(props: ReceiptTemplateArtifactEditorProps) {
  // b26 (v15 live check of b25): both presets come from one read of the same service, so a read
  // cut off by the connection is said once here, not once per preset. Both are read again by
  // themselves once the connection is back, or with Try again here.
  const [unread, setUnread] = useState<ReadonlySet<ReceiptTemplateArtifactKind>>(() => new Set()),
    [retry, setRetry] = useState(0);
  const readFailed = useCallback(
    (kind: ReceiptTemplateArtifactKind, failed: boolean) =>
      setUnread((old) =>
        old.has(kind) === failed
          ? old
          : new Set(failed ? [...old, kind] : [...old].filter((k) => k !== kind)),
      ),
    [],
  );
  const online = useReadAgainWhenOnline(unread.size > 0, () => setRetry((n) => n + 1));
  return (
    <section hidden={props.hidden} aria-label={t("Receipt presets")}>
      <h4>{t("Receipt presets")}</h4>
      <p>
        {t(
          "Save the receipt layout and the fields every receipt must show; receipt templates are built from these presets. Saving them does not change customer receipts and does not mean a legal professional has approved them.",
        )}
      </p>
      {unread.size > 0 && (
        <p role="alert">
          {t(
            "Receipt presets could not be loaded. They are read again once the connection is back; an earlier save remains protected.",
          )}
          {online ? (
            <>
              {" "}
              <button
                type="button"
                className="store-setup-inline-action"
                onClick={() => setRetry((n) => n + 1)}
              >
                {t("Try again")}
              </button>
            </>
          ) : null}
        </p>
      )}
      {(["Layout", "Compliance"] as const).map((kind) => (
        <Preset key={kind} {...props} kind={kind} retry={retry} onReadFailed={readFailed} />
      ))}
    </section>
  );
}
function Preset({
  scope,
  csrf,
  disabled = false,
  client: injected,
  journalFactory = createReceiptTemplateArtifactPendingJournal,
  onSaved,
  kind,
  retry,
  onReadFailed,
}: ReceiptTemplateArtifactEditorProps & {
  kind: ReceiptTemplateArtifactKind;
  /** b26: the section's Try again, or the connection coming back, reads this preset again. */
  retry: number;
  onReadFailed: (kind: ReceiptTemplateArtifactKind, failed: boolean) => void;
}) {
  const client = useMemo(() => injected ?? createReceiptTemplateArtifactClient(), [injected]);
  const [view, setView] = useState<ReceiptTemplateArtifactsCurrent | null>(null),
    [pending, setPending] = useState<ReceiptTemplateArtifactCursor | null>(null),
    [busy, setBusy] = useState(false),
    [ready, setReady] = useState(false),
    [error, setError] = useState<StoreSetupClientError["code"] | null>(null),
    [notice, setNotice] = useState("");
  const epoch = useRef(0),
    active = useRef<AbortController | null>(null),
    running = useRef(false),
    journal = useRef<ReceiptTemplateArtifactPendingJournal | null>(null);
  const label = kind === "Layout" ? t("receipt layout") : t("required receipt fields"),
    scopeKey = JSON.stringify(scope);
  useEffect(() => {
    const e = ++epoch.current,
      c = new AbortController();
    active.current = c;
    running.current = false;
    setBusy(true);
    setReady(false);
    setView(null);
    setPending(null);
    setError(null);
    setNotice("");
    journal.current = null;
    void client
      .load({ storeReference: scope.storeReference, expectedScope: scope, signal: c.signal })
      .then(async (v) => {
        const j = journalFactory(scope, kind),
          p = await j.load();
        if (e !== epoch.current || c.signal.aborted) return;
        journal.current = j;
        setView(v);
        setPending(p);
        setReady(true);
      })
      .catch((v) => {
        if (e === epoch.current && !c.signal.aborted)
          setError(v instanceof StoreSetupClientError ? v.code : "Unavailable");
      })
      .finally(() => {
        if (e === epoch.current && !c.signal.aborted) setBusy(false);
      });
    return () => {
      epoch.current++;
      active.current?.abort();
      c.abort();
    };
  }, [client, scopeKey, csrf, journalFactory, kind, retry]);
  // b26: a read cut off by the connection is said once, by the section above.
  const readFailed = !ready && !busy && error === "Unavailable";
  useEffect(() => onReadFailed(kind, readFailed), [onReadFailed, kind, readFailed]);
  useEffect(() => {
    if (disabled && running.current) active.current?.abort();
  }, [disabled]);
  useEffect(() => {
    const offline = () => {
      if (running.current) active.current?.abort();
    };
    window.addEventListener("offline", offline);
    return () => window.removeEventListener("offline", offline);
  }, []);
  const action = async (mode: "Save" | "Resolve") => {
    if (running.current || disabled || !navigator.onLine) return;
    running.current = true;
    setBusy(true);
    setError(null);
    setNotice("");
    const e = epoch.current,
      c = new AbortController();
    active.current?.abort();
    active.current = c;
    const valid = () => e === epoch.current && !c.signal.aborted;
    try {
      const j = journal.current ?? journalFactory(scope, kind);
      journal.current = j;
      const p = await j.load();
      if (!valid()) return;
      setPending(p);
      if (mode === "Save" && (p || !view || !ready)) throw new StoreSetupClientError("Conflict");
      if (mode === "Resolve" && !p) throw new StoreSetupClientError("Conflict");
      const common = { client, journal: j, csrf, signal: c.signal, isCurrent: valid };
      const result =
        mode === "Resolve" && p
          ? await recoverReceiptTemplateArtifact({ ...common, cursor: p })
          : view
            ? await dispatchReceiptTemplateArtifact({
                ...common,
                scope,
                artifactKind: kind,
                baseline: view,
                onReserved: (cursor) => {
                  if (valid()) setPending(cursor);
                },
                // b25: a save the server refused never happened; it can be saved again.
                onReleased: () => {
                  if (valid()) setPending(null);
                },
              })
            : null;
      if (result && valid()) {
        setView(result.current);
        setPending(null);
        setReady(true);
        if (result.receipt.outcome === "Committed") onSaved?.();
        setNotice(
          result.receipt.outcome === "Committed"
            ? t("Saved preset confirmed.")
            : t("Earlier save did not commit. You can save again."),
        );
      }
    } catch (v) {
      const code = v instanceof StoreSetupClientError ? v.code : "Unavailable";
      if (e === epoch.current) setError(code);
      // b25: changed elsewhere meanwhile: what is saved now is read and shown by itself.
      if (e === epoch.current && code === "Conflict" && mode === "Save")
        void client
          .load({ storeReference: scope.storeReference, expectedScope: scope, signal: c.signal })
          .then((v) => {
            if (e === epoch.current && !c.signal.aborted) setView(v);
          })
          .catch(() => undefined);
    } finally {
      if (e === epoch.current) {
        running.current = false;
        setBusy(false);
      }
    }
  };
  const saved = kind === "Layout" ? view?.layout : view?.compliance;
  return (
    <section aria-label={label}>
      <h5>{kind === "Layout" ? t("Accessible receipt layout") : t("Required receipt fields")}</h5>
      <p>
        {kind === "Layout"
          ? t("Accessible digital receipt, using the standard receipt fields.")
          : t(
              "Issuer, Store, order number, issue time, items, subtotal, discount, fee, tax, tip, total, payment status and refunded total. Professional and legal review have not been evaluated.",
            )}
      </p>
      {saved ? <p>{t("Saved.")}</p> : ready ? <p>{t("No saved preset yet.")}</p> : null}
      {busy && <p role="status">{t("Loading {label}…", { label: label })}</p>}
      {notice && <p role="status">{notice}</p>}
      {error && !readFailed && (
        <p role="alert">
          {error === "Denied"
            ? t("You do not have permission to manage this receipt preset.")
            : error === "Conflict"
              ? t(
                  "The saved preset was changed elsewhere. What is saved now is shown; save again if you still need to.",
                )
              : error === "OutcomeUnknown"
                ? t(
                    "The save could not be confirmed. Recover the original save before saving again.",
                  )
                : error === "Invalid"
                  ? t("This preset could not be saved as it is.")
                  : !ready
                    ? t(
                        "Receipt presets could not be loaded. They are read again once the connection is back; an earlier save remains protected.",
                      )
                    : t(
                        "Could not connect just now. Try again once connected; an earlier save remains protected.",
                      )}
        </p>
      )}
      {pending && (
        <p role="status">{t("An earlier save must be recovered before another save.")}</p>
      )}
      {pending ? (
        <button
          style={{ minHeight: 44 }}
          type="button"
          disabled={disabled || busy}
          onClick={() => void action("Resolve")}
        >
          {t("Recover original {label} save", { label: label })}
        </button>
      ) : (
        <button
          style={{ minHeight: 44 }}
          type="button"
          disabled={disabled || busy || !ready}
          onClick={() => void action("Save")}
        >
          {t("Save {label}", { label: label })}
        </button>
      )}
    </section>
  );
}

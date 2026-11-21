import { Link } from "react-router";
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { AppFrame, StatePanel } from "@bop-rms/ui";
import {
  BrandDiscoveryError,
  createMerchantBrandDiscoveryClient,
  parseMerchantBrandInvitationStart,
  type MerchantBrandDiscoveryClient,
  type MerchantBrandDiscoverySession,
  type MerchantBrandDiscoveryPage,
} from "./merchant-brand-discovery-client.js";
import { t } from "./i18n/i18n.js";
import { brandLifecycleLabel } from "./brand-lifecycle-label.js";
export interface BrandDiscoveryPageProps {
  readonly client?: MerchantBrandDiscoveryClient;
}
export interface BrandDiscoveryViewProps {
  readonly session: MerchantBrandDiscoverySession | null;
  readonly page: MerchantBrandDiscoveryPage | null;
  readonly status: string;
  readonly busy: boolean;
  readonly stale: boolean;
  readonly onRefresh: () => void;
  readonly onMore: () => void;
  readonly onChoose: (brand: string) => void;
  readonly onRenew: () => void;
  readonly onLogout: () => void;
  readonly onSignIn?: () => void;
  readonly invitation?: ReactNode;
}
export type BrandInvitationStatus =
  "Ready" | "Loading" | "Redirecting" | "Invalid" | "Offline" | "Unavailable" | "OutcomeUnknown";
export interface BrandInvitationViewProps {
  readonly secret: string;
  readonly status: BrandInvitationStatus;
  readonly busy: boolean;
  readonly inputRef?: RefObject<HTMLInputElement | null>;
  readonly onChange: (value: string) => void;
  readonly onSubmit: () => void;
  readonly onCancel: () => void;
}
export function BrandInvitationView({
  secret,
  status,
  busy,
  inputRef,
  onChange,
  onSubmit,
  onCancel,
}: BrandInvitationViewProps) {
  const unknown = status === "OutcomeUnknown";
  return (
    <form
      aria-label={t("Accept a Brand invitation")}
      method="post"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <fieldset>
        <legend>{t("Have an invitation?")}</legend>
        <p id="brand-invitation-help">
          {t("Enter the invitation code from your administrator to continue with secure sign-in.")}
        </p>
        <label htmlFor="brand-invitation-code">{t("Invitation code")}</label>
        <input
          ref={inputRef}
          id="brand-invitation-code"
          type="password"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={43}
          value={secret}
          disabled={busy || unknown}
          aria-describedby="brand-invitation-help brand-invitation-status"
          aria-invalid={status === "Invalid"}
          onChange={(event) => onChange(event.target.value)}
        />
        <p
          id="brand-invitation-status"
          role={status === "Invalid" || status === "Unavailable" || unknown ? "alert" : "status"}
        >
          {status === "Loading"
            ? t("Starting invitation sign-in…")
            : status === "Redirecting"
              ? t("Continuing to secure sign-in…")
              : status === "Invalid"
                ? t("Enter the complete 43-character invitation code.")
                : status === "Offline"
                  ? t("Offline. Reconnect, then enter your invitation code again.")
                  : status === "Unavailable"
                    ? t("Invitation sign-in is unavailable. Re-enter your code to try again.")
                    : unknown
                      ? t(
                          "The result is unknown. No retry was sent. Start again when you are ready to retry.",
                        )
                      : t("Your code is cleared when you continue.")}
        </p>
        <button type="submit" disabled={busy || unknown || secret.length === 0}>
          {t("Accept invitation")}
        </button>
        <button type="button" onClick={onCancel}>
          {busy
            ? t("Cancel invitation sign-in")
            : unknown
              ? t("Start again")
              : t("Clear invitation code")}
        </button>
      </fieldset>
    </form>
  );
}
function BrandInvitationEntry({ client }: { readonly client: MerchantBrandDiscoveryClient }) {
  const [secret, setSecret] = useState(""),
    [status, setStatus] = useState<BrandInvitationStatus>("Ready"),
    [busy, setBusy] = useState(false),
    inputRef = useRef<HTMLInputElement | null>(null),
    generation = useRef(0),
    running = useRef(false),
    controller = useRef<AbortController | null>(null);
  const clear = () => {
    if (inputRef.current) inputRef.current.value = "";
    setSecret("");
  };
  const cancel = () => {
    generation.current++;
    controller.current?.abort();
    running.current = false;
    clear();
    setBusy(false);
    setStatus(navigator.onLine ? "Ready" : "Offline");
  };
  const submit = async () => {
    if (running.current || status === "OutcomeUnknown") return;
    const candidate = secret;
    clear();
    if (!navigator.onLine) {
      setStatus("Offline");
      return;
    }
    if (!/^[A-Za-z0-9_-]{43}$/u.test(candidate)) {
      setStatus("Invalid");
      return;
    }
    const c = new AbortController(),
      g = ++generation.current;
    controller.current?.abort();
    controller.current = c;
    running.current = true;
    setBusy(true);
    setStatus("Loading");
    const current = () => g === generation.current && !c.signal.aborted && navigator.onLine;
    let received = false;
    try {
      const result = await client.startInvitation({ secret: candidate }, { signal: c.signal });
      if (!current()) return;
      received = true;
      const target = parseMerchantBrandInvitationStart(result, window.location.origin);
      clear();
      setStatus("Redirecting");
      window.location.assign(target.authorizationUrl);
    } catch (error) {
      if (current())
        setStatus(
          received
            ? "OutcomeUnknown"
            : error instanceof BrandDiscoveryError && error.code === "Invalid"
              ? "Invalid"
              : error instanceof BrandDiscoveryError && error.code === "OutcomeUnknown"
                ? "OutcomeUnknown"
                : "Unavailable",
        );
    } finally {
      if (current()) {
        running.current = false;
        setBusy(false);
      }
    }
  };
  useEffect(() => {
    generation.current++;
    running.current = false;
    setSecret("");
    setBusy(false);
    setStatus("Ready");
    const forget = () => {
      generation.current++;
      controller.current?.abort();
      running.current = false;
      if (inputRef.current) inputRef.current.value = "";
    };
    const offline = () => {
      forget();
      setSecret("");
      setBusy(false);
      setStatus("Offline");
    };
    const pagehide = () => {
      forget();
      setSecret("");
      setBusy(false);
      setStatus("Ready");
    };
    window.addEventListener("offline", offline);
    window.addEventListener("pagehide", pagehide);
    return () => {
      forget();
      window.removeEventListener("offline", offline);
      window.removeEventListener("pagehide", pagehide);
    };
  }, [client]);
  return (
    <BrandInvitationView
      secret={secret}
      status={status}
      busy={busy}
      inputRef={inputRef}
      onChange={(value) => {
        if (!running.current && status !== "OutcomeUnknown") {
          setSecret(value);
          setStatus("Ready");
        }
      }}
      onSubmit={() => void submit()}
      onCancel={cancel}
    />
  );
}
export function BrandDiscoveryView({
  session,
  page,
  status,
  busy,
  stale,
  onRefresh,
  onMore,
  onChoose,
  onRenew,
  onLogout,
  onSignIn,
  invitation,
}: BrandDiscoveryViewProps) {
  const disabled = busy || stale || status !== "Ready";
  return (
    <AppFrame
      title={t("Brands")}
      description={t("Choose a Brand you are currently authorized to administer.")}
      className="bop-shell--brand-administration"
    >
      <section aria-label={t("Brand access")}>
        <p role="status">
          {status === "Ready"
            ? stale
              ? t("Brand list expired. Refresh before choosing.")
              : t("Current authorized Brands")
            : status === "Loading"
              ? t("Checking current Brand access…")
              : status === "MfaRequired"
                ? t("Recent verification is required before choosing a Brand.")
                : status === "AccessRequired"
                  ? t("Sign in to load your authorized Brands.")
                  : status === "Offline"
                    ? t("Offline. Reconnect and refresh before choosing.")
                    : status === "SelectionConflict"
                      ? t(
                          "This session already has a different Brand selection. Renew your session to choose again.",
                        )
                      : status === "OutcomeUnknown"
                        ? t(
                            "Selection result unknown. Refresh to recover the actual session selection.",
                          )
                        : status === "LogoutPending"
                          ? t(
                              "Sign-out result unknown. Retry sign out; this session cannot authorize new actions.",
                            )
                          : t("Brand access could not be confirmed. Refresh to retry.")}
        </p>
        {status === "AccessRequired" ? (
          <a className="shell-action" href="/merchant/organization/brands/login" onClick={onSignIn}>
            {t("Sign in securely")}
          </a>
        ) : null}
        {status === "AccessRequired" ? invitation : null}
        <button type="button" disabled={busy} onClick={onRefresh}>
          {t("Refresh Brands")}
        </button>
        {session ? (
          <>
            <button
              type="button"
              disabled={busy || status === "LogoutPending" || status === "OutcomeUnknown"}
              onClick={onRenew}
            >
              {t("Renew session")}
            </button>
            <button type="button" disabled={busy} onClick={onLogout}>
              {t("Sign out")}
            </button>
          </>
        ) : null}
        {session?.selectedBrandReference && status === "Ready" ? (
          <p>
            <Link to={`/app/organization/brands/${session.selectedBrandReference}`}>
              {t("Continue with the selected Brand")}
            </Link>
          </p>
        ) : null}
      </section>
      {page && status === "Ready" ? (
        <section aria-label={t("Authorized Brands")}>
          {page.items.length === 0 ? (
            <StatePanel heading={t("No Brands on this page")} tone="neutral">
              <p>
                {page.hasMore
                  ? t(
                      "No currently authorized Brand appears in this scanned page. Continue to the next page.",
                    )
                  : t("No currently authorized Brand appears on this page.")}
              </p>
            </StatePanel>
          ) : (
            page.items.map((item) => (
              <article key={item.brandReference} className="summary-card">
                <h2>{item.displayName}</h2>
                <p>
                  {item.code} · {brandLifecycleLabel(item.lifecycle)}
                </p>
                <p>{t("Default locale {locale}", { locale: item.defaultLocale })}</p>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onChoose(item.brandReference)}
                >
                  {t("Choose {name}", { name: item.displayName })}
                </button>
              </article>
            ))
          )}
          {page.hasMore ? (
            <button type="button" disabled={disabled} onClick={onMore}>
              {t("More Brands")}
            </button>
          ) : null}
        </section>
      ) : null}
      <p>
        {t(
          "Store totals, Catalogue, Theme and configuration summaries are not available in this discovery view.",
        )}
      </p>
    </AppFrame>
  );
}
export function BrandDiscoveryPage({ client: provided }: BrandDiscoveryPageProps) {
  const client = useMemo(() => provided ?? createMerchantBrandDiscoveryClient(), [provided]),
    [session, setSession] = useState<MerchantBrandDiscoverySession | null>(null),
    [page, setPage] = useState<MerchantBrandDiscoveryPage | null>(null),
    [status, setStatus] = useState("Loading"),
    [busy, setBusy] = useState(false),
    [time, setTime] = useState(Date.now()),
    generation = useRef(0),
    running = useRef(false),
    controller = useRef<AbortController | null>(null),
    original = useRef<{ actorReference: string; brandReference: string } | null>(null),
    currentSession = useRef<MerchantBrandDiscoverySession | null>(null);
  const start = () => {
    if (status === "AccessRequired") setStatus("Loading");
    running.current = true;
    controller.current?.abort();
    client.invalidate();
    generation.current++;
    const c = new AbortController();
    controller.current = c;
    setBusy(true);
    return { c, g: generation.current };
  };
  const valid = (g: number, c: AbortController) =>
    g === generation.current && !c.signal.aborted && navigator.onLine;
  const errorStatus = (error: unknown) =>
    error instanceof BrandDiscoveryError ? error.code : "Unavailable";
  const refresh = async () => {
    if (running.current) return;
    if (!navigator.onLine) {
      setStatus("Offline");
      return;
    }
    const { c, g } = start();
    try {
      const fresh = await client.bootstrap({ signal: c.signal });
      if (!valid(g, c)) return;
      const old = currentSession.current;
      currentSession.current = fresh;
      setSession(fresh);
      setPage(null);
      if (original.current) {
        const pending = original.current;
        if (fresh.actorReference !== pending.actorReference) {
          original.current = null;
          setStatus("ScopeChanged");
          return;
        }
        original.current = null;
        if (fresh.selectedBrandReference === pending.brandReference) {
          window.location.assign(`/app/organization/brands/${pending.brandReference}`);
          return;
        }
        if (fresh.selectedBrandReference !== null) {
          setStatus("SelectionConflict");
          return;
        }
      }
      if (old && old.actorReference !== fresh.actorReference) {
        setStatus("ScopeChanged");
        return;
      }
      if (fresh.recentMfaRequired) {
        setStatus("MfaRequired");
        return;
      }
      const listed = await client.list(fresh, null, { signal: c.signal });
      if (!valid(g, c)) return;
      setPage(listed);
      setTime(Date.now());
      setStatus("Ready");
    } catch (error) {
      if (valid(g, c)) setStatus(errorStatus(error));
    } finally {
      if (valid(g, c)) {
        running.current = false;
        setBusy(false);
      }
    }
  };
  const more = async () => {
    if (
      running.current ||
      !session ||
      !page?.hasMore ||
      Date.now() >= Date.parse(page.validUntil) ||
      !navigator.onLine
    )
      return;
    const { c, g } = start();
    try {
      const result = await client.list(session, page.nextAfterBrandReference, { signal: c.signal });
      if (valid(g, c)) {
        setPage(result);
        setTime(Date.now());
        setStatus("Ready");
      }
    } catch (error) {
      if (valid(g, c)) setStatus(errorStatus(error));
    } finally {
      if (valid(g, c)) {
        running.current = false;
        setBusy(false);
      }
    }
  };
  const choose = async (brand: string) => {
    if (
      running.current ||
      !session ||
      !page ||
      status !== "Ready" ||
      Date.now() >= Date.parse(page.validUntil) ||
      !page.items.some((item) => item.brandReference === brand) ||
      !navigator.onLine
    )
      return;
    const { c, g } = start();
    original.current = { actorReference: session.actorReference, brandReference: brand };
    try {
      const selected = await client.select(session, brand, { signal: c.signal });
      if (valid(g, c)) {
        original.current = null;
        window.location.assign(selected.href);
      }
    } catch (error) {
      if (valid(g, c)) {
        const code = errorStatus(error);
        if (code !== "OutcomeUnknown") original.current = null;
        setStatus(code);
      }
    } finally {
      if (valid(g, c)) {
        running.current = false;
        setBusy(false);
      }
    }
  };
  const renew = async () => {
    if (running.current || !session || !navigator.onLine) return;
    const { c, g } = start();
    try {
      const result = await client.rotate({ csrf: session.csrf }, { signal: c.signal });
      if (valid(g, c)) window.location.assign(result.authorizationUrl);
    } catch (error) {
      if (valid(g, c)) setStatus(errorStatus(error));
    } finally {
      if (valid(g, c)) {
        running.current = false;
        setBusy(false);
      }
    }
  };
  const logout = async () => {
    if (running.current || !session || !navigator.onLine) return;
    const { c, g } = start();
    setPage(null);
    setStatus("LogoutPending");
    try {
      const result = await client.logout({ csrf: session.csrf }, { signal: c.signal });
      if (valid(g, c) && result.status === "browser_logout_required")
        window.location.assign(result.logoutUrl);
    } catch {
      if (valid(g, c)) setStatus("LogoutPending");
    } finally {
      if (valid(g, c)) {
        running.current = false;
        setBusy(false);
      }
    }
  };
  useEffect(() => {
    running.current = false;
    currentSession.current = null;
    original.current = null;
    setSession(null);
    setPage(null);
    void refresh();
    const timer = setInterval(() => setTime(Date.now()), 250);
    const offline = () => {
      generation.current++;
      controller.current?.abort();
      client.invalidate();
      running.current = false;
      setBusy(false);
      setStatus("Offline");
      setPage(null);
    };
    window.addEventListener("offline", offline);
    return () => {
      generation.current++;
      controller.current?.abort();
      client.invalidate();
      clearInterval(timer);
      window.removeEventListener("offline", offline);
    };
    // Each client instance owns its request epoch; a replacement discards the former session.
  }, [client]);
  return (
    <BrandDiscoveryView
      session={session}
      page={page}
      status={status}
      busy={busy}
      stale={page !== null && time >= Date.parse(page.validUntil)}
      onRefresh={() => void refresh()}
      onMore={() => void more()}
      onChoose={(brand) => void choose(brand)}
      onRenew={() => void renew()}
      onLogout={() => void logout()}
      onSignIn={() => {
        generation.current++;
        controller.current?.abort();
        client.invalidate();
        setStatus("Loading");
      }}
      invitation={<BrandInvitationEntry client={client} />}
    />
  );
}

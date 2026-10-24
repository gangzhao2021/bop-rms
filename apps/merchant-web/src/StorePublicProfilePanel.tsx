import { displayLocale, t } from "./i18n/i18n.js";
import { StatePanel } from "@bop-rms/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { serviceOperationReference } from "./service-control-client.js";
import {
  createStorePublicProfileClient,
  StorePublicProfileClientError,
  type StorePublicProfileView,
} from "./store-public-profile-client.js";
import { SourceTime } from "./StoreTime.js";

/**
 * WP-2423 DEC-STORE-CUSTOMER-NAME: Store setup → "Name and contact shown to customers". The Owner
 * sets the Store name customers see (in each language the Store offers), the street address and
 * the phone number once; the menu, order page, pickup panel and receipts issued from then on all
 * use them. Receipts already issued keep the name they were issued with.
 */
export const provinceNames: Readonly<Record<string, string>> = {
  AB: t("Alberta"),
  BC: t("British Columbia"),
  MB: t("Manitoba"),
  NB: t("New Brunswick"),
  NL: t("Newfoundland and Labrador"),
  NS: t("Nova Scotia"),
  NT: t("Northwest Territories"),
  NU: t("Nunavut"),
  ON: t("Ontario"),
  PE: t("Prince Edward Island"),
  QC: t("Quebec"),
  SK: t("Saskatchewan"),
  YT: t("Yukon"),
};

export interface StorePublicProfileFields {
  names: Record<string, string>;
  addressLines: string[];
  locality: string;
  regionCode: string;
  postalCode: string;
  phone: string;
}

/** "+14165550100" → "(416) 555-0100"; other numbers stay as stored. */
export function formatStorePhone(value: string | null): string {
  if (value === null) return "";
  const match = /^\+1([0-9]{3})([0-9]{3})([0-9]{4})$/u.exec(value);
  return match ? `(${match[1]}) ${match[2]}-${match[3]}` : value;
}

export function languageName(locale: string): string {
  try {
    return new Intl.DisplayNames([displayLocale()], { type: "language" }).of(locale) ?? locale;
  } catch {
    return locale;
  }
}

function fieldsOf(view: StorePublicProfileView): StorePublicProfileFields {
  const current = view.current;
  const names: Record<string, string> = {};
  for (const locale of view.locales)
    names[locale] = current?.names.find((entry) => entry.locale === locale)?.storeDisplayName ?? "";
  const lines = [...(current?.address.addressLines ?? [])];
  while (lines.length < 2) lines.push("");
  return {
    names,
    addressLines: lines,
    locality: current?.address.locality ?? "",
    regionCode: current?.address.regionCode ?? "",
    postalCode: current?.address.postalCode ?? "",
    phone: formatStorePhone(current?.businessPhone ?? null),
  };
}

const markup = /[<>{}[\]`*_#]/u;
/** The same rules the server enforces, so mistakes are shown next to the field. */
export function storePublicProfileFieldErrors(
  fields: StorePublicProfileFields,
): Partial<Record<string, string>> {
  const errors: Partial<Record<string, string>> = {};
  for (const [locale, name] of Object.entries(fields.names)) {
    const value = name.trim();
    if (value === "") errors["name-" + locale] = t("Enter the store name customers will see.");
    else if (value.length > 120) errors["name-" + locale] = t("Use 120 characters or fewer.");
    else if (markup.test(value))
      errors["name-" + locale] =
        "Use letters, digits and ordinary punctuation only (no # * _ < >).";
  }
  fields.addressLines.forEach((line, index) => {
    const value = line.trim();
    if (index === 0 && value === "") errors["line-0"] = t("Enter the street address.");
    else if (value.length > 160) errors["line-" + index] = t("Use 160 characters or fewer.");
    else if (markup.test(value))
      errors["line-" + index] = "Write the unit as “Unit 4” or “Suite 4” (no # * _ < >).";
  });
  if (fields.locality.trim() === "") errors.locality = t("Enter the city or town.");
  else if (markup.test(fields.locality)) errors.locality = t("Use letters and spaces only.");
  if (fields.regionCode === "") errors.regionCode = t("Choose the province or territory.");
  const postal = fields.postalCode
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/gu, "");
  if (!/^[ABCEGHJ-NPRSTVXY][0-9][ABCEGHJ-NPRSTV-Z][0-9][ABCEGHJ-NPRSTV-Z][0-9]$/u.test(postal))
    errors.postalCode = t("Enter a Canadian postal code, for example K1A 0B1.");
  const phone = fields.phone.trim();
  if (phone !== "") {
    const digits = phone.replace(/[^0-9]/gu, "");
    const national = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
    if (!/^\+?[0-9 ().-]+$/u.test(phone) || !/^[2-9][0-9]{2}[2-9][0-9]{6}$/u.test(national))
      errors.phone = t("Enter a 10-digit phone number, for example (416) 555-0100.");
  }
  return errors;
}

export function StorePublicProfilePanel({
  csrf,
  client: injected,
}: {
  readonly csrf: string;
  readonly client?: ReturnType<typeof createStorePublicProfileClient>;
}) {
  const client = useMemo(
    () => injected ?? createStorePublicProfileClient({ csrf }),
    [injected, csrf],
  );
  const [view, setView] = useState<StorePublicProfileView | null>(null);
  const [status, setStatus] = useState<"Loading" | "Ready" | "Hidden" | "Unavailable">("Loading");
  const [fields, setFields] = useState<StorePublicProfileFields | null>(null);
  const [busy, setBusy] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [message, setMessage] = useState<{ tone: "status" | "alert"; text: string } | null>(null);
  // One operation per intended publication: a lost answer is retried as the same publication.
  const operation = useRef<{ reference: string; key: string } | null>(null);
  const load = useCallback(async () => {
    try {
      const next = await client.load();
      setView(next);
      setFields(fieldsOf(next));
      setStatus("Ready");
    } catch (error) {
      setStatus(
        error instanceof StorePublicProfileClientError && error.code === "PermissionDenied"
          ? "Hidden"
          : "Unavailable",
      );
    }
  }, [client]);
  useEffect(() => {
    void load();
  }, [load]);
  if (status === "Hidden") return null;
  if (status === "Loading")
    return (
      <section id="store-public-profile" className="receipt-privacy" aria-busy="true">
        <h3>{t("Name and contact shown to customers")}</h3>
        <p role="status">{t("Loading the store name and contact details…")}</p>
      </section>
    );
  if (status === "Unavailable" || view === null || fields === null)
    return (
      <section
        id="store-public-profile"
        className="receipt-privacy"
        aria-labelledby="store-public-profile-heading"
      >
        <h3 id="store-public-profile-heading">{t("Name and contact shown to customers")}</h3>
        <StatePanel
          heading={t("The store name and contact details could not be loaded")}
          tone="error"
          status
        >
          <p>{t("Check your connection, then try again.")}</p>
          <button type="button" onClick={() => void load()}>
            {t("Try again")}
          </button>
        </StatePanel>
      </section>
    );
  const errors = storePublicProfileFieldErrors(fields);
  const invalid = Object.keys(errors).length > 0;
  const readOnly = !view.canChange;
  const submit = async () => {
    if (busy) return;
    setShowErrors(true);
    if (invalid) return;
    const key = JSON.stringify(fields);
    if (operation.current?.key !== key)
      operation.current = { reference: serviceOperationReference(), key };
    const pending = operation.current;
    setBusy(true);
    setMessage(null);
    const names: Record<string, string> = {};
    for (const locale of view.locales) names[locale] = (fields.names[locale] ?? "").trim();
    try {
      await client.save({
        expectedVersion: view.current?.version ?? 0,
        operationReference: pending.reference,
        details: {
          storeDisplayNames: names,
          address: {
            addressLines: fields.addressLines.map((line) => line.trim()).filter((l) => l !== ""),
            locality: fields.locality.trim(),
            regionCode: fields.regionCode,
            postalCode: fields.postalCode.trim(),
          },
          businessPhone: fields.phone.trim() === "" ? null : fields.phone.trim(),
        },
      });
      operation.current = null;
      setShowErrors(false);
      setMessage({
        tone: "status",
        text: t(
          "Published. Customers see these details the next time a page opens or refreshes, and receipts issued from now on use this name. Receipts already issued keep the name they were issued with.",
        ),
      });
      await load();
    } catch (error) {
      const code = error instanceof StorePublicProfileClientError ? error.code : "OutcomeUnknown";
      if (code !== "OutcomeUnknown") operation.current = null;
      setMessage({
        tone: "alert",
        text:
          code === "Invalid"
            ? t("Check the highlighted details and try again.")
            : code === "Conflict"
              ? t(
                  "Someone published new details since you opened this page. They have been reloaded — check them and publish again.",
                )
              : code === "NoChange"
                ? t("Nothing changed — customers already see these details.")
                : code === "PermissionDenied"
                  ? t(
                      "Only the Owner can change these details. Sign in again if your session ended.",
                    )
                  : code === "OutcomeUnknown"
                    ? t("We could not confirm the change. Try again — it is published once.")
                    : t("The details could not be published. Check your connection and try again."),
      });
      if (code === "Conflict") await load();
    } finally {
      setBusy(false);
    }
  };
  const input = (
    id: string,
    label: string,
    value: string,
    onChange: (next: string) => void,
    options: { hint?: string; autoComplete?: string; inputMode?: "text" | "tel" } = {},
  ) => {
    const error = showErrors ? errors[id] : undefined;
    const domId = "store-public-profile-" + id;
    const described = [
      options.hint ? domId + "-hint" : null,
      error ? domId + "-error" : null,
    ].filter((item) => item !== null);
    return (
      <div className="receipt-privacy__field" key={id}>
        <label htmlFor={domId}>{label}</label>
        {options.hint ? (
          <p id={domId + "-hint"} className="receipt-privacy__hint">
            {options.hint}
          </p>
        ) : null}
        <input
          id={domId}
          type={options.inputMode === "tel" ? "tel" : "text"}
          inputMode={options.inputMode ?? "text"}
          autoComplete={options.autoComplete ?? "off"}
          value={value}
          readOnly={readOnly}
          disabled={busy}
          aria-invalid={error ? true : undefined}
          aria-describedby={described.length > 0 ? described.join(" ") : undefined}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
        {error ? (
          <p id={domId + "-error"} className="receipt-privacy__error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    );
  };
  const update = (change: Partial<StorePublicProfileFields>) =>
    setFields((current) => (current === null ? current : { ...current, ...change }));
  const regionError = showErrors ? errors.regionCode : undefined;
  return (
    <section
      id="store-public-profile"
      className="receipt-privacy"
      aria-labelledby="store-public-profile-heading"
    >
      <h3 id="store-public-profile-heading">{t("Name and contact shown to customers")}</h3>
      <p>
        {t(
          "Customers see this name on the menu, their order page, the pickup screen and their receipt, and use the address and phone to reach the store. Receipts already issued keep the name they were issued with.",
        )}
      </p>
      {view.current !== null ? (
        <p className="receipt-privacy__hint">
          {t("Last published")} <SourceTime instant={view.current.publishedAt} />
        </p>
      ) : (
        <p role="note">
          {t("Customers cannot open this store’s menu until its name and address are published.")}
        </p>
      )}
      {readOnly ? <p role="note">{t("Only the Owner can change these details.")}</p> : null}
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {view.locales.map((locale) =>
          input(
            "name-" + locale,
            view.locales.length > 1
              ? t("Store name customers see ({locale})", { locale: languageName(locale) })
              : t("Store name customers see"),
            fields.names[locale] ?? "",
            (next) => update({ names: { ...fields.names, [locale]: next } }),
            { hint: t("For example “Maple Noodle House – King Street”.") },
          ),
        )}
        {fields.addressLines.map((line, index) =>
          input(
            "line-" + index,
            index === 0 ? t("Street address") : t("Unit or suite (optional)"),
            line,
            (next) =>
              update({
                addressLines: fields.addressLines.map((value, at) => (at === index ? next : value)),
              }),
            { autoComplete: index === 0 ? "address-line1" : "address-line2" },
          ),
        )}
        {input(
          "locality",
          t("City or town"),
          fields.locality,
          (next) => update({ locality: next }),
          {
            autoComplete: "address-level2",
          },
        )}
        <div className="receipt-privacy__field">
          <label htmlFor="store-public-profile-regionCode">{t("Province or territory")}</label>
          <select
            id="store-public-profile-regionCode"
            value={fields.regionCode}
            disabled={busy || readOnly}
            aria-invalid={regionError ? true : undefined}
            aria-describedby={regionError ? "store-public-profile-regionCode-error" : undefined}
            onChange={(event) => update({ regionCode: event.currentTarget.value })}
          >
            <option value="">{t("Choose…")}</option>
            {view.regionCodes.map((code) => (
              <option key={code} value={code}>
                {provinceNames[code] ?? code}
              </option>
            ))}
          </select>
          {regionError ? (
            <p
              id="store-public-profile-regionCode-error"
              className="receipt-privacy__error"
              role="alert"
            >
              {regionError}
            </p>
          ) : null}
        </div>
        {input(
          "postalCode",
          t("Postal code"),
          fields.postalCode,
          (next) => update({ postalCode: next }),
          { autoComplete: "postal-code" },
        )}
        {input(
          "phone",
          t("Phone number (optional)"),
          fields.phone,
          (next) => update({ phone: next }),
          {
            hint: t("Customers call this number about their order."),
            autoComplete: "tel",
            inputMode: "tel",
          },
        )}
        {view.canChange ? (
          <div className="card-actions">
            <button type="submit" data-variant="primary" disabled={busy}>
              {busy ? t("Publishing…") : t("Publish name and contact details")}
            </button>
          </div>
        ) : null}
      </form>
      {message ? <p role={message.tone === "alert" ? "alert" : "status"}>{message.text}</p> : null}
    </section>
  );
}

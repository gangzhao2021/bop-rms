import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

export type ReceiptEmailLocale = "en-CA" | "fr-CA";

export interface ReceiptEmailInput {
  readonly locale: ReceiptEmailLocale;
  readonly storeDisplayName: string;
  readonly orderNumber: string;
  readonly issuedAt: string;
  readonly lines: readonly {
    readonly displayName: string;
    readonly quantity: number;
    readonly amountMinor: bigint;
    readonly currencyCode: "CAD";
  }[];
  readonly subtotalMinor: bigint;
  readonly taxMinor: bigint;
  readonly tipMinor: bigint;
  readonly totalMinor: bigint;
  readonly currencyCode: "CAD";
}

export interface RenderedReceiptEmail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  readonly headers: Readonly<{
    "Content-Language": ReceiptEmailLocale;
    "X-BOP-Message-Purpose": "transactional-receipt";
  }>;
}

export class ReceiptEmailTemplateError extends Error {
  readonly code = "RECEIPT_EMAIL_TEMPLATE_INPUT_INVALID";
  constructor() {
    super("receipt email template input is invalid");
    this.name = "ReceiptEmailTemplateError";
  }
}

const copy = {
  "en-CA": {
    subject: "Your receipt is ready",
    heading: "Your receipt",
    order: "Order",
    issued: "Issued",
    item: "Item",
    quantity: "Quantity",
    amount: "Amount",
    subtotal: "Subtotal",
    tax: "Tax",
    tip: "Tip",
    total: "Total",
    notice: "This transactional message contains no marketing or tracking.",
  },
  "fr-CA": {
    subject: "Votre reçu est prêt",
    heading: "Votre reçu",
    order: "Commande",
    issued: "Émis",
    item: "Article",
    quantity: "Quantité",
    amount: "Montant",
    subtotal: "Sous-total",
    tax: "Taxe",
    tip: "Pourboire",
    total: "Total",
    notice: "Ce message transactionnel ne contient ni marketing ni suivi.",
  },
} as const;

function fail(): never {
  throw new ReceiptEmailTemplateError();
}

function exact(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !fields.includes(key))
  )
    return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = descriptors[field];
    if (!descriptor || descriptor.get || descriptor.set || !descriptor.enumerable) return fail();
    result[field] = descriptor.value;
  }
  return Object.freeze(result);
}

function text(value: unknown, maximum: number): string {
  const hasControl =
    typeof value === "string" &&
    Array.from(value).some((character) => {
      const point = character.codePointAt(0);
      return point !== undefined && (point <= 31 || point === 127);
    });
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.trim() !== value ||
    hasControl
  )
    return fail();
  return value;
}

function money(value: unknown): bigint {
  if (typeof value !== "bigint" || value < 0n || value > 999_999_999_999_99n) return fail();
  return value;
}

function formatMoney(amountMinor: bigint, locale: ReceiptEmailLocale): string {
  const dollars = amountMinor / 100n;
  const cents = (amountMinor % 100n).toString().padStart(2, "0");
  return locale === "fr-CA"
    ? `${dollars.toString()},${cents} $ CA`
    : `CA$${dollars.toString()}.${cents}`;
}

function parse(input: unknown): ReceiptEmailInput {
  const raw = exact(input, [
    "locale",
    "storeDisplayName",
    "orderNumber",
    "issuedAt",
    "lines",
    "subtotalMinor",
    "taxMinor",
    "tipMinor",
    "totalMinor",
    "currencyCode",
  ]);
  if ((raw.locale !== "en-CA" && raw.locale !== "fr-CA") || raw.currencyCode !== "CAD")
    return fail();
  if (
    typeof raw.issuedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(raw.issuedAt)
  )
    return fail();
  if (!Array.isArray(raw.lines) || raw.lines.length < 1 || raw.lines.length > 100) return fail();
  const lines = Object.freeze(
    raw.lines.map((value) => {
      const line = exact(value, ["displayName", "quantity", "amountMinor", "currencyCode"]);
      if (
        !Number.isSafeInteger(line.quantity) ||
        (line.quantity as number) < 1 ||
        (line.quantity as number) > 999 ||
        line.currencyCode !== "CAD"
      )
        return fail();
      return Object.freeze({
        displayName: text(line.displayName, 160),
        quantity: line.quantity as number,
        amountMinor: money(line.amountMinor),
        currencyCode: "CAD" as const,
      });
    }),
  );
  const subtotalMinor = money(raw.subtotalMinor);
  const taxMinor = money(raw.taxMinor);
  const tipMinor = money(raw.tipMinor);
  const totalMinor = money(raw.totalMinor);
  if (
    subtotalMinor + taxMinor + tipMinor !== totalMinor ||
    lines.reduce((sum, line) => sum + line.amountMinor, 0n) !== subtotalMinor
  )
    return fail();
  return Object.freeze({
    locale: raw.locale,
    storeDisplayName: text(raw.storeDisplayName, 160),
    orderNumber: text(raw.orderNumber, 64),
    issuedAt: raw.issuedAt,
    lines,
    subtotalMinor,
    taxMinor,
    tipMinor,
    totalMinor,
    currencyCode: "CAD",
  });
}

const style = Object.freeze({
  body: { fontFamily: "Arial, sans-serif", color: "#1f2933", lineHeight: 1.5 },
  table: { width: "100%", borderCollapse: "collapse" as const },
  cell: { padding: "8px", borderBottom: "1px solid #cbd2d9", textAlign: "left" as const },
  amount: { padding: "8px", borderBottom: "1px solid #cbd2d9", textAlign: "right" as const },
});

function row(label: string, value: string): ReactNode {
  return createElement(
    "tr",
    null,
    createElement("th", { scope: "row", style: style.cell }, label),
    createElement("td", { style: style.amount }, value),
  );
}

export function renderReceiptEmail(value: unknown): RenderedReceiptEmail {
  const input = parse(value);
  const labels = copy[input.locale];
  const lineText = input.lines.map(
    (line) =>
      `${line.quantity} × ${line.displayName} — ${formatMoney(line.amountMinor, input.locale)}`,
  );
  const textBody = [
    labels.heading,
    input.storeDisplayName,
    `${labels.order}: ${input.orderNumber}`,
    `${labels.issued}: ${input.issuedAt}`,
    "",
    ...lineText,
    "",
    `${labels.subtotal}: ${formatMoney(input.subtotalMinor, input.locale)}`,
    `${labels.tax}: ${formatMoney(input.taxMinor, input.locale)}`,
    `${labels.tip}: ${formatMoney(input.tipMinor, input.locale)}`,
    `${labels.total}: ${formatMoney(input.totalMinor, input.locale)}`,
    "",
    labels.notice,
  ].join("\n");
  const document = createElement(
    "html",
    { lang: input.locale },
    createElement(
      "body",
      { style: style.body },
      createElement(
        "main",
        null,
        createElement("h1", null, labels.heading),
        createElement("p", null, input.storeDisplayName),
        createElement("p", null, `${labels.order}: ${input.orderNumber}`),
        createElement("p", null, `${labels.issued}: ${input.issuedAt}`),
        createElement(
          "table",
          { style: style.table, "aria-label": labels.heading },
          createElement(
            "thead",
            null,
            createElement(
              "tr",
              null,
              createElement("th", { scope: "col", style: style.cell }, labels.item),
              createElement("th", { scope: "col", style: style.amount }, labels.quantity),
              createElement("th", { scope: "col", style: style.amount }, labels.amount),
            ),
          ),
          createElement(
            "tbody",
            null,
            ...input.lines.map((line, index) =>
              createElement(
                "tr",
                { key: index },
                createElement("td", { style: style.cell }, line.displayName),
                createElement("td", { style: style.amount }, line.quantity.toString()),
                createElement(
                  "td",
                  { style: style.amount },
                  formatMoney(line.amountMinor, input.locale),
                ),
              ),
            ),
          ),
          createElement(
            "tfoot",
            null,
            row(labels.subtotal, formatMoney(input.subtotalMinor, input.locale)),
            row(labels.tax, formatMoney(input.taxMinor, input.locale)),
            row(labels.tip, formatMoney(input.tipMinor, input.locale)),
            row(labels.total, formatMoney(input.totalMinor, input.locale)),
          ),
        ),
        createElement("p", null, labels.notice),
      ),
    ),
  );
  return Object.freeze({
    subject: labels.subject,
    text: textBody,
    html: `<!doctype html>${renderToStaticMarkup(document)}`,
    headers: Object.freeze({
      "Content-Language": input.locale,
      "X-BOP-Message-Purpose": "transactional-receipt" as const,
    }),
  });
}

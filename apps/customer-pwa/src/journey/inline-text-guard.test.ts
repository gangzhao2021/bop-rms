import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// WP-2423 C5 (text centralization): every sentence a guest reads on the cart, checkout and order
// status pages comes from `journey/messages.ts` by a stable key, so a second language is one more
// catalog of the same shape instead of a hunt through components. This guard fails when a
// component in those flows writes user-visible English inline again.

const guardedComponents = [
  "../cart/CartPage.tsx",
  "../checkout/CheckoutPage.tsx",
  "../checkout/CheckoutDetailsForm.tsx",
  "../order-status/OrderStatusPage.tsx",
  "../order-status/ContactDetailsSection.tsx",
  "../resume/ResumeScreen.tsx",
] as const;

/** Attributes whose values are markup, routing or machine values, never read by a guest. */
const technicalAttributes = new Set([
  "className",
  "id",
  "htmlFor",
  "key",
  "to",
  "path",
  "cartPath",
  "resultPath",
  "sizes",
  "href",
  "type",
  "role",
  "name",
  "autoComplete",
  "inputMode",
  "enterKeyHint",
  "pattern",
  "method",
  "rel",
  "target",
  "lang",
  "form",
  "step",
  "min",
  "max",
  "tone",
  "value",
  "style",
  "aria-labelledby",
  "aria-describedby",
  "aria-controls",
  "aria-live",
  "aria-current",
  "aria-busy",
  "aria-hidden",
]);

function attributeName(node: ts.Node): string | null {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isJsxAttribute(current)) return current.name.getText();
    if (ts.isJsxElement(current) || ts.isJsxSelfClosingElement(current)) return null;
  }
  return null;
}

/**
 * Reviewed machine codes that look like words, per file: values sent to or compared with the server
 * or returned by internal state helpers, never rendered. Their guest-visible labels come from the
 * catalog. JSX text is never exempt; keep each list to codes the file really compares.
 */
const machineCodes: Readonly<Record<string, ReadonlySet<string>>> = {
  // One-time order link page states (compared, never shown).
  "../resume/ResumeScreen.tsx": new Set(["Opening", "Expired", "Open", "TryAgain", "TooManyTries"]),
  // What the page tells the table page it did (router state, never shown), and the guest's
  // service channel the store-service read is asked about (v15 M30/M34; never shown).
  "../cart/CartPage.tsx": new Set(["Held", "Sent", "Pickup"]),
  "../checkout/CheckoutPage.tsx": new Set(["Held", "Sent", "Pickup"]),
  // Contact-method and receipt-choice values of the checkout details contract.
  "../checkout/CheckoutDetailsForm.tsx": new Set([
    "Phone",
    "Email",
    "InSession",
    "TransactionalEmail",
  ]),
  // Refund statuses, serving and kitchen progress codes, and the progress stage (all compared).
  "../order-status/OrderStatusPage.tsx": new Set([
    "Refunded",
    "Pending",
    "All",
    "Some",
    "None",
    "Unknown",
    "Served",
    "Queued",
    "Ready",
    "Preparing",
    "Submitted",
    "Accepted",
  ]),
};

/** Literals that are compared, switched on, used as keys or thrown: codes, not guest text. */
function isMachineUse(node: ts.Node): boolean {
  const parent = node.parent;
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) return true;
  if (ts.isLiteralTypeNode(parent) || ts.isCaseClause(parent)) return true;
  if (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) return true;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
  // A state's tag, or a browser setting: never read by a guest.
  if (
    ts.isPropertyAssignment(parent) &&
    /^(?:kind|status|state|step|channel|choice|action|rootMargin)$/u.test(parent.name.getText())
  )
    return true;
  if (
    ts.isBinaryExpression(parent) &&
    [
      ts.SyntaxKind.EqualsEqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ts.SyntaxKind.InKeyword,
    ].includes(parent.operatorToken.kind)
  )
    return true;
  if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
    const callee = parent.expression.getText();
    if (/(?:^|\.)(?:includes|startsWith|endsWith|getElementById|querySelector)$/u.test(callee))
      return true;
    if (/^(?:Error|TypeError|super|navigate)$/u.test(callee)) return true;
  }
  return false;
}

function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node))
    return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(" ");
  return null;
}

/** Whether a literal is what's being translated: the English text passed to `t()`, not a value. */
function isTranslatedText(node: ts.Node): boolean {
  const parent = node.parent;
  return (
    ts.isCallExpression(parent) &&
    parent.expression.getText() === "t" &&
    parent.arguments[0] === node
  );
}

/**
 * Inline guest-visible text in one component source: JSX text and sentence-like literals.
 * `translated`: text passed to `t()` is fine (the dictionary test checks it has its Chinese).
 */
export function findInlineGuestText(
  fileName: string,
  source: string,
  { translated = false }: { readonly translated?: boolean } = {},
): string[] {
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) {
      const text = node.text.trim();
      if (/[A-Za-z]/u.test(text)) found.push(text);
      return;
    }
    const text = literalText(node);
    if (text !== null) {
      if (translated && isTranslatedText(node)) return;
      const attribute = attributeName(node);
      const technical =
        attribute !== null && (technicalAttributes.has(attribute) || attribute.startsWith("data-"));
      if (!technical && !isMachineUse(node) && !(machineCodes[fileName]?.has(text) ?? false)) {
        const sentence = /[A-Za-z]/u.test(text) && /\s/u.test(text.trim());
        const word = /^[A-Z][a-z’']+[.!?…]?$/u.test(text);
        const readAttribute =
          attribute !== null && /[A-Za-z]/u.test(text) && !/^[a-z]+$/u.test(text);
        if (sentence || word || readAttribute) found.push(text);
      }
      if (ts.isTemplateExpression(node))
        node.templateSpans.forEach((span) => visit(span.expression));
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

const sourceRoot = new URL("..", import.meta.url).pathname;
/** Local previews and the entry points read no guest text; the dictionary is checked by itself. */
const unguarded = /^(?:customer-demo|customer-entry-lifecycle-demo|main\.|i18n\/)/u;
function pageSources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return pageSources(path);
    const file = relative(sourceRoot, path);
    return file.endsWith(".tsx") && !file.endsWith(".test.tsx") && !unguarded.test(file)
      ? [file]
      : [];
  });
}

/**
 * Reviewed codes every page compares or passes around under other names (never rendered), by file.
 * A literal rendered to a guest doesn't belong here: it goes through `t()`.
 */
const pageMachineCodes: Readonly<Record<string, ReadonlySet<string>>> = {
  // What the page tells the table page it did (router state, never shown), and the guest's
  // service channel the store-service read is asked about (v15 M30/M34; never shown).
  "cart/CartPage.tsx": new Set(["Held", "Sent", "Pickup"]),
  "checkout/CheckoutPage.tsx": new Set(["Held", "Sent", "Pickup"]),
  "checkout/CheckoutDetailsForm.tsx": new Set([
    "Phone",
    "Email",
    "InSession",
    "TransactionalEmail",
  ]),
  "delivery-status/DeliveryStatusPage.tsx": new Set(["Unavailable"]),
  "dining/DiningAdmissionPanel.tsx": new Set([
    "Unknown",
    "Ready",
    "Unavailable",
    "Invalid",
    "Joining",
    "Bound",
  ]),
  // The round statuses that mean nothing more will happen.
  "dining/DiningSessionPage.tsx": new Set(["Served"]),
  "dining/DiningStaffCallPanel.tsx": new Set(["Question", "Withdrawn"]),
  // What the error says in a log; a guest never sees it.
  "dining/SettledTableReceipt.tsx": new Set(["settled table receipt "]),
  // The name of the kind of tip sent to the server.
  // The name of the kind of tip sent to the server, and which dishes this phone pays (WP-2423
  // 同桌结账: Whole / Mine / Chosen, never rendered).
  "dining/TablePayPanel.tsx": new Set(["None", "Amount", "Percent", "Whole", "Mine", "Chosen"]),
  // Which dishes this round pays at a pay-first table (WP-2423 shared-table-checkout (a): Whole /
  // Mine / Chosen, sent to the server, never rendered).
  "cart/TablePayChoice.tsx": new Set(["Whole", "Mine", "Chosen"]),
  // The guest's answer to a free table (Start, Join, NewParty) and what starting it gave the menu
  // (Started, Refused, InUse): intents passed between handlers, never rendered.
  "entry/EntryContextPage.tsx": new Set([
    "Missing",
    "Loading",
    "/menu",
    "Start",
    "Join",
    "NewParty",
    "Started",
    "Refused",
    "InUse",
  ]),
  "member/MemberPage.tsx": new Set(["Loading", "Ready", "Failed", "Left"]),
  // M116: how the next opening is worded inside a line (never shown).
  "menu/ClosedStoreNotice.tsx": new Set(["Line"]),
  "menu/MenuPage.tsx": new Set([
    "Loading",
    // The guest's service channel the store-service notice is asked about (never shown).
    "Pickup",
    "DineIn",
    "88px",
    "(min-width: 960px) 45vw, (min-width: 736px) 640px, calc(100vw - 64px)",
    "configure-price- - ",
    "configure-allergens- - ",
  ]),
  "order-status/OrderStatusPage.tsx": new Set([
    "Refunded",
    "Pending",
    "All",
    "Some",
    "None",
    "Unknown",
    "Served",
    "Queued",
    "Ready",
    "Preparing",
    "Submitted",
    "Accepted",
  ]),
  "payment/SessionPaymentResultPage.tsx": new Set(["Checking"]),
  // The instruction the server sends, compared to show it in the guest's language.
  "pickup-code/PickupCodePanel.tsx": new Set([
    "Show this pickup confirmation to staff at the pickup counter.",
  ]),
  "resume/ResumeScreen.tsx": new Set(["Expired", "Opening"]),
  // How a formatter joins its parts, never its words.
  "store/StoreIdentity.tsx": new Set(["Line"]),
};

describe("WP-2423 item 2: no bare English on any guest page", () => {
  for (const file of pageSources(sourceRoot))
    it(`${file} shows nothing outside the dictionary`, () => {
      const source = readFileSync(join(sourceRoot, file), "utf8");
      const found = findInlineGuestText(file, source, { translated: true }).filter(
        (text) => !(pageMachineCodes[file]?.has(text) ?? false),
      );
      expect(found).toEqual([]);
    });

  it("catches bare words beside translated ones, and inside a translated sentence's values", () => {
    const sample = `export const A = ({ busy, n }: { busy: boolean; n: number }) => (
      <>
        <button>{busy ? "Refreshing…" : t("Refresh code")}</button>
        <dd>{busy ? t("Total") : "Calculating…"}</dd>
        <p>{t("{value1} is required.", { value1: \`Choice group \${n}\` })}</p>
      </>
    );`;
    expect(findInlineGuestText("sample.tsx", sample, { translated: true })).toEqual([
      "Refreshing…",
      "Calculating…",
      "Choice group  ",
    ]);
  });
});

describe("WP-2423 C5: guest text in the order flows comes from the messages catalog", () => {
  for (const path of guardedComponents)
    it(`${path} writes no inline guest-visible English`, () => {
      const source = readFileSync(new URL(path, import.meta.url), "utf8");
      expect(findInlineGuestText(path, source)).toEqual([]);
    });

  it("catches the inline forms it guards against and lets markup values through", () => {
    const sample = `
      import { x } from "./a.js";
      export function A({ s }: { s: "Active" | "Expired" }) {
        const label = \`Quantity for \${s}\`;
        if (s === "Expired") throw new Error("invalid state value");
        return (
          <section className="cart-state cart-state--warning" aria-labelledby="h" data-state="Ready">
            <h2 id="h">Your cart</h2>
            <button aria-label="Close">×</button>
            <Panel heading="Loading cart" tone="warning" />
            <p>{s === "Active" ? "Checkout" : "1 item"}</p>
            <span className={\`a \${s}\`} style={{ whiteSpace: "pre-wrap" }}>{label}</span>
            <option value="Email">Email</option>
          </section>
        );
      }`;
    expect(findInlineGuestText("sample.tsx", sample)).toEqual([
      "Quantity for  ",
      "Your cart",
      "Close",
      "Loading cart",
      "Checkout",
      "1 item",
      "Email",
    ]);
  });
});

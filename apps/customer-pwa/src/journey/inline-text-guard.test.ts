import { readFileSync } from "node:fs";
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
] as const;

/** Attributes whose values are markup, routing or machine values, never read by a guest. */
const technicalAttributes = new Set([
  "className",
  "id",
  "htmlFor",
  "key",
  "to",
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
  // Contact-method values of the checkout details contract.
  "../checkout/CheckoutDetailsForm.tsx": new Set(["Phone", "Email"]),
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
    if (/^(?:Error|TypeError)$/u.test(callee)) return true;
  }
  return false;
}

function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node))
    return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(" ");
  return null;
}

/** Inline guest-visible text in one component source: JSX text and sentence-like literals. */
export function findInlineGuestText(fileName: string, source: string): string[] {
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

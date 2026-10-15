import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PriceCommandMessage } from "./StorePricePages.js";
import {
  createPriceClient,
  dollarsToMinor,
  minorToDollars,
  suggestPriceBookCode,
} from "./store-price-pages.js";

describe("WP-2423 price page helpers", () => {
  it("converts dollars and cents exactly", () => {
    expect(dollarsToMinor("4.5")).toBe("450");
    expect(dollarsToMinor("4.50")).toBe("450");
    expect(dollarsToMinor("4")).toBe("400");
    expect(dollarsToMinor("0.05")).toBe("5");
    expect(dollarsToMinor("4.505")).toBeNull();
    expect(dollarsToMinor("-1")).toBeNull();
    expect(dollarsToMinor("100000")).toBeNull();
    expect(minorToDollars("450")).toBe("4.50");
    expect(minorToDollars("5")).toBe("0.05");
    expect(minorToDollars("0")).toBe("0.00");
    expect(suggestPriceBookCode("2026-10-08")).toBe("PRICES-20261008");
  });
  it("carries the items a refusal names", async () => {
    const client = createPriceClient("csrf", () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "NotCovered", sellableReferences: ["a", 1] }), {
          status: 409,
        }),
      ),
    );
    await expect(client.load(null)).rejects.toMatchObject({
      code: "NotCovered",
      sellableReferences: ["a"],
    });
  });
});

describe("WP-2423 price changes on a PIN sign-in", () => {
  const refused = () =>
    Promise.resolve(
      new Response(JSON.stringify({ error: "full_sign_in_required" }), { status: 403 }),
    );
  const command = {
    action: "Discard",
    operationReference: "op",
    priceBookReference: "book",
    expectedAggregateVersion: 1,
  } as const;
  it("maps the PIN-session refusal apart from a missing permission", async () => {
    await expect(createPriceClient("csrf", refused).command?.(command)).rejects.toMatchObject({
      code: "FullSignInRequired",
    });
    const denied = createPriceClient("csrf", () =>
      Promise.resolve(new Response(JSON.stringify({ error: "request_denied" }), { status: 403 })),
    );
    await expect(denied.command?.(command)).rejects.toMatchObject({ code: "PermissionDenied" });
  });
  it("offers to confirm it's you instead of the permission message", () => {
    const html = renderToStaticMarkup(
      <PriceCommandMessage
        message={{ text: "unused", fullSignIn: true }}
        csrf="csrf"
        fetcher={undefined}
        heading="Not created"
      />,
    );
    expect(html).toContain("You signed in with a PIN. Confirm it&#x27;s you");
    expect(html).toContain("Verify it&#x27;s you");
    expect(html).toContain("Sign out and sign in with your account");
    expect(html).not.toContain("permission");
    expect(html).not.toContain("Not created");
    const denied = renderToStaticMarkup(
      <PriceCommandMessage
        message={{
          text: "You do not have permission for this price action at Brand level.",
          fullSignIn: false,
        }}
        csrf="csrf"
        fetcher={undefined}
        heading="Not created"
      />,
    );
    expect(denied).toContain("Not created");
    expect(denied).not.toContain("Verify it&#x27;s you");
  });
});

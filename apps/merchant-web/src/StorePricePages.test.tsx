import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  DiscardDraftAction,
  DiscardDraftQuestion,
  PriceCommandMessage,
  StorePriceList,
  priceBookStatus,
} from "./StorePricePages.js";
import { StoreTimeZoneContext } from "./StoreTime.js";
import {
  createPriceClient,
  unavailablePriceClient,
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

const ref = (n: number) => "0190aaaa-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const listView = (permissions = { mayRead: true, mayEdit: true, mayApprove: true }) =>
  ({
    screenId: "PRICE-BOOK-LIST",
    sourceAsOf: "2026-10-14T18:05:00.000Z",
    viewer: ref(1),
    permissions,
    currencyCode: "CAD",
    storeAssignment: {
      assignmentReference: ref(2),
      priceBookReference: ref(10),
      versionReference: ref(11),
      stableCode: "PRICES-20261001",
      effectiveFrom: "2026-10-01T13:00:00.000Z",
      endedAt: null,
      assignedBy: ref(1),
    },
    assignmentHistory: [
      {
        assignmentReference: ref(2),
        priceBookReference: ref(10),
        versionReference: ref(11),
        stableCode: "PRICES-20261001",
        effectiveFrom: "2026-10-01T13:00:00.000Z",
        endedAt: null,
        assignedBy: ref(1),
      },
    ],
    sellables: [],
    menuSellables: [],
    books: [
      {
        priceBookReference: ref(20),
        stableCode: "PRICES-Q19-TEST",
        lifecycle: "Draft",
        aggregateVersion: 1,
        versionReference: ref(21),
        entries: 3,
        createdAt: "2026-10-15T16:30:00.000Z",
        updatedAt: "2026-10-15T16:30:00.000Z",
      },
      {
        priceBookReference: ref(10),
        stableCode: "PRICES-20261001",
        lifecycle: "Published",
        aggregateVersion: 2,
        versionReference: ref(11),
        entries: 4,
        createdAt: "2026-10-01T12:00:00.000Z",
        updatedAt: "2026-10-01T12:30:00.000Z",
      },
      {
        priceBookReference: ref(30),
        stableCode: "PRICES-OLD",
        lifecycle: "Archived",
        aggregateVersion: 2,
        versionReference: ref(31),
        entries: 0,
        createdAt: "2026-09-01T12:00:00.000Z",
        updatedAt: "2026-09-02T12:00:00.000Z",
      },
    ],
  }) as const;

async function renderList(view: ReturnType<typeof listView>, timeZone?: string) {
  const { MemoryRouter } = await import("react-router");
  const html = renderToStaticMarkup(
    <StoreTimeZoneContext.Provider value={timeZone}>
      <MemoryRouter initialEntries={["/app/commerce/pricing"]}>
        <StorePriceList view={view} client={unavailablePriceClient} csrf="c" fetcher={undefined} />
      </MemoryRouter>
    </StoreTimeZoneContext.Provider>,
  ).replaceAll("<!-- -->", "");
  return { html, text: html.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ") };
}

describe("WP-2423 price book list", () => {
  it("names each state in staff words", () => {
    expect(priceBookStatus("Draft", false)).toBe("Draft, not published yet");
    expect(priceBookStatus("Published", false)).toBe("Published");
    expect(priceBookStatus("Published", true)).toBe("In use at this Store");
    expect(priceBookStatus("Archived", false)).toBe("Discarded");
  });
  it("lists a draft with its state and a link to continue it", async () => {
    const { html, text } = await renderList(listView(), "America/Toronto");
    expect(text).toContain("PRICES-Q19-TEST Draft, not published yet 3");
    expect(html).toContain(`href="/app/commerce/pricing/${ref(20)}"`);
    expect(html).toContain(`aria-label="Continue draft PRICES-Q19-TEST"`);
    expect(text).toContain("PRICES-20261001 In use at this Store 4");
    expect(text).toContain("PRICES-OLD Discarded 0");
    // Only drafts offer to be continued; only published books can be copied.
    expect(html.match(/Continue draft/gu)).toHaveLength(2);
    expect(html).not.toContain("Copy of PRICES-Q19-TEST");
    expect(html).toContain("Copy of PRICES-20261001 (in use here)");
    // Internal references never show as text.
    expect(text).not.toContain(ref(20));
  });
  it("offers a reviewer, not an editor, to review a draft", async () => {
    const { html } = await renderList(
      listView({ mayRead: true, mayEdit: false, mayApprove: true }),
      "America/Toronto",
    );
    expect(html).toContain("Review draft");
    expect(html).not.toContain("Continue draft");
  });
  it("shows times in the Store's time zone, not UTC", async () => {
    const { html, text } = await renderList(listView(), "America/Toronto");
    expect(text).not.toContain("UTC");
    expect(text).toContain("since Oct 1, 2026, 9:00 AM");
    expect(text).toContain("Oct 15, 2026, 12:30 PM");
    expect(text).toContain("PRICES-20261001: Oct 1, 2026, 9:00 AM – now");
    expect(html).toContain('dateTime="2026-10-15T16:30:00.000Z"');
  });
});

describe("WP-2423 discarding a price book draft", () => {
  it("asks before discarding: the button only opens the question", () => {
    const html = renderToStaticMarkup(
      <DiscardDraftAction
        stableCode="PRICES-Q19-TEST"
        busy={false}
        retry={false}
        onDiscard={() => {
          throw new Error("not on render");
        }}
      />,
    ).replaceAll("<!-- -->", "");
    expect(html).toContain(">Discard draft</button><dialog");
    expect(html).not.toMatch(/<dialog[^>]* open/u);
    expect(html).toContain("Discard draft PRICES-Q19-TEST?");
    expect(html).toContain("This cannot be undone.");
    expect(html).toContain("Keep draft");
  });
  it("discards only when confirmed; keeping the draft sends nothing", () => {
    const calls: string[] = [];
    const tree = DiscardDraftQuestion({
      stableCode: "PRICES-Q19-TEST",
      busy: false,
      onDiscard: () => calls.push("discard"),
      onKeep: () => calls.push("keep"),
    });
    const buttons: { props: { children: string; onClick: () => void } }[] = [];
    const walk = (node: unknown) => {
      if (node === null || typeof node !== "object") return;
      if (Array.isArray(node)) return node.forEach(walk);
      const element = node as { type?: unknown; props?: { children?: unknown } };
      if (element.type === "button") buttons.push(element as never);
      walk(element.props?.children);
    };
    walk(tree);
    const press = (label: string) =>
      buttons.find((b) => b.props.children === label)?.props.onClick();
    press("Keep draft");
    expect(calls).toEqual(["keep"]);
    press("Discard draft");
    expect(calls).toEqual(["keep", "discard"]);
  });
  it("offers the same discard again when the answer was lost", () => {
    const html = renderToStaticMarkup(
      <DiscardDraftAction stableCode="P" busy={false} retry onDiscard={() => undefined} />,
    );
    expect(html).toContain("Retry discard");
  });
});

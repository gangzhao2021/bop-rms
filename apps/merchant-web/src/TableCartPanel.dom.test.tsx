// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { TableCartPanel } from "./TableCartPanel.js";
import { buttonNamed, click, mount, settle } from "./dom-test-kit.fixture.js";

// WP-2423 shared-table-checkout (c) (sim M36): staff see the dishes guests put in the table's
// cart and haven't sent, with whose phone added each, and take one out with a reason. The same
// removal is sent again with the same reference until it is answered; nothing can be taken out
// while a guest is paying for these dishes.

const id = (n: number) => "01a4d520-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const csrf = "A".repeat(43);
const line = (n: number, phoneNumber: number | null, phoneLeft = false) => ({
  cartItemReference: id(100 + n),
  sellableReference: id(500 + n),
  optionSelections: [],
  names: {
    "en-CA": n === 1 ? "Mapo tofu" : "Spring rolls",
    "zh-Hans-CA": n === 1 ? "麻婆豆腐" : "春卷",
  },
  quantity: n,
  withOptions: false,
  phoneNumber,
  phoneLeft,
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "cache-control": "no-store", "content-type": "application/json" },
  });

afterEach(() => {
  document.body.innerHTML = "";
});

function server(
  answers: ((body: Record<string, unknown>) => Response)[] = [],
  choosing: null | { phoneNumber: number | null; until: string } = null,
) {
  let version = 4;
  let lines = [line(1, 2, true), line(2, null)];
  const bodies: Record<string, unknown>[] = [];
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    const scripted = body.action === "Remove" ? answers.shift() : undefined;
    if (scripted !== undefined) return scripted(body);
    if (body.action === "Remove") {
      lines = lines.filter((candidate) => candidate.cartItemReference !== body.cartItemReference);
      version += 1;
    }
    return json({
      cart: {
        cartReference: id(9),
        cartVersion: version,
        guestPaying: false,
        ...(choosing === null ? {} : { guestChoosing: version === 4 ? choosing : null }),
        lines,
      },
    });
  });
  return { fetcher, bodies };
}

const panel = (fetcher: typeof fetch) => (
  <TableCartPanel
    diningSessionReference={id(1)}
    csrf={csrf}
    locked={false}
    refreshKey="1"
    fetcher={fetcher}
  />
);

describe("Table cart: staff see the unsent dishes and remove one with a reason", () => {
  it("lists each dish with how many and which phone added it, and whether that phone left", async () => {
    const { fetcher } = server();
    const { container } = await mount(panel(fetcher));
    await settle();
    expect(container.textContent).toContain("In the cart (not ordered yet)");
    expect(container.textContent).toContain("Mapo tofu × 1 · Phone 2 · left");
    expect(container.textContent).toContain("Spring rolls × 2 · Staff");
    // No references or codes on screen.
    expect(container.textContent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/u);
  });

  it("asks why, then removes it once with the reason and the version staff saw", async () => {
    const { fetcher, bodies } = server();
    const { container } = await mount(panel(fetcher));
    await settle();
    await click(buttonNamed(container, "Remove from cart"));
    expect(container.textContent).toContain("Why remove Mapo tofu?");
    await click(buttonNamed(container, "Guest left"));
    await settle();
    expect(bodies.at(-1)).toMatchObject({
      action: "Remove",
      diningSessionReference: id(1),
      cartReference: id(9),
      cartItemReference: id(101),
      expectedCartVersion: 4,
      reason: "GuestLeft",
    });
    expect(container.textContent).not.toContain("Mapo tofu");
    expect(container.textContent).toContain("Spring rolls");
  });

  it("an answer that didn't arrive (503) is retried with the same operation reference", async () => {
    const { fetcher, bodies } = server([
      () => json({ error: "dining_table_cart_unavailable" }, 503),
    ]);
    const { container } = await mount(panel(fetcher));
    await settle();
    await click(buttonNamed(container, "Remove from cart"));
    await click(buttonNamed(container, "Guest asked"));
    await settle();
    expect(container.textContent).toContain("We couldn't confirm the result.");
    await click(buttonNamed(container, "Guest asked"));
    await settle();
    const removes = bodies.filter((body) => body.action === "Remove");
    expect(removes).toHaveLength(2);
    expect(removes[1]?.operationReference).toBe(removes[0]?.operationReference);
    expect(container.textContent).not.toContain("Mapo tofu");
  });

  it("refused while a guest is paying: says so and keeps the dish", async () => {
    const { fetcher } = server([() => json({ error: "dining_table_cart_guest_paying" }, 409)]);
    const { container } = await mount(panel(fetcher));
    await settle();
    await click(buttonNamed(container, "Remove from cart"));
    await click(buttonNamed(container, "Can't make it"));
    await settle();
    expect(container.textContent).toContain("A guest is paying for these dishes now.");
    expect(container.textContent).toContain("Mapo tofu");
  });

  it("an empty cart shows nothing", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json({ cart: null }));
    const { container } = await mount(panel(fetcher));
    await settle();
    expect(container.textContent).toBe("");
  });
});

describe("v15 batch 7: a phone chose what it pays and hasn't paid yet", () => {
  it("says which phone is choosing and that taking a dish out asks it to choose again", async () => {
    const { fetcher, bodies } = server([], { phoneNumber: 2, until: "2026-11-10T20:05:00.000Z" });
    const { container } = await mount(panel(fetcher));
    await settle();
    expect(container.textContent).toMatch(
      /Phone 2 is choosing which of these dishes to pay, until .+\. Taking a dish out ends their choice: their phone asks them to choose again\./u,
    );
    // Staff can still take a dish out (the guest asked, or the kitchen can't make it).
    await click(buttonNamed(container, "Remove from cart"));
    await click(buttonNamed(container, "Guest asked"));
    await settle();
    expect(bodies.at(-1)).toMatchObject({ action: "Remove", reason: "GuestAsked" });
    expect(container.textContent).not.toContain("is choosing which of these dishes");
  });

  it("reads a cart from a server that does not say, and refuses a malformed choice", async () => {
    const { parseTableCart } = await import("./table-cart-client.js");
    const base = { cartReference: id(9), cartVersion: 4, guestPaying: false, lines: [] };
    expect(parseTableCart({ cart: base })?.guestChoosing).toBeNull();
    expect(
      parseTableCart({
        cart: { ...base, guestChoosing: { phoneNumber: null, until: "2026-11-10T20:05:00.000Z" } },
      })?.guestChoosing,
    ).toEqual({ phoneNumber: null, until: "2026-11-10T20:05:00.000Z" });
    expect(() =>
      parseTableCart({ cart: { ...base, guestChoosing: { phoneNumber: 2, until: "soon" } } }),
    ).toThrow();
  });
});

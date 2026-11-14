import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { findInternalText, staticText } from "../e2e/internal-text-patterns.js";
import { PickupIdentityDetails } from "./PickupHandoffForm.js";
import { readPickupIdentityCheck } from "./pickup-identity-check-client.js";
import { parsePickupQueueView } from "./pickup.js";
import { pickupQueueFixture } from "./pickup.fixtures.js";

const item = parsePickupQueueView(pickupQueueFixture()).items[0];
const storeReference = "01900000-0000-7000-8000-000000000004";
const respond = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

it("WP-2423: asks for one order's in-person details with intent only", async () => {
  if (!item) throw new Error("fixture");
  const fetcher = respond(200, { status: "Available", name: "Sam Lee", phoneLast4: "0123" });
  expect(
    await readPickupIdentityCheck({ item, storeReference, csrf: "A".repeat(43) }, fetcher),
  ).toEqual({ status: "Available", name: "Sam Lee", phoneLast4: "0123" });
  const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("/merchant/pickup/identity-check");
  expect(init).toMatchObject({ method: "POST", cache: "no-store", credentials: "same-origin" });
  expect(Object.keys(JSON.parse(String(init.body))).sort()).toEqual([
    "fulfillmentReference",
    "orderReference",
    "storeReference",
  ]);
});

it("WP-2423: refuses a full phone or extra fields, and maps failures to plain outcomes", async () => {
  if (!item) throw new Error("fixture");
  const read = (fetcher: typeof fetch) =>
    readPickupIdentityCheck({ item, storeReference, csrf: "A".repeat(43) }, fetcher);
  expect(
    await read(respond(200, { status: "Available", name: "Sam Lee", phoneLast4: "4165550123" })),
  ).toEqual({ status: "Unavailable" });
  expect(
    await read(respond(200, { status: "Available", name: "Sam", phoneLast4: "0123", phone: "x" })),
  ).toEqual({ status: "Unavailable" });
  expect(await read(respond(200, { status: "Removed" }))).toEqual({ status: "Removed" });
  expect(await read(respond(200, { status: "NotGiven" }))).toEqual({ status: "NotGiven" });
  expect(await read(respond(422, { error: "x" }))).toEqual({ status: "NotEligible" });
  expect(await read(respond(403, { error: "x" }))).toEqual({ status: "Unavailable" });
  expect(
    await read(
      vi.fn(async () => {
        throw new Error("offline");
      }),
    ),
  ).toEqual({ status: "Unavailable" });
});

it("WP-2423: shows the name and only the last four digits, in plain words", () => {
  const render = (details: Parameters<typeof PickupIdentityDetails>[0]["details"]) =>
    renderToStaticMarkup(<PickupIdentityDetails details={details} onRetry={() => undefined} />);
  const available = render({ status: "Available", name: "Sam Lee", phoneLast4: "0123" });
  expect(available).toContain("Name on the order");
  expect(available).toContain("Sam Lee");
  expect(available).toContain('<span aria-hidden="true">•••• </span>');
  expect(available).toContain("0123");
  expect(render({ status: "Available", name: "Sam Lee", phoneLast4: null })).toContain(
    "No phone on the order",
  );
  expect(render({ status: "Removed" })).toContain("deleted after the retention period");
  expect(render({ status: "NotGiven" })).toContain("did not leave a name or phone");
  expect(render({ status: "Unavailable" })).toContain("Try again");
  expect(render(null)).toBe("");
  for (const html of [
    available,
    render({ status: "Removed" }),
    render({ status: "NotGiven" }),
    render({ status: "NotEligible" }),
    render({ status: "Unavailable" }),
    render("Loading"),
  ])
    expect(findInternalText([staticText(html)])).toEqual([]);
});

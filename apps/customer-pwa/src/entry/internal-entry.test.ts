import { expect, test, vi } from "vitest";
import { loadInternalEntryToken } from "./internal-entry.js";
const location = {
  origin: "https://127.0.0.1:4443",
  pathname: "/",
  search: "",
  hash: "#internal-dining=table-2",
};
const response = () =>
  new Response(JSON.stringify({ schemaVersion: 1, qrToken: "synthetic.qr.token" }), {
    headers: { "cache-control": "no-store", "content-type": "application/json" },
  });
test("selected Dining and default Pickup use separate no-store exchange; location remains token-free", async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response());
  expect(await loadInternalEntryToken({ enabled: true, location, fetcher })).toBe(
    "synthetic.qr.token",
  );
  expect(fetcher).toHaveBeenLastCalledWith(
    "/bff/internal-test/dining-entry?table=table-2",
    expect.objectContaining({ cache: "no-store", credentials: "same-origin", redirect: "error" }),
  );
  await loadInternalEntryToken({ enabled: true, location: { ...location, hash: "" }, fetcher });
  expect(fetcher).toHaveBeenLastCalledWith("/bff/internal-test/pickup-entry", expect.anything());
  expect(location.hash).toBe("#internal-dining=table-2");
});
test.each([
  { enabled: false },
  { origin: "https://example.invalid" },
  { pathname: "/menu" },
  { search: "?table=2" },
  { hash: "#other" },
  { hash: "#internal-dining=../../other" },
])("disallowed entry does not fetch: %j", async (change) => {
  const fetcher = vi.fn<typeof fetch>();
  expect(
    await loadInternalEntryToken({
      enabled: !("enabled" in change) || change.enabled,
      location: { ...location, ...change },
      fetcher,
    }),
  ).toBeUndefined();
  expect(fetcher).not.toHaveBeenCalled();
});
test.each([
  new Response("{}", { status: 503 }),
  new Response(JSON.stringify({ schemaVersion: 1, qrToken: "synthetic.qr.token" }), {
    headers: { "content-type": "application/json" },
  }),
  new Response("invalid", {
    headers: { "cache-control": "no-store", "content-type": "application/json" },
  }),
])("failed Dining exchange never falls back to Pickup", async (result) => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(result);
  expect(await loadInternalEntryToken({ enabled: true, location, fetcher })).toBeUndefined();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

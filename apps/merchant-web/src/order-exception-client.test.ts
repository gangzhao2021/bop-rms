import { expect, it, vi } from "vitest";
import { createOrderExceptionClient } from "./order-exception-client.js";
it("uses only the same-origin BFF and never sends scope or credentials in a URL", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    new Response('{"items":[]}', {
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    }),
  );
  expect(await createOrderExceptionClient(fetcher).load()).toEqual({ items: [] });
  expect(fetcher).toHaveBeenCalledWith(
    "/merchant/order-exceptions",
    expect.objectContaining({
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      method: "GET",
    }),
  );
});
it.each([
  new Response("private-denial", { status: 403 }),
  new Response("{}", { headers: { "content-type": "application/json" } }),
  new Response("private-html", {
    headers: { "content-type": "text/html", "cache-control": "no-store" },
  }),
])("rejects denied or cacheable/unexpected responses with a safe error", async (response) => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
  await expect(createOrderExceptionClient(fetcher).load()).rejects.toThrow(
    "ORDER_EXCEPTION_UNAVAILABLE",
  );
});
it("propagates context cancellation and discards a late response", async () => {
  const context = new AbortController();
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => {
    context.abort();
    expect(options?.signal?.aborted).toBe(true);
    return new Response("{}", {
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  });
  await expect(createOrderExceptionClient(fetcher).load(context.signal)).rejects.toThrow(
    "ORDER_EXCEPTION_UNAVAILABLE",
  );
});

it("retains the response-size bound", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(" ".repeat(262145), {
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    }),
  );
  await expect(createOrderExceptionClient(fetcher).load()).rejects.toThrow(
    "ORDER_EXCEPTION_UNAVAILABLE",
  );
});

import { expect, it, vi } from "vitest";
import {
  createKitchenStaleCloseClient,
  KitchenStaleCloseClientError,
  type KitchenStaleCloseBody,
} from "./kitchen-stale-close-client.js";

const csrf = "a".repeat(43);
const body: KitchenStaleCloseBody = {
  idempotencyKey: "018f0f58-767a-7f3b-a1d0-000000000601",
  ticketReference: "018f0f58-767a-7f3b-a1d0-000000000602",
  expectedTicketVersion: "3",
  reasonCode: "ALREADY_SERVED",
  correlationReference: "018f0f58-767a-7f3b-a1d0-000000000603",
};
const json = (status: number, value: unknown) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

it("DEC-KITCHEN-STALE-TICKETS: sends the intent only, with the CSRF header, and reads the closed ticket", async () => {
  const fetcher = vi.fn(async () =>
    json(200, { status: "Closed", ticketReference: body.ticketReference }),
  );
  await expect(
    createKitchenStaleCloseClient({ csrf, fetcher: fetcher as typeof fetch }).close(body),
  ).resolves.toEqual({ status: "Closed" });
  const [path, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe("/merchant/kitchen/stale-ticket/close");
  expect(JSON.parse(String(init.body))).toEqual(body);
  expect((init.headers as Record<string, string>)["X-BOP-CSRF"]).toBe(csrf);
});

it("DEC-KITCHEN-STALE-TICKETS: names each refusal and treats a lost or odd answer as unknown", async () => {
  const code = async (response: Response | Error) => {
    const fetcher = vi.fn(async () => {
      if (response instanceof Error) throw response;
      return response;
    });
    return createKitchenStaleCloseClient({ csrf, fetcher: fetcher as typeof fetch })
      .close(body)
      .then(
        () => "ok",
        (error: unknown) => (error instanceof KitchenStaleCloseClientError ? error.code : "other"),
      );
  };
  expect(await code(json(403, { error: "x" }))).toBe("PermissionDenied");
  expect(await code(json(409, { error: "x" }))).toBe("Conflict");
  expect(await code(json(422, { error: "KITCHEN_STALE_TICKET_NOT_EARLIER_DAY" }))).toBe(
    "NotEarlierDay",
  );
  expect(await code(json(422, { error: "KITCHEN_STALE_TICKET_NOTHING_OPEN" }))).toBe("NothingOpen");
  expect(await code(json(503, { error: "x" }))).toBe("OutcomeUnknown");
  expect(await code(new TypeError("offline"))).toBe("OutcomeUnknown");
  expect(await code(json(200, { status: "Closed", ticketReference: "other" }))).toBe(
    "OutcomeUnknown",
  );
});

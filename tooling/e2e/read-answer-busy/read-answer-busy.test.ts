/**
 * WP-2423 (reads-under-burst, b12 review): a staff read answered "busy" by the answer-time guard
 * must say so in the body the staff screens know. The guard's first body (`service_busy`) was one
 * the merchant clients did not read as busy: a timer-cut `/merchant/session` ended the workspace
 * start as "unavailable" instead of asking again (Owner 2026-11-04: the session is busy, keep
 * waiting and ask again). This runs the API's own guard (`withRequestAcquireBudget` with
 * `sendReadAnswerBusy`, as request-correlation installs it) in front of a slow session read, and
 * the real workspace client against it.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, expect, it } from "vitest";
import {
  readAnswerBusyBody,
  sendReadAnswerBusy,
  withRequestAcquireBudget,
} from "../../../apps/api/src/request-acquire-budget.js";
import { createMerchantWorkspaceClient } from "../../../apps/merchant-web/src/merchant-workspace.js";

const servers: ReturnType<typeof createServer>[] = [];
afterAll(async () => {
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

it("a timer-cut staff session read is asked again by the workspace; a guest read keeps its body", async () => {
  let sessionReads = 0;
  const server = createServer((request, response) =>
    withRequestAcquireBudget(
      async () => {
        const answer = (status: number, body: unknown) => {
          response.statusCode = status;
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify(body));
        };
        if (request.url === "/merchant/session") {
          sessionReads += 1;
          // The first read is still working at its answer time (a rush): the guard answers busy.
          if (sessionReads === 1) await pause(500);
          answer(401, { error: "request_denied" });
          return;
        }
        await pause(500);
        answer(200, { late: true });
      },
      {
        response,
        answerWithinMs: request.method === "GET" ? 150 : undefined,
        busyAnswerMarginMs: 50,
        answerBusy: () => sendReadAnswerBusy(response, request.url),
      },
    ),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // The staff body is the one the workspace, refund and other staff clients read as busy.
  const cut = await fetch(base + "/merchant/session");
  expect(cut.status).toBe(503);
  expect(cut.headers.get("retry-after")).toBe("5");
  expect(await cut.json()).toEqual({ error: "retry_later" });

  // The real workspace client: the busy session is asked again, then the answer is read.
  sessionReads = 0;
  const calls: string[] = [];
  const client = createMerchantWorkspaceClient((input, init) => {
    calls.push(String(input));
    return fetch(base + String(input), init);
  });
  await expect(client.bootstrap()).resolves.toBeNull();
  expect(calls).toEqual(["/merchant/session", "/merchant/session"]);
  expect(sessionReads).toBe(2);

  // A guest read keeps the guest body (the phones read an unknown 503 with Retry-After as busy).
  const guest = await fetch(base + "/customer/menu");
  expect(guest.status).toBe(503);
  expect(guest.headers.get("retry-after")).toBe("5");
  expect(await guest.json()).toEqual(readAnswerBusyBody);
}, 15_000);

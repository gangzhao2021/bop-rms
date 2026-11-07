import assert from "node:assert/strict";
import { URL, URLSearchParams } from "node:url";
import { createRequire } from "node:module";
import { request } from "node:http";
import { createMerchantBffRouter } from "../../../apps/api/src/merchant-bff.ts";
import { parseMerchantWorkspace } from "../../../apps/merchant-web/src/merchant-workspace.ts";
const require = createRequire(new URL("../../../apps/api/package.json", import.meta.url));
const express = require("express");

/** Actual HTTP and persisted service; synthetic Provider/authority supplied by caller. */
export async function verifyPersistentMerchantBffHttp({
  service,
  authorization,
  credentials,
  initialStore,
  targetStore,
  diningTables,
  diningTableListInput,
  diningExpectedTableReferences,
  diningTableCommand,
  diningTableInput,
  diningTableClearInput,
  kitchenQuery,
  taskInbox,
  taskInboxObservedAt = "2026-07-28T12:30:00.000Z",
  kitchenListInput,
  kitchenOrderListInput,
  kitchenGetInput,
  kitchenExpectedWorkItemReference,
  kitchenExpectedStationReference,
  kitchenExpectedOwnerRows,
  diningSessionStart,
  diningSessionStartInput,
  orderQueue,
  expectedOrderNumbers,
  pickupExpectedInitialOrderNumbers,
  pickupQuery,
  pickupListInput,
  pickupExpectedFulfillmentReferences = [],
  orderExceptions,
  orderExceptionsTargetBusinessDate,
}) {
  const app = express();
  app.use(
    "/merchant",
    createMerchantBffRouter({
      service,
      exactOrigin: "https://merchant.example.test",
      acceptedHost: "merchant.example.test",
      ...(diningTables ? { diningTables } : {}),
      ...(diningTableCommand ? { diningTableCommand } : {}),
      ...(kitchenQuery ? { kitchenQuery } : {}),
      ...(taskInbox ? { taskInbox } : {}),
      ...(diningSessionStart ? { diningSessionStart } : {}),
      ...(orderQueue ? { orderQueue } : {}),
      ...(pickupQuery ? { pickupQuery } : {}),
      ...(orderExceptions ? { orderExceptions } : {}),
    }),
  );
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    listener.once("error", reject);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  function send(path, { cookie, body, csrf, origin = "https://merchant.example.test" } = {}) {
    return new Promise((resolve, reject) => {
      const call = request(
        {
          host: "127.0.0.1",
          port: address.port,
          path,
          method: body === undefined ? "GET" : "POST",
          headers: {
            Host: "merchant.example.test",
            Origin: origin,
            "Sec-Fetch-Site": "same-origin",
            ...(cookie ? { Cookie: cookie } : {}),
            ...(csrf ? { "X-BOP-CSRF": csrf } : {}),
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
        },
        (response) => {
          let text = "";
          response.setEncoding("utf8");
          response.on("data", (value) => {
            text += value;
          });
          response.on("end", () =>
            resolve({ status: response.statusCode, headers: response.headers, text }),
          );
          response.on("error", reject);
        },
      );
      call.setTimeout(5000, () => call.destroy(new Error("synthetic HTTP timeout")));
      call.on("error", reject);
      call.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  function issued(response, name) {
    const cookies = response.headers["set-cookie"] ?? [];
    const value = cookies.find(
      (entry) => entry.startsWith(name + "=") && !entry.includes("Max-Age=0"),
    );
    assert(value);
    for (const attribute of ["Path=/", "Secure", "HttpOnly", "SameSite=Lax"])
      assert(value.includes(attribute));
    return value.split(";")[0];
  }
  const kitchenRows = (items) =>
    items.map((item) => ({
      ticketReference: item.ticketReference,
      workItemReference: item.workItemReference,
      orderReference: item.orderReference,
      ticketAggregateVersion: item.ticketAggregateVersion,
      workItemVersion: item.workItemVersion,
      status: item.status,
      requiredQuantity: item.requiredQuantity,
      completedQuantity: item.completedQuantity,
      localizedDisplayNames: item.localizedDisplayNames,
      stationReference: item.stationReference,
    }));
  try {
    const start = await send("/merchant/login?returnTo=/operations/order-exceptions");
    assert.equal(start.status, 303);
    assert.equal(start.headers.location, "https://provider.example.test/authorize");
    const authCookie = issued(start, "__Host-bop-auth");
    const query = new URLSearchParams({
      state: authorization().state,
      code: credentials.generate(),
    });
    const callbackPath = "/merchant/callback?" + query;
    const callback = await send(callbackPath, { cookie: authCookie });
    assert.equal(callback.status, 303);
    assert.equal(callback.headers.location, "/operations/order-exceptions");
    const cookie = issued(callback, "__Host-bop-merchant");
    assert.equal((await send(callbackPath, { cookie: authCookie })).status, 403);
    const initial = await send("/merchant/session", { cookie });
    assert.equal(initial.status, 200);
    assert.equal(initial.headers["cache-control"], "no-store");
    const bootstrap = JSON.parse(initial.text);
    assert.equal(
      parseMerchantWorkspace(bootstrap.workspace).selectedScope.storeReference,
      initialStore,
    );
    if (orderExceptions) {
      const response = await send("/merchant/order-exceptions", { cookie });
      assert.equal(response.status, 200, response.text);
      assert.equal(response.headers["cache-control"], "no-store");
      const result = JSON.parse(response.text);
      assert.equal(result.storeLabel, "Synthetic Store");
      assert.equal(result.freshnessStatus, "Stale");
      assert.deepEqual(result.items, []);
      assert.equal(
        (await send("/merchant/order-exceptions?storeReference=" + targetStore, { cookie })).status,
        403,
      );
    }
    if (diningTables && diningTableListInput && diningExpectedTableReferences) {
      const response = await send("/merchant/dining/tables", {
        cookie,
        body: diningTableListInput,
        csrf: bootstrap.csrf,
      });
      assert.equal(response.status, 200, response.text);
      assert.equal(response.headers["cache-control"], "no-store");
      const result = JSON.parse(response.text);
      assert.deepEqual(
        result.items.map((item) => item.tableReference),
        [diningExpectedTableReferences[0]],
      );
    }
    if (pickupQuery && pickupListInput) {
      const response = await send("/merchant/pickup/query", {
        cookie,
        body: pickupListInput,
        csrf: bootstrap.csrf,
      });
      assert.equal(response.status, 200, response.text);
      assert.equal(response.headers["cache-control"], "no-store");
      const result = JSON.parse(response.text);
      assert.deepEqual(
        result.items.map((item) => item.fulfillmentReference),
        pickupExpectedFulfillmentReferences,
      );
    }
    if (orderQueue && expectedOrderNumbers) {
      const response = await send("/merchant/orders", { cookie });
      assert.equal(response.status, 200);
      assert.equal(response.headers["cache-control"], "no-store");
      const result = JSON.parse(response.text);
      assert.deepEqual(
        result.items.map((item) => item.orderNumber),
        pickupExpectedInitialOrderNumbers ?? [expectedOrderNumbers[0]],
      );
      if (pickupExpectedInitialOrderNumbers) {
        // The owner's Order is the one that is not the fixture Order (the queue is newest first).
        const ownerOrder = result.items.find(
          (item) =>
            pickupExpectedInitialOrderNumbers.includes(item.orderNumber) &&
            item.orderNumber !== expectedOrderNumbers[0],
        );
        const fixtureOrder = result.items.find(
          (item) => item.orderNumber === expectedOrderNumbers[0],
        );
        assert.equal(ownerOrder?.currentPhase, "Accepted");
        assert.equal(ownerOrder?.canRequestAcceptance, false);
        assert.equal(fixtureOrder?.currentPhase, "Submitted");
        assert.equal(fixtureOrder?.currentVersion, 1);
        assert.equal(fixtureOrder?.canRequestAcceptance, false);
      } else {
        assert.equal(result.items[0].currentPhase, "Submitted");
        assert.equal(result.items[0].currentVersion, 1);
        assert.equal(result.items[0].canRequestAcceptance, false);
      }
      assert.equal(
        (
          await send("/merchant/orders?storeReference=" + encodeURIComponent(targetStore), {
            cookie,
          })
        ).status,
        403,
      );
    }
    if (diningTableCommand && diningTableInput) {
      const path = "/merchant/dining/tables/availability";
      assert.equal(
        (
          await send(path, {
            cookie,
            body: diningTableInput,
            csrf: bootstrap.csrf,
            origin: "https://foreign.example.test",
          })
        ).status,
        403,
      );
      assert.equal(
        (await send(path, { cookie, body: diningTableInput, csrf: credentials.generate() })).status,
        403,
      );
      const result = await send(path, { cookie, body: diningTableInput, csrf: bootstrap.csrf });
      assert.equal(result.status, 200);
      assert.equal(result.headers["cache-control"], "no-store");
      assert.deepEqual(JSON.parse(result.text), {
        status: "Applied",
        tableReference: diningTableInput.tableReference,
        operationalState: "TemporarilyBlocked",
        aggregateVersion: 2,
      });
    }
    if (diningTableCommand && diningTableClearInput) {
      const path = "/merchant/dining/tables/availability";
      const cleared = await send(path, {
        cookie,
        body: diningTableClearInput,
        csrf: bootstrap.csrf,
      });
      assert.equal(cleared.status, 200);
      assert.deepEqual(JSON.parse(cleared.text), {
        status: "Applied",
        tableReference: diningTableClearInput.tableReference,
        operationalState: "Available",
        aggregateVersion: 3,
      });
    }
    if (kitchenQuery && kitchenListInput) {
      const path = "/merchant/kitchen/query";
      assert.equal(
        (await send(path, { cookie, body: kitchenListInput, csrf: credentials.generate() })).status,
        403,
      );
      const response = await send(path, { cookie, body: kitchenListInput, csrf: bootstrap.csrf });
      assert.equal(response.status, 200);
      assert.equal(response.headers["cache-control"], "no-store");
      const result = JSON.parse(response.text);
      assert.equal(result.storeReference, initialStore);
      assert.equal(result.operatorStatus, "Unverified");
      assert.equal(result.initializedEmpty, false);
      assert.equal(result.partial, false);
      assert.equal(result.stale, false);
      if (kitchenExpectedOwnerRows) {
        assert.deepEqual(kitchenRows(result.items), kitchenExpectedOwnerRows);
      } else {
        assert.equal(result.items.length, 1);
        assert.deepEqual(
          {
            ticketReference: result.items[0].ticketReference,
            workItemReference: result.items[0].workItemReference,
            status: result.items[0].status,
            requiredQuantity: result.items[0].requiredQuantity,
            completedQuantity: result.items[0].completedQuantity,
            localizedDisplayNames: result.items[0].localizedDisplayNames,
            stationReference: result.items[0].stationReference,
          },
          {
            ticketReference: kitchenListInput.filters.ticketReference,
            workItemReference: kitchenExpectedWorkItemReference,
            status: "Queued",
            requiredQuantity: 2,
            completedQuantity: 0,
            localizedDisplayNames: { "en-CA": "Synthetic noodles" },
            stationReference: kitchenExpectedStationReference,
          },
        );
      }
      if (kitchenOrderListInput) {
        assert.equal(
          (
            await send(path, {
              cookie,
              body: kitchenOrderListInput,
              csrf: credentials.generate(),
            })
          ).status,
          403,
        );
        const byOrderResponse = await send(path, {
          cookie,
          body: kitchenOrderListInput,
          csrf: bootstrap.csrf,
        });
        assert.equal(byOrderResponse.status, 200);
        assert.equal(byOrderResponse.headers["cache-control"], "no-store");
        const byOrder = JSON.parse(byOrderResponse.text);
        assert.equal(byOrder.storeReference, initialStore);
        assert.equal(byOrder.operatorStatus, "Unverified");
        assert.equal(byOrder.initializedEmpty, false);
        assert.equal(byOrder.partial, false);
        assert.equal(byOrder.stale, false);
        assert.equal(byOrder.items.length, 1);
        assert.equal(byOrder.items[0].orderReference, kitchenOrderListInput.filters.orderReference);
        assert.equal(byOrder.items[0].ticketReference, kitchenListInput.filters.ticketReference);
        assert.equal(byOrder.items[0].workItemReference, kitchenExpectedWorkItemReference);
      }
      if (kitchenGetInput) {
        assert.equal(
          (await send(path, { cookie, body: kitchenGetInput, csrf: credentials.generate() }))
            .status,
          403,
        );
        const detailResponse = await send(path, {
          cookie,
          body: kitchenGetInput,
          csrf: bootstrap.csrf,
        });
        assert.equal(detailResponse.status, 200);
        assert.equal(detailResponse.headers["cache-control"], "no-store");
        const detail = JSON.parse(detailResponse.text);
        assert.equal(detail.storeReference, initialStore);
        assert.equal(detail.operatorStatus, "Unverified");
        assert.equal(detail.initializedEmpty, false);
        assert.equal(detail.partial, false);
        assert.equal(detail.stale, false);
        assert.deepEqual(
          {
            ticketReference: detail.item.ticketReference,
            workItemReference: detail.item.workItemReference,
            status: detail.item.status,
            requiredQuantity: detail.item.requiredQuantity,
            completedQuantity: detail.item.completedQuantity,
            localizedDisplayNames: detail.item.localizedDisplayNames,
            stationReference: detail.item.stationReference,
          },
          {
            ticketReference: kitchenListInput.filters.ticketReference,
            workItemReference: kitchenExpectedWorkItemReference,
            status: "Queued",
            requiredQuantity: 2,
            completedQuantity: 0,
            localizedDisplayNames: { "en-CA": "Synthetic noodles" },
            stationReference: kitchenExpectedStationReference,
          },
        );
      }
    }
    if (taskInbox) {
      const response = await send("/merchant/tasks", { cookie });
      assert.equal(response.status, 200);
      assert.equal(response.headers["cache-control"], "no-store");
      assert.deepEqual(JSON.parse(response.text), {
        screenId: "TASK-INBOX",
        storeLabel: "Synthetic Store",
        observedAt: taskInboxObservedAt,
        nextAfterTaskReference: null,
        items: [],
      });
    }
    if (diningSessionStart && diningSessionStartInput) {
      const started = await send("/merchant/dining/sessions/start", {
        cookie,
        body: diningSessionStartInput,
        csrf: bootstrap.csrf,
      });
      assert.equal(started.status, 200);
      assert.equal(started.headers["cache-control"], "no-store");
      const result = JSON.parse(started.text);
      assert.deepEqual(
        {
          status: result.status,
          tableReference: result.tableReference,
          tableAssignmentVersion: result.tableAssignmentVersion,
          joinKind: result.joinKind,
        },
        {
          status: "Issued",
          tableReference: diningSessionStartInput.tableReference,
          tableAssignmentVersion: 3,
          joinKind: diningSessionStartInput.joinKind,
        },
      );
      assert.match(result.diningSessionReference, /^[0-9a-f-]{36}$/u);
      assert.equal(result.sessionVersion, 1);
      assert.match(result.joinCredential, /^[A-Za-z0-9_-]{22}$/u);
      const replay = await send("/merchant/dining/sessions/start", {
        cookie,
        body: diningSessionStartInput,
        csrf: bootstrap.csrf,
      });
      assert.equal(replay.status, 200);
      const replayResult = JSON.parse(replay.text);
      assert.equal(replayResult.status, "AlreadyApplied");
      assert.equal(replayResult.diningSessionReference, result.diningSessionReference);
      assert.equal(Object.hasOwn(replayResult, "joinCredential"), false);
    }
    const body = { targetStoreReference: targetStore };
    assert.equal(
      (await send("/merchant/store-context", { cookie, body, csrf: credentials.generate() }))
        .status,
      403,
    );
    assert.equal(
      (
        await send("/merchant/store-context", {
          cookie,
          body,
          csrf: bootstrap.csrf,
          origin: "https://foreign.example.test",
        })
      ).status,
      403,
    );
    const switched = await send("/merchant/store-context", { cookie, body, csrf: bootstrap.csrf });
    assert.equal(switched.status, 200);
    assert.equal(
      parseMerchantWorkspace(JSON.parse(switched.text).workspace).selectedScope.storeReference,
      targetStore,
    );
    const nextCookie = issued(switched, "__Host-bop-merchant");
    assert.notEqual(nextCookie, cookie);
    assert.equal((await send("/merchant/session", { cookie })).status, 403);
    const refreshed = await send("/merchant/session", { cookie: nextCookie });
    assert.equal(refreshed.status, 200);
    const next = JSON.parse(refreshed.text);
    assert.notEqual(next.csrf, bootstrap.csrf);
    if (taskInbox) {
      assert.equal((await send("/merchant/tasks", { cookie })).status, 403);
      const response = await send("/merchant/tasks", { cookie: nextCookie });
      assert.equal(response.status, 200, response.text);
      assert.equal(response.headers["cache-control"], "no-store");
      assert.deepEqual(JSON.parse(response.text), {
        screenId: "TASK-INBOX",
        storeLabel: "Synthetic Second Store",
        observedAt: taskInboxObservedAt,
        nextAfterTaskReference: null,
        items: [],
      });
      assert.equal(
        (await send("/merchant/tasks?storeReference=" + initialStore, { cookie: nextCookie }))
          .status,
        403,
      );
    }
    if (orderExceptions) {
      assert.equal((await send("/merchant/order-exceptions", { cookie })).status, 403);
      const response = await send("/merchant/order-exceptions", { cookie: nextCookie });
      assert.equal(response.status, 200, response.text);
      assert.equal(response.headers["cache-control"], "no-store");
      const result = JSON.parse(response.text);
      assert.equal(result.storeLabel, "Synthetic Second Store");
      assert.equal(result.businessDate, orderExceptionsTargetBusinessDate);
      assert.equal(result.freshnessStatus, "Stale");
      assert.deepEqual(result.items, []);
      assert.equal(response.text.includes(initialStore), false);
    }
    if (orderQueue && expectedOrderNumbers) {
      assert.equal((await send("/merchant/orders", { cookie })).status, 403);
      const response = await send("/merchant/orders", { cookie: nextCookie });
      assert.equal(response.status, 200);
      assert.equal(response.headers["cache-control"], "no-store");
      const result = JSON.parse(response.text);
      assert.deepEqual(
        result.items.map((item) => item.orderNumber),
        [expectedOrderNumbers[1]],
      );
      assert.equal(result.items[0].currentPhase, "Submitted");
      assert.equal(result.items[0].currentVersion, 1);
      assert.equal(result.items[0].canRequestAcceptance, false);
    }
    if (kitchenQuery && kitchenListInput) {
      const path = "/merchant/kitchen/query";
      assert.equal(
        (await send(path, { cookie, body: kitchenListInput, csrf: next.csrf })).status,
        403,
      );
      const response = await send(path, {
        cookie: nextCookie,
        body: kitchenListInput,
        csrf: next.csrf,
      });
      assert.equal(response.status, 200, response.text);
      assert.equal(response.headers["cache-control"], "no-store");
      const result = JSON.parse(response.text);
      assert.equal(result.storeReference, targetStore);
      assert.equal(result.operatorStatus, "Unverified");
      assert.equal(result.initializedEmpty, true);
      assert.equal(result.partial, false);
      assert.equal(result.stale, false);
      assert.deepEqual(result.items, []);
      assert.equal(
        (
          await send(path, {
            cookie: nextCookie,
            body: { ...kitchenListInput, storeReference: initialStore },
            csrf: next.csrf,
          })
        ).status,
        400,
      );
    }
    if (diningTables && diningTableListInput && diningExpectedTableReferences) {
      const path = "/merchant/dining/tables";
      assert.equal(
        (await send(path, { cookie, body: diningTableListInput, csrf: next.csrf })).status,
        403,
      );
      const response = await send(path, {
        cookie: nextCookie,
        body: diningTableListInput,
        csrf: next.csrf,
      });
      assert.equal(response.status, 200, response.text);
      assert.equal(response.headers["cache-control"], "no-store");
      const result = JSON.parse(response.text);
      assert.deepEqual(
        result.items.map((item) => item.tableReference),
        [diningExpectedTableReferences[1]],
      );
      assert.equal(
        (
          await send(path, {
            cookie: nextCookie,
            body: { ...diningTableListInput, storeReference: initialStore },
            csrf: next.csrf,
          })
        ).status,
        403,
      );
    }
    if (pickupQuery && pickupListInput) {
      const path = "/merchant/pickup/query";
      assert.equal(
        (
          await send(path, {
            cookie,
            body: pickupListInput,
            csrf: next.csrf,
          })
        ).status,
        403,
      );
      const response = await send(path, {
        cookie: nextCookie,
        body: pickupListInput,
        csrf: next.csrf,
      });
      assert.equal(response.status, 200, response.text);
      assert.equal(response.headers["cache-control"], "no-store");
      const result = JSON.parse(response.text);
      assert.equal(result.storeReference, targetStore);
      assert.deepEqual(result.items, []);
      assert.equal(
        (
          await send(path, {
            cookie: nextCookie,
            body: { ...pickupListInput, storeReference: initialStore },
            csrf: next.csrf,
          })
        ).status,
        400,
      );
    }
    assert.equal(
      (await send("/merchant/protected", { cookie: nextCookie, csrf: bootstrap.csrf, body: {} }))
        .status,
      403,
    );
    assert.equal(
      (await send("/merchant/protected", { cookie: nextCookie, csrf: next.csrf, body: {} })).status,
      200,
    );
    let logoutCookie = nextCookie;
    let logoutCsrf = next.csrf;
    if (pickupQuery && pickupListInput && pickupExpectedFulfillmentReferences.length > 0) {
      const returned = await send("/merchant/store-context", {
        cookie: nextCookie,
        body: { targetStoreReference: initialStore },
        csrf: next.csrf,
      });
      assert.equal(returned.status, 200, returned.text);
      assert.equal(returned.headers["cache-control"], "no-store");
      assert.equal(
        parseMerchantWorkspace(JSON.parse(returned.text).workspace).selectedScope.storeReference,
        initialStore,
      );
      const returnedCookie = issued(returned, "__Host-bop-merchant");
      assert.notEqual(returnedCookie, nextCookie);
      assert.equal((await send("/merchant/session", { cookie: nextCookie })).status, 403);
      const returnedSession = await send("/merchant/session", { cookie: returnedCookie });
      assert.equal(returnedSession.status, 200, returnedSession.text);
      assert.equal(returnedSession.headers["cache-control"], "no-store");
      const returnedBootstrap = JSON.parse(returnedSession.text);
      assert.notEqual(returnedBootstrap.csrf, next.csrf);
      const populated = await send("/merchant/pickup/query", {
        cookie: returnedCookie,
        body: pickupListInput,
        csrf: returnedBootstrap.csrf,
      });
      assert.equal(populated.status, 200, populated.text);
      assert.equal(populated.headers["cache-control"], "no-store");
      const populatedResult = JSON.parse(populated.text);
      assert.equal(populatedResult.storeReference, initialStore);
      assert.deepEqual(
        populatedResult.items.map((item) => item.fulfillmentReference),
        pickupExpectedFulfillmentReferences,
      );
      assert.equal(populated.text.includes(targetStore), false);
      assert.equal(
        (
          await send("/merchant/pickup/query", {
            cookie: returnedCookie,
            body: { ...pickupListInput, storeReference: targetStore },
            csrf: returnedBootstrap.csrf,
          })
        ).status,
        400,
      );
      if (kitchenExpectedOwnerRows) {
        const kitchenPath = "/merchant/kitchen/query";
        const kitchenResponse = await send(kitchenPath, {
          cookie: returnedCookie,
          body: kitchenListInput,
          csrf: returnedBootstrap.csrf,
        });
        assert.equal(kitchenResponse.status, 200, kitchenResponse.text);
        assert.equal(kitchenResponse.headers["cache-control"], "no-store");
        const kitchenResult = JSON.parse(kitchenResponse.text);
        assert.equal(kitchenResult.storeReference, initialStore);
        assert.equal(kitchenResult.operatorStatus, "Unverified");
        assert.equal(kitchenResult.initializedEmpty, false);
        assert.equal(kitchenResult.partial, false);
        assert.equal(kitchenResult.stale, false);
        assert.deepEqual(kitchenRows(kitchenResult.items), kitchenExpectedOwnerRows);
        assert.equal(kitchenResponse.text.includes(targetStore), false);
        assert.equal(
          (
            await send(kitchenPath, {
              cookie: returnedCookie,
              body: { ...kitchenListInput, storeReference: targetStore },
              csrf: returnedBootstrap.csrf,
            })
          ).status,
          400,
        );
      }
      logoutCookie = returnedCookie;
      logoutCsrf = returnedBootstrap.csrf;
    }
    const logout = await send("/merchant/logout", {
      cookie: logoutCookie,
      csrf: logoutCsrf,
      body: {},
    });
    assert.equal(logout.status, 204);
    assert(logout.headers["set-cookie"].some((entry) => entry.includes("Max-Age=0")));
    assert.equal((await send("/merchant/session", { cookie: logoutCookie })).status, 403);
    for (const response of [start, callback, switched, refreshed, logout])
      assert.equal(response.headers["cache-control"], "no-store");
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

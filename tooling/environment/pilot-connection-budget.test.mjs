import { expect, it } from "vitest";
import {
  pilotApiRoleConnectionLimit,
  pilotApiRoleMinimumLimit,
  pilotEffectiveRoleLimit,
  pilotProcessPoolSize,
  planPilotConnections,
} from "./pilot-connection-budget.mjs";
import {
  admitServedStores,
  PILOT_CONNECTION_BUDGET_EXCEEDED,
  reportConnectionBudget,
} from "./pilot-served-stores.mjs";

const stores = (n) => Array.from({ length: n }, (_, i) => "stores/demo-" + (i + 2));
/** Every process of every Store at its pool size, plus the operators' headroom. */
const total = (plan, storeCount) => {
  const size = (file) => pilotProcessPoolSize(plan, "/app/tooling/environment/" + file);
  // One process and one pool per entry, serving every Store; five workers per Store.
  return (
    size("pilot-api-entry.mjs") +
    size("pilot-https-entry.mjs") +
    storeCount *
      (size("pilot-business-worker.mjs") +
        size("pilot-kitchen-queue-worker.mjs") +
        size("pilot-reconciliation-worker.mjs") +
        size("pilot-daily-settlement-worker.mjs") +
        size("pilot-dining-exception-worker.mjs")) +
    10
  );
};

it("every process of every admitted Store fits the role's limit, whatever the Store count", () => {
  for (const limit of [30, 45, 60, pilotApiRoleConnectionLimit, 150])
    for (let storeCount = 1; storeCount <= 12; storeCount += 1) {
      const plan = planPilotConnections({ storeCount, limit });
      expect(total(plan, plan.admittedStores)).toBeLessThanOrEqual(limit);
    }
});

it("three Stores fit at the new limit with room for guests, four with smaller pools", () => {
  const three = planPilotConnections({ storeCount: 3, limit: pilotApiRoleConnectionLimit });
  expect(three.admittedStores).toBe(3);
  expect(three.pools).toEqual({ api: 7, https: 5, business: 3, worker: 2 });
  expect(pilotProcessPoolSize(three, "x/pilot-api-entry.mjs")).toBe(21);
  expect(pilotProcessPoolSize(three, "x/pilot-https-entry.mjs")).toBe(15);
  const four = planPilotConnections({ storeCount: 4, limit: pilotApiRoleConnectionLimit });
  expect(four.admittedStores).toBe(4);
  expect(four.pools).toEqual({ api: 3, https: 3, business: 2, worker: 2 });
  expect(planPilotConnections({ storeCount: 5, limit: 80 }).admittedStores).toBe(4);
});

it("a Store that doesn't fit is named and not started; the Stores before it keep running", () => {
  // v15 until its role limit is raised: 45, three Stores.
  const { admitted, refused } = admitServedStores(stores(2), 45);
  expect(admitted).toEqual(["stores/demo-2"]);
  expect(refused).toEqual(["stores/demo-3"]);
  const lines = [];
  reportConnectionBudget(refused, 45, (line) => lines.push(JSON.parse(line)));
  expect(lines).toEqual([
    {
      level: 50,
      event: PILOT_CONNECTION_BUDGET_EXCEEDED,
      store: "stores/demo-3",
      roleLimit: 45,
    },
  ]);
  // An unreadable limit never stops a Store: the database then answers for itself.
  expect(admitServedStores(stores(9), null).refused).toEqual([]);
});

it("the database's own limits decide, and the role is reported not ready below one Store's need", () => {
  expect(pilotEffectiveRoleLimit({ roleLimit: 80, maxConnections: 100 })).toBe(80);
  expect(pilotEffectiveRoleLimit({ roleLimit: -1, maxConnections: 100 })).toBe(80);
  expect(pilotEffectiveRoleLimit({ roleLimit: 90, maxConnections: 60 })).toBe(40);
  expect(pilotApiRoleMinimumLimit).toBe(26);
  expect(planPilotConnections({ storeCount: 1, limit: 25 }).admittedStores).toBe(0);
});

it("an operator command takes a small pool", () => {
  const plan = planPilotConnections({ storeCount: 1, limit: 80 });
  expect(pilotProcessPoolSize(plan, "/app/tooling/environment/pilot-acl-export.mjs")).toBe(2);
  expect(pilotProcessPoolSize(plan, undefined)).toBe(2);
});

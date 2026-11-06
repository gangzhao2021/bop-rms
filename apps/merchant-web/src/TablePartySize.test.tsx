// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import {
  TablePartySize,
  TablePartySizeError,
  type TablePartySizeClient,
  type TableTeaClient,
} from "./TablePartySize.js";
import { buttonNamed, click, deferred, mount, settle, typeInto } from "./dom-test-kit.fixture.js";

const session = "01a4d500-0000-7000-8000-000000000002";
afterEach(() => document.body.replaceChildren());

it("WP-2423 live minor 0: after the guests are saved the old per-head count is not shown while the bill follows", async () => {
  const sync = deferred<Awaited<ReturnType<TableTeaClient>>>();
  const tea: TableTeaClient = async (_csrf, command) =>
    command.action === "Sync"
      ? sync.promise
      : { status: "Charged", charged: 4, expected: 4, problem: null, itemName: "Sauce bar" };
  const client: TablePartySizeClient = {
    read: async () => ({ askPartySize: true, partySize: 4, version: 1 }),
    record: async (_csrf, command) => ({ partySize: command.partySize, version: 2 }),
  };
  const { container } = await mount(
    <TablePartySize
      diningSessionReference={session}
      tableLabel="T4"
      csrf={"a".repeat(43)}
      locked={false}
      client={client}
      tea={tea}
    />,
  );
  await settle();
  expect(container.textContent).toContain("Sauce bar on the bill: 4");
  await click(buttonNamed(container, "Change"));
  await typeInto(container.querySelector("input"), "6");
  await click(buttonNamed(container, "Save"));
  await settle();
  expect(container.textContent).toContain("6 guests");
  // Sync has not answered: the bill is being updated, never "on the bill: 4" beside 6 guests.
  const status = container.querySelector(".table-panel__tea");
  expect(status?.getAttribute("role")).toBe("status");
  expect(status?.textContent).toBe("Updating Sauce bar on the bill for 6 guests…");
  expect(container.textContent).not.toContain("Sauce bar on the bill: 4");
  expect(buttonNamed(container, /Change Sauce bar count/u)).toBeUndefined();
  sync.resolve({
    status: "Charged",
    charged: 6,
    expected: 6,
    problem: null,
    itemName: "Sauce bar",
  });
  await settle();
  expect(container.textContent).toContain("Sauce bar on the bill: 6");
  expect(container.textContent).not.toContain("Updating");
});

it("WP-2423 live minor 0: a sync that fails says so once it answers", async () => {
  const sync = deferred<Awaited<ReturnType<TableTeaClient>>>();
  const tea: TableTeaClient = async (_csrf, command) =>
    command.action === "Sync"
      ? sync.promise
      : { status: "Charged", charged: 4, expected: 4, problem: null, itemName: "Sauce bar" };
  const client: TablePartySizeClient = {
    read: async () => ({ askPartySize: true, partySize: 4, version: 1 }),
    record: async (_csrf, command) => ({ partySize: command.partySize, version: 2 }),
  };
  const { container } = await mount(
    <TablePartySize
      diningSessionReference={session}
      tableLabel="T4"
      csrf={"a".repeat(43)}
      locked={false}
      client={client}
      tea={tea}
    />,
  );
  await settle();
  await click(buttonNamed(container, "Change"));
  await typeInto(container.querySelector("input"), "6");
  await click(buttonNamed(container, "Save"));
  await settle();
  sync.reject(new TablePartySizeError("Offline"));
  await settle();
  expect(container.textContent).not.toContain("Updating");
  expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/isn't confirmed/u);
});

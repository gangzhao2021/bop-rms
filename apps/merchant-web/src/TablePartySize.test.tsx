// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  TablePartySize,
  TablePartySizeError,
  teaPaidText,
  teaRefusalText,
  type TablePartySizeClient,
  type TableTeaClient,
  type TableTeaView,
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

describe("M29: a refused tea change says why, never that the system is busy", () => {
  const view = (problem: TableTeaView["problem"]): TableTeaView => ({
    status: "Mismatch",
    charged: 8,
    expected: 7,
    problem,
    itemName: "Tea",
  });
  it("names checking out, served tea and a changed count", () => {
    expect(teaRefusalText(view("CheckingOut"))).toBe(
      "The bill is being paid, so Tea can't change now.",
    );
    expect(teaRefusalText(view("AlreadyServed"))).toBe(
      "Tea is already served for 8 guests. To charge fewer, comp the extra.",
    );
    expect(teaRefusalText(view("Changed"))).toBe(
      "Someone else changed the guest count. Check it again.",
    );
    // M28: taken off, not added back — said as that, not as "not confirmed".
    expect(teaRefusalText({ ...view("NotAddedBack"), charged: 5 })).toBe(
      "Tea was taken off but could not be added back: 5 charged, 7 wanted. Try again.",
    );
    expect(teaRefusalText(view("Unavailable"))).toBeNull();
    expect(teaRefusalText({ ...view("CheckingOut"), status: "Charged" })).toBeNull();
  });
});

describe("M29 (v15 batch 5): a paid table's guest count changing says the bill stays as paid", () => {
  const paid = (
    charged: number,
    expected: number | null,
    settledBy: TableTeaView["settledBy"] = "Paid",
  ): TableTeaView => ({
    status: "Paid",
    settledBy,
    charged,
    expected,
    problem: null,
    itemName: "Tea",
  });
  it("offers a refund only when guests paid and the count went down", () => {
    expect(teaPaidText(paid(2, 1))).toBe(
      "This table has paid, so Tea on the bill stays at 2. If a guest should get money back, a manager refunds it on the order.",
    );
    expect(teaPaidText(paid(2, 2))).toBeNull();
    expect(teaPaidText(paid(2, null))).toBeNull();
    expect(teaPaidText({ ...paid(2, 1), status: "Charged" })).toBeNull();
  });
  it("says an extra guest's charge is not on the paid bill, with no refund", () => {
    const text = teaPaidText(paid(2, 3));
    expect(text).toBe(
      "This table has paid, so Tea on the bill stays at 2 and the extra guests' Tea isn't charged. To charge it, take a new order for it.",
    );
    expect(text).not.toMatch(/refund|money back/i);
  });
  it("never tells staff a written-off table has paid or should be refunded", () => {
    for (const expected of [1, 3]) {
      const text = teaPaidText(paid(2, expected, "WrittenOff"));
      expect(text).toBe(
        "This table was recorded as left without paying, so Tea on the bill stays at 2. Nothing is charged or refunded for the change.",
      );
      expect(text).not.toMatch(/has paid|money back|refunds it/i);
    }
    // An older server that doesn't say how: worded to fit both, no refund step.
    const older: TableTeaView = {
      status: "Paid",
      charged: 2,
      expected: 1,
      problem: null,
      itemName: "Tea",
    };
    expect(teaPaidText(older)).toBe("This table's bill is settled, so Tea on the bill stays at 2.");
  });
});

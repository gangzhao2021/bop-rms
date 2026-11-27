// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { TableBillTotal } from "./TableBillTotal.js";
import { splitBillFixture } from "./table-split.fixtures.js";
import { mount, settle } from "./dom-test-kit.fixture.js";

afterEach(() => document.body.replaceChildren());

// v15 b12 live (DEC-TAX-WHOLE-RECEIPT): the staff bill summary read "Tax rounding $0.01" under
// Tax while checkout and the paid bill print one Tax line, the tax worked out on the whole bill.
it("b13: the whole bill reads one Tax line, its rounding included, as checkout prints it", async () => {
  const bill = splitBillFixture();
  const rounds = bill.rounds as Record<string, unknown>[];
  // The bill's tax rounds down a cent: it sits in round 2's tax (461 − 1).
  rounds[1] = { ...rounds[1], taxMinor: "460", totalMinor: "4010", taxRoundingMinor: "-1" };
  bill.taxRoundingMinor = "-1";
  const fetcher = vi.fn(
    async () =>
      new Response(JSON.stringify(bill), {
        status: 200,
        headers: { "Cache-Control": "no-store", "Content-Type": "application/json" },
      }),
  );
  const { container } = await mount(
    <TableBillTotal
      diningSessionReference={bill.diningSessionReference as string}
      csrf={"a".repeat(43)}
      refreshKey="1"
      fetcher={fetcher as unknown as typeof fetch}
    />,
  );
  await settle(10);
  const text = container.textContent ?? "";
  expect(text).toContain("Whole bill, before tax$84.00");
  expect(text).toContain("Tax$10.91");
  expect(text).toContain("Whole bill$94.91");
  expect(text).not.toContain("Tax rounding");
});

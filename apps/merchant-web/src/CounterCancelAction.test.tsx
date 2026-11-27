// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { CounterCancelAction, counterCancelOutcome } from "./CounterCancelAction.js";
import { buttonNamed, click, mount, settle } from "./dom-test-kit.fixture.js";

const ref = (n: number) => `01900000-0000-7000-8000-${String(n).padStart(12, "0")}`;
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
  this.open = true;
};
HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
  this.open = false;
};
afterEach(() => document.body.replaceChildren());

it("WP-2423 M127: says why a cancel was refused in staff words", () => {
  expect(counterCancelOutcome(403, "order_cancellation_permission_denied")).toBe("Denied");
  expect(counterCancelOutcome(409, "counter_cancel_already_paid")).toBe("Paid");
  expect(counterCancelOutcome(409, "counter_cancel_paper_order")).toBe("Paper");
  expect(counterCancelOutcome(409, "order_version_conflict")).toBe("Changed");
  expect(counterCancelOutcome(503, "counter_cancellation_unavailable")).toBe("Unknown");
});

it("WP-2423 M127: cancels with the reason chosen, and a lost answer retries the same operation", async () => {
  let answer: () => Response = () => {
    throw new TypeError("offline");
  };
  const fetcher = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () =>
    answer(),
  );
  const cancelled = vi.fn();
  const { container } = await mount(
    <CounterCancelAction
      orderReference={ref(1)}
      orderBatchReference={ref(2)}
      orderNumber="12"
      expectedOrderVersion={1}
      csrf={"a".repeat(43)}
      fetcher={fetcher as typeof fetch}
      onCancelled={cancelled}
    />,
  );
  await click(buttonNamed(container, "Cancel order"));
  const submit = buttonNamed(container, "Cancel order 12") as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  await click(container.querySelector('input[value="COUNTER_GUEST_LEFT_UNPAID"]'));
  await click(submit);
  await settle();
  expect(container.textContent).toContain("it is never cancelled twice");
  // The first try may have cancelled it: the retry repeats the same reason, so it can't change.
  expect(container.querySelector("fieldset")?.disabled).toBe(true);
  answer = () =>
    new Response(JSON.stringify({ status: "Cancelled", cancelledAt: "2026-11-06T12:00:00.000Z" }), {
      headers: { "content-type": "application/json" },
    });
  await click(submit);
  await settle();
  const bodies = fetcher.mock.calls.map((call) => JSON.parse(String(call[1]?.body)));
  expect(bodies[0]).toMatchObject({
    orderReference: ref(1),
    orderBatchReference: ref(2),
    expectedOrderVersion: 1,
    reasonCode: "COUNTER_GUEST_LEFT_UNPAID",
  });
  expect(bodies[1].operationReference).toBe(bodies[0].operationReference);
  expect(cancelled).toHaveBeenCalledTimes(1);
});

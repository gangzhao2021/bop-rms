// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { PickupHandoffForm } from "./PickupHandoffForm.js";
import type { PickupQueueItem } from "./pickup.js";
import { buttonNamed, click, mount, settle } from "./dom-test-kit.fixture.js";

const ref = (n: number) => `01900000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const item = (counter: boolean): PickupQueueItem => ({
  fulfillmentReference: ref(1),
  orderReference: ref(2),
  publicOrderNumber: "12",
  phase: "Ready",
  readyAt: "2026-09-19T00:00:00.000Z",
  proofReadiness: counter ? "NotIssued" : "Ready",
  stagingLocation: null,
  claimStatus: "Unavailable",
  exceptionStatus: "Unavailable",
  packageCount: null,
  allergenCue: "Unavailable",
  ...(counter ? { takenAtCounter: true as const } : {}),
  execution: {
    aggregateVersion: "3",
    publicOrderReference: null,
    proof: counter
      ? null
      : { kind: "HumanCode", generation: 1, expiresAt: "2026-09-20T00:00:00.000Z" },
    items: [
      // Two ready, none handed over yet; and one of three handed over earlier.
      {
        fulfillmentItemReference: ref(3),
        orderedQuantity: 2,
        readyQuantity: 2,
        handedOverQuantity: 0,
      },
      {
        fulfillmentItemReference: ref(4),
        orderedQuantity: 3,
        readyQuantity: 3,
        handedOverQuantity: 1,
      },
    ],
  },
});
const verification = {
  verificationReference: ref(7),
  fulfillmentReference: ref(1),
  expectedAggregateVersion: "3",
  generation: 1,
  grantsCompletionAuthority: false as const,
};
const workstation = { deviceReference: ref(8), pickupLocationReference: ref(9) };
const answer = () =>
  new Response(
    JSON.stringify({
      status: "Applied",
      handoffReference: ref(10),
      fulfillmentReference: ref(1),
      nextAggregateVersion: "4",
      nextPhase: "Completed",
    }),
    { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } },
  );
// jsdom has no modal dialog.
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
  this.open = true;
};
HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
  this.open = false;
};
afterEach(() => {
  document.body.replaceChildren();
});

it("WP-2423 M21: after the code matches, one tap hands every remaining item to the customer", async () => {
  const fetcher = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () =>
    answer(),
  );
  const recorded = vi.fn();
  const { container } = await mount(
    <PickupHandoffForm
      item={item(false)}
      verification={verification}
      workstation={workstation}
      csrf={"A".repeat(43)}
      storeReference={ref(5)}
      fetcher={fetcher as typeof fetch}
      onRecorded={recorded}
    />,
  );
  expect(container.textContent).toContain("Check every item before you tap");
  await click(buttonNamed(container, "Hand over to customer · Order 12"));
  await settle();
  const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
  expect(body).toMatchObject({
    verificationReference: ref(7),
    recipientType: "Customer",
    recipientDisplayMask: null,
    quantities: [
      { fulfillmentItemReference: ref(3), quantity: 2 },
      { fulfillmentItemReference: ref(4), quantity: 2 },
    ],
  });
  expect("identityCheck" in body).toBe(false);
  expect(recorded).toHaveBeenCalledTimes(1);
});

it("WP-2423 M21: a counter order is called and handed over in one tap, recorded as a called number", async () => {
  const fetcher = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () =>
    answer(),
  );
  const { container } = await mount(
    <PickupHandoffForm
      item={item(true)}
      verification={null}
      workstation={workstation}
      csrf={"A".repeat(43)}
      storeReference={ref(5)}
      fetcher={fetcher as typeof fetch}
      onRecorded={() => undefined}
    />,
  );
  await click(buttonNamed(container, "Called and handed over · Order 12"));
  await settle();
  const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
  expect(body).toMatchObject({
    identityCheck: "OrderNumberCalled",
    recipientType: "Customer",
    recipientDisplayMask: null,
  });
});

it("WP-2423 M21: someone else collecting still needs the initial and the confirmation", async () => {
  const fetcher = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () =>
    answer(),
  );
  const { container } = await mount(
    <PickupHandoffForm
      item={item(false)}
      verification={verification}
      workstation={workstation}
      csrf={"A".repeat(43)}
      storeReference={ref(5)}
      fetcher={fetcher as typeof fetch}
    />,
  );
  await click(buttonNamed(container, "Someone else is collecting"));
  const dialog = container.querySelector("dialog");
  const submit = [...(dialog?.querySelectorAll("button") ?? [])].find(
    (button) => button.textContent === "Confirm and record handoff",
  );
  expect(dialog?.querySelector("select")?.value).toBe("Delegate");
  expect(submit?.disabled).toBe(true);
  expect(fetcher).not.toHaveBeenCalled();
});

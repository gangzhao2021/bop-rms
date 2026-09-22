import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { CurrentOrderDetails, CurrentOrderQueueRows } from "./CurrentOrderQueuePage.js";
import { parseCurrentOrderQueue } from "./current-order-queue-client.js";
it("renders actual Accepted version and visibly unresolved state without fabricated summaries", () => {
  const item = {
    orderReference: "01909968-0000-7000-8000-000000000001",
    orderNumber: "ORD-1001",
    orderType: "Pickup",
    sourceChannel: "Web",
    submittedAt: "2026-09-14T00:00:00.000Z",
    observedAt: "2026-09-14T00:01:00.000Z",
    initialBatchReference: "01909968-0000-7000-8000-000000000090",
    batches: [
      {
        orderBatchReference: "01909968-0000-7000-8000-000000000090",
        sequence: 1,
        acceptanceStatus: "Accepted",
        canRequestAcceptance: false,
      },
    ],
    canRequestAcceptance: false,
    currentPhase: "Accepted",
    currentVersion: 2,
  };
  const render = (value: unknown) =>
    renderToStaticMarkup(
      <CurrentOrderQueueRows
        view={parseCurrentOrderQueue({ items: [value], nextAfterOrderReference: null })}
      />,
    );
  expect(render(item)).toContain("Accepted");
  expect(render(item)).toContain("Current version");
  expect(render(item)).not.toContain("guestSession");
  expect(render({ ...item, currentPhase: null, currentVersion: null })).toContain(
    "Status unavailable",
  );
});
it("renders an empty page explicitly", () => {
  expect(
    renderToStaticMarkup(
      <CurrentOrderQueueRows view={{ items: [], nextAfterOrderReference: null }} />,
    ),
  ).toContain("No orders on this page");
});

it("labels a cancelled additional Batch distinctly from unaccepted work", () => {
  const id = (n: number) => `01909968-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
  const view = parseCurrentOrderQueue({
    items: [
      {
        orderReference: id(1),
        orderNumber: "ORD-1001",
        orderType: "DineIn",
        sourceChannel: "Web",
        submittedAt: "2026-09-14T00:00:00.000Z",
        observedAt: "2026-09-14T00:01:00.000Z",
        initialBatchReference: id(2),
        batches: [
          {
            orderBatchReference: id(2),
            sequence: 1,
            acceptanceStatus: "Accepted",
            canRequestAcceptance: false,
          },
          {
            orderBatchReference: id(3),
            sequence: 2,
            acceptanceStatus: "Cancelled",
            canRequestAcceptance: false,
          },
        ],
        canRequestAcceptance: false,
        currentPhase: "Ready",
        currentVersion: 8,
      },
    ],
    nextAfterOrderReference: null,
  });
  const html = renderToStaticMarkup(<CurrentOrderQueueRows view={view} />);
  expect(html).toContain("Batch cancelled");
  expect(html).not.toContain("Not accepted");
});

it("keeps payments accessible on cancelled Dining without offering unavailable serving, preserving fulfilled history", () => {
  const order = {
    orderReference: "01909968-0000-7000-8000-000000000001",
    orderNumber: "ORD-1001",
    orderType: "DineIn",
    sourceChannel: "Web",
    submittedAt: "2026-09-14T00:00:00.000Z",
    observedAt: "2026-09-14T00:01:00.000Z",
    initialBatchReference: "01909968-0000-7000-8000-000000000090",
    batches: [],
    canRequestAcceptance: false,
    currentPhase: "Cancelled",
    currentVersion: 2,
  };
  const item = parseCurrentOrderQueue({ items: [order], nextAfterOrderReference: null }).items[0];
  if (!item) throw new Error("missing synthetic order");
  const render = (currentPhase: string) =>
    renderToStaticMarkup(
      <CurrentOrderDetails
        order={{ ...item, currentPhase }}
        csrf="synthetic"
        locked={false}
        onBusy={() => undefined}
      />,
    );
  expect(render("Cancelled")).toContain("View payments and refunds");
  expect(render("Cancelled")).not.toContain("View serving progress");
  expect(render("Accepted")).toContain("View serving progress");
  expect(render("Fulfilled")).toContain("View serving progress");
});

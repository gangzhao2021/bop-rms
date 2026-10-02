import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { expect, it } from "vitest";
import { TaskInboxScreen, TaskInboxStatePanel } from "./TaskInboxPage.js";
import { parseTaskInboxView } from "./task-inbox-state.js";

const view = (
  items = [
    {
      taskReference: "0190fad5-0000-7000-8000-000000000001",
      version: 3,
      taskType: "DINING_UNPAID_BATCH_EXCEPTION",
      severity: "CRITICAL",
      priority: "CRITICAL",
      status: "Assigned",
      ownerStatus: "Unclaimed",
      dueAt: "2026-09-20T01:00:00.000Z",
      sourceType: "DINING_SESSION",
      canClaim: true,
    },
  ],
) =>
  parseTaskInboxView({
    screenId: "TASK-INBOX",
    storeLabel: "Synthetic Store",
    observedAt: "2026-09-20T00:00:00.000Z",
    items,
    nextAfterTaskReference: null,
  });

function screen(state: Parameters<typeof TaskInboxScreen>[0]["state"], online = true) {
  const noop = () => undefined;
  return renderToStaticMarkup(
    <MemoryRouter>
      <TaskInboxScreen state={state} onRefresh={noop} onNext={noop} online={online} />
    </MemoryRouter>,
  );
}

it("renders returned owner fields and keeps unsupported Task actions disabled", () => {
  const html = screen({ kind: "Ready", view: view() });
  for (const value of [
    "TASK-INBOX",
    "Synthetic Store",
    "DINING UNPAID BATCH EXCEPTION",
    "CRITICAL",
    "Unclaimed",
    "2026-09-20T01:00:00.000Z",
    "SLA",
    "Policy unavailable",
    "DINING SESSION",
    "Display-safe reference unavailable",
    "Task actions unavailable",
    "Filtering controls are unavailable here",
  ])
    expect(html).toContain(value);
  expect(html).not.toContain("0190fad5-0000-7000-8000-000000000001");
  expect(html).not.toContain("0190fad5-0000-7000-8000-000000000002");
  expect(html).not.toMatch(/task-heading-0190/u);
  expect(html.match(/disabled=""/g)?.length).toBe(5);
  expect(html).toContain("No Task or source state was changed");
});

it("does not turn a source-trimmed empty page into a business-finality claim", () => {
  const html = screen({ kind: "Ready", view: view([]) });
  expect(html).toContain("No Task records returned on this page");
  expect(html).toContain("No business outcome is inferred");
});

it("keeps a same-context offline page read-only", () => {
  const html = screen({ kind: "Offline", view: view() }, false);
  expect(html).toContain("Offline read-only");
  expect(html).toContain("The last authorized page remains visible for reference");
  expect(html.match(/disabled=""/g)?.length).toBe(6);
});

it("provides a clear permission-denied state", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <TaskInboxStatePanel state="PermissionDenied" />
    </MemoryRouter>,
  );
  expect(html).toContain("Permission denied");
  expect(html).toContain("workflow.operate");
});

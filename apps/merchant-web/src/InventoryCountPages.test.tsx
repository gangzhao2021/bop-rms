import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { InventoryCountScreen, InventoryCountState } from "./InventoryCountPages.js";
import { InventoryCountClientError, parseInventoryCountView } from "./inventory-count-pages.js";

const id = (n: number) => `018fa700-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
function projection(
  screenId = "INV-COUNT-WORKBENCH",
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return {
    screenId,
    projectionName: "inventory_count_workbench_v1",
    projectionVersion: 1,
    stockScope: {
      scopeType: "Location",
      scopeReference: id(5),
      scopeLabel: "Authorized prep location",
    },
    asOfUtc: "2026-08-14T12:30:00.000Z",
    freshness: "Current",
    partial: false,
    selectedCountReference: screenId === "INV-COUNT-WORKBENCH" ? id(10) : null,
    counts: [
      {
        countReference: id(10),
        countType: "Cycle",
        status: "InProgress",
        expectedQuantityVisibility: "BlindUntilSubmit",
        movementControl: "SnapshotOnly",
        approvalPolicy: "Segregated",
        snapshotReference: id(11),
        snapshotCapturedAt: "2026-08-14T09:00:00.000Z",
        assigneeDisplay: "Authorized count assignee",
        submittedByDisplay: null,
        approvedByDisplay: null,
        dueAt: "2026-08-14T18:00:00.000Z",
        totalLines: 1,
        countedLines: 0,
        varianceLines: null,
        aggregateVersion: 2,
        lines:
          screenId === "INV-COUNT-WORKBENCH"
            ? [
                {
                  lineReference: id(20),
                  itemReference: id(21),
                  itemName: "Synthetic ingredient",
                  internalCode: "ITEM_01",
                  lotReference: id(22),
                  locationLabel: "Authorized prep location",
                  unitCode: "KG",
                  expectedQuantity: null,
                  countedQuantity: null,
                  variance: null,
                  varianceReasonCode: null,
                  recountNumber: 0,
                  conflict: "None",
                  movementReference: null,
                },
              ]
            : [],
      },
    ],
    ...overrides,
  };
}

describe("Inventory Count screens", () => {
  it("strictly parses one scoped Count projection", () => {
    expect(parseInventoryCountView(projection())).toMatchObject({
      stockScope: { scopeType: "Location" },
      counts: [{ status: "InProgress", varianceLines: null }],
    });
    expect(() => parseInventoryCountView({ ...projection(), stockScope: null })).toThrow(
      InventoryCountClientError,
    );
    expect(() => parseInventoryCountView({ ...projection(), unexpected: true })).toThrow(
      InventoryCountClientError,
    );
  });

  it("fails closed if BlindUntilSubmit leaks expected quantity or variance", () => {
    const leaked = projection();
    const counts = leaked.counts.map((count) => ({
      ...count,
      lines: count.lines.map((line) => ({ ...line, expectedQuantity: "10", variance: "0" })),
    }));
    expect(() => parseInventoryCountView({ ...leaked, counts })).toThrow(InventoryCountClientError);
  });

  it("renders blind Workbench, snapshot, lines, conflicts and disabled workflow actions", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <InventoryCountScreen view={parseInventoryCountView(projection())} />
      </MemoryRouter>,
    );
    for (const text of [
      "immutable snapshot and Movement posting",
      "Authorized prep location",
      "Blind — hidden",
      "Enter / scan quantity",
      "Reject for recount",
      "Post idempotent Movements",
    ])
      expect(html).toContain(text);
  });

  it("reveals expected and variance only after submission", () => {
    const submitted = projection();
    const counts = submitted.counts.map((count) => ({
      ...count,
      status: "Submitted",
      countedLines: 1,
      varianceLines: 1,
      submittedByDisplay: "Authorized submitter",
      lines: count.lines.map((line) => ({
        ...line,
        expectedQuantity: "10",
        countedQuantity: "12",
        variance: "2",
        varianceReasonCode: "COUNT_VARIANCE",
      })),
    }));
    const view = parseInventoryCountView({ ...submitted, counts });
    expect(view.counts[0]?.lines[0]).toMatchObject({ expectedQuantity: "10", variance: "2" });
  });

  it("covers mandatory failure, conflict, stale and offline states", () => {
    for (const state of [
      "Loading",
      "PermissionDenied",
      "NotFound",
      "FeatureDisabled",
      "Stale",
      "Conflict",
      "CommandFailed",
      "Offline",
      "Unavailable",
    ] as const)
      expect(
        renderToStaticMarkup(
          <MemoryRouter>
            <InventoryCountState state={state} />
          </MemoryRouter>,
        ),
      ).toContain("status");
  });
});

import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { platformWorkflows } from "./platform-workflows.mjs";

/**
 * WP-2423 item 9 gate. A Brand holds one family per purpose and order type, and no tool moves it to
 * a changed definition yet. Change a transition here and every Brand is stuck: the guard refuses a
 * new family, the release tool refuses an older cancellation definition, and the cancellation worker
 * accepts only the repository's current one. Write the family upgrade step first, then change these.
 */
const RELEASED_DEFINITIONS = Object.freeze({
  UnpaidDineInBatchCancellation: "fac79734f54999c6b9bbd3b969b37b4542c047ae4eadf84b37af5c7789264264",
  OrderFulfillmentPickup: "3aa299967b0228ddc3b1d5a21d61e4eb550a7d265d37a5bbb369781ca273fe49",
  OrderFulfillmentDineIn: "3aa299967b0228ddc3b1d5a21d61e4eb550a7d265d37a5bbb369781ca273fe49",
  OrderFulfillmentAdditionalRound:
    "5c46c9df2c6f175f0fb16cfa8af362d2f3d3e8e89af40d2c85fe27d87046fc03",
});
const digest = ({ transitions }) =>
  createHash("sha256").update(JSON.stringify(transitions)).digest("hex");

it("keeps the released definitions until a Brand can be moved to a changed one", () => {
  expect(
    Object.fromEntries(
      Object.entries(platformWorkflows).map(([name, workflow]) => [name, digest(workflow)]),
    ),
    "docs/runbooks/single-store-pilot.md: no upgrade tool yet. Write that step before changing these.",
  ).toEqual(RELEASED_DEFINITIONS);
});

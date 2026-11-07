import { expect, it } from "vitest";
import {
  initialRevisionIsCurrent,
  type OrderInitialRevision,
} from "../infrastructure/persistence/order-termination-store.js";

const id = (n: number) => "0190ed26-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const chain = (...kinds: OrderInitialRevision["kind"][]): OrderInitialRevision[] =>
  kinds.map((kind, index) => ({ kind, version: index + 1, checkpoint: id(index + 1) }));

// WP-2423 (v15 order 10): work issued from the accepted Order (version 2) stays current after
// staff cancel item lines, and only then.
it("keeps work issued at a revision current only across later staff item cancellations", () => {
  const accepted = chain("Initial", "Acceptance");
  expect(initialRevisionIsCurrent(accepted, 2n, id(2), "Exact")).toBe(true);
  expect(initialRevisionIsCurrent(accepted, 2n, id(2), "Issued")).toBe(true);

  const itemsCancelled = chain(
    "Initial",
    "Acceptance",
    "StaffItemCancellation",
    "StaffItemCancellation",
  );
  expect(initialRevisionIsCurrent(itemsCancelled, 2n, id(2), "Exact")).toBe(false);
  expect(initialRevisionIsCurrent(itemsCancelled, 2n, id(2), "Issued")).toBe(true);
  expect(initialRevisionIsCurrent(itemsCancelled, 4n, id(4), "Exact")).toBe(true);

  const terminated = chain("Initial", "Acceptance", "StaffItemCancellation", "Termination");
  expect(initialRevisionIsCurrent(terminated, 2n, id(2), "Issued")).toBe(false);
  expect(initialRevisionIsCurrent(terminated, 3n, id(3), "Issued")).toBe(false);
});

it("refuses a revision that is not in the chain or carries another checkpoint", () => {
  const revisions = chain("Initial", "Acceptance", "StaffItemCancellation");
  expect(initialRevisionIsCurrent(revisions, 2n, id(9), "Issued")).toBe(false);
  expect(initialRevisionIsCurrent(revisions, 5n, id(2), "Issued")).toBe(false);
  expect(initialRevisionIsCurrent([], 1n, id(1), "Issued")).toBe(false);
});

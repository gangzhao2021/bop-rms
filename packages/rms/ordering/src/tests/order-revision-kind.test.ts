import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import {
  ORDER_REVISION_KINDS,
  ORDER_REVISION_KIND_POLICY,
  isChainedOrderRevisionKind,
  isTerminalOrderRevisionKind,
  persistedOrderRevisionKindPolicy,
} from "../domain/order-revision-kind.js";
import { parseOrderRevision } from "../domain/order-revision-chain.js";
import {
  orderRevisionOperationBoundSql,
  orderRevisionOwnerBindingSql,
} from "../infrastructure/persistence/order-revision-binding.js";

const migrations = fileURLToPath(new URL("../../../../../migrations/", import.meta.url));

function sqlFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sqlFiles(join(directory, entry.name))
      : entry.name.endsWith(".sql")
        ? [join(directory, entry.name)]
        : [],
  );
}

test("TS order revision kinds equal the latest migration CHECK constraint", () => {
  const latest = sqlFiles(migrations)
    .sort()
    .map((path) => readFileSync(path, "utf8"))
    .flatMap((text) => {
      const found = [
        ...text.matchAll(
          /ADD CONSTRAINT order_revision_kind_check\s+CHECK \(kind IN \(([^)]*)\)\)/gu,
        ),
      ];
      return found.map((match) => match[1] ?? "");
    })
    .at(-1);
  expect(latest).toBeDefined();
  const kinds = [...(latest ?? "").matchAll(/'([^']+)'/gu)].map((match) => match[1]);
  expect(kinds).toEqual([...ORDER_REVISION_KINDS]);
});

test("policies are consistent and only Initial is a root", () => {
  for (const kind of ORDER_REVISION_KINDS) {
    const policy = ORDER_REVISION_KIND_POLICY[kind];
    expect(policy.terminal && policy.continuesDiningOrder).toBe(false);
    expect(policy.root && policy.terminal).toBe(false);
    expect(isChainedOrderRevisionKind(kind)).toBe(!policy.root);
    expect(isTerminalOrderRevisionKind(kind)).toBe(policy.terminal);
    expect(orderRevisionOwnerBindingSql(policy.ownerRecord)).toMatch(/^EXISTS \(SELECT 1 FROM /u);
  }
  expect(ORDER_REVISION_KINDS.filter((kind) => ORDER_REVISION_KIND_POLICY[kind].root)).toEqual([
    "Initial",
  ]);
  expect(
    ORDER_REVISION_KINDS.filter((kind) => !ORDER_REVISION_KIND_POLICY[kind].continuesDiningOrder),
  ).toEqual(["Termination", "Fulfillment"]);
  expect(
    new Set(ORDER_REVISION_KINDS.map((k) => ORDER_REVISION_KIND_POLICY[k].ownerRecord)).size,
  ).toBe(ORDER_REVISION_KINDS.length);
  expect(persistedOrderRevisionKindPolicy("Unknown")).toBeNull();
  expect(persistedOrderRevisionKindPolicy(null)).toBeNull();
});

test("operation_bound CASE binds every selected kind and nothing else", () => {
  const all = orderRevisionOperationBoundSql();
  for (const kind of ORDER_REVISION_KINDS) expect(all).toContain("WHEN '" + kind + "' THEN EXISTS");
  expect(all).toMatch(/^CASE r\.kind .* ELSE false END AS operation_bound $/u);
  const open = orderRevisionOperationBoundSql((policy) => !policy.terminal);
  expect(open).not.toContain("WHEN 'Termination'");
  expect(open).not.toContain("order_fulfillment_completion_record");
});

test("chain revisions accept every non-root kind and refuse Initial", () => {
  const revision = (kind: string) => ({
    brandReference: "018f0000-0000-7000-8000-000000000001",
    storeReference: "018f0000-0000-7000-8000-000000000002",
    orderReference: "018f0000-0000-7000-8000-000000000003",
    revisionReference: "018f0000-0000-7000-8000-000000000004",
    previousRevisionReference: "018f0000-0000-7000-8000-000000000005",
    expectedVersion: 1,
    version: 2,
    occurredAt: "2026-10-13T00:00:00.000Z",
    kind,
  });
  for (const kind of ORDER_REVISION_KINDS) {
    if (ORDER_REVISION_KIND_POLICY[kind].root)
      expect(() => parseOrderRevision(revision(kind))).toThrow();
    else expect(parseOrderRevision(revision(kind)).kind).toBe(kind);
  }
});

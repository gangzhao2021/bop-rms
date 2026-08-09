import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createOrderKitchenSourceEvidenceBinding,
  createOrderKitchenSourceLineBinding,
  createOrderKitchenSourceQueryService,
  OrderKitchenSourceError,
  parseConfirmedOrderKitchenSourceEvidence,
  parseOrderKitchenCustomerNote,
  parseResolveConfirmedOrderKitchenSourceInput,
  type OrderKitchenSourceQueryPorts,
} from "../index.js";

const id = (value: number) => `018f6800-0000-7000-8000-${value.toString(16).padStart(12, "0")}`;
const capturedAt = "2026-08-08T14:00:00.000Z";
const observedAt = "2026-08-08T14:01:00.000Z";
const placeholderDigest = `sha256:${"0".repeat(64)}`;
const refs = {
  evidence: id(1),
  brand: id(2),
  store: id(3),
  order: id(4),
  batch: id(5),
  confirmation: id(6),
  sourceEvent: id(7),
  item: id(8),
  product: id(9),
  productVersion: id(10),
  sku: id(11),
  menuVersion: id(12),
  option: id(13),
};

function hash(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function sourceItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const candidate: Record<string, unknown> = {
    orderItemReference: refs.item,
    orderBatchReference: refs.batch,
    ordinal: 1,
    quantity: 2,
    productReference: refs.product,
    productVersionReference: refs.productVersion,
    skuReference: refs.sku,
    menuVersionReference: refs.menuVersion,
    localizedDisplayNames: { "fr-CA": "Article synthétique", "en-CA": "Synthetic item" },
    selectedOptions: [
      {
        optionReference: refs.option,
        quantity: 1,
        localizedNames: { "fr-CA": "Option synthétique", "en-CA": "Synthetic option" },
      },
    ],
    customerNote: "Café\nsynthetic request",
    lineDigest: placeholderDigest,
    ...overrides,
  };
  candidate.lineDigest = hash(createOrderKitchenSourceLineBinding(candidate));
  return candidate;
}

function sourceEvidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const candidate: Record<string, unknown> = {
    evidenceReference: refs.evidence,
    brandReference: refs.brand,
    storeReference: refs.store,
    orderReference: refs.order,
    orderBatchReference: refs.batch,
    confirmationReference: refs.confirmation,
    sourceEventReference: refs.sourceEvent,
    sourceAggregateVersion: 3n,
    sourceSnapshotDigest: hash("ordering-source"),
    capturedAt,
    evidenceVersion: 1,
    items: [sourceItem()],
    evidenceDigest: placeholderDigest,
    ...overrides,
  };
  candidate.evidenceDigest = hash(createOrderKitchenSourceEvidenceBinding(candidate));
  return candidate;
}

function queryInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    brandReference: refs.brand,
    storeReference: refs.store,
    orderReference: refs.order,
    orderBatchReference: refs.batch,
    confirmationReference: refs.confirmation,
    sourceEventReference: refs.sourceEvent,
    sourceAggregateVersion: 3n,
    sourceSnapshotDigest: hash("ordering-source"),
    observedAt,
    ...overrides,
  };
}

function queryPorts(
  input: {
    readonly source?: unknown | null;
    readonly authorize?: OrderKitchenSourceQueryPorts["authorization"]["authorize"];
    readonly digest?: (canonicalValue: string) => string;
    readonly loadSource?: OrderKitchenSourceQueryPorts["source"]["loadExact"];
  } = {},
): { readonly calls: string[]; readonly ports: OrderKitchenSourceQueryPorts } {
  const calls: string[] = [];
  return {
    calls,
    ports: {
      authorization: {
        authorize:
          input.authorize ??
          (async () => {
            calls.push("authorize");
            return true;
          }),
      },
      source: {
        loadExact:
          input.loadSource ??
          (async () => {
            calls.push("source");
            return input.source === undefined ? sourceEvidence() : input.source;
          }),
      },
      digests: { sha256: input.digest ?? hash },
    },
  };
}

function expectCode(code: OrderKitchenSourceError["code"]) {
  return expect.objectContaining({
    name: "OrderKitchenSourceError",
    code,
    message: "order kitchen source is unavailable",
  });
}

describe("ConfirmedOrderKitchenSourceEvidence", () => {
  it("strictly parses a canonical, lossy and deeply frozen source snapshot", () => {
    const parsed = parseConfirmedOrderKitchenSourceEvidence(sourceEvidence());

    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]).toMatchObject({
      orderItemReference: refs.item,
      quantity: 2,
      customerNote: "Café\nsynthetic request",
    });
    expect(Object.keys(parsed.items[0] ?? {})).toEqual([
      "orderItemReference",
      "orderBatchReference",
      "ordinal",
      "quantity",
      "productReference",
      "productVersionReference",
      "skuReference",
      "menuVersionReference",
      "localizedDisplayNames",
      "selectedOptions",
      "customerNote",
      "lineDigest",
    ]);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.items)).toBe(true);
    expect(Object.isFrozen(parsed.items[0])).toBe(true);
    expect(Object.isFrozen(parsed.items[0]?.localizedDisplayNames)).toBe(true);
    expect(Object.isFrozen(parsed.items[0]?.selectedOptions)).toBe(true);
    expect(Object.isFrozen(parsed.items[0]?.selectedOptions[0]?.localizedNames)).toBe(true);
  });

  it("rejects extra, symbol, custom-prototype and accessor data without reading the accessor", () => {
    expect(() =>
      parseConfirmedOrderKitchenSourceEvidence({ ...sourceEvidence(), pricing: {} }),
    ).toThrow(expectCode("ORDER_KITCHEN_SOURCE_INPUT_INVALID"));

    const symbolValue = sourceEvidence();
    Object.defineProperty(symbolValue, Symbol("extra"), { value: "synthetic" });
    expect(() => parseConfirmedOrderKitchenSourceEvidence(symbolValue)).toThrow(
      expectCode("ORDER_KITCHEN_SOURCE_INPUT_INVALID"),
    );

    const customPrototype = Object.assign(Object.create({ inherited: true }), sourceEvidence());
    expect(() => parseConfirmedOrderKitchenSourceEvidence(customPrototype)).toThrow(
      expectCode("ORDER_KITCHEN_SOURCE_INPUT_INVALID"),
    );

    let accessorRead = false;
    const accessorValue = sourceEvidence();
    Object.defineProperty(accessorValue, "orderReference", {
      enumerable: true,
      get() {
        accessorRead = true;
        return refs.order;
      },
    });
    expect(() => parseConfirmedOrderKitchenSourceEvidence(accessorValue)).toThrow(
      expectCode("ORDER_KITCHEN_SOURCE_INPUT_INVALID"),
    );
    expect(accessorRead).toBe(false);
  });

  it("enforces a unique contiguous one-to-100 item set bound to the source Batch", () => {
    const maximumItems = Array.from({ length: 100 }, (_, index) =>
      sourceItem({ orderItemReference: id(100 + index), ordinal: index + 1 }),
    );
    expect(
      parseConfirmedOrderKitchenSourceEvidence(sourceEvidence({ items: maximumItems })).items,
    ).toHaveLength(100);
    expect(() => parseConfirmedOrderKitchenSourceEvidence(sourceEvidence({ items: [] }))).toThrow(
      expectCode("ORDER_KITCHEN_SOURCE_INPUT_INVALID"),
    );
    expect(() =>
      parseConfirmedOrderKitchenSourceEvidence(
        sourceEvidence({
          items: [...maximumItems, sourceItem({ orderItemReference: id(250), ordinal: 101 })],
        }),
      ),
    ).toThrow(expectCode("ORDER_KITCHEN_SOURCE_INPUT_INVALID"));
    expect(() =>
      parseConfirmedOrderKitchenSourceEvidence(
        sourceEvidence({ items: [sourceItem({ ordinal: 2 })] }),
      ),
    ).toThrow(expectCode("ORDER_KITCHEN_SOURCE_INPUT_INVALID"));
    expect(() =>
      parseConfirmedOrderKitchenSourceEvidence(
        sourceEvidence({
          items: [sourceItem(), sourceItem({ ordinal: 2 })],
        }),
      ),
    ).toThrow(expectCode("ORDER_KITCHEN_SOURCE_INPUT_INVALID"));
    expect(() =>
      parseConfirmedOrderKitchenSourceEvidence(
        sourceEvidence({ items: [sourceItem({ orderBatchReference: id(99) })] }),
      ),
    ).toThrow(expectCode("ORDER_KITCHEN_SOURCE_INPUT_INVALID"));
  });

  it("enforces source and selected-Option quantity limits and single-line display names", () => {
    for (const quantity of [0, 1_000]) {
      expect(() => sourceItem({ quantity })).toThrow(
        expectCode("ORDER_KITCHEN_SOURCE_INPUT_INVALID"),
      );
      expect(() =>
        sourceItem({
          selectedOptions: [
            {
              optionReference: refs.option,
              quantity,
              localizedNames: { "en-CA": "Synthetic option" },
            },
          ],
        }),
      ).toThrow(expectCode("ORDER_KITCHEN_SOURCE_INPUT_INVALID"));
    }
    expect(() => sourceItem({ localizedDisplayNames: { "en-CA": "Synthetic\nitem" } })).toThrow(
      expectCode("ORDER_KITCHEN_SOURCE_INPUT_INVALID"),
    );
  });

  it("normalizes and bounds the opaque customer note by Unicode code point and line", () => {
    expect(parseOrderKitchenCustomerNote("Cafe\u0301")).toBe("Café");
    expect(parseOrderKitchenCustomerNote("😀".repeat(240))).toBe("😀".repeat(240));
    expect(parseOrderKitchenCustomerNote("a\nb\nc\nd")).toBe("a\nb\nc\nd");

    for (const invalid of [
      "",
      "😀".repeat(241),
      "a\nb\nc\nd\ne",
      "tab\tvalue",
      "carriage\rreturn",
      "override\u202evalue",
      "isolate\u2066value",
      "separator\u2028value",
      "unpaired\ud800surrogate",
    ]) {
      expect(() => parseOrderKitchenCustomerNote(invalid)).toThrow(
        expectCode("ORDER_KITCHEN_SOURCE_INPUT_INVALID"),
      );
    }
  });
});

describe("Ordering Kitchen source query", () => {
  it("parses, authorizes the exact identity and purpose, then reads and verifies the source", async () => {
    const calls: string[] = [];
    const evidence = sourceEvidence();
    const ports: OrderKitchenSourceQueryPorts = {
      authorization: {
        async authorize(input) {
          calls.push("authorize");
          expect(input).toEqual({
            action: "ResolveConfirmedOrderKitchenSource",
            purpose: "CreateKitchenWork",
            ...queryInput(),
          });
          return true;
        },
      },
      source: {
        async loadExact(input) {
          calls.push("source");
          expect(input).toEqual(parseResolveConfirmedOrderKitchenSourceInput(queryInput()));
          return evidence;
        },
      },
      digests: { sha256: hash },
    };

    const result = await createOrderKitchenSourceQueryService(ports).resolve(queryInput());

    expect(calls).toEqual(["authorize", "source"]);
    expect(result.evidenceReference).toBe(refs.evidence);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("fails before the source read when input is invalid or authorization denies or throws", async () => {
    const invalidHarness = queryPorts();
    await expect(
      createOrderKitchenSourceQueryService(invalidHarness.ports).resolve({
        ...queryInput(),
        storeReference: "unsafe-reference",
      }),
    ).rejects.toMatchObject(expectCode("ORDER_KITCHEN_SOURCE_INPUT_INVALID"));
    expect(invalidHarness.calls).toEqual([]);

    const deniedAuthorizationCalls: string[] = [];
    const denied = queryPorts({
      authorize: async () => {
        deniedAuthorizationCalls.push("authorize");
        return false;
      },
    });
    await expect(
      createOrderKitchenSourceQueryService(denied.ports).resolve(queryInput()),
    ).rejects.toMatchObject(expectCode("ORDER_KITCHEN_SOURCE_PERMISSION_DENIED"));
    expect(deniedAuthorizationCalls).toEqual(["authorize"]);
    expect(denied.calls).toEqual([]);

    const thrownAuthorizationCalls: string[] = [];
    const thrown = queryPorts({
      authorize: async () => {
        thrownAuthorizationCalls.push("authorize");
        throw new Error("synthetic authorization failure");
      },
    });
    await expect(
      createOrderKitchenSourceQueryService(thrown.ports).resolve(queryInput()),
    ).rejects.toMatchObject(expectCode("ORDER_KITCHEN_SOURCE_DEPENDENCY_UNAVAILABLE"));
    expect(thrownAuthorizationCalls).toEqual(["authorize"]);
    expect(thrown.calls).toEqual([]);
  });

  it("maps missing or throwing source dependencies to one closed error", async () => {
    const missing = queryPorts({ source: null });
    await expect(
      createOrderKitchenSourceQueryService(missing.ports).resolve(queryInput()),
    ).rejects.toMatchObject(expectCode("ORDER_KITCHEN_SOURCE_DEPENDENCY_UNAVAILABLE"));

    const throwing = queryPorts({
      loadSource: async () => {
        throw new Error("synthetic source failure");
      },
    });
    await expect(
      createOrderKitchenSourceQueryService(throwing.ports).resolve(queryInput()),
    ).rejects.toMatchObject(expectCode("ORDER_KITCHEN_SOURCE_DEPENDENCY_UNAVAILABLE"));
  });

  it.each([
    ["cross Brand", { brandReference: id(40) }],
    ["cross Store", { storeReference: id(41) }],
    ["different confirmation", { confirmationReference: id(42) }],
    ["different source Event", { sourceEventReference: id(43) }],
    ["different aggregate version", { sourceAggregateVersion: 4n }],
    ["different source digest", { sourceSnapshotDigest: hash("changed-source") }],
    ["future capture", { capturedAt: "2026-08-08T14:02:00.000Z" }],
  ])("rejects %s evidence as a conflict", async (_label, override) => {
    const harness = queryPorts({ source: sourceEvidence(override) });
    await expect(
      createOrderKitchenSourceQueryService(harness.ports).resolve(queryInput()),
    ).rejects.toMatchObject(expectCode("ORDER_KITCHEN_SOURCE_CONFLICT"));
  });

  it("rejects malformed, ambiguous, line-tampered and evidence-tampered source data", async () => {
    const malformed = queryPorts({ source: { ...sourceEvidence(), customerReference: id(50) } });
    await expect(
      createOrderKitchenSourceQueryService(malformed.ports).resolve(queryInput()),
    ).rejects.toMatchObject(expectCode("ORDER_KITCHEN_SOURCE_CONFLICT"));

    const ambiguous = queryPorts({ source: [sourceEvidence(), sourceEvidence()] });
    await expect(
      createOrderKitchenSourceQueryService(ambiguous.ports).resolve(queryInput()),
    ).rejects.toMatchObject(expectCode("ORDER_KITCHEN_SOURCE_CONFLICT"));

    const lineTampered = sourceItem();
    lineTampered.lineDigest = hash("changed-line");
    const changedLine = queryPorts({ source: sourceEvidence({ items: [lineTampered] }) });
    await expect(
      createOrderKitchenSourceQueryService(changedLine.ports).resolve(queryInput()),
    ).rejects.toMatchObject(expectCode("ORDER_KITCHEN_SOURCE_CONFLICT"));

    const evidenceTampered = queryPorts({
      source: { ...sourceEvidence(), evidenceDigest: hash("changed-evidence") },
    });
    await expect(
      createOrderKitchenSourceQueryService(evidenceTampered.ports).resolve(queryInput()),
    ).rejects.toMatchObject(expectCode("ORDER_KITCHEN_SOURCE_CONFLICT"));
  });

  it("does not execute accessors while parsing the query identity", async () => {
    let accessorRead = false;
    const value = queryInput();
    Object.defineProperty(value, "orderReference", {
      enumerable: true,
      get() {
        accessorRead = true;
        return refs.order;
      },
    });
    const harness = queryPorts();

    await expect(
      createOrderKitchenSourceQueryService(harness.ports).resolve(value),
    ).rejects.toMatchObject(expectCode("ORDER_KITCHEN_SOURCE_INPUT_INVALID"));
    expect(accessorRead).toBe(false);
    expect(harness.calls).toEqual([]);
  });
});

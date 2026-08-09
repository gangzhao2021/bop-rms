import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  type ConfirmedOrderIntakeReceipt,
  type KitchenDigest,
  type KitchenInstant,
  type KitchenPlanningSource,
  type KitchenPreparationEvidenceItem,
  type KitchenPreparationEvidenceSet,
  type KitchenReference,
  type KitchenStationRoutingCandidate,
  type KitchenStationRoutingCandidateSetEvidence,
  type KitchenWorkPlanPorts,
  type ResolveKitchenStationRoutingEvidenceInput,
  type ResolveRecipePreparationEvidenceInput,
  createKitchenPreparationEvidenceSetDigestBinding,
  createKitchenRoutingRuleDigestBinding,
  createKitchenStationRoutingCandidateSetDigestBinding,
  createKitchenWorkPlanDigestBinding,
  createKitchenWorkPlanReferenceBinding,
  createKitchenWorkPlanService,
  parseConfirmedOrderIntakeReceipt,
  parseKitchenPlanningSource,
  parseKitchenPreparationEvidenceSet,
  parseKitchenStationRoutingCandidateSetEvidence,
  parseKitchenTicketDigest,
  parseKitchenTicketReference,
} from "../index.js";

function id(value: number): KitchenReference {
  return parseKitchenTicketReference(
    `018f3000-0000-7000-8000-${value.toString(16).padStart(12, "0")}`,
  );
}

function sha256(value: string): KitchenDigest {
  return parseKitchenTicketDigest(`sha256:${createHash("sha256").update(value).digest("hex")}`);
}

const confirmedAt = "2026-08-08T16:00:00.000Z" as KitchenInstant;
const later = "2026-08-08T16:00:01.000Z" as KitchenInstant;
const placeholderDigest = sha256("placeholder");

function receipt(
  overrides: Partial<Record<keyof ConfirmedOrderIntakeReceipt, unknown>> = {},
): ConfirmedOrderIntakeReceipt {
  return parseConfirmedOrderIntakeReceipt({
    consumerName: "kitchen.confirmed-order:v1",
    consumerVersion: 1,
    sourceEventReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    orderReference: id(4),
    orderBatchReference: id(5),
    confirmationReference: id(6),
    sourceAggregateVersion: 3n,
    sourceSnapshotDigest: sha256("ordering-owned-snapshot"),
    confirmedAt,
    correlationReference: id(7),
    semanticEventBindingDigest: sha256("semantic-event"),
    ...overrides,
  });
}

function planningSource(
  input: ConfirmedOrderIntakeReceipt,
  overrides: Partial<Record<keyof KitchenPlanningSource, unknown>> = {},
): KitchenPlanningSource {
  return parseKitchenPlanningSource({
    brandReference: input.brandReference,
    storeReference: input.storeReference,
    orderReference: input.orderReference,
    orderBatchReference: input.orderBatchReference,
    confirmationReference: input.confirmationReference,
    sourceEvidenceReference: id(8),
    sourceEvidenceVersion: 4,
    sourceEvidenceDigest: sha256("lossy-planning-source"),
    items: [
      {
        orderItemReference: id(20),
        ordinal: 1,
        quantity: 2,
        productReference: id(21),
        productVersionReference: id(22),
        skuReference: id(23),
        menuVersionReference: id(24),
        selectedOptions: [
          { optionReference: id(26), quantity: 2 },
          { optionReference: id(25), quantity: 1 },
        ],
        sourceLineDigest: sha256("lossy-source-line"),
      },
    ],
    ...overrides,
  });
}

interface StationEvidenceOptions {
  readonly brandReference?: KitchenReference;
  readonly storeReference?: KitchenReference;
  readonly effectiveAt?: KitchenInstant;
  readonly evidenceReference?: KitchenReference;
  readonly evidenceVersion?: number;
  readonly candidateOverrides?: Partial<KitchenStationRoutingCandidate>;
  readonly candidates?: readonly Partial<KitchenStationRoutingCandidate>[];
  readonly signRules?: boolean;
}

function stationEvidence(
  input: ConfirmedOrderIntakeReceipt,
  options: StationEvidenceOptions = {},
): KitchenStationRoutingCandidateSetEvidence {
  const brandReference = options.brandReference ?? input.brandReference;
  const storeReference = options.storeReference ?? input.storeReference;
  const effectiveAt = options.effectiveAt ?? input.confirmedAt;
  const candidates = (options.candidates ?? [options.candidateOverrides ?? {}]).map(
    (overrides, index) => {
      const candidate: KitchenStationRoutingCandidate = {
        stationReference: id(40 + index * 10),
        stationVersion: 3,
        stationStatus: "Active",
        stationCapabilityReferences: [id(43), id(41), id(42)],
        routingRuleReference: id(50 + index * 10),
        routingRuleVersion: 5,
        routingRuleStatus: "Active",
        selector: { kind: "AllPreparedItems" },
        targetStationReference: id(40 + index * 10),
        routingRuleDigest: placeholderDigest,
        ...overrides,
      };
      if (options.signRules === false) return candidate;
      return {
        ...candidate,
        routingRuleDigest: sha256(
          createKitchenRoutingRuleDigestBinding({
            brandReference,
            storeReference,
            effectiveAt,
            candidate,
          }),
        ),
      };
    },
  );
  const draft = {
    evidenceReference: options.evidenceReference ?? id(60),
    evidenceVersion: options.evidenceVersion ?? 7,
    evidenceDigest: placeholderDigest,
    brandReference,
    storeReference,
    effectiveAt,
    candidates,
  };
  return parseKitchenStationRoutingCandidateSetEvidence({
    ...draft,
    evidenceDigest: sha256(createKitchenStationRoutingCandidateSetDigestBinding(draft)),
  });
}

interface PreparationEvidenceOptions {
  readonly brandReference?: KitchenReference;
  readonly storeReference?: KitchenReference;
  readonly effectiveAt?: KitchenInstant;
  readonly evidenceReference?: KitchenReference;
  readonly evidenceVersion?: number;
  readonly itemOverrides?: Partial<KitchenPreparationEvidenceItem>;
}

function preparationEvidence(
  input: ConfirmedOrderIntakeReceipt,
  source: KitchenPlanningSource,
  options: PreparationEvidenceOptions = {},
): KitchenPreparationEvidenceSet {
  const items = source.items.map((sourceItem, index) => ({
    orderItemReference: sourceItem.orderItemReference,
    ordinal: sourceItem.ordinal,
    quantity: sourceItem.quantity,
    productReference: sourceItem.productReference,
    productVersionReference: sourceItem.productVersionReference,
    skuReference: sourceItem.skuReference,
    menuVersionReference: sourceItem.menuVersionReference,
    selectedOptions: sourceItem.selectedOptions,
    sourceLineDigest: sourceItem.sourceLineDigest,
    preparationReference: id(70 + index),
    preparationVersion: 9,
    preparationDigest: sha256(`recipe-owned-preparation-${index}`),
    instructions: ["  Prepare Cafe\u0301 component  ", "Plate synthetic component"],
    requiredStationCapabilityReferences: [id(43), id(41)],
    ...(index === 0 ? options.itemOverrides : {}),
  }));
  const draft = {
    evidenceReference: options.evidenceReference ?? id(80),
    evidenceVersion: options.evidenceVersion ?? 11,
    evidenceDigest: placeholderDigest,
    brandReference: options.brandReference ?? input.brandReference,
    storeReference: options.storeReference ?? input.storeReference,
    effectiveAt: options.effectiveAt ?? input.confirmedAt,
    items,
  };
  return parseKitchenPreparationEvidenceSet({
    ...draft,
    evidenceDigest: sha256(createKitchenPreparationEvidenceSetDigestBinding(draft)),
  });
}

function fixture() {
  const inputReceipt = receipt();
  const source = planningSource(inputReceipt);
  return {
    receipt: inputReceipt,
    source,
    stationEvidence: stationEvidence(inputReceipt),
    preparationEvidence: preparationEvidence(inputReceipt, source),
  };
}

interface PlannerOverrides {
  readonly stationRouting?: (
    input: ResolveKitchenStationRoutingEvidenceInput,
  ) => Promise<unknown | null>;
  readonly preparations?: (input: ResolveRecipePreparationEvidenceInput) => Promise<unknown | null>;
  readonly derive?: (purpose: "KitchenWorkPlan", canonicalIdentity: string) => string;
  readonly digest?: (binding: string) => string;
}

function planner(input: ReturnType<typeof fixture>, overrides: PlannerOverrides = {}) {
  const calls = {
    station: [] as ResolveKitchenStationRoutingEvidenceInput[],
    preparations: [] as ResolveRecipePreparationEvidenceInput[],
    references: [] as (readonly ["KitchenWorkPlan", string])[],
    digests: [] as string[],
  };
  const ports: KitchenWorkPlanPorts = {
    stationRouting: {
      resolve: async (request) => {
        calls.station.push(request);
        return overrides.stationRouting === undefined
          ? input.stationEvidence
          : overrides.stationRouting(request);
      },
    },
    preparations: {
      resolve: async (request) => {
        calls.preparations.push(request);
        return overrides.preparations === undefined
          ? input.preparationEvidence
          : overrides.preparations(request);
      },
    },
    references: {
      derive: (purpose, identity) => {
        calls.references.push([purpose, identity]);
        return overrides.derive?.(purpose, identity) ?? id(90);
      },
    },
    digests: {
      sha256: (binding) => {
        calls.digests.push(binding);
        return overrides.digest?.(binding) ?? sha256(binding);
      },
    },
  };
  return { calls, service: createKitchenWorkPlanService(ports) };
}

describe("WP-1402 Kitchen Station routing and work-plan producer", () => {
  it("strictly parses, normalizes and deeply freezes both owner evidence sets", () => {
    const input = fixture();
    const parsedStation = parseKitchenStationRoutingCandidateSetEvidence(input.stationEvidence);
    const parsedPreparation = parseKitchenPreparationEvidenceSet(input.preparationEvidence);

    expect(parsedStation.candidates[0]?.stationCapabilityReferences).toEqual([
      id(41),
      id(42),
      id(43),
    ]);
    expect(
      parsedPreparation.items[0]?.selectedOptions.map((entry) => entry.optionReference),
    ).toEqual([id(25), id(26)]);
    expect(parsedPreparation.items[0]?.instructions).toEqual([
      "Prepare Café component",
      "Plate synthetic component",
    ]);
    expect(parsedPreparation.items[0]?.requiredStationCapabilityReferences).toEqual([
      id(41),
      id(43),
    ]);
    for (const value of [parsedStation, parsedPreparation])
      expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(parsedStation.candidates)).toBe(true);
    expect(Object.isFrozen(parsedStation.candidates[0])).toBe(true);
    expect(Object.isFrozen(parsedStation.candidates[0]?.selector)).toBe(true);
    expect(Object.isFrozen(parsedStation.candidates[0]?.stationCapabilityReferences)).toBe(true);
    expect(Object.isFrozen(parsedPreparation.items)).toBe(true);
    expect(Object.isFrozen(parsedPreparation.items[0])).toBe(true);
    expect(Object.isFrozen(parsedPreparation.items[0]?.selectedOptions)).toBe(true);
    expect(Object.isFrozen(parsedPreparation.items[0]?.instructions)).toBe(true);
    expect(Object.isFrozen(parsedPreparation.items[0]?.requiredStationCapabilityReferences)).toBe(
      true,
    );
  });

  it("rejects extras, symbols, prototypes, non-enumerable substitutions and accessors without invoking them", () => {
    const input = fixture();
    const contracts: readonly {
      readonly value: Record<string, unknown>;
      readonly arrayField: string;
      readonly parse: (value: unknown) => unknown;
    }[] = [
      {
        value: input.stationEvidence as unknown as Record<string, unknown>,
        arrayField: "candidates",
        parse: parseKitchenStationRoutingCandidateSetEvidence,
      },
      {
        value: input.preparationEvidence as unknown as Record<string, unknown>,
        arrayField: "items",
        parse: parseKitchenPreparationEvidenceSet,
      },
    ];

    for (const contract of contracts) {
      expect(() => contract.parse({ ...contract.value, extra: true })).toThrow();
      expect(() => contract.parse({ ...contract.value, [Symbol("extra")]: true })).toThrow();
      expect(() => contract.parse(Object.assign(Object.create(null), contract.value))).toThrow();

      const nonEnumerable = { ...contract.value };
      Object.defineProperty(nonEnumerable, "evidenceReference", {
        value: contract.value.evidenceReference,
        enumerable: false,
      });
      expect(() => contract.parse(nonEnumerable)).toThrow();

      let getterCalls = 0;
      const withGetter = { ...contract.value };
      Object.defineProperty(withGetter, "evidenceReference", {
        enumerable: true,
        get: () => {
          getterCalls += 1;
          return id(999);
        },
      });
      expect(() => contract.parse(withGetter)).toThrow();

      const originalValues = contract.value[contract.arrayField] as readonly unknown[];
      const values = [...originalValues];
      Object.defineProperty(values, "0", {
        enumerable: true,
        get: () => {
          getterCalls += 1;
          return originalValues[0];
        },
      });
      expect(() => contract.parse({ ...contract.value, [contract.arrayField]: values })).toThrow();
      expect(getterCalls).toBe(0);
    }

    for (const prohibited of ["\u061c", "\u200e", "\u200f", "\u202e", "\ud800"]) {
      const changed = {
        ...input.preparationEvidence,
        items: input.preparationEvidence.items.map((item) => ({
          ...item,
          instructions: [`safe${prohibited}unsafe`],
        })),
      };
      expect(() => parseKitchenPreparationEvidenceSet(changed)).toThrow();
    }
  });

  it("uses fixed ASCII set ordering and digest bindings independent of insertion order", () => {
    const input = receipt();
    const left = stationEvidence(input, {
      candidates: [
        {
          stationReference: id(40),
          targetStationReference: id(40),
          routingRuleReference: id(61),
          stationCapabilityReferences: [id(43), id(41)],
        },
        {
          stationReference: id(44),
          targetStationReference: id(44),
          routingRuleReference: id(51),
          stationCapabilityReferences: [id(42), id(41)],
        },
      ],
    });
    const right = stationEvidence(input, {
      candidates: [
        {
          stationReference: id(44),
          targetStationReference: id(44),
          routingRuleReference: id(51),
          stationCapabilityReferences: [id(41), id(42)],
        },
        {
          stationReference: id(40),
          targetStationReference: id(40),
          routingRuleReference: id(61),
          stationCapabilityReferences: [id(41), id(43)],
        },
      ],
    });
    expect(createKitchenStationRoutingCandidateSetDigestBinding(left)).toBe(
      createKitchenStationRoutingCandidateSetDigestBinding(right),
    );
    expect(left.candidates.map((entry) => entry.routingRuleReference)).toEqual([id(51), id(61)]);
    expect(() =>
      parseKitchenStationRoutingCandidateSetEvidence({
        ...left,
        candidates: [left.candidates[0], left.candidates[0]],
      }),
    ).toThrow();
    expect(() =>
      parseKitchenPreparationEvidenceSet({
        ...preparationEvidence(input, planningSource(input)),
        items: [
          {
            ...preparationEvidence(input, planningSource(input)).items[0],
            requiredStationCapabilityReferences: [id(41), id(41)],
          },
        ],
      }),
    ).toThrow();

    const preparation = preparationEvidence(input, planningSource(input));
    const reversed = {
      ...preparation,
      items: preparation.items.map((item) => ({
        ...item,
        selectedOptions: [...item.selectedOptions].reverse(),
        requiredStationCapabilityReferences: [
          ...item.requiredStationCapabilityReferences,
        ].reverse(),
      })),
    };
    expect(createKitchenPreparationEvidenceSetDigestBinding(reversed)).toBe(
      createKitchenPreparationEvidenceSetDigestBinding(preparation),
    );
    const stationVersionChanged = stationEvidence(input, {
      candidateOverrides: { stationVersion: 4 },
    });
    expect(stationVersionChanged.candidates[0]?.routingRuleDigest).not.toBe(
      stationEvidence(input).candidates[0]?.routingRuleDigest,
    );
  });

  it("sends exact least-privilege System requests and preserves the two independent source digests", async () => {
    const input = fixture();
    expect(input.receipt.sourceSnapshotDigest).not.toBe(input.source.sourceEvidenceDigest);
    const test = planner(input);
    const plan = await test.service.resolve({ receipt: input.receipt, source: input.source });

    expect(plan).not.toBeNull();
    expect(test.calls.station).toEqual([
      {
        actorType: "System",
        actorReference: null,
        action: "ResolveKitchenStationRoutingEvidence",
        purpose: "CreateKitchenWork",
        brandReference: input.receipt.brandReference,
        storeReference: input.receipt.storeReference,
        effectiveAt: input.receipt.confirmedAt,
      },
    ]);
    expect(Reflect.ownKeys(test.calls.station[0] ?? {})).toEqual([
      "actorType",
      "actorReference",
      "action",
      "purpose",
      "brandReference",
      "storeReference",
      "effectiveAt",
    ]);
    expect(test.calls.preparations).toEqual([
      {
        actorType: "System",
        actorReference: null,
        action: "ResolveRecipePreparationEvidence",
        purpose: "CreateKitchenWork",
        brandReference: input.receipt.brandReference,
        storeReference: input.receipt.storeReference,
        effectiveAt: input.receipt.confirmedAt,
        sourceEvidenceReference: input.source.sourceEvidenceReference,
        sourceEvidenceVersion: input.source.sourceEvidenceVersion,
        sourceEvidenceDigest: input.source.sourceEvidenceDigest,
        items: input.source.items,
      },
    ]);
    expect(Reflect.ownKeys(test.calls.preparations[0] ?? {})).toEqual([
      "actorType",
      "actorReference",
      "action",
      "purpose",
      "brandReference",
      "storeReference",
      "effectiveAt",
      "sourceEvidenceReference",
      "sourceEvidenceVersion",
      "sourceEvidenceDigest",
      "items",
    ]);
    expect(Object.isFrozen(test.calls.station[0])).toBe(true);
    expect(Object.isFrozen(test.calls.preparations[0])).toBe(true);
    for (const forbidden of [
      "customerNote",
      "localizedDisplayNames",
      "allergen",
      "health",
      "money",
      "payment",
      "provider",
      "correlationReference",
      "sourceSnapshotDigest",
    ]) {
      expect(
        JSON.stringify({ station: test.calls.station, recipe: test.calls.preparations }),
      ).not.toContain(forbidden);
    }
    expect(plan?.sourceEvidenceDigest).toBe(input.source.sourceEvidenceDigest);
  });

  it("rejects each shared identity mismatch before either evidence port while never comparing source digests", async () => {
    const input = fixture();
    const sharedFields = [
      "brandReference",
      "storeReference",
      "orderReference",
      "orderBatchReference",
      "confirmationReference",
    ] as const;
    for (const [index, field] of sharedFields.entries()) {
      const changedSource = { ...input.source, [field]: id(200 + index) };
      const test = planner(input);
      await expect(
        test.service.resolve({ receipt: input.receipt, source: changedSource }),
      ).resolves.toBeNull();
      expect(test.calls.station).toHaveLength(0);
      expect(test.calls.preparations).toHaveLength(0);
    }

    const changedDigest = sha256("independently-versioned-source-evidence");
    const source = parseKitchenPlanningSource({
      ...input.source,
      sourceEvidenceDigest: changedDigest,
    });
    const changed = { ...input, source };
    const test = planner(changed);
    await expect(test.service.resolve({ receipt: input.receipt, source })).resolves.toMatchObject({
      sourceEvidenceDigest: changedDigest,
    });
    expect(test.calls.station).toHaveLength(1);
    expect(test.calls.preparations[0]?.sourceEvidenceDigest).toBe(changedDigest);
  });

  it("short-circuits owner denial before source reads and propagates only a safe owner failure", async () => {
    const input = fixture();
    let stationReads = 0;
    let recipeReads = 0;
    const expectedStationKeys = [
      "actorType",
      "actorReference",
      "action",
      "purpose",
      "brandReference",
      "storeReference",
      "effectiveAt",
    ];
    const expectedRecipeKeys = [
      ...expectedStationKeys,
      "sourceEvidenceReference",
      "sourceEvidenceVersion",
      "sourceEvidenceDigest",
      "items",
    ];
    const stationOwnerAdapter =
      (decision: "Allow" | "Deny" | "Throw") =>
      async (request: ResolveKitchenStationRoutingEvidenceInput) => {
        expect(Object.getPrototypeOf(request)).toBe(Object.prototype);
        expect(Reflect.ownKeys(request)).toEqual(expectedStationKeys);
        expect(request).toMatchObject({
          actorType: "System",
          actorReference: null,
          action: "ResolveKitchenStationRoutingEvidence",
          purpose: "CreateKitchenWork",
        });
        if (decision === "Deny") return null;
        if (decision === "Throw")
          throw new Error("secret Station locator and owner failure detail");
        stationReads += 1;
        return input.stationEvidence;
      };
    const recipeOwnerAdapter =
      (decision: "Allow" | "Deny" | "Throw") =>
      async (request: ResolveRecipePreparationEvidenceInput) => {
        expect(Object.getPrototypeOf(request)).toBe(Object.prototype);
        expect(Reflect.ownKeys(request)).toEqual(expectedRecipeKeys);
        expect(request).toMatchObject({
          actorType: "System",
          actorReference: null,
          action: "ResolveRecipePreparationEvidence",
          purpose: "CreateKitchenWork",
        });
        if (decision === "Deny") return null;
        if (decision === "Throw") throw new Error("secret Recipe locator and owner failure detail");
        recipeReads += 1;
        return input.preparationEvidence;
      };
    const stationDeny = planner(input, {
      stationRouting: stationOwnerAdapter("Deny"),
      preparations: recipeOwnerAdapter("Allow"),
    });
    await expect(
      stationDeny.service.resolve({ receipt: input.receipt, source: input.source }),
    ).resolves.toBeNull();
    expect(stationReads).toBe(0);
    expect(recipeReads).toBe(0);
    expect(stationDeny.calls.preparations).toHaveLength(0);

    const recipeDeny = planner(input, {
      stationRouting: stationOwnerAdapter("Allow"),
      preparations: recipeOwnerAdapter("Deny"),
    });
    await expect(
      recipeDeny.service.resolve({ receipt: input.receipt, source: input.source }),
    ).resolves.toBeNull();
    expect(stationReads).toBe(1);
    expect(recipeReads).toBe(0);
    expect(recipeDeny.calls.references).toHaveLength(0);

    const ownerFailure = planner(input, {
      stationRouting: stationOwnerAdapter("Throw"),
    });
    await expect(
      ownerFailure.service.resolve({ receipt: input.receipt, source: input.source }),
    ).rejects.toThrow("kitchen work plan is unavailable");
    await ownerFailure.service
      .resolve({ receipt: input.receipt, source: input.source })
      .catch((error: unknown) => {
        expect(String(error)).not.toContain("secret Station locator");
      });
    expect(ownerFailure.calls.preparations).toHaveLength(0);
  });

  it("treats Recipe preparation digests as opaque while binding the complete consumer evidence set", async () => {
    const input = fixture();
    const changedOpaqueDigest = sha256("Recipe-private-algorithm-v99");
    const changedItem = {
      ...input.preparationEvidence.items[0],
      preparationDigest: changedOpaqueDigest,
    };
    const tampered = {
      ...input.preparationEvidence,
      items: [changedItem],
    };
    const rejected = planner(input, { preparations: async () => tampered });
    await expect(
      rejected.service.resolve({ receipt: input.receipt, source: input.source }),
    ).resolves.toBeNull();

    const draft = { ...tampered, evidenceDigest: placeholderDigest };
    const resigned = parseKitchenPreparationEvidenceSet({
      ...draft,
      evidenceDigest: sha256(createKitchenPreparationEvidenceSetDigestBinding(draft)),
    });
    const accepted = planner(input, { preparations: async () => resigned });
    const plan = await accepted.service.resolve({ receipt: input.receipt, source: input.source });
    expect(plan?.items[0]?.preparation.preparationDigest).toBe(changedOpaqueDigest);
    expect(accepted.calls.digests.some((binding) => binding.includes(changedOpaqueDigest))).toBe(
      true,
    );
  });

  it("rejects every changed preparation-to-source binding even when the owner evidence is validly re-signed", async () => {
    const input = fixture();
    const mutations: readonly {
      readonly name: string;
      readonly item: Partial<KitchenPreparationEvidenceItem>;
    }[] = [
      { name: "Order Item", item: { orderItemReference: id(201) } },
      { name: "source ordinal", item: { ordinal: 2 } },
      { name: "source quantity", item: { quantity: 3 } },
      { name: "Product", item: { productReference: id(202) } },
      { name: "Product Version", item: { productVersionReference: id(203) } },
      { name: "SKU", item: { skuReference: id(204) } },
      { name: "Menu Version", item: { menuVersionReference: id(205) } },
      { name: "source line", item: { sourceLineDigest: sha256("changed-source-line") } },
      {
        name: "Option reference",
        item: {
          selectedOptions: [
            { optionReference: id(206), quantity: 1 },
            { optionReference: id(26), quantity: 2 },
          ],
        },
      },
      {
        name: "Option quantity",
        item: {
          selectedOptions: [
            { optionReference: id(25), quantity: 2 },
            { optionReference: id(26), quantity: 2 },
          ],
        },
      },
    ];
    for (const mutation of mutations) {
      const evidence = preparationEvidence(input.receipt, input.source, {
        itemOverrides: mutation.item,
      });
      const test = planner(input, { preparations: async () => evidence });
      await expect(
        test.service.resolve({ receipt: input.receipt, source: input.source }),
        mutation.name,
      ).resolves.toBeNull();
      expect(test.calls.references, mutation.name).toHaveLength(0);
    }

    const first = input.preparationEvidence.items[0];
    if (first === undefined) throw new Error("fixture preparation missing");
    const extraDraft = {
      ...input.preparationEvidence,
      evidenceDigest: placeholderDigest,
      items: [{ ...first }, { ...first, orderItemReference: id(207), ordinal: 2 }],
    };
    const extra = parseKitchenPreparationEvidenceSet({
      ...extraDraft,
      evidenceDigest: sha256(createKitchenPreparationEvidenceSetDigestBinding(extraDraft)),
    });
    await expect(
      planner(input, { preparations: async () => extra }).service.resolve({
        receipt: input.receipt,
        source: input.source,
      }),
    ).resolves.toBeNull();
  });

  it("detects a changed exact preparation field through the complete consumer evidence digest", async () => {
    const input = fixture();
    const base = input.preparationEvidence.items[0];
    if (base === undefined) throw new Error("fixture preparation missing");
    const mutations: readonly {
      readonly name: string;
      readonly item: KitchenPreparationEvidenceItem;
    }[] = [
      { name: "Order Item", item: { ...base, orderItemReference: id(211) } },
      { name: "ordinal", item: { ...base, ordinal: 2 } },
      { name: "quantity", item: { ...base, quantity: 3 } },
      { name: "Product", item: { ...base, productReference: id(212) } },
      { name: "Product Version", item: { ...base, productVersionReference: id(213) } },
      { name: "SKU", item: { ...base, skuReference: id(214) } },
      { name: "Menu Version", item: { ...base, menuVersionReference: id(215) } },
      { name: "source line", item: { ...base, sourceLineDigest: sha256("changed-line") } },
      {
        name: "Option reference",
        item: {
          ...base,
          selectedOptions: [
            { optionReference: id(216), quantity: 1 },
            { optionReference: id(26), quantity: 2 },
          ],
        },
      },
      {
        name: "Option quantity",
        item: {
          ...base,
          selectedOptions: [
            { optionReference: id(25), quantity: 2 },
            { optionReference: id(26), quantity: 2 },
          ],
        },
      },
      {
        name: "Preparation reference",
        item: { ...base, preparationReference: id(217) },
      },
      { name: "Preparation version", item: { ...base, preparationVersion: 10 } },
      {
        name: "opaque Preparation digest",
        item: { ...base, preparationDigest: sha256("changed-opaque-anchor") },
      },
      { name: "instruction", item: { ...base, instructions: ["Changed instruction"] } },
      {
        name: "required capability",
        item: { ...base, requiredStationCapabilityReferences: [id(42)] },
      },
    ];
    for (const mutation of mutations) {
      const tampered = { ...input.preparationEvidence, items: [mutation.item] };
      const test = planner(input, { preparations: async () => tampered });
      await expect(
        test.service.resolve({ receipt: input.receipt, source: input.source }),
        mutation.name,
      ).resolves.toBeNull();
      expect(test.calls.references, mutation.name).toHaveLength(0);
    }
  });

  it("accepts exact instruction and capability limits and rejects every adjacent overflow", async () => {
    const input = fixture();
    const capabilities = Array.from({ length: 32 }, (_, index) => id(500 + index));
    const instructions = ["x".repeat(500), ...Array.from({ length: 31 }, () => "step")];
    const maximumStation = stationEvidence(input.receipt, {
      candidateOverrides: { stationCapabilityReferences: [...capabilities].reverse() },
    });
    const maximumPreparation = preparationEvidence(input.receipt, input.source, {
      itemOverrides: {
        instructions,
        requiredStationCapabilityReferences: [...capabilities].reverse(),
      },
    });
    const maximum = await planner(input, {
      stationRouting: async () => maximumStation,
      preparations: async () => maximumPreparation,
    }).service.resolve({ receipt: input.receipt, source: input.source });
    expect(maximum?.items[0]?.preparation.instructions).toHaveLength(32);
    expect(maximum?.items[0]?.preparation.instructions[0]).toHaveLength(500);

    const zeroCapabilities = await planner(input, {
      stationRouting: async () =>
        stationEvidence(input.receipt, {
          candidateOverrides: { stationCapabilityReferences: [] },
        }),
      preparations: async () =>
        preparationEvidence(input.receipt, input.source, {
          itemOverrides: { requiredStationCapabilityReferences: [] },
        }),
    }).service.resolve({ receipt: input.receipt, source: input.source });
    expect(zeroCapabilities).not.toBeNull();

    const preparation = input.preparationEvidence;
    const invalidInstructions = [[], Array.from({ length: 33 }, () => "step"), ["x".repeat(501)]];
    for (const invalid of invalidInstructions) {
      expect(() =>
        parseKitchenPreparationEvidenceSet({
          ...preparation,
          items: preparation.items.map((item) => ({ ...item, instructions: invalid })),
        }),
      ).toThrow();
    }
    expect(() =>
      parseKitchenPreparationEvidenceSet({
        ...preparation,
        items: preparation.items.map((item) => ({
          ...item,
          requiredStationCapabilityReferences: Array.from({ length: 33 }, (_, index) =>
            id(600 + index),
          ),
        })),
      }),
    ).toThrow();
    expect(() =>
      parseKitchenStationRoutingCandidateSetEvidence({
        ...input.stationEvidence,
        candidates: input.stationEvidence.candidates.map((candidate) => ({
          ...candidate,
          stationCapabilityReferences: Array.from({ length: 33 }, (_, index) => id(700 + index)),
        })),
      }),
    ).toThrow();
  });

  it("requires one active exact rule, exact evidence scope/time and complete Station capability coverage", async () => {
    const input = fixture();
    const ruleTampered = stationEvidence(input.receipt, {
      signRules: false,
      candidateOverrides: { routingRuleDigest: sha256("not-the-rule-binding") },
    });
    const malformedSelector = {
      ...input.stationEvidence,
      candidates: [{ ...input.stationEvidence.candidates[0], selector: { kind: "ByCategory" } }],
    };
    const cases: readonly {
      readonly name: string;
      readonly station?: unknown;
      readonly preparation?: unknown;
    }[] = [
      { name: "zero candidates", station: stationEvidence(input.receipt, { candidates: [] }) },
      {
        name: "ambiguous candidates",
        station: stationEvidence(input.receipt, {
          candidates: [
            {},
            {
              stationReference: id(44),
              targetStationReference: id(44),
              routingRuleReference: id(54),
            },
          ],
        }),
      },
      {
        name: "inactive Station",
        station: stationEvidence(input.receipt, {
          candidateOverrides: { stationStatus: "Inactive" },
        }),
      },
      {
        name: "inactive rule",
        station: stationEvidence(input.receipt, {
          candidateOverrides: { routingRuleStatus: "Inactive" },
        }),
      },
      {
        name: "target mismatch",
        station: stationEvidence(input.receipt, {
          candidateOverrides: { targetStationReference: id(99) },
        }),
      },
      { name: "unsupported selector", station: malformedSelector },
      {
        name: "cross-Brand Station evidence",
        station: stationEvidence(input.receipt, { brandReference: id(201) }),
      },
      {
        name: "stale Station evidence",
        station: stationEvidence(input.receipt, { effectiveAt: later }),
      },
      { name: "tampered rule digest", station: ruleTampered },
      {
        name: "tampered Station set digest",
        station: { ...input.stationEvidence, evidenceDigest: sha256("tampered-station-set") },
      },
      {
        name: "cross-Store Recipe evidence",
        preparation: preparationEvidence(input.receipt, input.source, {
          storeReference: id(202),
        }),
      },
      {
        name: "stale Recipe evidence",
        preparation: preparationEvidence(input.receipt, input.source, { effectiveAt: later }),
      },
      {
        name: "missing Station capability",
        preparation: preparationEvidence(input.receipt, input.source, {
          itemOverrides: { requiredStationCapabilityReferences: [id(999)] },
        }),
      },
      {
        name: "changed source binding",
        preparation: preparationEvidence(input.receipt, input.source, {
          itemOverrides: { quantity: 3 },
        }),
      },
      {
        name: "tampered Recipe set digest",
        preparation: {
          ...input.preparationEvidence,
          evidenceDigest: sha256("tampered-preparation-set"),
        },
      },
    ];

    for (const scenario of cases) {
      const test = planner(input, {
        stationRouting: async () => scenario.station ?? input.stationEvidence,
        preparations: async () => scenario.preparation ?? input.preparationEvidence,
      });
      await expect(
        test.service.resolve({ receipt: input.receipt, source: input.source }),
        scenario.name,
      ).resolves.toBeNull();
      expect(test.calls.references, scenario.name).toHaveLength(0);
    }
  });

  it("produces one exact immutable ordinal-1 plan item with no split, lifecycle or hidden routing fields", async () => {
    const input = fixture();
    const plan = await planner(input).service.resolve({
      receipt: input.receipt,
      source: input.source,
    });
    const candidate = input.stationEvidence.candidates[0];
    const preparation = input.preparationEvidence.items[0];
    expect(plan?.items).toEqual([
      {
        orderItemReference: input.source.items[0]?.orderItemReference,
        splitOrdinal: 1,
        stationRouting: {
          stationReference: candidate?.stationReference,
          routingRuleReference: candidate?.routingRuleReference,
          routingRuleVersion: candidate?.routingRuleVersion,
          routingRuleDigest: candidate?.routingRuleDigest,
        },
        preparation: {
          preparationReference: preparation?.preparationReference,
          preparationVersion: preparation?.preparationVersion,
          preparationDigest: preparation?.preparationDigest,
          instructions: preparation?.instructions,
        },
      },
    ]);
    expect(Reflect.ownKeys(plan?.items[0] ?? {})).toEqual([
      "orderItemReference",
      "splitOrdinal",
      "stationRouting",
      "preparation",
    ]);
    expect(JSON.stringify(plan)).not.toMatch(/priority|fallback|course|queue|eta|lifecycle|step/i);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan?.items)).toBe(true);
    expect(Object.isFrozen(plan?.items[0]?.stationRouting)).toBe(true);
    expect(Object.isFrozen(plan?.items[0]?.preparation.instructions)).toBe(true);
  });

  it("routes two source items to the same Station with split ordinal 1 and union capability coverage", async () => {
    const inputReceipt = receipt();
    const first = planningSource(inputReceipt).items[0];
    if (first === undefined) throw new Error("fixture source item missing");
    const source = planningSource(inputReceipt, {
      items: [
        first,
        {
          ...first,
          orderItemReference: id(27),
          ordinal: 2,
          productReference: id(28),
          productVersionReference: id(29),
          skuReference: id(30),
          menuVersionReference: id(31),
          selectedOptions: [],
          sourceLineDigest: sha256("second-source-line"),
        },
      ],
    });
    const basePreparation = preparationEvidence(inputReceipt, source);
    const preparationDraft = {
      ...basePreparation,
      evidenceDigest: placeholderDigest,
      items: basePreparation.items.map((item, index) => ({
        ...item,
        requiredStationCapabilityReferences: [id(index === 0 ? 41 : 42)],
      })),
    };
    const preparations = parseKitchenPreparationEvidenceSet({
      ...preparationDraft,
      evidenceDigest: sha256(createKitchenPreparationEvidenceSetDigestBinding(preparationDraft)),
    });
    const value = {
      receipt: inputReceipt,
      source,
      stationEvidence: stationEvidence(inputReceipt, {
        candidateOverrides: { stationCapabilityReferences: [id(42), id(41)] },
      }),
      preparationEvidence: preparations,
    };
    const plan = await planner(value).service.resolve({ receipt: inputReceipt, source });
    expect(plan?.items).toHaveLength(2);
    expect(plan?.items.map((item) => item.splitOrdinal)).toEqual([1, 1]);
    expect(new Set(plan?.items.map((item) => item.stationRouting.stationReference))).toEqual(
      new Set([id(40)]),
    );
  });

  it("derives a stable business identity and returns byte-identical deterministic plans", async () => {
    const input = fixture();
    const test = planner(input);
    const [first, second, concurrent] = await Promise.all([
      test.service.resolve({ receipt: input.receipt, source: input.source }),
      test.service.resolve({ receipt: input.receipt, source: input.source }),
      test.service.resolve({ receipt: input.receipt, source: input.source }),
    ]);
    expect(first).toEqual(second);
    expect(JSON.stringify(first)).toBe(JSON.stringify(concurrent));
    expect(first).toMatchObject({
      planReference: id(90),
      planVersion: 1,
      generatedAt: input.receipt.confirmedAt,
      sourceEvidenceDigest: input.source.sourceEvidenceDigest,
    });
    expect(first?.planDigest).toBe(sha256(createKitchenWorkPlanDigestBinding(first)));
    expect(test.calls.references).toEqual(
      Array.from({ length: 3 }, () => [
        "KitchenWorkPlan",
        createKitchenWorkPlanReferenceBinding(input.receipt),
      ]),
    );

    const changedPreparation = preparationEvidence(input.receipt, input.source, {
      itemOverrides: { instructions: ["Prepare a changed published version"] },
    });
    const changed = await planner(input, {
      preparations: async () => changedPreparation,
    }).service.resolve({ receipt: input.receipt, source: input.source });
    expect(changed?.planReference).toBe(first?.planReference);
    expect(changed?.planDigest).not.toBe(first?.planDigest);
  });

  it("rejects malformed or colliding derived references and safely propagates dependency failures", async () => {
    const input = fixture();
    const observed = [
      input.receipt.sourceEventReference,
      input.receipt.brandReference,
      input.receipt.storeReference,
      input.receipt.orderReference,
      input.receipt.orderBatchReference,
      input.receipt.confirmationReference,
      input.receipt.correlationReference,
      input.source.sourceEvidenceReference,
      input.stationEvidence.evidenceReference,
      input.preparationEvidence.evidenceReference,
      ...input.source.items.flatMap((item) => [
        item.orderItemReference,
        item.productReference,
        item.productVersionReference,
        item.skuReference,
        item.menuVersionReference,
        ...item.selectedOptions.map((option) => option.optionReference),
      ]),
      ...input.stationEvidence.candidates.flatMap((candidate) => [
        candidate.stationReference,
        candidate.routingRuleReference,
        candidate.targetStationReference,
        ...candidate.stationCapabilityReferences,
      ]),
      ...input.preparationEvidence.items.flatMap((preparation) => [
        preparation.preparationReference,
        ...preparation.requiredStationCapabilityReferences,
      ]),
    ].filter((value): value is KitchenReference => value !== undefined);
    expect(observed).toContain(id(26));
    expect(observed).toContain(id(42));
    for (const collision of observed) {
      const test = planner(input, { derive: () => collision });
      await expect(
        test.service.resolve({ receipt: input.receipt, source: input.source }),
      ).resolves.toBeNull();
    }
    await expect(
      planner(input, { derive: () => "not-a-uuidv7" }).service.resolve({
        receipt: input.receipt,
        source: input.source,
      }),
    ).resolves.toBeNull();

    const dependencies: readonly PlannerOverrides[] = [
      {
        stationRouting: async () => {
          throw new Error("private Station failure");
        },
      },
      {
        preparations: async () => {
          throw new Error("private Recipe failure");
        },
      },
      {
        derive: () => {
          throw new Error("private reference adapter failure");
        },
      },
      {
        digest: () => {
          throw new Error("private digest adapter failure");
        },
      },
    ];
    for (const dependency of dependencies) {
      await expect(
        planner(input, dependency).service.resolve({
          receipt: input.receipt,
          source: input.source,
        }),
      ).rejects.toThrow("kitchen work plan is unavailable");
    }
  });

  it("returns null for malformed input/evidence without running getters or later dependencies", async () => {
    const input = fixture();
    let getterCalls = 0;
    const withGetter = { receipt: input.receipt, source: input.source };
    Object.defineProperty(withGetter, "source", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return input.source;
      },
    });
    const malformedInput = planner(input);
    await expect(malformedInput.service.resolve(withGetter)).resolves.toBeNull();
    expect(getterCalls).toBe(0);
    expect(malformedInput.calls.station).toHaveLength(0);

    const malformedStation = planner(input, {
      stationRouting: async () => ({ ...input.stationEvidence, extra: true }),
    });
    await expect(
      malformedStation.service.resolve({ receipt: input.receipt, source: input.source }),
    ).resolves.toBeNull();
    expect(malformedStation.calls.preparations).toHaveLength(0);

    const malformedPreparation = planner(input, {
      preparations: async () => ({ ...input.preparationEvidence, items: [] }),
    });
    await expect(
      malformedPreparation.service.resolve({ receipt: input.receipt, source: input.source }),
    ).resolves.toBeNull();
    expect(malformedPreparation.calls.references).toHaveLength(0);
  });
});

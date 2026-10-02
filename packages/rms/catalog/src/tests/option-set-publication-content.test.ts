import { describe, expect, it, vi } from "vitest";
import {
  createCatalogOptionSetPublicationMaterialization,
  deriveCatalogOptionSetPublicationContentIdentity,
  parseCatalogOptionSetPublicationContent,
} from "../contracts/option-set-publication-content.js";

const id = (n: number) => "01902421-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-09-30T12:00:00.000Z",
  later = "2026-09-30T12:01:00.000Z";
function source() {
  return {
    optionSetReference: id(1),
    brandReference: id(2),
    internalCode: "MILK",
    lifecycle: "Draft",
    aggregateVersion: 7,
    createdAt: at,
    createdByActorReference: id(3),
    updatedAt: at,
    draft: {
      versionReference: id(4),
      status: "Draft",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic milk" },
      localizedDescriptions: { "en-CA": "Synthetic choices" },
      displayStyle: "MultiChoice",
      minimumSelection: 1,
      maximumSelection: 2,
      allowRepeatedOption: false,
      perOptionMaximumQuantity: 1,
      maximumTotalQuantity: 2,
      options: [5, 6].map((n) => ({
        optionReference: id(n),
        optionSetReference: id(1),
        brandReference: id(2),
        stableCode: "MILK_" + n,
        lifecycle: n === 5 ? "Active" : "Inactive",
        localizedNames: { "en-CA": "Synthetic option " + n },
        localizedDescriptions: { "en-CA": "Synthetic description" },
        sortOrder: n - 5,
        defaultEligible: n === 5,
        triggeredOptionSetReference: n === 5 ? id(50) : null,
        conflictOptionReferences: n === 5 ? [id(6)] : [],
        createdAt: at,
        createdByActorReference: id(3),
      })),
      createdAt: at,
      updatedAt: at,
    },
  };
}
function transition(s = source()) {
  return {
    tenantReference: id(10),
    brandReference: s.brandReference,
    optionSetReference: s.optionSetReference,
    versionReference: s.draft.versionReference,
    sourceAggregateVersion: s.aggregateVersion,
    publicationOperationReference: id(11),
    publicationIntentDigest: "sha256:" + "a".repeat(64),
    successorDraftVersionReference: id(12),
    sealedAt: later,
    ...deriveCatalogOptionSetPublicationContentIdentity(s),
  };
}
function firstOption(s: ReturnType<typeof source>) {
  const option = s.draft.options[0];
  if (option === undefined) throw new Error("missing synthetic option");
  return option;
}
const materialize = () => {
  const s = source();
  return createCatalogOptionSetPublicationMaterialization(s, transition(s));
};

describe("supported Option Set immutable content foundation", () => {
  it("freezes supported content and preserves stable identities in a distinct successor", () => {
    const s = source(),
      t = transition(s),
      { content, successor } = createCatalogOptionSetPublicationMaterialization(s, t);
    expect(content.sourceAggregate).toEqual(s);
    expect(content).toMatchObject({
      profile: "CatalogSupportedOptionSetDraftContentV1",
      publicationOperationReference: id(11),
      publicationIntentDigest: t.publicationIntentDigest,
      sourceAggregateVersion: 7,
      eligibility: "NotEvaluated",
    });
    expect(successor).toMatchObject({
      optionSetReference: s.optionSetReference,
      internalCode: s.internalCode,
      createdAt: s.createdAt,
      createdByActorReference: s.createdByActorReference,
      aggregateVersion: 8,
      updatedAt: later,
      draft: { versionReference: id(12), status: "Draft", createdAt: later, updatedAt: later },
    });
    expect(successor.draft.options).toEqual(content.sourceAggregate.draft.options);
    expect(parseCatalogOptionSetPublicationContent(JSON.parse(JSON.stringify(content)))).toEqual(
      content,
    );
    firstOption(s).localizedNames["en-CA"] = "Later mutable input";
    s.draft.localizedDescriptions["en-CA"] = "Later input description";
    expect(content.sourceAggregate.draft.options[0]?.localizedNames["en-CA"]).toBe(
      "Synthetic option 5",
    );
    expect(successor.draft.options[0]?.localizedNames["en-CA"]).toBe("Synthetic option 5");
    expect(Object.isFrozen(content.sourceAggregate.draft.options[0]?.localizedNames)).toBe(true);
    expect(Object.isFrozen(successor.draft.options)).toBe(true);
  });

  it("keeps original frozen content when a later successor draft is edited", () => {
    const { content, successor } = materialize(),
      original = JSON.stringify(content),
      edited = JSON.parse(JSON.stringify(successor));
    edited.draft.localizedNames["en-CA"] = "Later draft";
    const second = createCatalogOptionSetPublicationMaterialization(edited, {
      ...transition(edited),
      publicationOperationReference: id(13),
      successorDraftVersionReference: id(14),
    });
    expect(second.content.sourceAggregateVersion).toBe(8);
    expect(second.successor.aggregateVersion).toBe(9);
    expect(JSON.stringify(content)).toBe(original);
    expect(parseCatalogOptionSetPublicationContent(content).sourceAggregate.aggregateVersion).toBe(
      7,
    );
  });

  it("invalidates content after prose edits while retaining the unchanged rule configuration", () => {
    const s = source(),
      before = deriveCatalogOptionSetPublicationContentIdentity(s);
    s.draft.localizedNames["en-CA"] = "Different name";
    firstOption(s).localizedDescriptions["en-CA"] = "Different option description";
    const after = deriveCatalogOptionSetPublicationContentIdentity(s);
    expect(after.contentDigest).not.toBe(before.contentDigest);
    expect(after.sourceDigest).not.toBe(before.sourceDigest);
    expect(after.configurationDigest).toBe(before.configurationDigest);
  });

  it.each(["lifecycle", "default", "trigger", "conflict", "quantity"])(
    "invalidates current configuration after a %s rule change",
    (kind) => {
      const s = source(),
        before = deriveCatalogOptionSetPublicationContentIdentity(s),
        option = firstOption(s);
      if (kind === "lifecycle") option.lifecycle = "Inactive";
      if (kind === "default") option.defaultEligible = false;
      if (kind === "trigger") option.triggeredOptionSetReference = null;
      if (kind === "conflict") option.conflictOptionReferences = [];
      if (kind === "quantity") s.draft.minimumSelection = 0;
      expect(deriveCatalogOptionSetPublicationContentIdentity(s).configurationDigest).not.toBe(
        before.configurationDigest,
      );
    },
  );

  it.each(["brand", "root", "version", "revision", "source", "content", "configuration", "time"])(
    "refuses a transition with a mismatched %s",
    (kind) => {
      const s = source(),
        t = transition(s),
        otherDigest = "sha256:" + "b".repeat(64);
      if (kind === "brand") t.brandReference = id(20);
      if (kind === "root") t.optionSetReference = id(20);
      if (kind === "version") t.versionReference = id(20);
      if (kind === "revision") t.sourceAggregateVersion++;
      if (kind === "source") t.sourceDigest = otherDigest;
      if (kind === "content") t.contentDigest = otherDigest;
      if (kind === "configuration") t.configurationDigest = otherDigest;
      if (kind === "time") t.sealedAt = "2026-09-30T11:59:59.000Z";
      expect(() => createCatalogOptionSetPublicationMaterialization(s, t)).toThrow();
    },
  );

  it.each([1, 4, 5])("refuses existing local identity %s as successor version", (n) => {
    const s = source();
    expect(() =>
      createCatalogOptionSetPublicationMaterialization(s, {
        ...transition(s),
        successorDraftVersionReference: id(n),
      }),
    ).toThrowError(expect.objectContaining({ code: "CATALOG_LIFECYCLE_CONFLICT" }));
  });

  it.each(["archived", "exhausted", "draft-time", "option-time"])(
    "refuses incoherent %s source facts",
    (kind) => {
      const s = source();
      if (kind === "archived") s.lifecycle = "Archived";
      if (kind === "exhausted") s.aggregateVersion = 2147483647;
      if (kind === "draft-time") s.draft.updatedAt = later;
      if (kind === "option-time") firstOption(s).createdAt = later;
      expect(() => deriveCatalogOptionSetPublicationContentIdentity(s)).toThrow();
    },
  );

  it.each(["source", "intent", "valid-intent", "operation", "eligibility", "unknown"])(
    "rejects tampered stored %s rather than substituting today's draft",
    (kind) => {
      const c = JSON.parse(JSON.stringify(materialize().content));
      if (kind === "source") c.sourceAggregate.draft.options[0].stableCode = "CHANGED";
      if (kind === "intent") c.publicationIntentDigest = "invalid";
      if (kind === "valid-intent") c.publicationIntentDigest = "sha256:" + "b".repeat(64);
      if (kind === "operation") c.publicationOperationReference = id(20);
      if (kind === "eligibility") c.eligibility = "Pass";
      if (kind === "unknown") c.currentPublished = true;
      expect(() => parseCatalogOptionSetPublicationContent(c)).toThrow();
    },
  );

  it("refuses accessors and sparse arrays without reading a getter", () => {
    const getter = vi.fn(() => source()),
      c = { ...materialize().content };
    Object.defineProperty(c, "sourceAggregate", { get: getter, enumerable: true });
    expect(() => parseCatalogOptionSetPublicationContent(c)).toThrow();
    expect(getter).not.toHaveBeenCalled();
    const s = source();
    delete s.draft.options[0];
    expect(() => deriveCatalogOptionSetPublicationContentIdentity(s)).toThrow();
  });

  it("does not synthesize missing full-content fields or published eligibility", () => {
    const s = source();
    expect(() =>
      createCatalogOptionSetPublicationMaterialization(s, {
        ...transition(s),
        currentValidation: "Pass",
      }),
    ).toThrow();
    const { content } = materialize();
    expect(content.sourceAggregate.draft.options[1]?.lifecycle).toBe("Inactive");
    expect(content.eligibility).toBe("NotEvaluated");
    expect(content.sourceAggregate.draft.options[0]).not.toHaveProperty("mediaReference");
  });
  it("allows the final int32 successor revision but never a subsequent publication", () => {
    const s = source();
    s.aggregateVersion = 2147483646;
    const result = createCatalogOptionSetPublicationMaterialization(s, transition(s));
    expect(result.successor.aggregateVersion).toBe(2147483647);
    expect(() => deriveCatalogOptionSetPublicationContentIdentity(result.successor)).toThrow();
  });
  it("refuses an oversized supported snapshot instead of truncating options", () => {
    const s = source(),
      template = firstOption(s);
    s.draft.options = Array.from({ length: 101 }, (_, i) => ({
      ...template,
      optionReference: id(100 + i),
      stableCode: "OPTION_" + i,
      sortOrder: i,
      conflictOptionReferences: [],
    }));
    expect(() => deriveCatalogOptionSetPublicationContentIdentity(s)).toThrow();
  });
  it("refuses ambiguous repeated Option identity even with distinct codes and sort positions", () => {
    const s = source();
    firstOption(s).conflictOptionReferences = [];
    const second = s.draft.options[1];
    if (second === undefined) throw new Error("missing synthetic option");
    second.optionReference = firstOption(s).optionReference;
    expect(() => deriveCatalogOptionSetPublicationContentIdentity(s)).toThrow();
  });
});

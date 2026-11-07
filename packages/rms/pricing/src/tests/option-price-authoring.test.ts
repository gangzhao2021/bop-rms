import { describe, expect, it } from "vitest";
import { input } from "./price-quote.fixture.js";
import { parsePricingReference } from "../domain/money-tax-contract.js";
import {
  materializeOptionPriceVersion,
  optionPriceIntentDigest,
  optionPriceWireSnapshot,
  optionPriceWireState,
  parseOptionPriceAuthoringCommand,
  parseOptionPriceAuthoringContent,
  parseOptionPriceAuthoringState,
  type OptionPriceAuthoringState,
} from "../contracts/option-price-authoring.js";
const id = (n: number) =>
  parsePricingReference("018fb000-0000-7000-8000-" + n.toString(16).padStart(12, "0"));
function fixture() {
  const q = input(),
    entry = q.priceBook.entries[0];
  if (!entry) throw new Error("controlled fixture missing period");
  const content = parseOptionPriceAuthoringContent({
    skuReference: null,
    scopeKind: "Brand",
    scopeReference: null,
    channelCode: null,
    orderType: null,
    unitAmountMinor: "9007199254740993",
    includedQuantity: 1,
    effectivePeriod: entry.effectivePeriod,
  });
  const command = parseOptionPriceAuthoringCommand({
    action: "CreateDraft",
    operationReference: id(201),
    ruleReference: id(202),
    expectedAggregateVersion: null,
    bindingReference: id(203),
    optionReference: id(204),
    content,
  });
  const draft = materializeOptionPriceVersion({
    command,
    current: null,
    brandReference: q.brandReference,
    versionReference: id(205),
    occurredAt: q.createdAt,
    currencyMetadata: q.currencyMetadata,
  });
  const state = parseOptionPriceAuthoringState({
    profile: "OptionPriceAuthoringStateV1",
    brandReference: q.brandReference,
    ruleReference: command.ruleReference,
    bindingReference: command.bindingReference,
    optionReference: command.optionReference,
    aggregateVersion: 1,
    createdAt: q.createdAt,
    createdByActorReference: id(206),
    updatedAt: q.createdAt,
    draftAuthorActorReference: id(206),
    draft: optionPriceWireSnapshot(draft),
    currentPublished: null,
    latestVersion: optionPriceWireSnapshot(draft),
  });
  return { q, content, command, draft, state };
}
describe("closed Option price authoring intent and immutable versions", () => {
  it("preserves exact bigint money and produces immutable own snapshots", () => {
    const { draft } = fixture();
    expect(draft.unitAmount.amountMinor).toBe(9007199254740993n);
    expect(Object.isFrozen(draft)).toBe(true);
  });
  it("hashes browser intent independently of allocated version/time", () => {
    const { q, command } = fixture();
    const first = materializeOptionPriceVersion({
      command,
      current: null,
      brandReference: q.brandReference,
      versionReference: id(207),
      occurredAt: q.createdAt,
      currencyMetadata: q.currencyMetadata,
    });
    const later = materializeOptionPriceVersion({
      command,
      current: null,
      brandReference: q.brandReference,
      versionReference: id(208),
      occurredAt: "2026-08-02T16:00:01.000Z",
      currencyMetadata: q.currencyMetadata,
    });
    expect(first.snapshotDigest).not.toBe(later.snapshotDigest);
    expect(optionPriceIntentDigest({ ...command })).toBe(optionPriceIntentDigest(command));
  });
  it.each(["-1", "01", "1.2", "9223372036854775808"])(
    "refuses noncanonical or overflowing minor amount %s",
    (unitAmountMinor) => {
      const { content } = fixture();
      expect(() => parseOptionPriceAuthoringContent({ ...content, unitAmountMinor })).toThrow();
    },
  );
  it("refuses caller allocated publication version, accessor and unknown command fields", () => {
    const { command } = fixture();
    expect(() =>
      parseOptionPriceAuthoringCommand({ ...command, versionReference: id(209) }),
    ).toThrow();
    const packet = { ...command };
    Object.defineProperty(packet, "action", {
      enumerable: true,
      get() {
        throw new Error("must not execute");
      },
    });
    expect(() => parseOptionPriceAuthoringCommand(packet)).toThrow();
  });
  it("keeps Binding and Choice fixed when reopening a Published root", () => {
    const { q, command, draft, state } = fixture();
    const published = { ...draft, lifecycle: "Published" as const };
    const current: OptionPriceAuthoringState = {
      ...state,
      draft: null,
      draftAuthorActorReference: null,
      currentPublished: published,
      latestVersion: published,
    };
    expect(() =>
      materializeOptionPriceVersion({
        command: { ...command, expectedAggregateVersion: 1, bindingReference: id(210) },
        current,
        brandReference: q.brandReference,
        versionReference: id(211),
        occurredAt: q.createdAt,
        currencyMetadata: q.currencyMetadata,
      }),
    ).toThrow();
  });
  it("does not retarget a Draft to a different current currency metadata at Publish", () => {
    const { q, command, state } = fixture();
    expect(() =>
      materializeOptionPriceVersion({
        command: {
          ...command,
          action: "Publish",
          expectedAggregateVersion: 1,
          bindingReference: null,
          optionReference: null,
          content: null,
        },
        current: state,
        brandReference: q.brandReference,
        versionReference: id(212),
        occurredAt: q.createdAt,
        currencyMetadata: {
          ...q.currencyMetadata,
          metadataVersion: 2,
          metadataVersionReference: id(213),
        },
      }),
    ).toThrow();
  });
  it("Archive preserves published currency, full conditions and period instead of changing to today's metadata", () => {
    const { q, command, draft, state } = fixture();
    const published = { ...draft, lifecycle: "Published" as const };
    const current = {
      ...state,
      draft: null,
      draftAuthorActorReference: null,
      currentPublished: published,
      latestVersion: published,
    };
    const archived = materializeOptionPriceVersion({
      command: {
        ...command,
        action: "Archive",
        expectedAggregateVersion: 1,
        bindingReference: null,
        optionReference: null,
        content: null,
      },
      current,
      brandReference: q.brandReference,
      versionReference: id(214),
      occurredAt: q.createdAt,
      currencyMetadata: {
        ...q.currencyMetadata,
        metadataVersion: 2,
        metadataVersionReference: id(215),
      },
    });
    expect(archived.currencyMetadata).toEqual(published.currencyMetadata);
    expect(archived.effectivePeriod).toEqual(published.effectivePeriod);
    expect(archived.unitAmount).toEqual(published.unitAmount);
    expect(archived.lifecycle).toBe("Archived");
  });
  it("accepts separate Draft and Published heads and rejects forged root identity", () => {
    const { state, draft } = fixture();
    const published = { ...draft, versionReference: id(216), lifecycle: "Published" as const };
    const packet = {
      ...optionPriceWireState(state),
      currentPublished: optionPriceWireSnapshot(published),
    };
    expect(parseOptionPriceAuthoringState(packet).currentPublished?.versionReference).toBe(id(216));
    expect(() =>
      parseOptionPriceAuthoringState({ ...packet, bindingReference: id(217) }),
    ).toThrow();
  });
});

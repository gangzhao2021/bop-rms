import { describe, expect, it } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { input } from "./price-quote.fixture.js";
import { createTaxConfigurationSnapshot } from "../domain/tax-configuration.js";
import {
  parsePricingReference,
  parsePricingDigest,
  parsePricingCode,
} from "../domain/money-tax-contract.js";
import { TaxConfigWorkflowError } from "../application/tax-config-service.js";
import {
  parseTaxConfigAuthoringCommand,
  parseTaxConfigAuthoringContent,
  parseTaxConfigAuthoringCurrent,
  parseTaxConfigAuthoringOperation,
  parseTaxConfigAuthoringResolve,
  parseTaxConfigAuthoringScope,
  parseTaxConfigAuthoringState,
  parseTaxConfigAuthoringRoster,
  taxConfigAuthoringIntentDigest,
} from "../contracts/tax-config-authoring.js";

const id = (n: number) =>
  parsePricingReference(`018ff400-0000-7000-8000-${n.toString(16).padStart(12, "0")}`);
const at = "2026-08-02T16:00:00.000Z";
const digest = (letter: string) => parsePricingDigest(`sha256:${letter.repeat(64)}`);
function fixture() {
  const q = input();
  const scope = parseTaxConfigAuthoringScope({
    tenantReference: id(1),
    brandReference: q.brandReference,
    storeReference: q.storeReference,
    actorReference: id(4),
  });
  const content = parseTaxConfigAuthoringContent({
    stableCode: "SYNTHETIC_TAX",
    effectivePeriod: q.taxConfiguration.effectivePeriod,
    rules: [
      {
        taxClassificationReference: id(5),
        orderType: "Pickup",
        chargeType: "Sellable",
        taxComponentCode: "SYNTHETIC_TAX",
        treatment: "Taxable",
        rate: "0.13",
        priceInclusion: "Exclusive",
        roundingMode: "HalfUp",
        calculationOrder: 1,
        compoundOnPriorTax: false,
        exceptionEvidenceReference: null,
        receiptPresentationCode: "SYNTHETIC_TAX",
      },
    ],
  });
  const command = parseTaxConfigAuthoringCommand({
    action: "CreateDraft",
    operationReference: id(6),
    configurationReference: null,
    expectedAggregateVersion: null,
    content,
  });
  const snapshot = createTaxConfigurationSnapshot({
    configurationReference: id(7),
    versionReference: id(8),
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    stableCode: content.stableCode,
    aggregateVersion: 1,
    versionNumber: 1,
    snapshotDigest: digest("a"),
    lifecycle: "Draft",
    jurisdictionCode: parsePricingCode("CA-ON"),
    currencyMetadata: q.currencyMetadata,
    effectivePeriod: content.effectivePeriod,
    registrationEvidence: null,
    professionalEvidence: null,
    rules: content.rules.map((item) => ({ ruleReference: id(9), ...item })),
    createdAt: at,
  });
  const original = {
    action: command.action,
    operationReference: command.operationReference,
    configurationReference: command.configurationReference,
    expectedAggregateVersion: command.expectedAggregateVersion,
  };
  const operation = {
    profile: "TaxConfigAuthoringOperationV1",
    ...scope,
    ...original,
    command,
    intentDigest: taxConfigAuthoringIntentDigest(scope, command),
    serviceIntentDigest: digest("b"),
    outcome: "Committed",
    snapshot,
    auditReference: id(10),
    eventReference: id(11),
    occurredAt: at,
  };
  const state = parseTaxConfigAuthoringState({
    profile: "TaxConfigAuthoringStateV1",
    tenantReference: scope.tenantReference,
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    draftAuthorActorReference: scope.actorReference,
    snapshot,
  });
  const current = {
    profile: "TaxConfigAuthoringCurrentV1",
    ...scope,
    configurationReference: snapshot.configurationReference,
    state,
    observedAt: at,
    validUntil: "2026-08-02T16:00:05.000Z",
    referenceEligibility: "NotEvaluated",
  };
  return { q, scope, content, command, snapshot, operation, state, current };
}
function firstRule() {
  const item = fixture().content.rules[0];
  if (!item) throw new Error("synthetic rule missing");
  return item;
}
function rejects(value: unknown) {
  expect(() => parseTaxConfigAuthoringCommand(value)).toThrow(TaxConfigWorkflowError);
}

describe("closed Tax Draft authoring contracts; synthetic data is not professional approval", () => {
  it("accepts an incomplete empty Draft without currency or professional defaults", () => {
    const { command } = fixture();
    const parsed = parseTaxConfigAuthoringCommand({
      ...command,
      content: { ...command.content, rules: [] },
    });
    expect(parsed.content.rules).toEqual([]);
    expect(Object.keys(parsed.content)).toEqual(["stableCode", "effectivePeriod", "rules"]);
    expect(Object.isFrozen(parsed.content.effectivePeriod.effectiveFrom)).toBe(true);
  });
  it("detaches and freezes original nested rule inputs", () => {
    const { command } = fixture(),
      r = { ...firstRule() };
    const raw = { ...command, content: { ...command.content, rules: [r] } };
    const parsed = parseTaxConfigAuthoringCommand(raw);
    r.rate =
      parseTaxConfigAuthoringContent({ ...command.content, rules: [{ ...r, rate: "0.14" }] })
        .rules[0]?.rate ?? r.rate;
    expect(parsed.content.rules[0]?.rate).toBe("0.13");
    expect(Object.isFrozen(parsed.content.rules[0])).toBe(true);
  });
  it.each([
    "tenantReference",
    "actorReference",
    "currencyMetadata",
    "registrationEvidence",
    "professionalEvidence",
    "createdAt",
    "versionReference",
  ])("rejects caller-managed field %s", (field) => {
    const { command } = fixture();
    rejects({ ...command, content: { ...command.content, [field]: null } });
  });
  it("rejects rule allocation IDs and accessors without invoking them", () => {
    const { command } = fixture();
    rejects({
      ...command,
      content: { ...command.content, rules: [{ ...firstRule(), ruleReference: id(12) }] },
    });
    let invoked = false;
    const raw = { ...command };
    Object.defineProperty(raw, "content", {
      enumerable: true,
      get() {
        invoked = true;
        throw new Error("must not run");
      },
    });
    rejects(raw);
    expect(invoked).toBe(false);
  });
  it("rejects sparse arrays, custom prototypes and noncanonical decimal numbers", () => {
    const { command } = fixture();
    const sparse = new Array(1);
    rejects({ ...command, content: { ...command.content, rules: sparse } });
    rejects(Object.assign(Object.create({}), command));
    for (const rate of [-1, 0.13, "-0.1", "0.130", "1e-2", "NaN"])
      rejects({ ...command, content: { ...command.content, rules: [{ ...firstRule(), rate }] } });
  });
  it("enforces Create null pins and Replace existing exact CAS", () => {
    const { command } = fixture();
    rejects({ ...command, configurationReference: id(7) });
    rejects({ ...command, expectedAggregateVersion: 1 });
    const replace = {
      ...command,
      action: "ReplaceDraft",
      configurationReference: id(7),
      expectedAggregateVersion: 4,
    };
    expect(parseTaxConfigAuthoringCommand(replace).expectedAggregateVersion).toBe(4);
    for (const expectedAggregateVersion of [null, 0, 1.5, 2147483647])
      rejects({ ...replace, expectedAggregateVersion });
  });
  it("requires coherent component order, inclusion and exception evidence", () => {
    const { command } = fixture(),
      r = firstRule();
    for (const rules of [
      [r, r],
      [{ ...r, calculationOrder: 2 }],
      [{ ...r, compoundOnPriorTax: true }],
      [{ ...r, treatment: "Exempt", rate: "0", exceptionEvidenceReference: null }],
      [r, { ...r, taxComponentCode: "SECOND", calculationOrder: 2, priceInclusion: "Inclusive" }],
    ])
      rejects({ ...command, content: { ...command.content, rules } });
    expect(
      parseTaxConfigAuthoringContent({
        ...command.content,
        rules: [{ ...r, treatment: "Exempt", rate: "0", exceptionEvidenceReference: id(14) }],
      }).rules[0]?.rate,
    ).toBe("0");
  });
  it("rejects unbounded rules and invalid canonical zoned periods", () => {
    const { command } = fixture();
    rejects({
      ...command,
      content: { ...command.content, rules: new Array(257).fill(firstRule()) },
    });
    rejects({
      ...command,
      content: {
        ...command.content,
        effectivePeriod: {
          ...command.content.effectivePeriod,
          effectiveFrom: {
            ...command.content.effectivePeriod.effectiveFrom,
            instant: "2026-02-30T04:00:00.000Z",
          },
        },
      },
    });
  });
  it("hashes original scope and complete body without server allocations", () => {
    const { scope, command, operation } = fixture();
    expect(operation.intentDigest).toBe(
      `sha256:${sha256Hex(canonicalizeRfc8785({ scope, command }))}`,
    );
    expect(taxConfigAuthoringIntentDigest({ ...scope, actorReference: id(15) }, command)).not.toBe(
      operation.intentDigest,
    );
    expect(
      taxConfigAuthoringIntentDigest(scope, {
        ...command,
        content: { ...command.content, stableCode: "CHANGED" },
      }),
    ).not.toBe(operation.intentDigest);
    expect(operation.serviceIntentDigest).not.toBe(operation.intentDigest);
  });
  it("parses payload-free Resolve with unchanged Create null pins", () => {
    const { command, operation } = fixture();
    const resolve = {
      action: command.action,
      operationReference: command.operationReference,
      configurationReference: null,
      expectedAggregateVersion: null,
      intentDigest: operation.intentDigest,
    };
    expect(parseTaxConfigAuthoringResolve(resolve).configurationReference).toBeNull();
    expect(() => parseTaxConfigAuthoringResolve({ ...resolve, content: command.content })).toThrow(
      TaxConfigWorkflowError,
    );
  });
  it("preserves server-generated Create ID while original command remains null", () => {
    const { operation } = fixture();
    const parsed = parseTaxConfigAuthoringOperation(operation);
    expect(parsed.configurationReference).toBeNull();
    expect(parsed.command?.configurationReference).toBeNull();
    expect(parsed.snapshot?.configurationReference).toBe(id(7));
    expect(Object.isFrozen(parsed.snapshot?.currencyMetadata)).toBe(true);
    expect(parsed.snapshot?.registrationEvidence).toBeNull();
    expect(parsed.snapshot?.professionalEvidence).toBeNull();
  });
  it("refuses changed receipt body, scope, tuple, source content and event omission", () => {
    const { operation } = fixture();
    for (const change of [
      { actorReference: id(16) },
      { operationReference: id(16) },
      { intentDigest: digest("c") },
      {
        command: {
          ...operation.command,
          content: { ...operation.command.content, stableCode: "CHANGED" },
        },
      },
      { snapshot: { ...operation.snapshot, stableCode: "CHANGED" } },
      { snapshot: { ...operation.snapshot, aggregateVersion: 2 } },
      { eventReference: null },
      { serviceIntentDigest: null },
    ])
      expect(() => parseTaxConfigAuthoringOperation({ ...operation, ...change })).toThrow(
        TaxConfigWorkflowError,
      );
  });
  it("accepts genuine Abandoned tuple/hash without inventing absent content", () => {
    const { operation } = fixture();
    const abandoned = {
      ...operation,
      command: null,
      outcome: "Abandoned",
      snapshot: null,
      eventReference: null,
      serviceIntentDigest: null,
    };
    expect(parseTaxConfigAuthoringOperation(abandoned).command).toBeNull();
    expect(() =>
      parseTaxConfigAuthoringOperation({ ...abandoned, command: operation.command }),
    ).toThrow(TaxConfigWorkflowError);
    expect(() =>
      parseTaxConfigAuthoringOperation({ ...abandoned, snapshot: operation.snapshot }),
    ).toThrow(TaxConfigWorkflowError);
  });
  it("binds Replace receipt to exact original root, scope and complete content", () => {
    const { scope, command, snapshot, operation } = fixture();
    const replace = parseTaxConfigAuthoringCommand({
      ...command,
      action: "ReplaceDraft",
      configurationReference: snapshot.configurationReference,
      expectedAggregateVersion: 1,
    });
    const receipt = {
      ...operation,
      action: replace.action,
      configurationReference: replace.configurationReference,
      expectedAggregateVersion: replace.expectedAggregateVersion,
      command: replace,
      intentDigest: taxConfigAuthoringIntentDigest(scope, replace),
      snapshot: { ...snapshot, aggregateVersion: 2, versionNumber: 2, versionReference: id(20) },
    };
    expect(parseTaxConfigAuthoringOperation(receipt).snapshot?.aggregateVersion).toBe(2);
    expect(() =>
      parseTaxConfigAuthoringOperation({
        ...receipt,
        snapshot: { ...receipt.snapshot, configurationReference: id(21) },
      }),
    ).toThrow(TaxConfigWorkflowError);
  });
  it("retains actual Currency metadata rather than imposing a browser exponent", () => {
    const { operation } = fixture();
    const parsed = parseTaxConfigAuthoringOperation({
      ...operation,
      snapshot: {
        ...operation.snapshot,
        currencyMetadata: { ...operation.snapshot.currencyMetadata, minorUnitExponent: 3 },
      },
    });
    expect(parsed.snapshot?.currencyMetadata.minorUnitExponent).toBe(3);
  });
  it("permits a different current reader from historical Draft author", () => {
    const { current, state } = fixture();
    const parsed = parseTaxConfigAuthoringCurrent(
      { ...current, actorReference: id(17) },
      state.snapshot.configurationReference,
    );
    expect(parsed.actorReference).toBe(id(17));
    expect(parsed.state?.draftAuthorActorReference).not.toBe(parsed.actorReference);
    expect(() => parseTaxConfigAuthoringCurrent(current, id(18))).toThrow(TaxConfigWorkflowError);
  });
  it("enforces original observation window, actual target and Draft-only evidence", () => {
    const { current, state } = fixture();
    for (const change of [
      { validUntil: at },
      { validUntil: "2026-08-02T16:00:05.001Z" },
      { configurationReference: id(19) },
      { observedAt: "2026-08-02T15:59:59.000Z" },
    ])
      expect(() => parseTaxConfigAuthoringCurrent({ ...current, ...change })).toThrow(
        TaxConfigWorkflowError,
      );
    expect(() =>
      parseTaxConfigAuthoringState({
        ...state,
        snapshot: { ...state.snapshot, lifecycle: "Published" },
      }),
    ).toThrow(TaxConfigWorkflowError);
    expect(() =>
      parseTaxConfigAuthoringState({
        ...state,
        snapshot: { ...state.snapshot, professionalEvidence: { result: "Pass" } },
      }),
    ).toThrow(TaxConfigWorkflowError);
    expect(
      parseTaxConfigAuthoringCurrent({ ...current, state: null }, current.configurationReference)
        .state,
    ).toBeNull();
  });
});

function rosterFixture(count = 2) {
  const { scope, state } = fixture();
  const entries = Array.from({ length: count }, (_, i) =>
    parseTaxConfigAuthoringState({
      ...state,
      snapshot: {
        ...state.snapshot,
        configurationReference: id(100 + i),
        versionReference: id(200 + i),
      },
    }),
  );
  return {
    profile: "TaxConfigAuthoringRosterV1",
    ...scope,
    actorReference: id(300),
    afterConfiguration: null,
    entries,
    nextAfterConfiguration: null,
    observedAt: at,
    validUntil: "2026-08-02T16:00:05.000Z",
    referenceEligibility: "NotEvaluated",
  };
}
describe("saved Tax Draft roster; current observation without professional qualification", () => {
  it("returns detached frozen saved heads with historical authors distinct from current reader", () => {
    const raw = rosterFixture(),
      parsed = parseTaxConfigAuthoringRoster(raw, null);
    expect(parsed.entries).toEqual(raw.entries);
    expect(parsed.entries).not.toBe(raw.entries);
    expect(Object.isFrozen(parsed.entries)).toBe(true);
    expect(parsed.entries[0]?.draftAuthorActorReference).not.toBe(parsed.actorReference);
    expect(parsed.referenceEligibility).toBe("NotEvaluated");
  });
  it("supports empty observations and exact full-page last-root cursors", () => {
    expect(parseTaxConfigAuthoringRoster(rosterFixture(0)).entries).toEqual([]);
    const raw = rosterFixture(50),
      last = raw.entries[49];
    if (!last) throw new Error("synthetic final root missing");
    expect(
      parseTaxConfigAuthoringRoster({
        ...raw,
        nextAfterConfiguration: last.snapshot.configurationReference,
      }).nextAfterConfiguration,
    ).toBe(last.snapshot.configurationReference);
    const next = rosterFixture(1);
    expect(
      parseTaxConfigAuthoringRoster({ ...next, afterConfiguration: id(99) }, id(99)).entries,
    ).toHaveLength(1);
  });
  it("rejects duplicate, reversed and at-or-before cursor roots", () => {
    const raw = rosterFixture(),
      first = raw.entries[0];
    if (!first) throw new Error("synthetic root missing");
    for (const change of [
      { entries: [first, first] },
      { entries: [...raw.entries].reverse() },
      { afterConfiguration: first.snapshot.configurationReference },
    ])
      expect(() => parseTaxConfigAuthoringRoster({ ...raw, ...change })).toThrow(
        TaxConfigWorkflowError,
      );
    expect(() => parseTaxConfigAuthoringRoster(raw, id(99))).toThrow(TaxConfigWorkflowError);
  });
  it("refuses partial-page continuation and arbitrary next cursors", () => {
    expect(() =>
      parseTaxConfigAuthoringRoster({ ...rosterFixture(), nextAfterConfiguration: id(101) }),
    ).toThrow(TaxConfigWorkflowError);
    expect(() =>
      parseTaxConfigAuthoringRoster({ ...rosterFixture(50), nextAfterConfiguration: id(999) }),
    ).toThrow(TaxConfigWorkflowError);
    expect(() => parseTaxConfigAuthoringRoster(rosterFixture(51))).toThrow(TaxConfigWorkflowError);
  });
  it("rejects foreign scope heads, published or professional status substitutions", () => {
    const raw = rosterFixture(),
      first = raw.entries[0];
    if (!first) throw new Error("synthetic root missing");
    for (const entry of [
      { ...first, tenantReference: id(301) },
      {
        ...first,
        brandReference: id(302),
        snapshot: { ...first.snapshot, brandReference: id(302) },
      },
      {
        ...first,
        storeReference: id(303),
        snapshot: { ...first.snapshot, storeReference: id(303) },
      },
      { ...first, snapshot: { ...first.snapshot, lifecycle: "Published" } },
    ])
      expect(() => parseTaxConfigAuthoringRoster({ ...raw, entries: [entry] })).toThrow(
        TaxConfigWorkflowError,
      );
    expect(() =>
      parseTaxConfigAuthoringRoster({ ...raw, referenceEligibility: "Qualified" }),
    ).toThrow(TaxConfigWorkflowError);
  });
  it("rejects expired/oversized windows and future recorded heads", () => {
    const raw = rosterFixture();
    for (const change of [
      { validUntil: at },
      { validUntil: "2026-08-02T16:00:05.001Z" },
      { observedAt: "2026-08-02T15:59:59.000Z" },
    ])
      expect(() => parseTaxConfigAuthoringRoster({ ...raw, ...change })).toThrow(
        TaxConfigWorkflowError,
      );
  });
  it("refuses sparse and accessor entries without invoking their code", () => {
    const raw = rosterFixture();
    expect(() => parseTaxConfigAuthoringRoster({ ...raw, entries: new Array(1) })).toThrow(
      TaxConfigWorkflowError,
    );
    let called = false;
    const entries = [raw.entries[0]];
    Object.defineProperty(entries, "0", {
      enumerable: true,
      get() {
        called = true;
        throw new Error("must not run");
      },
    });
    expect(() => parseTaxConfigAuthoringRoster({ ...raw, entries })).toThrow(
      TaxConfigWorkflowError,
    );
    expect(called).toBe(false);
  });
  it("enforces the aggregate one-MiB page budget even when each Draft is individually valid", () => {
    const raw = rosterFixture(50),
      base = firstRule();
    const entries = raw.entries.map((entry, i) =>
      parseTaxConfigAuthoringState({
        ...entry,
        snapshot: {
          ...entry.snapshot,
          rules: Array.from({ length: 96 }, (_, j) => ({
            ...base,
            ruleReference: id(1000 + i * 100 + j),
            taxClassificationReference: id(7000 + j),
          })),
        },
      }),
    );
    expect(() => parseTaxConfigAuthoringRoster({ ...raw, entries })).toThrow(
      TaxConfigWorkflowError,
    );
  });
});

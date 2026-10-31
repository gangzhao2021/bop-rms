import { expect, it, vi } from "vitest";
import {
  parseDigitalReceiptTemplateDraft,
  parseDigitalReceiptTemplateDraftRoster,
  parseDigitalReceiptTemplateDraftSave,
  parseDigitalReceiptTemplateDraftResolve,
  parseDigitalReceiptTemplateDraftReceipt,
  parseDigitalReceiptTemplateDraftCurrent,
} from "../contracts/digital-receipt-template-draft.js";
import { createDigitalReceiptTemplateDraftContent } from "../contracts/digital-receipt-template-draft-fields.js";
import { DigitalReceiptTemplateError } from "../contracts/digital-receipt-template.js";
const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`,
  at = "2026-10-05T10:00:00.000Z",
  later = "2026-10-05T10:01:00.000Z",
  digest = "sha256:" + "a".repeat(64),
  scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) },
  actor = { ...scope, actorReference: id(4) };
const fields = () => ({
  locale: "en-CA",
  layoutDefinitionReference: id(6),
  complianceRuleReference: id(7),
  activation: { mode: "Immediate" },
  effectiveUntil: null,
});
const content = () =>
  createDigitalReceiptTemplateDraftContent({
    ...scope,
    templateReference: id(5),
    versionReference: id(8),
    versionNumber: 1,
    fields: fields(),
  });
const snapshot = () => ({
  profile: "DigitalReceiptTemplateDraftV2",
  ...scope,
  familyReference: id(9),
  revision: 1,
  authoredByReference: id(4),
  previousVersionReference: null,
  content: content(),
  contentDigest: digest,
  createdAt: at,
  updatedAt: at,
  dataClassification: "Internal",
});
const save = () => ({
  profile: "DigitalReceiptTemplateDraftSaveV1",
  ...actor,
  operationReference: id(10),
  templateReference: null,
  expectedVersionReference: null,
  expectedRevision: 0,
  fields: fields(),
  purposeCode: "RECEIPT_TEMPLATE_AUTHORING",
});
const resolve = () => {
  const { fields: _fields, ...rest } = save();
  void _fields;
  return { ...rest, profile: "DigitalReceiptTemplateDraftResolveV1", intentDigest: digest };
};
const receipt = () => ({
  profile: "DigitalReceiptTemplateDraftReceiptV1",
  ...actor,
  operationReference: id(10),
  templateReference: null,
  expectedVersionReference: null,
  expectedRevision: 0,
  intentDigest: digest,
  outcome: "Committed",
  snapshot: snapshot(),
  auditReference: id(11),
  occurredAt: at,
});
const current = () => ({
  profile: "DigitalReceiptTemplateDraftCurrentV1",
  ...actor,
  templateReference: id(5),
  snapshot: snapshot(),
  observedAt: at,
  validUntil: "2026-10-05T10:00:05.000Z",
  sourceQualification: "NotEvaluated",
});
const rejects = (work: () => unknown) => {
  expect(work).toThrow(DigitalReceiptTemplateError);
  expect(work).toThrow("RECEIPT_TEMPLATE_INPUT_INVALID");
};
it("first creation carries no fabricated template or version identity", () => {
  const command = parseDigitalReceiptTemplateDraftSave(save());
  expect(command.templateReference).toBeNull();
  expect(command.expectedVersionReference).toBeNull();
  expect(command.expectedRevision).toBe(0);
  expect(Object.keys(command)).toHaveLength(11);
  expect(command).not.toHaveProperty("content");
});
it("existing replacement requires both exact original pins", () => {
  expect(
    parseDigitalReceiptTemplateDraftSave({
      ...save(),
      templateReference: id(5),
      expectedVersionReference: id(8),
      expectedRevision: 1,
    }),
  ).toMatchObject({ expectedRevision: 1, expectedVersionReference: id(8) });
  for (const value of [
    { templateReference: id(5) },
    { expectedVersionReference: id(8) },
    { expectedRevision: 1 },
    { templateReference: id(5), expectedRevision: 1 },
    { expectedVersionReference: id(8), expectedRevision: 1 },
  ])
    rejects(() => parseDigitalReceiptTemplateDraftSave({ ...save(), ...value }));
});
it("payload-free Resolve retains immutable original identity only", () => {
  const original = parseDigitalReceiptTemplateDraftResolve(resolve());
  expect(Object.keys(original)).toHaveLength(11);
  expect(original).not.toHaveProperty("fields");
  rejects(() => parseDigitalReceiptTemplateDraftResolve({ ...resolve(), fields: fields() }));
});
it("snapshots are detached/frozen and complete ContentV2 is retained", () => {
  const raw = snapshot(),
    parsed = parseDigitalReceiptTemplateDraft(raw);
  raw.familyReference = id(20);
  expect(parsed.familyReference).toBe(id(9));
  expect(parsed.content.versionReference).toBe(id(8));
  expect(Object.isFrozen(parsed)).toBe(true);
  expect(Object.isFrozen(parsed.content.requiredFields)).toBe(true);
  expect(Object.keys(parsed)).toHaveLength(13);
});
it("successor Draft can retain next publication number with a distinct immutable version", () => {
  const first = snapshot(),
    next = {
      ...first,
      revision: 2,
      authoredByReference: id(12),
      previousVersionReference: id(8),
      content: { ...first.content, versionReference: id(13) },
      updatedAt: later,
    };
  const parsed = parseDigitalReceiptTemplateDraft(next);
  expect(parsed.content.versionNumber).toBe(1);
  expect(parsed.createdAt).toBe(at);
  expect(parsed.authoredByReference).toBe(id(12));
});
it("creation receipt binds actual server allocated template result and original writer", () => {
  const r = parseDigitalReceiptTemplateDraftReceipt(receipt());
  expect(r.templateReference).toBeNull();
  expect(r.snapshot?.content.templateReference).toBe(id(5));
  expect(Object.keys(r)).toHaveLength(14);
});
it("replacement receipt binds revision, previous version, original template, actor and time", () => {
  const first = snapshot(),
    next = {
      ...first,
      revision: 2,
      previousVersionReference: id(8),
      content: { ...first.content, versionReference: id(13) },
      updatedAt: later,
    };
  expect(
    parseDigitalReceiptTemplateDraftReceipt({
      ...receipt(),
      templateReference: id(5),
      expectedVersionReference: id(8),
      expectedRevision: 1,
      snapshot: next,
      occurredAt: later,
    }).snapshot?.revision,
  ).toBe(2);
});
it("Abandoned is payload-free and cannot claim committed content", () => {
  expect(
    parseDigitalReceiptTemplateDraftReceipt({ ...receipt(), outcome: "Abandoned", snapshot: null })
      .snapshot,
  ).toBeNull();
  rejects(() => parseDigitalReceiptTemplateDraftReceipt({ ...receipt(), outcome: "Abandoned" }));
  rejects(() => parseDigitalReceiptTemplateDraftReceipt({ ...receipt(), snapshot: null }));
});
it("current historical author differs legitimately from authorized reader", () => {
  const v = parseDigitalReceiptTemplateDraftCurrent({ ...current(), actorReference: id(12) });
  expect(v.actorReference).toBe(id(12));
  expect(v.snapshot?.authoredByReference).toBe(id(4));
  expect(v.sourceQualification).toBe("NotEvaluated");
  expect(Object.keys(v)).toHaveLength(10);
  expect(
    parseDigitalReceiptTemplateDraftCurrent({
      ...current(),
      templateReference: null,
      snapshot: null,
    }).snapshot,
  ).toBeNull();
  expect(
    parseDigitalReceiptTemplateDraftCurrent({ ...current(), snapshot: null }).templateReference,
  ).toBe(id(5));
});
it.each(["tenantReference", "brandReference", "storeReference"] as const)(
  "snapshot content scope drift rejects %s",
  (key) =>
    rejects(() =>
      parseDigitalReceiptTemplateDraft({ ...snapshot(), content: { ...content(), [key]: id(50) } }),
    ),
);
it.each([
  { revision: 0 },
  { revision: 2147483648 },
  { revision: 1.5 },
  { previousVersionReference: id(8) },
  { revision: 2 },
  { createdAt: later },
  { updatedAt: later },
  { dataClassification: "Public" },
  { profile: "Published" },
  { contentDigest: "a".repeat(64) },
])("snapshot invariant refuses %j", (change) =>
  rejects(() => parseDigitalReceiptTemplateDraft({ ...snapshot(), ...change })),
);
it("snapshot previous version cannot equal successor content version", () =>
  rejects(() =>
    parseDigitalReceiptTemplateDraft({
      ...snapshot(),
      revision: 2,
      previousVersionReference: id(8),
      updatedAt: later,
    }),
  ));
it.each([
  { actorReference: id(12) },
  { occurredAt: later },
  { templateReference: id(50), expectedVersionReference: id(8), expectedRevision: 1 },
  { snapshot: { ...snapshot(), authoredByReference: id(12) } },
  {
    snapshot: {
      ...snapshot(),
      brandReference: id(50),
      content: { ...content(), brandReference: id(50) },
    },
  },
  { snapshot: { ...snapshot(), revision: 2, previousVersionReference: id(20), updatedAt: later } },
])("receipt tuple rejects %j", (change) =>
  rejects(() => parseDigitalReceiptTemplateDraftReceipt({ ...receipt(), ...change })),
);
it.each([
  { validUntil: at },
  { validUntil: "2026-10-05T10:00:05.001Z" },
  { observedAt: "2026-10-05T09:59:59.000Z" },
  { templateReference: null },
  { templateReference: id(50) },
  { sourceQualification: "Pass" },
  { brandReference: id(50) },
])("current denies incoherent snapshot or lease %j", (change) =>
  rejects(() => parseDigitalReceiptTemplateDraftCurrent({ ...current(), ...change })),
);
it("maximum revision cannot be saved again but original Resolve remains representable", () => {
  const pins = {
    templateReference: id(5),
    expectedVersionReference: id(8),
    expectedRevision: 2147483647,
  };
  rejects(() => parseDigitalReceiptTemplateDraftSave({ ...save(), ...pins }));
  expect(parseDigitalReceiptTemplateDraftResolve({ ...resolve(), ...pins }).expectedRevision).toBe(
    2147483647,
  );
});
it.each(["sha256:" + "A".repeat(64), "sha256:abc", "a".repeat(64), null])(
  "digest rejects malformed %s",
  (intentDigest) =>
    rejects(() => parseDigitalReceiptTemplateDraftResolve({ ...resolve(), intentDigest })),
);
it("closed descriptors reject getters without invocation and inherited/hidden metadata", () => {
  const getter = vi.fn(() => fields()),
    raw = save();
  Object.defineProperty(raw, "fields", { enumerable: true, get: getter });
  rejects(() => parseDigitalReceiptTemplateDraftSave(raw));
  expect(getter).not.toHaveBeenCalled();
  rejects(() =>
    parseDigitalReceiptTemplateDraftSave(Object.assign(Object.create({ extra: true }), save())),
  );
  const hidden = receipt();
  Object.defineProperty(hidden, "secret", { value: true });
  rejects(() => parseDigitalReceiptTemplateDraftReceipt(hidden));
  rejects(() =>
    parseDigitalReceiptTemplateDraftCurrent({ ...current(), [Symbol("unknown")]: true }),
  );
});
it("bounded snapshot refuses bulk content, extra approvals and sparse fields", () => {
  rejects(() => parseDigitalReceiptTemplateDraft({ ...snapshot(), approval: { accepted: true } }));
  rejects(() =>
    parseDigitalReceiptTemplateDraft({
      ...snapshot(),
      content: { ...content(), locale: "a".repeat(17000) },
    }),
  );
  const c = content(),
    requiredFields = [...c.requiredFields];
  delete requiredFields[0];
  rejects(() =>
    parseDigitalReceiptTemplateDraft({ ...snapshot(), content: { ...c, requiredFields } }),
  );
});
it("save fields cannot inject server metadata or professional claims", () => {
  for (const key of [
    "versionReference",
    "versionNumber",
    "publishedAt",
    "approval",
    "legalConclusion",
  ])
    rejects(() =>
      parseDigitalReceiptTemplateDraftSave({ ...save(), fields: { ...fields(), [key]: id(50) } }),
    );
});

const roster = () => ({
  profile: "DigitalReceiptTemplateDraftRosterV1",
  ...actor,
  afterTemplate: null,
  entries: [snapshot()],
  nextAfter: null,
  observedAt: at,
  validUntil: "2026-10-05T10:00:05.000Z",
  sourceQualification: "NotEvaluated",
});
it("roster is closed, bounded and detached with historical author distinct from reader", () => {
  const raw = roster(),
    view = parseDigitalReceiptTemplateDraftRoster({ ...raw, actorReference: id(12) });
  raw.entries.length = 0;
  expect(view.entries).toHaveLength(1);
  expect(view.entries[0]?.authoredByReference).toBe(id(4));
  expect(Object.isFrozen(view.entries)).toBe(true);
  expect(Object.keys(view)).toHaveLength(11);
});
it("roster checks unique sorted identities after cursor and exact continuation", () => {
  const entry = snapshot(),
    next = { ...entry, content: { ...content(), templateReference: id(50) } };
  expect(
    parseDigitalReceiptTemplateDraftRoster({ ...roster(), entries: [entry, next] }).entries,
  ).toHaveLength(2);
  for (const entries of [
    [entry, entry],
    [next, entry],
  ])
    rejects(() => parseDigitalReceiptTemplateDraftRoster({ ...roster(), entries }));
  rejects(() => parseDigitalReceiptTemplateDraftRoster({ ...roster(), afterTemplate: id(5) }));
  rejects(() => parseDigitalReceiptTemplateDraftRoster({ ...roster(), nextAfter: id(5) }));
  const entries = Array.from({ length: 20 }, (_, i) => ({
    ...entry,
    content: { ...content(), templateReference: id(100 + i) },
  }));
  expect(
    parseDigitalReceiptTemplateDraftRoster({ ...roster(), entries, nextAfter: id(119) }).nextAfter,
  ).toBe(id(119));
  rejects(() =>
    parseDigitalReceiptTemplateDraftRoster({ ...roster(), entries, nextAfter: id(118) }),
  );
  rejects(() =>
    parseDigitalReceiptTemplateDraftRoster({
      ...roster(),
      entries: [...entries, { ...entry, content: { ...content(), templateReference: id(120) } }],
    }),
  );
});
it("roster refuses extra fields, sparse arrays, scope/time drift and invented qualification", () => {
  const raw = roster();
  delete raw.entries[0];
  rejects(() => parseDigitalReceiptTemplateDraftRoster(raw));
  for (const change of [
    { limit: 20 },
    { brandReference: id(50) },
    { validUntil: at },
    { validUntil: "2026-10-05T10:00:05.001Z" },
    { sourceQualification: "Pass" },
    { entries: [{ ...snapshot(), updatedAt: later }] },
  ])
    rejects(() => parseDigitalReceiptTemplateDraftRoster({ ...roster(), ...change }));
});

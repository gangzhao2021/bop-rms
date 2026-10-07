import { expect, it, vi } from "vitest";
import {
  parsePublishingOptionSetCurrentQualification as parse,
  optionSetCurrentQualificationCheckCodes,
} from "../contracts/option-set-current-qualification.js";
import { createPublishingScope } from "../contracts/publishing.js";
const id = (n: number) => "01902421-7000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-10-05T12:00:00.000Z",
  end = "2026-10-05T12:00:05.000Z",
  digest = "sha256:" + "a".repeat(64);
function value() {
  return {
    profile: "PublishingOptionSetCurrentQualificationV1",
    tenantReference: id(1),
    operationReference: id(2),
    actorReference: id(3),
    scope: createPublishingScope({ kind: "Brand", brandReference: id(4), storeReference: null }),
    familyReference: id(5),
    lifecycleReference: id(6),
    expectedLifecycleVersion: 3,
    latestMutationOperationReference: id(7),
    snapshotReference: id(8),
    snapshotDigest: digest,
    reviewOperationReference: id(9),
    validationEvidenceReference: id(10),
    approvalOperationReference: id(7),
    approvalEvidenceReference: id(11),
    policyReference: id(12),
    policyVersion: 1,
    policyContentDigest: digest,
    policyPublicationReference: id(13),
    qualificationEvidenceReference: id(14),
    qualificationReportDigest: digest,
    result: "Pass",
    originalObservedAt: at,
    checkedAt: "2026-10-05T12:00:01.000Z",
    validUntil: end,
    checkCodes: [...optionSetCurrentQualificationCheckCodes],
    sourceAssessmentDigests: [digest],
  };
}
it("retains the original operation deadline while recording later acquired qualification", () => {
  const input = value(),
    parsed = parse(input);
  input.checkCodes.reverse();
  expect(parsed.checkedAt).toBe("2026-10-05T12:00:01.000Z");
  expect(parsed.validUntil).toBe(end);
  expect(parsed.originalObservedAt).toBe(at);
  expect(Object.isFrozen(parsed)).toBe(true);
  expect(Object.isFrozen(parsed.checkCodes)).toBe(true);
});
it.each([
  { result: "HardError" },
  { result: "Indeterminate" },
  { result: undefined },
  { validUntil: "2026-10-05T12:00:06.000Z" },
  { checkedAt: "2026-10-05T11:59:59.999Z" },
  { checkedAt: end },
  { checkCodes: ["CURRENT_REFERENCES"] },
  { qualificationReportDigest: "not-a-digest" },
  { approvalOperationReference: null },
  {
    scope: createPublishingScope({ kind: "Store", brandReference: id(4), storeReference: id(15) }),
  },
])("rejects a non-success, incomplete or rebound qualification %#", (patch) => {
  expect(() => parse({ ...value(), ...patch })).toThrow();
});
it("requires all closed fields and refuses caller extensions and accessors without invocation", () => {
  const original = value(),
    get = vi.fn(() => at);
  const missing = { ...original };
  Reflect.deleteProperty(missing, "originalObservedAt");
  expect(() => parse(missing)).toThrow();
  expect(() => parse({ ...original, callerPass: true })).toThrow();
  Object.defineProperty(original, "checkedAt", { enumerable: true, get });
  expect(() => parse(original)).toThrow();
  expect(get).not.toHaveBeenCalled();
});
it("refuses duplicate source digest claims and accessor array entries", () => {
  const input = value(),
    get = vi.fn(() => digest);
  expect(() => parse({ ...input, sourceAssessmentDigests: [digest, digest] })).toThrow();
  Object.defineProperty(input.sourceAssessmentDigests, "0", { enumerable: true, get });
  expect(() => parse(input)).toThrow();
  expect(get).not.toHaveBeenCalled();
});
it("allows the explicit no-Approval disposition without fabricating an Approval reference", () => {
  expect(
    parse({ ...value(), approvalOperationReference: null, approvalEvidenceReference: null })
      .approvalEvidenceReference,
  ).toBeNull();
});

it("fixed publication candidate acquires its writer-compatible fence before history or nested policy readers", async () => {
  const { createPostgresPublishingMutationStore } =
    await import("../infrastructure/persistence/publishing-mutation-store.js");
  const query = vi.fn(async (sql: string, values: readonly unknown[]) => {
    void sql;
    void values;
    return { rows: [] };
  });
  const owner = createPostgresPublishingMutationStore(
    { run: (work) => work({ query }) },
    id(1),
    createPublishingScope({ kind: "Brand", brandReference: id(4), storeReference: null }),
  );
  await expect(
    owner.resolveCurrentOptionSetPublicationCandidate({
      familyReference: id(5),
      lifecycleReference: id(6),
      observedAt: at,
    }),
  ).rejects.toThrow();
  const calls = query.mock.calls.map(([sql]) => sql);
  expect(calls[1]).toBe(
    "LOCK TABLE bop_publishing.publishing_mutation_record IN SHARE ROW EXCLUSIVE MODE",
  );
  expect(calls[2]).toContain("ORDER BY lifecycle_version DESC");
  expect(calls.some((sql) => sql.includes(" IN SHARE MODE"))).toBe(false);
  expect(calls.some((sql) => sql.startsWith("INSERT"))).toBe(false);
});
it("fixed candidate refuses unknown selectors/accessors before querying or claiming current authority", async () => {
  const { createPostgresPublishingMutationStore } =
    await import("../infrastructure/persistence/publishing-mutation-store.js");
  const query = vi.fn(),
    get = vi.fn(() => id(5));
  const owner = createPostgresPublishingMutationStore(
    { run: (work) => work({ query }) },
    id(1),
    createPublishingScope({ kind: "Brand", brandReference: id(4), storeReference: null }),
  );
  const input = { familyReference: id(5), lifecycleReference: id(6), observedAt: at };
  Object.defineProperty(input, "familyReference", { enumerable: true, get });
  await expect(owner.resolveCurrentOptionSetPublicationCandidate(input)).rejects.toThrow();
  expect(get).not.toHaveBeenCalled();
  expect(query).not.toHaveBeenCalled();
});

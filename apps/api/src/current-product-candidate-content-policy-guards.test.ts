import { expect, it, vi } from "vitest";
import {
  parseCatalogReference,
  parseCatalogInstant,
  type CatalogProductContentPolicyAssessment,
} from "@rms/catalog";
import type { createCurrentProductContentPolicySource } from "./current-product-content-policy.js";
import { createCurrentProductCandidateContentPolicySource } from "./current-product-candidate-content-policy.js";
type PartialOptions = Parameters<typeof createCurrentProductContentPolicySource>[0];
vi.mock("./current-product-content-policy.js", () => ({
  createCurrentProductContentPolicySource: (options: PartialOptions) => ({
    async withCurrentAssessment(
      tx: unknown,
      input: { binding: unknown; brandRequest: unknown; policyRequest: unknown },
      work: (value: unknown, publication: string) => Promise<unknown>,
    ) {
      // Deliberately synthetic inner assessment: tests only the outer source guard.
      return options.brandSource.withCurrentContent(
        input.brandRequest as never,
        async (value, actual) => {
          expect(actual).toBe(tx);
          return options.policySource.withCurrentPolicy(
            actual as never,
            input.policyRequest as never,
            async () => work(value as unknown, id(21)),
          );
        },
      );
    },
  }),
}));
const id = (n: number) => "01902421-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-09-30T06:00:00.000Z",
  hash = "sha256:" + "a".repeat(64),
  instant = (ms: number) => new Date(Date.parse(at) + ms).toISOString();
function fixture() {
  let clock = at;
  const context = {
    tenantReference: parseCatalogReference(id(1)),
    brandReference: parseCatalogReference(id(2)),
    actorReference: parseCatalogReference(id(3)),
    actorKind: "User" as const,
  };
  const command = {
    purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
    ...context,
    operationReference: id(4),
    productReference: id(5),
    versionReference: id(6),
    expectedProductAggregateVersion: 1,
    expectedPublicationVersion: 0,
    action: "Validate",
    contentDigest: hash,
    configurationDigest: hash,
    scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
    effectivePeriod: {
      timeZone: "UTC",
      effectiveFrom: { instant: at, localDateTime: at.slice(0, -1), utcOffsetMinutes: 0 },
      effectiveUntil: null,
    },
    scheduleReference: null,
    replacementVersionReference: null,
    successorDraftVersionReference: null,
    occurredAt: at,
    reasonCode: "SYNTHETIC",
  };
  const candidate = {
    ...context,
    aggregate: {},
    observedAt: parseCatalogInstant(at),
    validUntil: parseCatalogInstant(instant(30000)),
    originalIntentDigest: hash,
  };
  const assessment = {
    observedAt: parseCatalogInstant(at),
    validUntil: parseCatalogInstant(instant(20000)),
    publishValidation: "Incomplete",
    mediaReadiness: "NotEvaluated",
    eligibility: "NotEvaluated",
  } as CatalogProductContentPolicyAssessment;
  const tx = { query: vi.fn() };
  type Options = Parameters<typeof createCurrentProductCandidateContentPolicySource>[0];
  const candidateRead = vi.fn<Options["candidateSource"]["withCurrentCandidate"]>(
      async (_c, work) => work(candidate as never, tx),
    ),
    brandRead = vi.fn<Options["brandSource"]["withCurrentContent"]>(async (_input, work) =>
      work(assessment as never, tx),
    ),
    policyRead = vi.fn<Options["policySource"]["withCurrentPolicy"]>(async (_tx, _input, work) =>
      work({} as never),
    );
  const options: Options = {
    candidateSource: {
      context,
      withCurrentCandidate: candidateRead as Options["candidateSource"]["withCurrentCandidate"],
    },
    brandSource: { withCurrentContent: brandRead as Options["brandSource"]["withCurrentContent"] },
    policySource: {
      context: { ...context },
      withCurrentPolicy: policyRead as Options["policySource"]["withCurrentPolicy"],
      withHeldScopePolicy: vi.fn(),
    },
    clock: { now: () => clock },
  };
  const source = createCurrentProductCandidateContentPolicySource(options);
  const input = {
    command,
    configurationVersionReference: id(8),
    expectedBrandVersion: 1,
    policyReference: id(9),
    policyVersion: 1,
  };
  return {
    options,
    candidateRead,
    brandRead,
    policyRead,
    source,
    tx,
    input,
    candidate,
    assessment,
    setClock: (v: string) => {
      clock = v;
    },
    run: (
      work: (v: CatalogProductContentPolicyAssessment, publication: string) => Promise<unknown>,
    ) => source.withCurrentAssessment(tx, input, work),
  };
}
it("keeps the partial assessment unchanged without a full validation or qualification", async () => {
  const f = fixture(),
    work = vi.fn(async (value) => value);
  expect(await f.run(work)).toBe(f.assessment);
  expect(work).toHaveBeenCalledOnce();
  expect(f.candidateRead).toHaveBeenCalledOnce();
  expect(f.brandRead).toHaveBeenCalledOnce();
  expect(f.policyRead).toHaveBeenCalledOnce();
});
it("uses original methods/context/clock despite collaborator rebound before acquisition", async () => {
  const f = fixture();
  const rebound = vi.fn(async () => {
    throw Error("rebound must not be used");
  });
  Object.assign(f.options.candidateSource, {
    context: {
      ...f.options.candidateSource.context,
      actorReference: parseCatalogReference(id(99)),
    },
    withCurrentCandidate: rebound,
  });
  Object.assign(f.options.brandSource, { withCurrentContent: rebound });
  Object.assign(f.options.policySource, {
    context: { ...f.options.policySource.context, brandReference: parseCatalogReference(id(99)) },
    withCurrentPolicy: rebound,
  });
  Object.assign(f.options.clock, { now: () => instant(60000) });
  expect(await f.run(async (v) => v)).toBe(f.assessment);
  expect(rebound).not.toHaveBeenCalled();
});
it("refuses in-window clock regression after the consumer", async () => {
  const f = fixture();
  f.setClock(instant(1000));
  await expect(
    f.run(async () => {
      f.setClock(instant(500));
    }),
  ).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
});
it("captured original clock cannot be replaced to conceal final expiry", async () => {
  const f = fixture();
  await expect(
    f.run(async () => {
      f.setClock(instant(20000));
      Object.assign(f.options.clock, { now: () => at });
    }),
  ).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
});
it("refuses query replacement in the original transaction after consumer work", async () => {
  const f = fixture();
  await expect(
    f.run(async () => {
      f.tx.query = vi.fn();
    }),
  ).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
});
it("does not extend the original observation deadline for a later acquired source", async () => {
  const f = fixture();
  f.candidate.observedAt = parseCatalogInstant(instant(1000));
  f.candidate.validUntil = parseCatalogInstant(instant(31000));
  Object.assign(f.assessment, { observedAt: instant(1000), validUntil: instant(31000) });
  f.candidateRead.mockImplementation(async (_c, work) => {
    f.setClock(instant(30000));
    return work(f.candidate as never, f.tx);
  });
  const work = vi.fn();
  await expect(f.run(work)).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
  expect(work).not.toHaveBeenCalled();
});
it("checks original clock at final candidate authority even inside the source window", async () => {
  const f = fixture();
  f.setClock(instant(1000));
  f.candidateRead.mockImplementation(async (_c, work) => {
    const result = await work(f.candidate as never, f.tx);
    f.setClock(instant(500));
    return result;
  });
  await expect(f.run(async () => undefined)).rejects.toHaveProperty(
    "code",
    "CATALOG_DEPENDENCY_UNAVAILABLE",
  );
});
it("does not allow swallowed reentrant callbacks to finish successfully", async () => {
  const f = fixture(),
    work = vi.fn(async () => undefined);
  f.candidateRead.mockImplementation(async (_c, callback) => {
    const result = await callback(f.candidate as never, f.tx);
    try {
      await callback(f.candidate as never, f.tx);
    } catch {
      /* deliberately hostile test double */
    }
    return result;
  });
  await expect(f.run(work)).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
  expect(work).toHaveBeenCalledOnce();
});

it("invalid clock failure stays latched when a source swallows it and restores time", async () => {
  const f = fixture();
  f.candidateRead.mockImplementation(async (_c, work) => {
    f.setClock("invalid");
    try {
      await work(f.candidate as never, f.tx);
    } catch {
      /* hostile source */
    }
    f.setClock(at);
    return undefined as never;
  });
  const work = vi.fn();
  await expect(f.run(work)).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
  expect(work).not.toHaveBeenCalled();
});

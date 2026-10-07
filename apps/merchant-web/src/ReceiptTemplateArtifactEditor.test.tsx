import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ReceiptTemplateArtifactEditor,
  dispatchReceiptTemplateArtifact,
  recoverReceiptTemplateArtifact,
} from "./ReceiptTemplateArtifactEditor.js";
import {
  createReceiptTemplateArtifactClient,
  type ReceiptTemplateArtifactCursor,
  type ReceiptTemplateArtifactReceipt,
  type ReceiptTemplateArtifactContent,
} from "./receipt-template-artifact-client.js";
import type { ReceiptTemplateArtifactPendingJournal } from "./receipt-template-artifact-pending-journal.js";
import { StoreSetupClientError } from "./store-setup-client.js";
const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`,
  at = "2026-10-05T10:00:00.000Z",
  scope = {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
  },
  csrf = "A".repeat(43);
beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(Date.parse(at)));
afterEach(() => vi.restoreAllMocks());
// Real client parsing/hash with controlled transport/journal, not native IAM.
function fixture() {
  let snapshot: ReceiptTemplateArtifactReceipt["snapshot"] = null,
    pending: ReceiptTemplateArtifactCursor | null = null,
    receipt: unknown;
  const sequence: string[] = [],
    bodies: Record<string, unknown>[] = [];
  const state = { lose: false, deny: false, cleanup: false, changed: false };
  const current = () => ({
    profile: "DigitalReceiptTemplateArtifactsCurrentV1",
    ...scope,
    layout: snapshot?.artifactKind === "Layout" ? snapshot : null,
    compliance: snapshot?.artifactKind === "Compliance" ? snapshot : null,
    observedAt: at,
    validUntil: "2026-10-05T10:00:05.000Z",
    sourceQualification: "NotEvaluated",
  });
  const journal: ReceiptTemplateArtifactPendingJournal = {
    load: async () => pending,
    reserve: async (c) => {
      sequence.push("reserve");
      pending = c;
    },
    complete: async () => {
      sequence.push("complete");
      if (state.cleanup) throw new StoreSetupClientError("Unavailable");
      pending = null;
    },
  };
  const client = createReceiptTemplateArtifactClient(
    vi.fn(async (_url: RequestInfo | URL, options?: RequestInit) => {
      if (options?.method === "POST") {
        const body = JSON.parse(String(options.body)) as Record<string, unknown>;
        bodies.push(body);
        sequence.push(String(body.command));
        if (state.deny) return new Response("{}", { status: 403 });
        if (body.command === "SaveArtifact") {
          const c = pending;
          if (!c) throw new Error("not reserved");
          snapshot = {
            profile: "DigitalReceiptTemplateArtifactV1",
            tenantReference: scope.tenantReference,
            brandReference: scope.brandReference,
            storeReference: scope.storeReference,
            artifactKind: c.artifactKind,
            artifactReference: id(8),
            revision: c.expectedRevision + 1,
            authoredByReference: scope.actorReference,
            previousArtifactReference: c.expectedArtifactReference,
            content: body.content as ReceiptTemplateArtifactContent,
            createdAt: at,
            updatedAt: at,
            dataClassification: "Internal",
          };
          receipt = {
            profile: "DigitalReceiptTemplateArtifactReceiptV1",
            ...scope,
            artifactKind: c.artifactKind,
            operationReference: c.operationReference,
            intentDigest: c.intentDigest,
            expectedArtifactReference: c.expectedArtifactReference,
            expectedRevision: c.expectedRevision,
            outcome: "Committed",
            snapshot,
            auditReference: id(9),
            occurredAt: at,
          };
          if (state.lose) throw new Error("lost reply");
        }
        return response(receipt);
      }
      sequence.push("read");
      const v = current();
      if (state.changed && snapshot)
        v.layout = {
          ...snapshot,
          artifactReference: id(10),
          revision: 2,
          previousArtifactReference: snapshot.artifactReference,
          authoredByReference: id(11),
        };
      return response(v);
    }),
  );
  return {
    client,
    journal,
    state,
    sequence,
    bodies,
    current: () => client.load({ storeReference: scope.storeReference, expectedScope: scope }),
    pending: () => pending,
  };
}
const response = (v: unknown) =>
  new Response(JSON.stringify(v), {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
it("renders two separate ordinary presets without opaque IDs or Store binding", () => {
  const markup = renderToStaticMarkup(<ReceiptTemplateArtifactEditor scope={scope} csrf={csrf} />);
  expect(markup).toContain("Save receipt layout");
  expect(markup).toContain("Save required receipt fields");
  expect(markup).toContain("legal approval");
  expect(markup).not.toContain(scope.storeReference);
  expect(markup).not.toContain("Use saved");
});
it.each(["Layout", "Compliance"] as const)(
  "reserves %s original before POST and clears only after fresh current",
  async (kind) => {
    const f = fixture(),
      baseline = await f.current();
    await dispatchReceiptTemplateArtifact({
      client: f.client,
      journal: f.journal,
      scope,
      artifactKind: kind,
      baseline,
      csrf,
      signal: new AbortController().signal,
      onReserved: () => undefined,
    });
    expect(f.sequence).toEqual(["read", "read", "reserve", "SaveArtifact", "read", "complete"]);
    expect(f.pending()).toBeNull();
    expect(f.bodies[0]?.expectedRevision).toBe(0);
  },
);
it("lost reply retains payload-free original and recovery never resends content", async () => {
  const f = fixture(),
    baseline = await f.current();
  f.state.lose = true;
  await expect(
    dispatchReceiptTemplateArtifact({
      client: f.client,
      journal: f.journal,
      scope,
      artifactKind: "Layout",
      baseline,
      csrf,
      signal: new AbortController().signal,
      onReserved: () => undefined,
    }),
  ).rejects.toMatchObject({ code: "OutcomeUnknown" });
  const cursor = f.pending();
  expect(cursor).not.toBeNull();
  if (!cursor) throw new Error("missing cursor");
  expect(Object.keys(cursor)).not.toContain("content");
  f.state.lose = false;
  await recoverReceiptTemplateArtifact({
    client: f.client,
    journal: f.journal,
    cursor,
    csrf,
    signal: new AbortController().signal,
  });
  expect(f.bodies[1]).toEqual({
    command: "ResolveOriginal",
    operationReference: cursor.operationReference,
    expectedArtifactReference: null,
    expectedRevision: 0,
    intentDigest: cursor.intentDigest,
  });
  expect(f.pending()).toBeNull();
});
it.each(["deny", "cleanup"] as const)("%s keeps reserved original", async (mode) => {
  const f = fixture(),
    baseline = await f.current();
  f.state[mode] = true;
  await expect(
    dispatchReceiptTemplateArtifact({
      client: f.client,
      journal: f.journal,
      scope,
      artifactKind: "Compliance",
      baseline,
      csrf,
      signal: new AbortController().signal,
      onReserved: () => undefined,
    }),
  ).rejects.toBeDefined();
  expect(f.pending()).not.toBeNull();
});
it("scope cancellation prevents reserve and dispatch", async () => {
  const f = fixture(),
    baseline = await f.current();
  await expect(
    dispatchReceiptTemplateArtifact({
      client: f.client,
      journal: f.journal,
      scope,
      artifactKind: "Layout",
      baseline,
      csrf,
      signal: new AbortController().signal,
      isCurrent: () => false,
      onReserved: () => undefined,
    }),
  ).rejects.toMatchObject({ code: "ScopeChanged" });
  expect(f.bodies).toEqual([]);
  expect(f.pending()).toBeNull();
});

it("fresh head drift refuses a new save before reserve or POST", async () => {
  const f = fixture(),
    baseline = await f.current();
  const input = {
    client: f.client,
    journal: f.journal,
    scope,
    artifactKind: "Layout" as const,
    baseline,
    csrf,
    signal: new AbortController().signal,
    onReserved: () => undefined,
  };
  const saved = await dispatchReceiptTemplateArtifact(input);
  f.state.changed = true;
  await expect(
    dispatchReceiptTemplateArtifact({ ...input, baseline: saved.current }),
  ).rejects.toMatchObject({ code: "Conflict" });
  expect(f.bodies).toHaveLength(1);
  expect(f.pending()).toBeNull();
});

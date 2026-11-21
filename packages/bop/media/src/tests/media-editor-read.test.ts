import { describe, expect, it } from "vitest";
import {
  buildMediaEditorReadSnapshot,
  mediaEditorReadFields,
  parseMediaEditorReadRequest,
  parseMediaEditorReadSnapshot,
  type MediaEditorReadSnapshot,
} from "../contracts/media-editor-read.js";
import {
  createMediaAsset,
  createMediaAssetVersion,
  createMediaScope,
  parseAssetReference,
} from "../contracts/media.js";
import { parseMediaPublicationReadRequest } from "../contracts/media-publication-read.js";
import {
  createPostgresMediaEditorReadSource,
  createPostgresMediaPublicationReadSource,
  type MediaEditorReadAuthorityInput,
  type MediaEditorReadSourceOptions,
} from "../infrastructure/persistence/media-publication-read-store.js";
import type { MediaPersistenceTransaction } from "../infrastructure/persistence/media-upload-store.js";

const id = (n: number) => "019a2421-0032-7000-8000-" + n.toString(16).padStart(12, "0"),
  hash = (n: number) => "sha256:" + n.toString(16).padStart(64, "0"),
  at = "2026-10-04T12:00:00.000Z",
  until = "2026-10-04T12:00:05.000Z",
  unavailable = { code: "MEDIA_EDITOR_READ_UNAVAILABLE" };
function fixture() {
  const scope = createMediaScope({
    kind: "Brand",
    brandReference: id(2),
    storeReference: null,
  } as Parameters<typeof createMediaScope>[0]);
  const asset = createMediaAsset({
    assetId: id(5),
    scope,
    purpose: "PRODUCT_IMAGE",
    mediaKind: "Image",
    ownerType: "PRODUCT",
    ownerReference: id(7),
    classification: "Public",
    version: 1,
    currentVersionReference: null,
  } as Parameters<typeof createMediaAsset>[0]);
  const version = createMediaAssetVersion({
    assetVersionId: id(6),
    assetId: id(5),
    version: 1,
    objectEvidenceReference: id(12),
    providerObjectVersion: id(13),
    byteSize: 234,
    checksum: hash(10),
    contentType: "image/png",
    checkState: "Quarantined",
    readinessState: "Pending",
    createdAt: "2026-10-04T11:59:00.000Z",
  } as Parameters<typeof createMediaAssetVersion>[0]);
  const request = parseMediaEditorReadRequest({
    profile: "MediaEditorReadRequestV1",
    intentKind: "EditorCreate",
    tenantReference: id(1),
    scope,
    actorReference: id(3),
    actorKind: "User",
    operationReference: id(4),
    originalIntentDigest: hash(1),
    productReference: id(7),
    versionReference: id(8),
    expectedAggregateVersion: 0,
    aggregateSnapshotDigest: hash(2),
    contentDigest: hash(3),
    configurationDigest: hash(4),
    references: [
      {
        mediaReference: id(9),
        assetReference: id(5),
        assetVersionReference: id(6),
        cropReference: null,
        focusReference: null,
      },
    ],
    observedAt: at,
    validUntil: until,
  });
  return { scope, asset, version, request };
}
function harness() {
  const f = fixture(),
    guards: { guard: () => Promise<void>; final: () => void }[] = [],
    holds: MediaEditorReadAuthorityInput[] = [],
    calls: string[] = [];
  const state = {
    now: at,
    deadline: until,
    allowed: true,
    missing: false,
    committed: false,
    tentative: 0,
    context: {
      tenant_reference: id(1),
      brand_reference: id(2),
      store_reference: null as string | null,
      isolation: "read committed",
    },
    row: {
      asset: f.asset,
      version: f.version,
      coherent: true,
      intent: null,
      intent_digest: null,
      plan_digest: null,
      completion: null,
      completion_digest: null,
      completed_asset: null,
      completed_version: null,
      completed_at: null,
      source_config: null,
      admission: null,
      admission_digest: null,
      provenance_coherent: false,
    } as Record<string, unknown>,
    onHold: null as null | (() => Promise<void>),
  };
  const tx: MediaPersistenceTransaction = {
    async query<Row>(sql: string) {
      calls.push(sql);
      const rows = sql.startsWith("SELECT current_setting")
        ? [state.context]
        : sql.includes("FROM bop_media.asset_version v JOIN")
          ? state.missing
            ? []
            : [state.row]
          : null;
      if (!rows) throw Error("unexpected controlled SQL");
      return { rows: rows as unknown as readonly Row[] };
    },
  };
  const options: MediaEditorReadSourceOptions = {
    tenantReference: id(1),
    scope: f.scope,
    actorReference: id(3),
    actorKind: "User",
    clock: { now: () => state.now },
    authority: {
      async holdUntilTransactionCompletes(actual, input) {
        expect(actual).toBe(tx);
        holds.push(input);
        await state.onHold?.();
        if (!state.allowed) throw Error("controlled denial");
        return { observedAt: input.request.observedAt, validUntil: state.deadline };
      },
    },
    async registerBeforeCommit(actual, guard, final) {
      expect(actual).toBe(tx);
      guards.push({ guard, final });
    },
  };
  const source = createPostgresMediaEditorReadSource(options);
  async function commit(later?: () => Promise<void>) {
    for (const g of guards) await g.guard();
    await later?.();
    for (const g of guards) g.final();
    state.committed = true;
  }
  async function run(work: () => Promise<unknown>, later?: () => Promise<void>) {
    try {
      await work();
      await commit(later);
    } catch (error) {
      state.tentative = 0;
      throw error;
    }
  }
  return { ...f, state, tx, options, source, holds, calls, guards, commit, run };
}

describe("closed Media editor read contract", () => {
  it("detaches the full Create intent and distinguishes a real expected Draft root", () => {
    const f = fixture(),
      candidate = JSON.parse(JSON.stringify(f.request));
    const parsed = parseMediaEditorReadRequest(candidate);
    candidate.references.length = 0;
    expect(parsed.references).toHaveLength(1);
    expect(Object.isFrozen(parsed.references[0])).toBe(true);
    expect(
      parseMediaEditorReadRequest({
        ...f.request,
        intentKind: "DraftReplace",
        expectedAggregateVersion: 3,
      }),
    ).toMatchObject({ intentKind: "DraftReplace", expectedAggregateVersion: 3 });
    expect(() => parseMediaPublicationReadRequest(parsed)).toThrow(
      expect.objectContaining({ code: "MEDIA_PUBLICATION_READ_UNAVAILABLE" }),
    );
  });
  it.each([
    { profile: "MediaPublicationReadRequestV1" },
    { intentKind: "PublicationV2" },
    { actorKind: "System" },
    { expectedAggregateVersion: 1 },
    { intentKind: "DraftReplace", expectedAggregateVersion: 0 },
    { expectedAggregateVersion: 2147483648 },
    { replacementIntentDigest: hash(1) },
    { originalIntentDigest: "invalid" },
    { validUntil: "2026-10-04T12:00:05.001Z" },
  ])("rejects foreign protocols, forged hashes and invalid bounds %j", (change) => {
    expect(() => parseMediaEditorReadRequest({ ...fixture().request, ...change })).toThrow(
      expect.objectContaining(unavailable),
    );
  });
  it("does not invoke input accessors", () => {
    let calls = 0;
    const request = { ...fixture().request };
    Object.defineProperty(request, "originalIntentDigest", {
      enumerable: true,
      get() {
        calls++;
        return hash(1);
      },
    });
    expect(() => parseMediaEditorReadRequest(request)).toThrow(
      expect.objectContaining(unavailable),
    );
    expect(calls).toBe(0);
  });
  it("rejects duplicate and excessive reference lists", () => {
    const request = fixture().request,
      first = request.references[0];
    if (!first) throw Error("fixture reference absent");
    expect(() => parseMediaEditorReadRequest({ ...request, references: [first, first] })).toThrow(
      expect.objectContaining(unavailable),
    );
    expect(() =>
      parseMediaEditorReadRequest({
        ...request,
        references: Array.from({ length: 101 }, (_, n) => ({
          ...first,
          mediaReference: id(100 + n),
        })),
      }),
    ).toThrow(expect.objectContaining(unavailable));
  });
});

describe("actual scoped editor pin read over controlled SQL facts", () => {
  it.each(["EditorCreate", "DraftReplace"] as const)(
    "records incomplete %s media without claiming Ready or requiring publication",
    async (kind) => {
      const h = harness(),
        request = parseMediaEditorReadRequest({
          ...h.request,
          intentKind: kind,
          expectedAggregateVersion: kind === "EditorCreate" ? 0 : 4,
        });
      let observed: MediaEditorReadSnapshot | undefined;
      await h.run(() =>
        h.source.withCurrentReferences(h.tx, request, async (snapshot, tx) => {
          expect(tx).toBe(h.tx);
          observed = snapshot;
          h.state.tentative++;
          return "consumer";
        }),
      );
      expect(h.state.committed).toBe(true);
      expect(h.state.tentative).toBe(1);
      expect(observed).toMatchObject({
        eligibility: "NotEvaluated",
        references: [
          {
            status: "Recorded",
            assetVersion: { checkState: "Quarantined", readinessState: "Pending" },
            processingProvenanceDigest: null,
          },
        ],
      });
      expect(parseMediaEditorReadSnapshot(observed)).toEqual(observed);
      expect(h.holds).toHaveLength(2);
      for (const held of h.holds)
        expect(held).toEqual({
          request,
          action: "media.asset.access",
          purposeCode: "CATALOG_PRODUCT_EDITOR_MEDIA_READ",
          requiredFields: mediaEditorReadFields,
        });
      expect(h.calls.filter((s) => s.includes("FROM bop_media.asset_version"))).toHaveLength(1);
    },
  );
  it("returns genuine empty references with original authority and no asset lookup", async () => {
    const h = harness();
    const value = await h.source.withCurrentReferences(
      h.tx,
      { ...h.request, references: [] },
      async (snapshot) => snapshot,
    );
    await h.commit();
    expect(value.references).toEqual([]);
    expect(h.calls).toHaveLength(1);
    expect(h.holds).toHaveLength(2);
  });
  it("keeps the same reference fingerprint across editor operations and the mutable current pointer", async () => {
    const a = harness(),
      b = harness();
    b.state.row.asset = createMediaAsset({
      ...b.asset,
      version: 3,
      currentVersionReference: id(70),
    } as Parameters<typeof createMediaAsset>[0]);
    const first = await a.source.withCurrentReferences(
        a.tx,
        a.request,
        async (snapshot) => snapshot,
      ),
      second = await b.source.withCurrentReferences(
        b.tx,
        {
          ...b.request,
          intentKind: "DraftReplace",
          expectedAggregateVersion: 9,
          operationReference: id(90),
        },
        async (snapshot) => snapshot,
      );
    expect(first.relevantReferenceDigest).toBe(second.relevantReferenceDigest);
    expect(first.digest).not.toBe(second.digest);
  });
  it("leaves the original publication NotReady result unchanged", async () => {
    const h = harness(),
      common = Object.fromEntries(
        Object.entries(h.request).filter(([key]) => key !== "expectedAggregateVersion"),
      );
    const request = parseMediaPublicationReadRequest({
      ...common,
      profile: "MediaPublicationReadRequestV1",
      intentKind: "PublicationV2",
      replacementIntentDigest: hash(90),
    });
    const source = createPostgresMediaPublicationReadSource({
      ...h.options,
      authority: {
        async holdUntilTransactionCompletes() {
          return { observedAt: at, validUntil: until };
        },
      },
    });
    const snapshot = await source.withCurrentReferences(h.tx, request, async (value) => value);
    expect(snapshot.references).toEqual([
      { ...request.references[0], status: "Unavailable", reason: "NotReady" },
    ]);
    await h.commit();
  });
  it.each([
    "missing",
    "scope",
    "version",
    "asset",
    "coherent",
    "readyWithoutProvenance",
    "rls",
  ] as const)("refuses corrupt or foreign %s facts before the consumer", async (kind) => {
    const h = harness();
    let consumed = false;
    if (kind === "missing") h.state.missing = true;
    if (kind === "scope")
      h.state.row.asset = { ...h.asset, scope: { ...h.scope, brandReference: id(80) } };
    if (kind === "version") h.state.row.version = { ...h.version, assetVersionId: id(80) };
    if (kind === "asset") h.state.row.version = { ...h.version, assetId: id(80) };
    if (kind === "coherent") h.state.row.coherent = false;
    if (kind === "readyWithoutProvenance")
      h.state.row.version = { ...h.version, checkState: "Clean", readinessState: "Ready" };
    if (kind === "rls") h.state.context.store_reference = id(80);
    await expect(
      h.run(() =>
        h.source.withCurrentReferences(h.tx, h.request, async () => {
          consumed = true;
        }),
      ),
    ).rejects.toMatchObject(unavailable);
    expect(consumed).toBe(false);
    expect(h.state.committed).toBe(false);
  });
  it.each([
    { tenantReference: id(90) },
    { actorReference: id(90) },
    { scope: { kind: "Brand", brandReference: id(90), storeReference: null } },
  ])("refuses a caller transplanted to another current identity %j", async (change) => {
    const h = harness();
    let consumed = false;
    await expect(
      h.source.withCurrentReferences(
        h.tx,
        parseMediaEditorReadRequest({ ...h.request, ...change }),
        async () => {
          consumed = true;
        },
      ),
    ).rejects.toMatchObject(unavailable);
    expect(consumed).toBe(false);
    expect(h.holds).toHaveLength(0);
    expect(h.calls).toHaveLength(0);
    await expect(h.commit()).rejects.toMatchObject(unavailable);
  });
  it("captures the full request before the first authority await", async () => {
    const h = harness(),
      input = JSON.parse(JSON.stringify(h.request));
    h.state.onHold = async () => {
      input.originalIntentDigest = hash(99);
      input.references.length = 0;
    };
    const result = await h.source.withCurrentReferences(h.tx, input, async (value) => value);
    await h.commit();
    expect(result.request.originalIntentDigest).toBe(h.request.originalIntentDigest);
    expect(result.references).toHaveLength(1);
  });
  it("refuses an unimplemented adjustment instead of assuming its identity exists", async () => {
    const h = harness(),
      request = {
        ...h.request,
        references: h.request.references.map((r) => ({ ...r, cropReference: id(90) })),
      };
    await expect(
      h.source.withCurrentReferences(h.tx, request, async () => true),
    ).rejects.toMatchObject(unavailable);
    expect(h.calls).toHaveLength(1);
  });
  it("binds snapshot bytes, actual pin and unextended original lease", async () => {
    const h = harness(),
      value = await h.source.withCurrentReferences(h.tx, h.request, async (s) => s);
    expect(() => parseMediaEditorReadSnapshot({ ...value, digest: hash(90) })).toThrow(
      expect.objectContaining(unavailable),
    );
    expect(() =>
      buildMediaEditorReadSnapshot({
        request: h.request,
        references: value.references,
        observedAt: at,
        validUntil: "2026-10-04T12:00:06.000Z",
      }),
    ).toThrow(expect.objectContaining(unavailable));
    expect(() =>
      buildMediaEditorReadSnapshot({
        request: h.request,
        references: value.references.map((r) => ({
          ...r,
          assetVersion: { ...r.assetVersion, assetId: parseAssetReference(id(90)) },
        })),
        observedAt: at,
        validUntil: until,
      }),
    ).toThrow(expect.objectContaining(unavailable));
  });
  it("poisons the outer transaction after a caught nested invocation", async () => {
    const h = harness();
    let consumers = 0;
    await expect(
      h.run(() =>
        h.source.withCurrentReferences(h.tx, h.request, async () => {
          consumers++;
          h.state.tentative++;
          await expect(
            h.source.withCurrentReferences(h.tx, h.request, async () => {
              consumers++;
            }),
          ).rejects.toMatchObject(unavailable);
          return true;
        }),
      ),
    ).rejects.toMatchObject(unavailable);
    expect(consumers).toBe(1);
    expect(h.state.tentative).toBe(0);
    expect(h.state.committed).toBe(false);
  });
  it("retains an early rejecting guard when a caller swallows missing-reference failure", async () => {
    const h = harness();
    h.state.missing = true;
    await expect(
      h.run(async () => {
        await expect(
          h.source.withCurrentReferences(h.tx, h.request, async () => true),
        ).rejects.toMatchObject(unavailable);
        h.state.tentative++;
      }),
    ).rejects.toMatchObject(unavailable);
    expect(h.state.tentative).toBe(0);
    expect(h.state.committed).toBe(false);
  });
  it.each(["revoke", "expiry", "rollback", "query"] as const)(
    "rejects completion of a held consumer for late %s",
    async (kind) => {
      const h = harness();
      await expect(
        h.run(
          () =>
            h.source.withCurrentReferences(h.tx, h.request, async () => {
              h.state.tentative++;
              if (kind === "revoke") h.state.allowed = false;
            }),
          async () => {
            if (kind === "expiry") h.state.now = until;
            if (kind === "rollback") h.state.now = "2026-10-04T11:59:59.999Z";
            if (kind === "query") h.tx.query = async () => ({ rows: [] });
          },
        ),
      ).rejects.toMatchObject(unavailable);
      expect(h.state.committed).toBe(false);
      expect(h.state.tentative).toBe(0);
    },
  );
  it("captures authority and clock receivers before awaiting source work", async () => {
    const h = harness();
    const original = h.options.authority.holdUntilTransactionCompletes;
    h.state.onHold = async () => {
      h.options.authority.holdUntilTransactionCompletes = async () => {
        throw Error("mutated");
      };
      h.options.clock.now = () => {
        throw Error("mutated");
      };
    };
    await h.run(() => h.source.withCurrentReferences(h.tx, h.request, async () => true));
    expect(h.holds).toHaveLength(2);
    expect(h.options.authority.holdUntilTransactionCompletes).not.toBe(original);
  });
  it("uses a shorter authority lease and refuses renewal or post-read expiry", async () => {
    const h = harness();
    h.state.deadline = "2026-10-04T12:00:01.000Z";
    await expect(
      h.run(
        () => h.source.withCurrentReferences(h.tx, h.request, async () => true),
        async () => {
          h.state.now = h.state.deadline;
        },
      ),
    ).rejects.toMatchObject(unavailable);
    expect(h.state.committed).toBe(false);
    const b = harness();
    b.state.deadline = "2026-10-04T12:00:06.000Z";
    await expect(
      b.source.withCurrentReferences(b.tx, b.request, async () => true),
    ).rejects.toMatchObject(unavailable);
  });
});

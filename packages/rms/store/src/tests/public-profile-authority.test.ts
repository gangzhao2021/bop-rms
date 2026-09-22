import { beforeEach, expect, it, vi } from "vitest";
import { candidate, ids } from "./public-store-profile.fixture.js";
import {
  createPostgresPublicStoreProfileAuthority,
  publicStoreProfileContent,
} from "../infrastructure/public-profile-authority.js";
const f = vi.hoisted(() => ({ load: vi.fn(), create: vi.fn() }));
vi.mock("@bop/publishing", async (original) => ({
  ...(await original<typeof import("@bop/publishing")>()),
  createPostgresPublishingMutationStore: (...args: unknown[]) => {
    f.create(...args);
    return { resolveCurrentRelease: f.load };
  },
}));
beforeEach(() => vi.resetAllMocks());
function setup() {
  const profile = candidate();
  const tx = { query: vi.fn() };
  const authorize = vi.fn(async () => true),
    effective = vi.fn(async () => true),
    media = vi.fn(async () => true);
  f.load.mockResolvedValue({
    lifecycle: profile.publishingLifecycle,
    release: profile.publishingRelease,
  });
  const options = {
    tenantReference: ids.lookup,
    brandReference: ids.brand,
    storeReference: ids.store,
    authorize,
    hashContent: vi.fn((value: unknown) => {
      void value;
      return profile.contentDigest;
    }),
    verifyEffective: effective,
    verifyMedia: media,
  };
  const verify = createPostgresPublicStoreProfileAuthority(options);
  return { profile, tx, authorize, effective, media, options, verify };
}
const at = "2026-01-15T12:00:00.000Z";
it("binds exact current release in the same transaction and requires current ancillary authority", async () => {
  const x = setup();
  expect(await x.verify(x.tx, x.profile as never, at)).toBe(true);
  expect(f.load).toHaveBeenCalledExactlyOnceWith({
    familyReference: ids.family,
    configurationType: "STORE_PROFILE",
    purposeCode: "CUSTOMER_ENTRY",
    observedAt: at,
  });
  const creation = f.create.mock.calls[0];
  if (!creation) throw new Error("publishing source was not composed");
  await creation[0].run(async (tx: unknown) => expect(tx).toBe(x.tx));
  expect(x.authorize).toHaveBeenCalledTimes(2);
  expect(x.effective).toHaveBeenCalledOnce();
  expect(x.media).toHaveBeenCalledOnce();
  expect(x.options.hashContent.mock.calls[0]?.[0]).not.toHaveProperty("publishingRelease");
  expect(publicStoreProfileContent(x.profile as never)).not.toHaveProperty("contentDigest");
});
it("rejects unavailable, replaced or withdrawn publication and mismatched display digest", async () => {
  const x = setup();
  f.load.mockRejectedValueOnce(new Error("withdrawn"));
  expect(await x.verify(x.tx, x.profile as never, at)).toBe(false);
  f.load.mockResolvedValueOnce({
    lifecycle: x.profile.publishingLifecycle,
    release: { ...x.profile.publishingRelease, releaseId: ids.lookup },
  });
  expect(await x.verify(x.tx, x.profile as never, at)).toBe(false);
  x.options.hashContent.mockReturnValue("sha256:" + "b".repeat(64));
  expect(await x.verify(x.tx, x.profile as never, at)).toBe(false);
  expect(x.effective).not.toHaveBeenCalled();
});
it("rejects scoped authorization withdrawal and invalid effective/media evidence; null logo does not query Media", async () => {
  const x = setup();
  x.effective.mockResolvedValueOnce(false);
  expect(await x.verify(x.tx, x.profile as never, at)).toBe(false);
  x.media.mockResolvedValueOnce(false);
  expect(await x.verify(x.tx, x.profile as never, at)).toBe(false);
  x.authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  expect(await x.verify(x.tx, x.profile as never, at)).toBe(false);
  x.media.mockClear();
  expect(await x.verify(x.tx, { ...x.profile, logo: null } as never, at)).toBe(true);
  expect(x.media).not.toHaveBeenCalled();
  expect(await x.verify(x.tx, { ...x.profile, storeReference: ids.lookup } as never, at)).toBe(
    false,
  );
});

it("rejects timing payloads bound to another profile, release, scope or clock before current timing lookup", async () => {
  const x = setup();
  const base = x.profile.effectiveVersion;
  for (const change of [
    { configurationType: "OTHER_PROFILE" },
    { purposeCode: "OTHER_PURPOSE" },
    { configurationReference: ids.lookup },
    { snapshotReference: ids.lookup },
    { snapshotDigest: "sha256:" + "b".repeat(64) },
    { releaseReference: ids.lookup },
    { scope: { ...base.scope, storeReference: ids.lookup } },
    { period: { ...base.period, timeZone: "America/Toronto" } },
    { createdAt: "2026-01-16T00:00:00.000Z" },
  ]) {
    expect(
      await x.verify(
        x.tx,
        {
          ...x.profile,
          effectiveVersion: { ...base, ...change },
        } as never,
        at,
      ),
    ).toBe(false);
  }
  expect(x.effective).not.toHaveBeenCalled();
  expect(x.media).not.toHaveBeenCalled();
});

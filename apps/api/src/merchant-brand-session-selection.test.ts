import { Buffer } from "node:buffer";
import {
  createAuthenticationSession,
  createBrowserSessionRecord,
  createIdentityActor,
  parseSelectorHash,
  type OidcAuthorizationTransaction,
} from "@bop/identity";
import { createBrand, createTenantContext, createBrandAdministrationContext } from "@bop/tenant";
import { beforeEach, expect, it, vi } from "vitest";
import {
  createMerchantBrandSessionSelection,
  createMerchantBrandAdministrationSessionSelection,
} from "./merchant-brand-session-selection.js";
const port = vi.hoisted(() => ({ authority: vi.fn(), administration: vi.fn() }));
vi.mock("./merchant-current-brand-scope.js", async (original) => ({
  ...(await original<typeof import("./merchant-current-brand-scope.js")>()),
  readMerchantCurrentBrandAuthority: port.authority,
  readMerchantCurrentBrandAdministrationAuthority: port.administration,
}));
const id = (n: number) => "0190ed60-0000-7000-8000-" + String(n).padStart(12, "0");
const at = "2026-09-10T10:00:00.000Z";
const actor = createIdentityActor({
  actorType: "User",
  actorReference: id(1),
  accountKind: "Workforce",
  status: "Active",
  authenticationMethod: "Oidc",
  verificationLevel: "SingleFactor",
  authenticatedAt: at,
  recentMfaAt: null,
});
const brand = createBrand({
  brandReference: id(3),
  code: "SYNTHETIC",
  displayName: "Synthetic Brand",
  defaultLocale: "en-CA",
  currencyCode: "CAD",
  lifecycle: "Active",
  version: 1,
  createdAt: at,
  updatedAt: at,
});
beforeEach(() => {
  vi.clearAllMocks();
});
function fixture(rotatedFrom: string | null = null, administrative = false) {
  const session = createAuthenticationSession({
    sessionReference: id(2),
    actor,
    status: "Active",
    policyCode: administrative ? "Privileged" : "WorkforceStandard",
    maxActiveSessions: administrative ? 2 : 5,
    idleTimeoutMinutes: administrative ? 15 : 30,
    absoluteTimeoutMinutes: administrative ? 480 : 720,
    version: 1,
    authenticatedAt: at,
    createdAt: at,
    lastSeenAt: at,
    idleExpiresAt: administrative ? "2026-09-10T10:15:00.000Z" : "2026-09-10T10:30:00.000Z",
    absoluteExpiresAt: administrative ? "2026-09-10T18:00:00.000Z" : "2026-09-10T22:00:00.000Z",
    rotatedFromSessionReference: rotatedFrom,
    revocationReason: null,
    revokedAt: null,
  });
  const stored: Record<string, unknown> = {
    session_id: session.sessionReference,
    actor_id: actor.actorReference,
    status: "Active",
    policy_code: session.policy.code,
    version: 1,
    authenticated_at: at,
    created_at: at,
    last_seen_at: at,
    idle_expires_at: session.idleExpiresAt,
    absolute_expires_at: session.absoluteExpiresAt,
    rotated_from_session_id: rotatedFrom,
    revocation_reason: null,
    revoked_at: null,
    precise: true,
  };
  const state = {
    clock: at,
    allowed: true,
    actor,
    row: null as Record<string, unknown> | null,
    inserts: 0,
    brand: createBrand({ ...brand, lifecycle: administrative ? "Draft" : "Active" }),
    boundary: null as string | null,
  };
  const tx: OidcAuthorizationTransaction = {
    async query(sql, values) {
      if (sql.includes("FROM bop_identity.authentication_session"))
        return {
          rows: [
            sql.includes("WHERE session_selector_hash")
              ? {
                  ...stored,
                  authenticated_at: new Date(at),
                  created_at: new Date(at),
                  last_seen_at: new Date(at),
                  idle_expires_at: new Date(session.idleExpiresAt),
                  absolute_expires_at: new Date(session.absoluteExpiresAt),
                }
              : Object.fromEntries(
                  Object.entries(stored).filter(
                    ([key]) =>
                      ![
                        "cipher_algorithm",
                        "key_reference",
                        "encrypted_secret",
                        "encryption_context",
                        "csrf_selector_hash",
                      ].includes(key),
                  ),
                ),
          ],
        };
      if (sql.startsWith("SELECT current_setting"))
        return { rows: [{ session_scope: "", actor_scope: "" }] };
      if (sql.startsWith("INSERT")) {
        state.inserts++;
        state.row = {
          session_id: values[0],
          actor_id: values[1],
          brand_id: values[2],
          selected_at: values[3],
          precise: true,
        };
      }
      return {
        rows:
          sql.includes("FROM bop_identity.browser_brand_session_selection") && state.row
            ? [state.row]
            : [],
      };
    },
  };
  const configuration = {
    environment: "synthetic",
    issuer: "https://identity.invalid/",
    clientId: "workforce",
    redirectUri: "https://merchant.invalid/merchant/organization/brands/callback",
    allowedPostLoginPaths: ["/app/organization/brands"],
  };
  const proof = {
    profile: "WorkforceBrowserSessionV1",
    issuer: configuration.issuer,
    clientId: configuration.clientId,
    tokenBundle: "synthetic",
    csrf: "x".repeat(43),
    mfa: {
      sessionReference: id(2),
      actorReference: id(1),
      method: "Totp",
      evidenceReference: id(20),
      authorizationTransactionReference: id(21),
      authenticatedAt: at,
      verifiedAt: at,
      validUntil: "2026-09-10T10:15:00.000Z",
    },
  };
  const encryptedSecrets = {
    algorithm: "SYNTHETIC_AES_256_GCM" as const,
    keyReference: "synthetic",
    ciphertext: Buffer.from(new Uint8Array(32)).toString("base64url"),
    encryptionContext: `synthetic:session:${id(2)}:${id(1)}`,
  };
  Object.assign(stored, {
    cipher_algorithm: encryptedSecrets.algorithm,
    key_reference: encryptedSecrets.keyReference,
    encrypted_secret: new Uint8Array(32),
    encryption_context: encryptedSecrets.encryptionContext,
    csrf_selector_hash: new Uint8Array(32).fill(170),
  });
  const record = createBrowserSessionRecord({
    session,
    encryptedSecrets,
    sessionSelectorHash: parseSelectorHash("b".repeat(64)),
    csrfSelectorHash: parseSelectorHash("a".repeat(64)),
  });
  const source = {
    now: () => state.clock,
    currentActor: async () => state.actor,
    identity: {
      configuration,
      envelopes: {
        async encrypt() {
          throw new Error("unused controlled crypto");
        },
        async decrypt() {
          return JSON.stringify(proof);
        },
      },
      hasher: {
        hash: () => parseSelectorHash("a".repeat(64)),
        equals: (a: string, b: string) => a === b,
      },
    },
  };
  const selectedAuthority = administrative ? port.administration : port.authority;
  selectedAuthority.mockImplementation(async () => ({
    context: administrative
      ? createBrandAdministrationContext(actor, state.brand, state.clock)
      : createTenantContext(actor, state.brand, null, state.clock),
    decisions: [{ effect: state.allowed ? "Allow" : "Deny" }],
    validUntil: state.boundary,
  }));
  const guards: { check: () => Promise<void>; final: () => void }[] = [];
  const run = (previousSessionReference: string | null = rotatedFrom) =>
    (administrative
      ? createMerchantBrandAdministrationSessionSelection
      : createMerchantBrandSessionSelection)({
      source,
      brandReference: id(3),
      previousSessionReference,
      registerBeforeCommit: async (transaction, check, final) => {
        expect(transaction).toBe(tx);
        guards.push({ check, final });
      },
    })(tx, record);
  return { state, stored, guards, run, proof, record };
}
it.each([null, id(9)])("binds the genuine new session on login/rotation: %s", async (previous) => {
  const f = fixture(previous);
  await f.run();
  expect(f.state.row).toMatchObject({ session_id: id(2), actor_id: id(1), brand_id: id(3) });
  expect(f.guards).toHaveLength(1);
  await f.guards[0]?.check();
  f.guards[0]?.final();
  expect(f.state.inserts).toBe(1);
});
it("rejects a mismatched rotation predecessor instead of copying stale identity", async () => {
  const f = fixture(id(9));
  await expect(f.run(id(8))).rejects.toThrow();
  expect(f.state.inserts).toBe(0);
});
it("denies initial Brand permission before writing the selection", async () => {
  const f = fixture();
  f.state.allowed = false;
  await expect(f.run()).rejects.toThrow();
  expect(f.state.inserts).toBe(0);
});
it.each(["session", "actor", "permission", "expiry"])(
  "refuses late %s at the original commit guard",
  async (reason) => {
    const f = fixture();
    await f.run();
    if (reason === "session") f.stored.status = "Revoked";
    if (reason === "actor")
      f.state.actor = createIdentityActor({ ...actor, actorReference: id(9) });
    if (reason === "permission") f.state.allowed = false;
    if (reason === "expiry") f.state.clock = "2026-09-10T10:00:05.000Z";
    const guard = f.guards[0];
    if (!guard) throw new Error("fixture");
    await expect(guard.check()).rejects.toThrow();
    expect(guard.final).toThrow();
  },
);

it.each([null, id(9)])(
  "binds a genuine Draft administrative Brand on new login/rotation: %s",
  async (previous) => {
    const f = fixture(previous, true);
    await f.run();
    expect(f.state.brand.lifecycle).toBe("Draft");
    expect(f.state.row).toMatchObject({ session_id: id(2), actor_id: id(1), brand_id: id(3) });
    expect(port.authority).not.toHaveBeenCalled();
    expect(port.administration).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      id(3),
      at,
      ["organization.manage"],
      expect.any(Object),
    );
    await f.guards[0]?.check();
    f.guards[0]?.final();
    expect(f.state.inserts).toBe(1);
  },
);
it("retains operational Draft refusal and administrative initial permission denial", async () => {
  const ordinary = fixture();
  ordinary.state.brand = createBrand({ ...brand, lifecycle: "Draft" });
  await expect(ordinary.run()).rejects.toThrow();
  expect(ordinary.state.inserts).toBe(0);
  const administrative = fixture(null, true);
  administrative.state.allowed = false;
  await expect(administrative.run()).rejects.toThrow();
  expect(administrative.state.inserts).toBe(0);
});
it.each(["session", "actor", "permission", "expiry", "Brand", "selection", "boundary"])(
  "refuses late administrative %s at the original commit guard",
  async (reason) => {
    const f = fixture(null, true);
    if (reason === "boundary") f.state.boundary = "2026-09-10T10:00:00.001Z";
    await f.run();
    if (reason === "session") f.stored.status = "Revoked";
    if (reason === "actor")
      f.state.actor = createIdentityActor({ ...actor, actorReference: id(9) });
    if (reason === "permission") f.state.allowed = false;
    if (reason === "expiry") f.state.clock = "2026-09-10T10:00:05.000Z";
    if (reason === "Brand")
      f.state.brand = createBrand({ ...f.state.brand, lifecycle: "Active", version: 2 });
    if (reason === "selection" && f.state.row) f.state.row.brand_id = id(9);
    if (reason === "boundary") f.state.clock = String(f.state.boundary);
    const guard = f.guards[0];
    if (!guard) throw new Error("fixture");
    await expect(guard.check()).rejects.toThrow();
    expect(guard.final).toThrow();
  },
);
it("refuses an administrative rotation with another predecessor", async () => {
  const f = fixture(id(9), true);
  await expect(f.run(id(8))).rejects.toThrow();
  expect(f.state.inserts).toBe(0);
});

it("administrative selection authorizes actual proof-derived RecentMfa and rejects mismatched proof", async () => {
  const f = fixture(null, true);
  await f.run();
  expect(port.administration.mock.calls[0]?.[1]?.actor.verificationLevel).toBe("RecentMfa");
  const g = fixture(null, true);
  g.proof.mfa.sessionReference = id(99);
  await expect(g.run()).rejects.toThrow();
  expect(g.state.inserts).toBe(0);
});

import { Buffer } from "node:buffer";
import { generateKeyPairSync, sign } from "node:crypto";
import { expect, it } from "vitest";
import {
  BrandProvisioningApprovalError,
  brandProvisioningApprovalSigningBytes,
  parseBrandProvisioningApproval,
  parseBrandProvisioningApprovalExpected,
  parseBrandProvisioningApprovalTrust,
  type BrandProvisioningApproval,
} from "../contracts/brand-provisioning-approval.js";
import {
  createSignedBrandProvisioningApprovalSource,
  type BrandProvisioningApprovalLease,
  type SignedBrandProvisioningApprovalSourceOptions,
} from "../infrastructure/brand-provisioning-approval-source.js";

const id = (n: number) => `01902421-0001-7000-8000-${String(n).padStart(12, "0")}`;
const at = "2026-10-06T12:00:00.000Z",
  after = (ms: number) => new Date(Date.parse(at) + ms).toISOString();
function setup() {
  const keys = generateKeyPairSync("ed25519");
  const unsigned = {
    profile: "BrandInitialProvisioningApprovalV1",
    purposeCode: "BRAND_INITIAL_PROVISIONING",
    environmentReference: id(1),
    operationReference: id(2),
    brandReference: id(3),
    planDigest: "sha256:" + "a".repeat(64),
    operatorReference: id(4),
    approvedByReference: id(5),
    approvalEvidenceReference: id(6),
    notBefore: at,
    validUntil: after(60000),
    keyReference: id(7),
    signature: Buffer.alloc(64).toString("base64url"),
  };
  const signed = (change: Partial<BrandProvisioningApproval> = {}) => {
    const value = parseBrandProvisioningApproval({ ...unsigned, ...change });
    return parseBrandProvisioningApproval({
      ...value,
      signature: sign(
        null,
        Buffer.from(brandProvisioningApprovalSigningBytes(value)),
        keys.privateKey,
      ).toString("base64url"),
    });
  };
  const trust = parseBrandProvisioningApprovalTrust({
    profile: "BrandInitialProvisioningTrustV1",
    keys: [
      {
        keyReference: id(7),
        approvedByReference: id(5),
        environmentReference: id(1),
        purposeCode: "BRAND_INITIAL_PROVISIONING",
        notBefore: at,
        validUntil: after(60000),
        publicKeySpki: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
      },
    ],
    revokedApprovalEvidenceReferences: [],
  });
  const state: {
    now: string;
    approval: unknown;
    trust: unknown;
    reads: number;
    trustReads: number;
    beforeApproval?: () => Promise<void>;
    beforeTrust?: () => Promise<void>;
  } = {
    now: at,
    approval: signed(),
    trust,
    reads: 0,
    trustReads: 0,
  };
  const expected = parseBrandProvisioningApprovalExpected({
    environmentReference: id(1),
    operationReference: id(2),
    brandReference: id(3),
    planDigest: unsigned.planDigest,
    operatorReference: id(4),
  });
  const options: SignedBrandProvisioningApprovalSourceOptions = {
    clock: { now: () => state.now },
    async readApproval(input) {
      expect(input).toEqual(expected);
      state.reads++;
      await state.beforeApproval?.();
      return state.approval;
    },
    async readTrust(input) {
      expect(input.environmentReference).toBe(id(1));
      expect(input.purposeCode).toBe("BRAND_INITIAL_PROVISIONING");
      state.trustReads++;
      await state.beforeTrust?.();
      return state.trust;
    },
  };
  const source = createSignedBrandProvisioningApprovalSource(options);
  const complete = (work?: (lease: BrandProvisioningApprovalLease) => Promise<void>) =>
    source.withApproval(expected, async (lease) => {
      await work?.(lease);
      await lease.assertCurrent();
      lease.assertFinalized();
      return lease;
    });
  return {
    state,
    expected,
    trust,
    options,
    source,
    signed,
    complete,
    signBytes: (bytes: string) =>
      sign(null, Buffer.from(bytes), keys.privateKey).toString("base64url"),
  };
}
it("verifies actual ephemeral Ed25519 approval and seals inside the owning transaction callback", async () => {
  const f = setup();
  const lease = await f.complete(async (held) => {
    expect(held.approval.operatorReference).toBe(id(4));
    expect(held.observedAt).toBe(at);
    expect(held.validUntil).toBe(after(5000));
  });
  expect(f.state.reads).toBe(2);
  expect(f.state.trustReads).toBe(2);
  f.state.now = after(10000);
  expect(lease.validUntil).toBe(after(5000));
  await expect(lease.assertCurrent()).rejects.toThrow(BrandProvisioningApprovalError);
});
it("does not perform post-COMMIT clock or file reads when the transaction finishes inside work", async () => {
  const f = setup();
  await f.source
    .withApproval(f.expected, async (lease) => {
      await lease.assertCurrent();
      lease.assertFinalized();
      f.state.now = after(10000);
      f.state.approval = null;
      f.state.trust = null;
      return "committed";
    })
    .then((value) => expect(value).toBe("committed"));
  expect(f.state.reads).toBe(2);
});
it.each([
  "environmentReference",
  "operationReference",
  "brandReference",
  "planDigest",
  "operatorReference",
] as const)("rejects a genuine signature bound to another %s", async (field) => {
  const f = setup();
  f.state.approval = f.signed({
    [field]: field === "planDigest" ? "sha256:" + "b".repeat(64) : id(99),
  });
  await expect(f.complete()).rejects.toThrow(BrandProvisioningApprovalError);
});
it("rejects forged signature, other signing key and wrong domain separation", async () => {
  for (const kind of ["tamper", "foreignKey", "wrongDomain"] as const) {
    const f = setup(),
      approval = f.signed();
    const other = generateKeyPairSync("ed25519");
    const signature =
      kind === "tamper"
        ? Buffer.alloc(64).toString("base64url")
        : kind === "wrongDomain"
          ? f.signBytes(JSON.stringify(approval))
          : sign(
              null,
              Buffer.from(brandProvisioningApprovalSigningBytes(approval)),
              other.privateKey,
            ).toString("base64url");
    f.state.approval = { ...approval, signature };
    await expect(f.complete()).rejects.toThrow(BrandProvisioningApprovalError);
  }
});
it("requires a configured matching key and independent approver", async () => {
  const f = setup();
  f.state.trust = { ...f.trust, keys: [] };
  await expect(f.complete()).rejects.toThrow();
  for (const change of [
    { approvedByReference: id(99) },
    { environmentReference: id(99) },
    { notBefore: after(1) },
  ]) {
    const g = setup(),
      key = g.trust.keys[0];
    if (!key) throw new Error("fixture key missing");
    g.state.trust = { ...g.trust, keys: [{ ...key, ...change }] };
    await expect(g.complete()).rejects.toThrow();
  }
  const g = setup();
  g.state.approval = { ...g.signed(), approvedByReference: id(4) };
  await expect(g.complete()).rejects.toThrow();
});
it("bounds the original lease by approval and key expiry without renewal", async () => {
  const f = setup();
  f.state.approval = f.signed({ validUntil: after(3000) });
  const key = f.trust.keys[0];
  if (!key) throw new Error("fixture key missing");
  f.state.trust = { ...f.trust, keys: [{ ...key, validUntil: after(2000) }] };
  const lease = await f.complete();
  expect(lease.validUntil).toBe(after(2000));
  const g = setup();
  g.state.approval = g.signed({ validUntil: after(1000) });
  await expect(
    g.complete(async (held) => {
      g.state.now = after(1000);
      await held.assertCurrent();
    }),
  ).rejects.toThrow();
});
it("rechecks approval withdrawal and current key removal in the pre-COMMIT async guard", async () => {
  for (const change of ["revoke", "remove"] as const) {
    const f = setup();
    await expect(
      f.complete(async () => {
        f.state.trust =
          change === "revoke"
            ? { ...f.trust, revokedApprovalEvidenceReferences: [id(6)] }
            : { ...f.trust, keys: [] };
      }),
    ).rejects.toThrow();
  }
});
it("pins signed identity and selected trust key validity while allowing unrelated trust updates", async () => {
  for (const change of ["approval", "key"] as const) {
    const f = setup(),
      key = f.trust.keys[0];
    if (!key) throw new Error("fixture key missing");
    await expect(
      f.complete(async () => {
        if (change === "approval")
          f.state.approval = f.signed({ approvalEvidenceReference: id(99) });
        else f.state.trust = { ...f.trust, keys: [{ ...key, validUntil: after(120000) }] };
      }),
    ).rejects.toThrow();
  }
  const f = setup(),
    key = f.trust.keys[0];
  if (!key) throw new Error("fixture key missing");
  await f.complete(async () => {
    f.state.trust = {
      ...f.trust,
      keys: [key, { ...key, keyReference: id(99) }],
      revokedApprovalEvidenceReferences: [id(98)],
    };
  });
});
it.each(["approval", "trust", "clock"] as const)(
  "captures %s port and poisons replacements after await",
  async (field) => {
    const f = setup();
    await expect(
      f.complete(async () => {
        if (field === "clock") Object.defineProperty(f.options.clock, "now", { value: () => at });
        else
          Object.defineProperty(f.options, field === "approval" ? "readApproval" : "readTrust", {
            value: async () => null,
          });
      }),
    ).rejects.toThrow(BrandProvisioningApprovalError);
  },
);
it("refuses expiry or monotonic-clock reversal at the final synchronous seal", async () => {
  for (const finalAt of [after(5000), "2026-10-06T11:59:59.999Z"]) {
    const f = setup();
    await expect(
      f.source.withApproval(f.expected, async (lease) => {
        await lease.assertCurrent();
        f.state.now = finalAt;
        lease.assertFinalized();
      }),
    ).rejects.toThrow();
  }
});
it("requires one async reread and exactly one final seal, and poisons caught early/repeated seals", async () => {
  for (const kind of ["missing", "early", "double"] as const) {
    const f = setup();
    await expect(
      f.source.withApproval(f.expected, async (lease) => {
        if (kind === "missing") return;
        if (kind === "early") {
          expect(() => lease.assertFinalized()).toThrow();
          await lease.assertCurrent();
          return;
        }
        await lease.assertCurrent();
        lease.assertFinalized();
        expect(() => lease.assertFinalized()).toThrow();
      }),
    ).rejects.toThrow();
  }
});
it("poisons callback reentry and reuse even when the caller catches refusal", async () => {
  const f = setup();
  await expect(
    f.complete(async () => {
      await expect(f.source.withApproval(f.expected, async () => true)).rejects.toThrow();
    }),
  ).rejects.toThrow();
  const g = setup();
  await g.complete();
  await expect(g.source.withApproval(g.expected, async () => true)).rejects.toThrow();
});
it("refuses unawaited/pending guard escape and overlapping current reads", async () => {
  const f = setup();
  let release: (() => void) | undefined;
  await expect(
    f.source.withApproval(f.expected, async (lease) => {
      f.state.beforeApproval = () =>
        new Promise<void>((resolve) => {
          release = resolve;
        });
      const pending = lease.assertCurrent();
      void pending.catch(() => undefined);
      expect(() => lease.assertFinalized()).toThrow();
      if (!release) throw new Error("Pending source was not entered");
      release();
      await expect(pending).rejects.toThrow();
    }),
  ).rejects.toThrow();
  const g = setup();
  await expect(
    g.source.withApproval(g.expected, async (lease) => {
      g.state.beforeApproval = () =>
        new Promise<void>((resolve) => {
          release = resolve;
        });
      const first = lease.assertCurrent();
      void first.catch(() => undefined);
      await expect(lease.assertCurrent()).rejects.toThrow();
      if (!release) throw new Error("Pending source was not entered");
      release();
      await expect(first).rejects.toThrow();
    }),
  ).rejects.toThrow();
});
it("normalizes unknown remote failures and malformed source bytes without leaking detail", async () => {
  const f = setup();
  f.state.beforeApproval = async () => {
    throw new Error("private filename /secret");
  };
  await expect(f.complete()).rejects.toMatchObject({
    code: "BRAND_PROVISIONING_APPROVAL_UNAVAILABLE",
    message: "Brand initialization approval is unavailable",
  });
  const g = setup();
  g.state.approval = { ...g.signed(), extra: true };
  await expect(g.complete()).rejects.toThrow();
});
it.each(["approval", "trust"] as const)(
  "refuses original deadline consumed while awaiting %s material",
  async (field) => {
    const f = setup();
    if (field === "approval")
      f.state.beforeApproval = async () => {
        f.state.now = after(5000);
      };
    else
      f.state.beforeTrust = async () => {
        f.state.now = after(5000);
      };
    let called = false;
    await expect(
      f.complete(async () => {
        called = true;
      }),
    ).rejects.toThrow();
    expect(called).toBe(false);
  },
);
it("keeps captured expected scalars detached from caller mutation and invokes the callback once", async () => {
  const f = setup(),
    expected = { ...f.expected };
  let called = 0;
  await f.source.withApproval(expected, async (lease) => {
    called++;
    expected.brandReference = id(99);
    await lease.assertCurrent();
    lease.assertFinalized();
  });
  expect(called).toBe(1);
});
it("poisons malformed initial expected input instead of reopening a source", async () => {
  const f = setup();
  await expect(
    f.source.withApproval({ ...f.expected, allow: true }, async () => true),
  ).rejects.toThrow();
  await expect(f.complete()).rejects.toThrow();
  expect(f.state.reads).toBe(0);
});
it("rejects initial option and clock getters before invoking them", () => {
  for (const field of ["clock", "readApproval", "readTrust", "now"] as const) {
    const f = setup();
    let touched = false;
    const target = field === "now" ? f.options.clock : f.options;
    Object.defineProperty(target, field, {
      enumerable: true,
      get() {
        touched = true;
        throw new Error("must not invoke getter");
      },
    });
    expect(() => createSignedBrandProvisioningApprovalSource(f.options)).toThrow(
      BrandProvisioningApprovalError,
    );
    expect(touched).toBe(false);
  }
});
it("does not invoke a replacement option getter during current guard validation", async () => {
  const f = setup();
  let touched = false;
  await expect(
    f.complete(async () => {
      Object.defineProperty(f.options, "readTrust", {
        enumerable: true,
        get() {
          touched = true;
          throw new Error("must not invoke");
        },
      });
    }),
  ).rejects.toThrow();
  expect(touched).toBe(false);
});

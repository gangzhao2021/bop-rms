import { describe, expect, it } from "vitest";

import { paymentProviderAdmissionKillSwitchKey, verifyPaymentProviderAdmission } from "../index.js";

const id = (n: number) => `0198a008-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const refs = { brand: id(1), store: id(2), otherBrand: id(3), otherStore: id(4), control: id(5) };
const at = "2026-08-08T15:00:00.000Z";

interface EvaluationOptions {
  readonly key?: string;
  readonly kind?: "KillSwitch" | "ReleaseFlag";
  readonly version?: number;
  readonly scopeKind?: "Brand" | "Store";
  readonly brandReference?: string;
  readonly storeReference?: string | null;
  readonly backendExecution?: "Allow" | "Deny";
  readonly frontendVisibility?: "Show" | "Hide";
  readonly reason?:
    | "KILL_INACTIVE"
    | "KILL_ACTIVE"
    | "KILL_RECOVERY_ALLOWED"
    | "KILL_RECOVERY_BLOCKED"
    | "RELEASE_ENABLED"
    | "CONTROL_UNAVAILABLE";
  readonly killMode?: "BlockNew" | "SafePause" | "Terminate" | null;
  readonly inFlightPolicy?: "AllowToComplete" | "ReachSafeCheckpoint" | "CompensateAndStop" | null;
  readonly evaluatedAt?: string;
  readonly recordVersion?: number;
}

function evaluation(options: EvaluationOptions = {}) {
  const kind = options.kind ?? "KillSwitch";
  const reason = options.reason ?? "KILL_INACTIVE";
  const backendExecution = options.backendExecution ?? "Allow";
  const frontendVisibility = options.frontendVisibility ?? "Show";
  const killMode = options.killMode === undefined ? "BlockNew" : options.killMode;
  const inFlightPolicy =
    options.inFlightPolicy === undefined ? "AllowToComplete" : options.inFlightPolicy;
  const scopeKind = options.scopeKind ?? "Store";
  const version = options.version ?? 1;
  const scope = Object.freeze({
    kind: scopeKind,
    brandReference: options.brandReference ?? refs.brand,
    storeReference:
      options.storeReference === undefined
        ? scopeKind === "Brand"
          ? null
          : refs.store
        : options.storeReference,
  });
  return Object.freeze({
    effectiveControl: Object.freeze({ controlId: refs.control, version, scope }),
    backendExecution,
    frontendVisibility,
    reason,
    killMode,
    inFlightPolicy,
    record: Object.freeze({
      key: options.key ?? paymentProviderAdmissionKillSwitchKey,
      kind,
      version: options.recordVersion ?? version,
      scopeKind,
      backendExecution,
      frontendVisibility,
      reason,
      killMode,
      evaluatedAt: options.evaluatedAt ?? at,
    }),
  });
}

function expected(overrides: Record<string, unknown> = {}) {
  return {
    action: "CreatePaymentIntent",
    brandReference: refs.brand,
    storeReference: refs.store,
    evaluatedAt: at,
    ...overrides,
  } as never;
}

describe("WP-1308 Payment provider admission Kill Switch", () => {
  it("accepts only exact inactive and progressive-recovery Feature Control decisions", () => {
    for (const candidate of [
      evaluation(),
      evaluation({
        reason: "KILL_RECOVERY_ALLOWED",
        killMode: "SafePause",
        inFlightPolicy: "ReachSafeCheckpoint",
      }),
      evaluation({ scopeKind: "Brand", storeReference: null }),
    ]) {
      const result = verifyPaymentProviderAdmission(candidate, expected());
      expect(result).toMatchObject({ action: "CreatePaymentIntent", result: "Allow" });
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result?.record)).toBe(true);
      expect(JSON.stringify(result)).not.toContain(refs.control);
      expect(JSON.stringify(result)).not.toContain(refs.brand);
      expect(JSON.stringify(result)).not.toContain(refs.store);
    }
  });

  it("denies every active mode and a recovery-blocked decision", () => {
    for (const killMode of ["BlockNew", "SafePause", "Terminate"] as const) {
      expect(
        verifyPaymentProviderAdmission(
          evaluation({
            backendExecution: "Deny",
            frontendVisibility: "Hide",
            reason: "KILL_ACTIVE",
            killMode,
          }),
          expected(),
        ),
      ).toBeNull();
    }
    expect(
      verifyPaymentProviderAdmission(
        evaluation({
          backendExecution: "Deny",
          frontendVisibility: "Hide",
          reason: "KILL_RECOVERY_BLOCKED",
        }),
        expected(),
      ),
    ).toBeNull();
  });

  it("fails closed for wrong kind, key, scope, time, version and frontend/backend disagreement", () => {
    const cases = [
      evaluation({
        kind: "ReleaseFlag",
        reason: "RELEASE_ENABLED",
        killMode: null,
        inFlightPolicy: null,
      }),
      evaluation({ key: "payment.provider.other" }),
      evaluation({ brandReference: refs.otherBrand }),
      evaluation({ storeReference: refs.otherStore }),
      evaluation({ evaluatedAt: "2026-08-08T15:00:01.000Z" }),
      evaluation({ recordVersion: 2 }),
      evaluation({ frontendVisibility: "Hide" }),
      evaluation({ backendExecution: "Deny", reason: "KILL_INACTIVE" }),
    ];
    for (const candidate of cases)
      expect(verifyPaymentProviderAdmission(candidate, expected())).toBeNull();
  });

  it("rejects unavailable, mutable, extra and accessor evidence without reading accessors", () => {
    const base = evaluation();
    const unavailable = Object.freeze({
      effectiveControl: null,
      backendExecution: "Deny",
      frontendVisibility: "Hide",
      reason: "CONTROL_UNAVAILABLE",
      killMode: null,
      inFlightPolicy: null,
      record: Object.freeze({
        key: paymentProviderAdmissionKillSwitchKey,
        kind: null,
        version: null,
        scopeKind: null,
        backendExecution: "Deny",
        frontendVisibility: "Hide",
        reason: "CONTROL_UNAVAILABLE",
        killMode: null,
        evaluatedAt: at,
      }),
    });
    expect(verifyPaymentProviderAdmission(unavailable, expected())).toBeNull();
    expect(verifyPaymentProviderAdmission({ ...base }, expected())).toBeNull();
    expect(
      verifyPaymentProviderAdmission(Object.freeze({ ...base, extra: true }), expected()),
    ).toBeNull();
    expect(
      verifyPaymentProviderAdmission(
        Object.freeze({ ...base, record: { ...base.record } }),
        expected(),
      ),
    ).toBeNull();

    let evaluated = false;
    const accessor = { ...base } as Record<string, unknown>;
    Object.defineProperty(accessor, "record", {
      enumerable: true,
      get() {
        evaluated = true;
        return base.record;
      },
    });
    Object.freeze(accessor);
    expect(verifyPaymentProviderAdmission(accessor, expected())).toBeNull();
    expect(evaluated).toBe(false);
  });
});

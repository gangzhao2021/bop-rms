import { t } from "./i18n/i18n.js";
import { useState, type ReactNode } from "react";
import { StepUpVerification } from "./StepUpVerification.js";

/** WP-2423 Q19 step 2: what a Brand gate says about the signed-in author approving alone. */
export interface SoleOperatorGateView {
  readonly status: "Effective" | "NotSet" | "OtherApprovers";
  readonly otherApprovers: readonly { readonly displayName: string | null }[];
  readonly verifiedUntil: string | null;
}
const statuses = new Set(["Effective", "NotSet", "OtherApprovers"]);
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
/** Strict read of the gate view a page query carries (null when not offered). */
export function parseSoleOperatorGate(value: unknown): SoleOperatorGateView | null {
  if (value === null || value === undefined) return null;
  const r = value as Record<string, unknown>;
  if (
    typeof value !== "object" ||
    Object.keys(r).sort().join(",") !== "otherApprovers,status,verifiedUntil" ||
    !statuses.has(String(r.status)) ||
    !Array.isArray(r.otherApprovers) ||
    r.otherApprovers.length > 100 ||
    (r.verifiedUntil !== null &&
      (typeof r.verifiedUntil !== "string" || !instantPattern.test(r.verifiedUntil)))
  )
    throw new Error("SOLE_OPERATOR_GATE_INVALID");
  return Object.freeze({
    status: r.status as SoleOperatorGateView["status"],
    otherApprovers: Object.freeze(
      r.otherApprovers.map((item: unknown) => {
        const name = (item as Record<string, unknown> | null)?.displayName;
        if (name !== null && (typeof name !== "string" || name.length > 80))
          throw new Error("SOLE_OPERATOR_GATE_INVALID");
        return Object.freeze({ displayName: name as string | null });
      }),
    ),
    verifiedUntil: r.verifiedUntil as string | null,
  });
}
/** "Mia", "Mia and Noah", "Mia, Noah and Sam". */
export function soleOperatorOtherNames(gate: SoleOperatorGateView): string {
  const names = gate.otherApprovers.map((p) => p.displayName ?? t("another staff member"));
  return names.length <= 1
    ? (names[0] ?? t("another staff member"))
    : names.slice(0, -1).join(", ") + " and " + names.at(-1);
}

/**
 * The author's own approval as sole operator: when in effect, a summary of what is being approved,
 * a second-factor check (valid 15 minutes) and an explicit confirmation before the action; when
 * not, why another person must approve (naming them). Authority is decided by the server.
 */
export function SoleOperatorSelfApproval({
  gate,
  csrf,
  summary,
  what,
  permissionName,
  actionLabel,
  busy,
  onApprove,
  fetcher,
  yourPart = t("You made this change"),
}: {
  readonly gate: SoleOperatorGateView | null;
  readonly csrf: string | undefined;
  /** What is being approved, in the staff member's words. */
  readonly summary: ReactNode;
  /** Lower-case noun for the confirmation, e.g. "these prices". */
  readonly what: string;
  /** e.g. "price approval". */
  readonly permissionName: string;
  readonly actionLabel: string;
  readonly busy: boolean;
  onApprove(): void;
  readonly fetcher?: typeof fetch | undefined;
  /**
   * Why the signed-in person cannot simply approve, in their words: "You made this change"
   * (default) or, for a second review, "You already gave the cost review".
   */
  readonly yourPart?: string;
}) {
  const [verifiedUntil, setVerifiedUntil] = useState<string | null>(gate?.verifiedUntil ?? null);
  const [confirmed, setConfirmed] = useState(false);
  if (gate === null || gate.status === "NotSet")
    return (
      <p>
        {t(
          "{yourPart}, so someone else who holds {permissionName} must approve it.{value}If you run this business on your own, the brand owner can turn on Sole operator in Store setup.",
          {
            yourPart: yourPart,
            permissionName: permissionName,
            value: gate === null ? " " : t(" Sole operator is off. "),
          },
        )}
      </p>
    );
  if (gate.status === "OtherApprovers")
    return (
      <p>
        {t(
          "Sole operator is on, but {gate} also {value} {permissionName}, so they must approve this.",
          {
            gate: soleOperatorOtherNames(gate),
            value: gate.otherApprovers.length === 1 ? t("holds") : t("hold"),
            permissionName: permissionName,
          },
        )}
      </p>
    );
  const verified = verifiedUntil !== null && Date.parse(verifiedUntil) > Date.now();
  return (
    <div className="sole-operator-confirm">
      <p>
        {t(
          "{yourPart} and you are the only person who holds {permissionName} (sole operator), so you may approve it yourself. Check it first:",
          { yourPart: yourPart, permissionName: permissionName },
        )}
      </p>
      {summary}
      <p>{t("It will be recorded as approved by you alone.")}</p>
      {csrf === undefined ? null : (
        <StepUpVerification
          purpose="SoleOperatorApproval"
          csrf={csrf}
          verifiedUntil={verifiedUntil}
          onVerified={setVerifiedUntil}
          loadServerStatus={false}
          label={t("Verify to approve on your own")}
          fetcher={fetcher}
        />
      )}
      <label>
        <input
          type="checkbox"
          checked={confirmed}
          disabled={busy}
          onChange={(event) => setConfirmed(event.currentTarget.checked)}
        />{" "}
        {t("I checked {what} and approve on my own", { what: what })}
      </label>{" "}
      <button
        type="button"
        data-variant="primary"
        disabled={busy || !confirmed || !verified}
        onClick={onApprove}
      >
        {actionLabel}
      </button>
    </div>
  );
}

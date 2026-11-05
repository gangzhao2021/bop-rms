import { t } from "./i18n/i18n.js";

/** The kitchen may well have begun by now, though nobody tapped Start. */
export const kitchenMayHaveStartedAfterMs = 3 * 60_000;

/**
 * DEC-KITCHEN-ONE-TAP: Start is optional, so "not started" only says nobody marked it. Staff taking a
 * dish back are warned, never blocked, once the kitchen has had it a while: ask before refunding food
 * that may already be in the pan.
 */
export function kitchenMayHaveStartedText(
  receivedAt: string | null | undefined,
  now: number,
): string | null {
  if (receivedAt === null || receivedAt === undefined) return null;
  const waited = now - Date.parse(receivedAt);
  if (!Number.isFinite(waited) || waited < kitchenMayHaveStartedAfterMs) return null;
  return t("The kitchen got this {minutes} min ago and may already be making it. Ask them first.", {
    minutes: Math.floor(waited / 60_000),
  });
}

export function KitchenMayHaveStartedNote({
  receivedAt,
}: {
  readonly receivedAt: string | null | undefined;
}) {
  const text = kitchenMayHaveStartedText(receivedAt, Date.now());
  return text === null ? null : (
    <p className="kitchen-may-have-started" role="note">
      {text}
    </p>
  );
}

import type { KitchenStepKind, KitchenStepReply } from "./kitchen-step-client.js";
import { KitchenStepClientError } from "./kitchen-step-client.js";

/** A tap waits this long before it is sent: undoing it sends nothing, so nothing changes anywhere. */
export const kitchenStepHoldMs = 5_000;
/** A lost answer or a busy server: the same body again, by itself, at these intervals. */
export const kitchenStepRetryDelaysMs = [3_000, 8_000, 20_000] as const;

export type KitchenTapPhase =
  /** Waiting out its hold; can still be undone. */
  | "Holding"
  /** Hold over, waiting its turn to be sent. */
  | "Waiting"
  | "Sending"
  /** Its answer was lost or the server was busy; the same body goes again on its own. */
  | "Retrying"
  /** Retries are used up, or the connection went: the cook decides. */
  | "Failed";

export interface KitchenTap<Target> {
  readonly id: number;
  readonly step: KitchenStepKind;
  readonly targets: readonly Target[];
  readonly phase: KitchenTapPhase;
}

export interface KitchenStepQueueOptions<Target> {
  /** Sends this tap's one immutable body; the same body each time it is sent. */
  send(tap: KitchenTap<Target>): Promise<KitchenStepReply>;
  /** Online, the board fresh, a named operator, the same session: checked again before each send. */
  authority(): boolean;
  onChange(taps: readonly KitchenTap<Target>[]): void;
  onConfirmed(tap: KitchenTap<Target>, reply: KitchenStepReply): void;
  /** The server refused the body outright: nothing was recorded and sending again cannot help. */
  onRefused(tap: KitchenTap<Target>, code: "PermissionDenied" | "Invalid"): void;
  /** Taps that were never sent went back to the cook. */
  onNotSent(taps: readonly KitchenTap<Target>[]): void;
  holdMs?: number;
  retryDelaysMs?: readonly number[];
}

/**
 * DEC-KITCHEN-ONE-TAP: what happens between a tap and the server. Each tap waits out a short hold
 * (undo sends nothing), then the bodies go one at a time in the order tapped. A lost answer blocks
 * only its own lines: it goes again by itself, and other taps keep going, because each step follows
 * current state under the ticket's lock. Handoff 87.11.1 / IDR-0039: nothing is ever sent later than
 * the connection allows; when authority goes, unsent taps return to the cook, never queued.
 */
export function createKitchenStepQueue<Target>(options: KitchenStepQueueOptions<Target>) {
  const holdMs = options.holdMs ?? kitchenStepHoldMs;
  const retryDelays = options.retryDelaysMs ?? kitchenStepRetryDelaysMs;
  interface Entry {
    tap: KitchenTap<Target>;
    attempts: number;
    timer: ReturnType<typeof setTimeout> | null;
  }
  let entries: Entry[] = [];
  let next = 1;
  let sending = false;
  let disposed = false;
  const emit = () => {
    if (!disposed) options.onChange(entries.map((entry) => entry.tap));
  };
  const setPhase = (entry: Entry, phase: KitchenTapPhase) => {
    entry.tap = Object.freeze({ ...entry.tap, phase });
  };
  const remove = (entry: Entry) => {
    if (entry.timer !== null) clearTimeout(entry.timer);
    entries = entries.filter((candidate) => candidate !== entry);
  };
  const pump = () => {
    if (sending || disposed) return;
    const entry = entries.find((candidate) => candidate.tap.phase === "Waiting");
    if (entry === undefined) return;
    if (!options.authority()) {
      authorityLost();
      return;
    }
    sending = true;
    setPhase(entry, "Sending");
    emit();
    void options
      .send(entry.tap)
      .then((reply) => {
        sending = false;
        if (disposed) return;
        remove(entry);
        options.onConfirmed(entry.tap, reply);
        emit();
        pump();
      })
      .catch((error: unknown) => {
        sending = false;
        if (disposed) return;
        const code = error instanceof KitchenStepClientError ? error.code : "OutcomeUnknown";
        if (code === "PermissionDenied" || code === "Invalid") {
          remove(entry);
          options.onRefused(entry.tap, code);
        } else {
          const delay = retryDelays[entry.attempts];
          entry.attempts += 1;
          if (delay === undefined || !options.authority()) setPhase(entry, "Failed");
          else {
            setPhase(entry, "Retrying");
            entry.timer = setTimeout(() => {
              entry.timer = null;
              if (options.authority()) setPhase(entry, "Waiting");
              else setPhase(entry, "Failed");
              emit();
              pump();
            }, delay);
          }
        }
        emit();
        pump();
      });
  };
  /** The connection or authority went: unsent taps go back; what may have been sent stays open. */
  function authorityLost() {
    const unsent = entries.filter(
      (entry) => entry.tap.phase === "Holding" || entry.tap.phase === "Waiting",
    );
    for (const entry of unsent) remove(entry);
    for (const entry of entries)
      if (entry.tap.phase === "Retrying") {
        if (entry.timer !== null) clearTimeout(entry.timer);
        entry.timer = null;
        setPhase(entry, "Failed");
      }
    if (unsent.length > 0) options.onNotSent(unsent.map((entry) => entry.tap));
    emit();
  }
  return Object.freeze({
    /** A tap: held, then sent. Returns its id. */
    tap(step: KitchenStepKind, targets: readonly Target[]): number {
      const id = next;
      next += 1;
      const entry: Entry = {
        tap: Object.freeze({ id, step, targets, phase: "Holding" as const }),
        attempts: 0,
        timer: null,
      };
      entry.timer = setTimeout(() => {
        entry.timer = null;
        if (!options.authority()) {
          authorityLost();
          return;
        }
        setPhase(entry, "Waiting");
        emit();
        pump();
      }, holdMs);
      entries = [...entries, entry];
      emit();
      return id;
    },
    /** Within the hold: nothing was sent, so nothing is recorded and nobody is told anything. */
    undo(id: number): boolean {
      const entry = entries.find((candidate) => candidate.tap.id === id);
      if (entry === undefined || entry.tap.phase !== "Holding") return false;
      remove(entry);
      emit();
      return true;
    },
    /** The same body again, when the cook asks for it. */
    retry(id: number) {
      const entry = entries.find((candidate) => candidate.tap.id === id);
      if (entry === undefined || entry.tap.phase !== "Failed" || !options.authority()) return;
      entry.attempts = retryDelays.length;
      setPhase(entry, "Waiting");
      emit();
      pump();
    },
    /** The cook gives up on a tap whose answer never came: the board shows what it reads next. */
    dismiss(id: number) {
      const entry = entries.find((candidate) => candidate.tap.id === id);
      if (entry === undefined || entry.tap.phase !== "Failed") return;
      remove(entry);
      emit();
    },
    authorityLost,
    dispose() {
      disposed = true;
      for (const entry of entries) if (entry.timer !== null) clearTimeout(entry.timer);
      entries = [];
    },
  });
}

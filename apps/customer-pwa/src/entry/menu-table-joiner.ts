import {
  admissionStateForFailure,
  type DiningAdmissionUi,
} from "../dining/DiningAdmissionPanel.js";
import type { GuestTableStartAnswer } from "../session/customer-transaction-context.js";

/**
 * WP-2423 M115: the join a guest's tap on Add runs from the menu of an open table they have not
 * joined (the same QR join as the entry page's panel). One join intent per table: when an answer
 * did not come back the next tap resumes that same join (the server replays it by its operation,
 * and the journey only resumes its own), never a second join with a new operation, which the
 * server would refuse as a repeat from this guest. Only a definitive refusal (it joined nothing)
 * ends the intent, so the next tap is a new one.
 */
export function createMenuTableJoiner(
  admission: DiningAdmissionUi,
  onJoined: () => void,
): () => Promise<GuestTableStartAnswer> {
  let pending: string | null = null;
  return async () => {
    try {
      const resume = pending !== null;
      const operationReference = pending ?? admission.generateOperationReference();
      pending = operationReference;
      const result = resume
        ? await admission.journey.resume({ operationReference })
        : await admission.journey.start({ operationReference, joinCredential: null });
      if (
        result === null ||
        typeof result !== "object" ||
        (result as { status?: unknown }).status !== "Bound"
      )
        return "Refused";
    } catch (error) {
      const state = admissionStateForFailure(error);
      if (state !== "Unknown") pending = null;
      return state === "TableInUse" ? "InUse" : "Refused";
    }
    pending = null;
    onJoined();
    return "Started";
  };
}

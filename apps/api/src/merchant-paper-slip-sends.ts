/**
 * DEC-PAPER-SEND-IDEMPOTENT (b11 review): paper sends carrying the same slip reference are run one
 * after another in this process (check, place and record), so two tablets sending the same slip at
 * once never both pass the check and both place an order: the second one is refused before it
 * places anything. Across processes the payment record's own slip lock still records it once,
 * and the counter then names the order placed without its payment. An earlier send is waited for
 * at most `paperSlipSendWaitMs`.
 */
const paperSlipSends = new Map<string, Promise<void>>();
const paperSlipSendWaitMs = 15_000;
export function onePaperSlipSendAtATime(
  slipReference: string | null,
  work: () => Promise<void>,
): Promise<void> {
  const key = slipReference?.replace(/\s+/gu, "").toUpperCase() ?? "";
  if (key === "") return work();
  const earlier = paperSlipSends.get(key);
  const waited =
    earlier === undefined
      ? Promise.resolve()
      : Promise.race([
          earlier,
          new Promise<void>((resolve) => setTimeout(resolve, paperSlipSendWaitMs).unref?.()),
        ]);
  const run = waited.then(work);
  // Only the order of the sends is kept here; each send answers its own failure.
  const settled = run.catch((error: unknown) => void error);
  paperSlipSends.set(key, settled);
  void settled.then(() => {
    if (paperSlipSends.get(key) === settled) paperSlipSends.delete(key);
  });
  return run;
}

import { canonicalizeRfc8785 } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import {
  parseWorkforceOnboardingPlan,
  parseWorkforceOnboardingPlanExpected,
  hashWorkforceOnboardingPlan,
  workforceOnboardingPlanUnavailable as unavailable,
  type WorkforceOnboardingPlan,
} from "../contracts/workforce-onboarding-plan.js";
import {
  configuredPrivateApprovalPath,
  readPrivateApprovalJson,
} from "./read-private-approval-json.js";

export interface WorkforceOnboardingPlanFileSource {
  read(
    expected: unknown,
  ): Promise<{ readonly plan: WorkforceOnboardingPlan; readonly planDigest: string }>;
}
/** A configured static-content source, never authentication or signature proof.
 * The actual transaction owner must re-read it in its asynchronous final guard;
 * this source supplies no renewed execution lease or post-COMMIT clock read. */
export function createFileWorkforceOnboardingPlanSource(options: {
  readonly planPath: string;
}): WorkforceOnboardingPlanFileSource {
  const r = readClosedRecord(options, ["planPath"]),
    planPath = configuredPrivateApprovalPath(r.planPath, unavailable);
  let busy = false,
    poisoned = false,
    expectedPin: string | undefined,
    contentPin: string | undefined;
  const fail = (): never => {
    poisoned = true;
    return unavailable();
  };
  const check = () => {
    if (poisoned) return fail();
    const current = readClosedRecord(options, ["planPath"]);
    if (current.planPath !== planPath) return fail();
  };
  return Object.freeze({
    async read(value: unknown) {
      if (busy) return fail();
      busy = true;
      try {
        check();
        const expected = parseWorkforceOnboardingPlanExpected(value),
          pin = canonicalizeRfc8785(expected);
        if (expectedPin !== undefined && expectedPin !== pin) return fail();
        expectedPin = pin;
        const plan = parseWorkforceOnboardingPlan(await readPrivateApprovalJson(planPath, fail));
        check();
        const actual = parseWorkforceOnboardingPlanExpected({
          configuration: plan.configuration,
          environmentReference: plan.environmentReference,
          operationReference: plan.operationReference,
          brandReference: plan.brandReference,
          actorReference: plan.actorReference,
          membershipReference: plan.membershipReference,
          operatorReference: plan.operatorReference,
        });
        if (canonicalizeRfc8785(actual) !== pin) return fail();
        const content = canonicalizeRfc8785(plan);
        if (contentPin !== undefined && contentPin !== content) return fail();
        contentPin = content;
        return Object.freeze({ plan, planDigest: hashWorkforceOnboardingPlan(plan) });
      } catch {
        return fail();
      } finally {
        busy = false;
      }
    },
  });
}

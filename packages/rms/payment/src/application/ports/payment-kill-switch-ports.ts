import type { FeatureControlEvaluation } from "@bop/feature-control";

import {
  paymentProviderAdmissionKillSwitchKey,
  type PaymentProviderAdmissionExpectation,
} from "../payment-kill-switch.js";

export interface PaymentKillSwitchEvaluationInput extends PaymentProviderAdmissionExpectation {
  readonly key: typeof paymentProviderAdmissionKillSwitchKey;
}

export interface PaymentKillSwitchPort {
  evaluate(input: PaymentKillSwitchEvaluationInput): Promise<FeatureControlEvaluation>;
}

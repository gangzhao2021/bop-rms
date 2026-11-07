import {
  createCognitoSubjectStatus,
  type CognitoSubjectStatusOptions,
} from "./cognito-subject-status.js";

export type CognitoPlatformSubjectStatusOptions = CognitoSubjectStatusOptions;

/** Compatible Platform entry point; the private kernel observes Provider
 * account status only and never chooses an Identity account kind. */
export function createCognitoPlatformSubjectStatus(options: CognitoPlatformSubjectStatusOptions) {
  return createCognitoSubjectStatus(options);
}

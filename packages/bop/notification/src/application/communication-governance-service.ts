import type {
  CommunicationHistoryProjection,
  CommunicationHistoryQuery,
  CommunicationTemplateProjection,
  CommunicationTemplateQuery,
} from "../contracts/communication-governance.js";
import { NotificationServiceError } from "./notification-service.js";
export interface CommunicationGovernancePorts {
  readonly authorize: {
    check(input: CommunicationHistoryQuery | CommunicationTemplateQuery): Promise<{
      authorized: boolean;
      mayResendOperational: boolean;
      mayManageSuppression: boolean;
      mayEdit: boolean;
      mayApprove: boolean;
      mayTest: boolean;
    } | null>;
  };
  readonly projections: {
    history(query: CommunicationHistoryQuery): Promise<CommunicationHistoryProjection>;
    templates(query: CommunicationTemplateQuery): Promise<CommunicationTemplateProjection>;
  };
}
const fail = (): never => {
  throw new NotificationServiceError("NOTIFICATION_EVIDENCE_DENIED");
};
export async function queryCommunicationHistory(
  query: CommunicationHistoryQuery,
  ports: CommunicationGovernancePorts,
): Promise<CommunicationHistoryProjection> {
  const access = await ports.authorize.check(query);
  if (!access?.authorized) fail();
  const granted = access as NonNullable<typeof access>,
    result = await ports.projections.history(query);
  if (
    result.projectionName !== "notification_communication_history_v1" ||
    result.projectionVersion !== 1 ||
    result.brandReference !== query.brandReference
  )
    fail();
  return Object.freeze({
    ...result,
    permissions: Object.freeze({
      mayResendOperational: granted.mayResendOperational,
      mayManageSuppression: granted.mayManageSuppression,
    }),
  });
}
export async function queryCommunicationTemplates(
  query: CommunicationTemplateQuery,
  ports: CommunicationGovernancePorts,
): Promise<CommunicationTemplateProjection> {
  const access = await ports.authorize.check(query);
  if (!access?.authorized) fail();
  const granted = access as NonNullable<typeof access>,
    result = await ports.projections.templates(query);
  if (
    result.projectionName !== "notification_template_admin_v1" ||
    result.projectionVersion !== 1 ||
    result.brandReference !== query.brandReference
  )
    fail();
  return Object.freeze({
    ...result,
    permissions: Object.freeze({
      mayEdit: granted.mayEdit,
      mayApprove: granted.mayApprove,
      mayTest: granted.mayTest,
    }),
  });
}

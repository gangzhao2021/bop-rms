import type {
  DeliveryDetailProjection,
  DeliveryDetailQuery,
} from "../contracts/delivery-detail.js";
import { reviseDeliverySnapshot, type DeliveryDetail } from "../domain/delivery-detail.js";
import { DeliveryTaskError, type DeliveryReference } from "../domain/delivery-task.js";
import type {
  DeliveryDetailAuditPort,
  DeliveryDetailProjectionPort,
  DeliveryDetailRepository,
} from "./ports/delivery-detail-ports.js";
export class DeliveryDetailService {
  constructor(
    private readonly repository: DeliveryDetailRepository,
    private readonly projection: DeliveryDetailProjectionPort,
    private readonly audit: DeliveryDetailAuditPort,
  ) {}
  async load(query: DeliveryDetailQuery): Promise<DeliveryDetailProjection> {
    const result = await this.projection.load(query);
    if (!result) throw new DeliveryTaskError("INVALID");
    return result;
  }
  async revise(
    taskReference: DeliveryReference,
    input: Parameters<typeof reviseDeliverySnapshot>[1],
  ): Promise<DeliveryDetail> {
    const current = await this.repository.load(taskReference);
    if (!current) throw new DeliveryTaskError("INVALID");
    const revised = reviseDeliverySnapshot(current, input);
    await this.repository.append(revised, input.expectedVersion);
    await this.audit.append({
      taskReference,
      actorReference: input.actorReference as DeliveryReference,
      outcome: revised.revisions.at(-1)?.outcome ?? "Rejected",
    });
    return revised;
  }
}

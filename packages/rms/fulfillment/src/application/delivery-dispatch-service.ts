import type {
  CreateDeliveryTaskCommand,
  DeliveryDispatchProjection,
  DeliveryDispatchQuery,
} from "../contracts/delivery-dispatch.js";
import { createDeliveryTask, DeliveryTaskError } from "../domain/delivery-task.js";
import type { DeliveryDispatchPorts } from "./ports/delivery-dispatch-ports.js";
const fail = (code: DeliveryTaskError["code"] = "INVALID"): never => {
  throw new DeliveryTaskError(code);
};
export async function createDeliveryTaskService(
  command: CreateDeliveryTaskCommand,
  ports: DeliveryDispatchPorts,
) {
  if (
    command.purpose !== "DeliveryTaskCreation" ||
    command.permission !== "fulfillment.delivery.create"
  )
    fail();
  const access = await ports.authorization.authorize(command);
  if (!access?.authorized) fail();
  const intentHash = ports.references.hashIntent(JSON.stringify(command)),
    replay = await ports.repository.resolveOperation(command.operationReference);
  if (replay) {
    if (!ports.references.equals(replay.intentHash, intentHash)) fail("CONFLICT");
    return Object.freeze({ ...replay, outcome: "AlreadyCreated" as const });
  }
  const source = await ports.fulfillmentSource.resolve(command),
    task = createDeliveryTask({
      ...command,
      orderReference: source.orderReference,
      fulfillmentType: source.fulfillmentType,
      fulfillmentStatus: source.fulfillmentStatus,
      addressSnapshotReference: source.addressSnapshotReference,
      confirmedWindowReference: source.confirmedWindowReference,
      capacityAllocationReference: source.capacityAllocationReference,
      requirementsReference: source.requirementsReference,
    });
  return ports.repository.create(
    Object.freeze({
      operationReference: command.operationReference,
      intentHash,
      command,
      task,
      auditReference: await ports.audit.create(command),
      outcome: "Created" as const,
    }),
  );
}
export async function queryDeliveryDispatch(
  query: DeliveryDispatchQuery,
  ports: DeliveryDispatchPorts,
): Promise<DeliveryDispatchProjection> {
  const access = await ports.authorization.authorize(query);
  if (!access?.authorized) fail();
  const granted = access as NonNullable<typeof access>,
    result = await ports.projections.queue(query);
  if (
    result.projectionName !== "delivery_task_queue_v1" ||
    result.projectionVersion !== 1 ||
    result.tenantReference !== query.tenantReference ||
    result.brandReference !== query.brandReference ||
    result.storeReference !== query.storeReference
  )
    fail();
  return Object.freeze({
    ...result,
    permissions: Object.freeze({
      mayAssign: granted.mayAssign,
      mayAccept: granted.mayAccept,
      mayStart: granted.mayStart,
      mayReassign: granted.mayReassign,
      mayOpenException: granted.mayOpenException,
    }),
  });
}

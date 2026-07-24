import {
  consumeEventInTransaction,
  type ConsumerOutcome,
  type ConsumerRegistry,
  type ConsumerTransaction,
  ConsumerTransactionRollback,
  type DomainEventEnvelope,
} from "@bop/eventing";

export interface ConsumerDeliveryPort {
  transaction<T>(
    scope: { readonly brandId: string; readonly storeId?: string },
    work: (transaction: ConsumerTransaction) => Promise<T>,
  ): Promise<T>;
}
export class ConsumerDeliveryWorker {
  constructor(
    private readonly dependencies: {
      readonly database: ConsumerDeliveryPort;
      readonly registry: ConsumerRegistry;
    },
  ) {}
  async deliver(consumerName: string, envelope: DomainEventEnvelope): Promise<ConsumerOutcome> {
    const resolved = this.dependencies.registry.resolve(consumerName, envelope);
    if ("errorCode" in resolved) return { status: "rejected", errorCode: resolved.errorCode };
    try {
      return await this.dependencies.database.transaction(
        { brandId: envelope.tenantId, ...(envelope.storeId ? { storeId: envelope.storeId } : {}) },
        async (transaction) =>
          await consumeEventInTransaction(transaction, resolved.registration, envelope),
      );
    } catch (error) {
      if (error instanceof ConsumerTransactionRollback) return error.outcome;
      throw error;
    }
  }
}

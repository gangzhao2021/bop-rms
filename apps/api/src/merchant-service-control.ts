import { createMerchantServicePauseProof } from "./merchant-service-pause-proof.js";
import {
  appendAuditRecordInTransaction,
  canonicalizeRfc8785,
  sha256Hex,
  type AppendAuditRecordInput,
} from "@bop/audit";
import {
  createPostgresCurrentStorePublicationProof,
  createPostgresStoreServiceControl,
  createPostgresStoreServiceControlState,
  createPostgresStoreBusinessDateSource,
} from "@rms/store";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import type { MerchantBffService } from "./merchant-bff.js";

export function createMerchantServiceControl(options: {
  readonly persistence: PersistentMerchantBffOptions;
  readonly authentication: Pick<MerchantBffService, "authorize">;
  readonly audit: Pick<
    AppendAuditRecordInput,
    "reasonCode" | "retentionPolicyCode" | "retentionPolicyVersion"
  >;
}) {
  const source = options.persistence;
  const resolveScope = createMerchantStoreScope(source);
  const write = async (input: { sessionCookie: unknown; csrf: unknown; command: unknown }) => {
    const authorized = await options.authentication.authorize(input);
    const body = input.command;
    const keys = [
      "command",
      "operationReference",
      "configurationReference",
      "expectedVersion",
      "auditReference",
      "content",
    ];
    if (
      !body ||
      typeof body !== "object" ||
      Object.getPrototypeOf(body) !== Object.prototype ||
      Reflect.ownKeys(body).length !== keys.length ||
      keys.some(
        (key) =>
          !Object.getOwnPropertyDescriptor(body, key)?.enumerable ||
          !("value" in (Object.getOwnPropertyDescriptor(body, key) ?? {})),
      )
    )
      throw new Error("STORE_SERVICE_COMMAND_INVALID");
    const request = body as Record<string, unknown>;
    if (request.command !== "PauseService" && request.command !== "ResumeService")
      throw new Error("STORE_SERVICE_COMMAND_INVALID");
    return source.transactions.run(async (tx) => {
      const { selected, context, store, actorReference, allowed } = await resolveScope(
        tx,
        input.sessionCookie,
        request.command === "PauseService" ? "store.service.pause" : "store.service.resume",
        authorized.sessionReference,
      );
      const digest = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
      return createPostgresStoreServiceControl({
        brandReference: context.brand.brandReference,
        storeReference: store.storeReference,
        now: source.now,
        run: async (work) => work(tx),
        authorize: allowed,
        currentConfiguration: async (transaction, reference, at) =>
          (
            await createPostgresCurrentStorePublicationProof({
              ...source.publication,
              tenantReference: selected.tenantReference,
              brandReference: context.brand.brandReference,
              storeReference: store.storeReference,
              configurationReference: reference,
              authorize: allowed,
              hashContent: digest,
            })(transaction, at)
          ).configuration,
        hashIntent: (command) =>
          digest({
            brandReference: context.brand.brandReference,
            storeReference: store.storeReference,
            ...command,
          }),
        appendAudit: async (transaction, event) => {
          await appendAuditRecordInTransaction(transaction, {
            ...options.audit,
            auditId: event.command.auditReference,
            afterSummary: {
              intentDigest: digest({
                brandReference: context.brand.brandReference,
                storeReference: store.storeReference,
                ...event.command,
              }),
              expectedVersion: event.command.expectedVersion,
              resultingVersion: event.resultingVersion,
            },
            brandId: context.brand.brandReference,
            storeId: store.storeReference,
            actor: { type: "User", reference: actorReference },
            actionCode:
              event.command.command === "PauseService"
                ? "STORE_SERVICE_PAUSED"
                : "STORE_SERVICE_RESUMED",
            targetType: "StoreServiceControl",
            targetId: event.command.operationReference,
            correlationId: event.command.operationReference,
            occurredAt: event.occurredAt,
            sourceChannel: "MERCHANT_WEB",
            dataClassification: "Internal",
          });
        },
      })({ ...request, actorReference, purposeCode: "STORE_SERVICE" });
    });
  };
  const read = async (sessionCookie: unknown) =>
    source.transactions.run(async (tx) => {
      const { selected, context, store, allowed } = await resolveScope(
        tx,
        sessionCookie,
        "store.service.read",
      );
      const at = context.resolvedAt;
      let published:
        | Awaited<ReturnType<ReturnType<typeof createPostgresCurrentStorePublicationProof>>>
        | undefined;
      await createPostgresStoreBusinessDateSource({
        brandReference: context.brand.brandReference,
        storeReference: store.storeReference,
        timeZone: store.timeZone,
        authorize: allowed,
        publicationProof: async (transaction, candidate, observedAt) => {
          published = await createPostgresCurrentStorePublicationProof({
            ...source.publication,
            tenantReference: selected.tenantReference,
            brandReference: context.brand.brandReference,
            storeReference: store.storeReference,
            configurationReference: candidate.configurationReference,
            authorize: allowed,
            hashContent: (value) => "sha256:" + sha256Hex(canonicalizeRfc8785(value)),
          })(transaction, observedAt);
          return {
            contentDigest: published.contentDigest,
            businessDayStartSource: published.businessDayStartSource,
          };
        },
      })(tx, at);
      if (!published) throw new Error("STORE_SERVICE_CONFIGURATION_UNAVAILABLE");
      const state = await createPostgresStoreServiceControlState({
        brandReference: context.brand.brandReference,
        storeReference: store.storeReference,
        authorize: allowed,
        verifyOperation: createMerchantServicePauseProof({
          brandReference: context.brand.brandReference,
          storeReference: store.storeReference,
          authorize: allowed,
        }),
      })(tx, at);
      return Object.freeze({
        screenId: "STORE-HOURS-SERVICE" as const,
        storeReference: store.storeReference,
        configurationReference: published.configuration.configurationReference,
        enabledServiceModes: published.configuration.enabledServiceModes,
        timeZone: store.timeZone,
        hours: Object.freeze({
          configurationSource: published.configuration.source,
          effectiveFrom: published.configuration.effectiveFrom,
          effectiveUntil: published.configuration.effectiveUntil,
          businessDayStartLocalTime: published.configuration.businessDayStartLocalTime,
          weeklySchedule: published.configuration.weeklySchedule,
          exceptions: published.configuration.exceptions,
        }),
        ...state,
      });
    });
  return Object.assign(write, { read });
}

import { appendPlatformAuditRecordInTransaction, canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  BrowserSessionError,
  createPostgresCurrentPlatformBrowserSessionSource,
  parseCanonicalInstant,
  parseRawBrowserCredential,
  type PlatformBrowserSessionService,
} from "@bop/identity";
import { createPostgresPlatformPermissionSource, PlatformPermissionError } from "@bop/permission";
import {
  createPostgresPlatformPublishingStore,
  parsePlatformPublishingRequest,
  parsePlatformPublishingSourceScope,
  parsePublishingReference,
  parsePublishingDigest,
  parsePublishingVersion,
} from "@bop/publishing";
import {
  PlatformBrandTemplateError,
  copyPlatformBrandTemplateValue,
  createPostgresPlatformBrandTemplateStore,
  parsePlatformBrandTemplateContent,
  parsePlatformBrandTemplateListRequest,
} from "@bop/tenant";

type SessionOptions = Parameters<typeof createPostgresCurrentPlatformBrowserSessionSource>[0];
type PublishingOptions = Parameters<typeof createPostgresPlatformPublishingStore>[0];
export interface PlatformTemplateAdministrationOptions {
  readonly authentication: Pick<PlatformBrowserSessionService, "authorize">;
  readonly persistence: SessionOptions & {
    readonly transactions: {
      run<T>(work: (tx: PublishingOptions["transaction"]) => Promise<T>): Promise<T>;
    };
  };
  readonly registerBeforeCommit: (
    tx: PublishingOptions["transaction"],
    guard: () => Promise<void>,
    final: () => void,
  ) => Promise<void> | void;
  readonly nextReference: () => string;
}
const invalid = (): never => {
  throw new PlatformBrandTemplateError("PLATFORM_TEMPLATE_INPUT_INVALID");
};
const denied = (): never => {
  throw new BrowserSessionError("BROWSER_SESSION_DENIED");
};
const unavailable = (): never => {
  throw new PlatformBrandTemplateError("PLATFORM_TEMPLATE_DEPENDENCY_UNAVAILABLE");
};
function closed(value: unknown, keys: readonly string[]) {
  const r = copyPlatformBrandTemplateValue(value);
  if (
    !r ||
    typeof r !== "object" ||
    Array.isArray(r) ||
    Reflect.ownKeys(r).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(r, k))
  )
    return invalid();
  return r as Record<string, unknown>;
}
function integer(value: unknown, max = 2147483647) {
  const n = parsePublishingVersion(value);
  if (n > max) return invalid();
  return n;
}
function action(value: unknown) {
  const r = copyPlatformBrandTemplateValue(value);
  if (!r || typeof r !== "object" || Array.isArray(r)) return invalid();
  return (r as Record<string, unknown>).action;
}
export function parsePlatformTemplateAdministrationQuery(value: unknown) {
  const a = action(value);
  switch (a) {
    case "Actions": {
      closed(value, ["action"]);
      return Object.freeze({ action: a });
    }
    case "List": {
      const r = closed(value, ["action", "after", "limit"]);
      return Object.freeze({
        action: a,
        ...parsePlatformBrandTemplateListRequest({ after: r.after, limit: r.limit }),
      });
    }
    case "Current": {
      const r = closed(value, ["action", "templateReference"]);
      return Object.freeze({
        action: a,
        templateReference: parsePublishingReference(r.templateReference),
      });
    }
    case "Exact": {
      const r = closed(value, ["action", "templateVersionReference"]);
      return Object.freeze({
        action: a,
        templateVersionReference: parsePublishingReference(r.templateVersionReference),
      });
    }
    case "History": {
      const r = closed(value, ["action", "templateReference", "beforeRevision"]);
      return Object.freeze({
        action: a,
        templateReference: parsePublishingReference(r.templateReference),
        beforeRevision: r.beforeRevision === null ? null : integer(r.beforeRevision),
      });
    }
    case "PublicationCurrent": {
      const r = closed(value, ["action", "templateReference", "lifecycleReference"]);
      return Object.freeze({
        action: a,
        templateReference: parsePublishingReference(r.templateReference),
        lifecycleReference:
          r.lifecycleReference === null ? null : parsePublishingReference(r.lifecycleReference),
      });
    }
    case "PublicationExact": {
      const r = closed(value, ["action", "templateReference", "sequence"]);
      return Object.freeze({
        action: a,
        templateReference: parsePublishingReference(r.templateReference),
        sequence: integer(r.sequence),
      });
    }
    case "PublicationHistory": {
      const r = closed(value, ["action", "templateReference", "beforeSequence"]);
      return Object.freeze({
        action: a,
        templateReference: parsePublishingReference(r.templateReference),
        beforeSequence: r.beforeSequence === null ? null : integer(r.beforeSequence),
      });
    }
    default:
      return invalid();
  }
}
export function parsePlatformTemplateAdministrationCommand(value: unknown) {
  const a = action(value);
  switch (a) {
    case "Save": {
      const r = closed(value, [
        "action",
        "operationReference",
        "templateReference",
        "expectedHead",
        "content",
      ]);
      const h =
        r.expectedHead === null
          ? null
          : closed(r.expectedHead, ["revision", "templateVersionReference", "sourceDigest"]);
      const expectedHead =
        h === null
          ? null
          : Object.freeze({
              revision: integer(h.revision, 2147483646),
              templateVersionReference: parsePublishingReference(h.templateVersionReference),
              sourceDigest: parsePublishingDigest(h.sourceDigest),
            });
      const templateReference =
        r.templateReference === null ? null : parsePublishingReference(r.templateReference);
      if ((templateReference === null) !== (expectedHead === null)) return invalid();
      return Object.freeze({
        action: a,
        operationReference: parsePublishingReference(r.operationReference),
        templateReference,
        expectedHead,
        content: parsePlatformBrandTemplateContent(r.content),
      });
    }
    case "ResolveSave":
    case "ResolvePublication": {
      const r = closed(value, ["action", "operationReference", "intentDigest"]);
      return Object.freeze({
        action: a,
        operationReference: parsePublishingReference(r.operationReference),
        intentDigest: parsePublishingDigest(r.intentDigest),
      });
    }
    case "Publication": {
      const r = closed(value, ["action", "request"]);
      return Object.freeze({ action: a, request: parsePlatformPublishingRequest(r.request) });
    }
    default:
      return invalid();
  }
}
export interface PlatformTemplateAdministration {
  query(input: {
    readonly sessionCookie: unknown;
    readonly csrf: unknown;
    readonly request: unknown;
  }): Promise<unknown>;
  command(input: {
    readonly sessionCookie: unknown;
    readonly csrf: unknown;
    readonly request: unknown;
  }): Promise<unknown>;
}
/** Thin composition on the actual Identity host; all business facts belong to public owners. */
export function createPlatformTemplateAdministration(
  options: PlatformTemplateAdministrationOptions,
): PlatformTemplateAdministration {
  const authentication = options.authentication,
    authorize = authentication.authorize;
  const persistence = options.persistence,
    transactions = persistence.transactions,
    run = transactions.run,
    now = persistence.now;
  const register = options.registerBeforeCommit,
    next = options.nextReference;
  const currentActor = persistence.currentActor,
    hasher = persistence.hasher,
    envelopes = persistence.envelopes;
  const hash = hasher.hash,
    equals = hasher.equals,
    encrypt = envelopes.encrypt,
    decrypt = envelopes.decrypt;
  const configuration = Object.freeze({
    environment: persistence.environment,
    issuer: persistence.issuer,
    clientId: persistence.clientId,
    redirectUri: persistence.redirectUri,
    allowedPostLoginPaths: Object.freeze([...persistence.allowedPostLoginPaths]),
  });
  const sessionSource = createPostgresCurrentPlatformBrowserSessionSource({
    ...configuration,
    now,
    currentActor,
    hasher,
    envelopes,
  });
  function ports() {
    if (
      options.authentication !== authentication ||
      authentication.authorize !== authorize ||
      options.persistence !== persistence ||
      persistence.transactions !== transactions ||
      transactions.run !== run ||
      persistence.now !== now ||
      options.registerBeforeCommit !== register ||
      options.nextReference !== next ||
      persistence.currentActor !== currentActor ||
      persistence.hasher !== hasher ||
      persistence.envelopes !== envelopes ||
      hasher.hash !== hash ||
      hasher.equals !== equals ||
      envelopes.encrypt !== encrypt ||
      envelopes.decrypt !== decrypt ||
      persistence.environment !== configuration.environment ||
      persistence.issuer !== configuration.issuer ||
      persistence.clientId !== configuration.clientId ||
      persistence.redirectUri !== configuration.redirectUri ||
      canonicalizeRfc8785(persistence.allowedPostLoginPaths) !==
        canonicalizeRfc8785(configuration.allowedPostLoginPaths)
    )
      return unavailable();
  }
  if (
    [authorize, run, now, register, next, currentActor, hash, equals, encrypt, decrypt].some(
      (p) => typeof p !== "function",
    )
  )
    return unavailable();
  async function execute(input: unknown, command: boolean): Promise<unknown> {
    ports();
    const r = closed(input, ["sessionCookie", "csrf", "request"]);
    const cookie = parseRawBrowserCredential(r.sessionCookie),
      csrf = parseRawBrowserCredential(r.csrf);
    const request = command
      ? parsePlatformTemplateAdministrationCommand(r.request)
      : parsePlatformTemplateAdministrationQuery(r.request);
    const origin = parseCanonicalInstant(now());
    const original = await authorize.call(authentication, { sessionCookie: cookie, csrf });
    ports();
    let deadline = new Date(
      Math.min(Date.parse(origin) + 5000, Date.parse(original.validUntil)),
    ).toISOString();
    const owners: { assertFinalized(): void }[] = [];
    let calls = 0,
      sealed = false,
      failed = false;
    const result = await run.call(transactions, async (tx: PublishingOptions["transaction"]) => {
      if (++calls !== 1) return denied();
      const query = tx.query;
      const check = () => {
        ports();
        const at = parseCanonicalInstant(now());
        if (failed || tx.query !== query || at < origin || at >= deadline) return denied();
      };
      const identity = async (actual: typeof tx) => {
        check();
        if (actual !== tx) return denied();
        const current = await sessionSource(tx, cookie);
        check();
        if (
          current.session.sessionReference !== original.session.sessionReference ||
          canonicalizeRfc8785(current.session.actor) !==
            canonicalizeRfc8785(original.session.actor) ||
          current.session.version !== original.session.version ||
          canonicalizeRfc8785(current.recentMfa) !== canonicalizeRfc8785(original.recentMfa)
        )
          return denied();
        deadline = new Date(
          Math.min(Date.parse(deadline), Date.parse(current.validUntil)),
        ).toISOString();
        check();
        return current;
      };
      try {
        const current = await identity(tx);
        if (current.session.actor.actorReference === null) return denied();
        const scope = parsePlatformPublishingSourceScope({
          kind: "Platform",
          actorReference: current.session.actor.actorReference,
          purposeCode: "PLATFORM_BRAND_TEMPLATE",
        });
        const registration: PublishingOptions["registerBeforeCommit"] = async (
          actual,
          guard,
          final,
        ) => {
          check();
          if (actual !== tx) return denied();
          await register(actual, guard, final);
          check();
        };
        await registration(
          tx,
          async () => {
            await identity(tx);
            check();
          },
          () => {
            check();
            sealed = true;
          },
        );
        const clock = Object.freeze({
          now: () => {
            check();
            return now();
          },
        });
        const common = {
          transaction: tx,
          clock,
          originalObservedAt: origin,
          originalValidUntil: deadline,
          registerBeforeCommit: registration,
        };
        if (request.action === "Actions") {
          const read = createPostgresPlatformPermissionSource({
            ...common,
            scope,
            currentIdentity: identity,
          });
          const base = await read.authorize({ action: "platform.brand-template.read" });
          owners.push(read);
          deadline = new Date(
            Math.min(Date.parse(deadline), Date.parse(base.validUntil)),
          ).toISOString();
          check();
          const allowedActions: string[] = [];
          const actions = [
            "platform.brand-template.manage",
            "platform.brand-template.submit",
            "platform.brand-template.approve",
            "platform.brand-template.publish",
            "platform.brand-template.archive",
          ] as const;
          for (const action of actions) {
            let registered = false;
            const candidate = createPostgresPlatformPermissionSource({
              ...common,
              scope,
              currentIdentity: identity,
              registerBeforeCommit: async (actual, guard, final) => {
                registered = true;
                await registration(actual, guard, final);
              },
            });
            try {
              const allowed = await candidate.authorize({ action });
              owners.push(candidate);
              deadline = new Date(
                Math.min(Date.parse(deadline), Date.parse(allowed.validUntil)),
              ).toISOString();
              check();
              allowedActions.push(action);
            } catch (error) {
              if (
                !registered &&
                error instanceof PlatformPermissionError &&
                error.code === "PLATFORM_PERMISSION_DENIED"
              ) {
                check();
                continue;
              }
              throw error;
            }
          }
          return Object.freeze({
            profile: "PlatformTemplateActionsV1" as const,
            scope,
            allowedActions: Object.freeze(allowedActions),
            observedAt: origin,
            validUntil: deadline,
          });
        }
        if (request.action.startsWith("Publication") || request.action === "ResolvePublication") {
          const owner = createPostgresPlatformPublishingStore({
            ...common,
            scope,
            currentIdentity: identity,
            nextReference: () => {
              check();
              return next();
            },
          });
          owners.push(owner);
          switch (request.action) {
            case "Publication":
              return await owner.execute(request.request);
            case "ResolvePublication":
              return await owner.resolve({
                profile: "PlatformPublishingResolveV1",
                operationReference: request.operationReference,
                intentDigest: request.intentDigest,
              });
            case "PublicationCurrent":
              return await owner.current({
                templateReference: request.templateReference,
                lifecycleReference: request.lifecycleReference,
              });
            case "PublicationExact":
              return await owner.exact({
                templateReference: request.templateReference,
                sequence: request.sequence,
              });
            case "PublicationHistory":
              return await owner.history({
                templateReference: request.templateReference,
                beforeSequence: request.beforeSequence,
              });
            default:
              return invalid();
          }
        }
        const permission = createPostgresPlatformPermissionSource({
          ...common,
          scope,
          currentIdentity: identity,
        });
        owners.push(permission);
        const owner = createPostgresPlatformBrandTemplateStore({
          ...common,
          ...scope,
          references: {
            canonicalize: canonicalizeRfc8785,
            hashIntent: (text) => `sha256:${sha256Hex(text)}`,
            nextReference: () => {
              check();
              return next();
            },
          },
          authority: {
            async holdUntilTransactionCompletes(actual, held) {
              check();
              if (actual !== tx) return denied();
              let permitted;
              try {
                permitted = await permission.authorize({ action: held.permission });
              } catch (error) {
                if (
                  error instanceof PlatformPermissionError &&
                  error.code === "PLATFORM_PERMISSION_DENIED"
                )
                  throw new PlatformBrandTemplateError("PLATFORM_TEMPLATE_PERMISSION_DENIED");
                throw error;
              }
              check();
              return { validUntil: permitted.validUntil };
            },
          },
          appendAudit: async (actual, audit) => {
            check();
            if (actual !== tx) return denied();
            await appendPlatformAuditRecordInTransaction(actual, {
              auditReference: audit.auditReference,
              actorReference: scope.actorReference,
              purposeCode: scope.purposeCode,
              actionCode: "PLATFORM_BRAND_TEMPLATE_SAVED",
              targetType:
                audit.mode === "Save" ? "PlatformBrandTemplate" : "PlatformBrandTemplateOperation",
              targetReference:
                audit.mode === "Save"
                  ? (audit.templateReference ?? denied())
                  : audit.operationReference,
              operationReference: audit.operationReference,
              intentDigest: audit.intentDigest,
              occurredAt: audit.occurredAt,
              reasonCode:
                audit.mode === "Save" ? "ADMIN_CONFIGURATION" : "ORIGINAL_RESOLUTION_ABANDONED",
              retentionPolicyCode: "CONFIGURATION_AUDIT",
              retentionPolicyVersion: 1,
            });
            check();
          },
        });
        owners.push(owner);
        switch (request.action) {
          case "List":
            return await owner.list({ after: request.after, limit: request.limit });
          case "Current":
            return await owner.current({ templateReference: request.templateReference });
          case "Exact":
            return await owner.exact({
              templateVersionReference: request.templateVersionReference,
            });
          case "History":
            return await owner.history({
              templateReference: request.templateReference,
              beforeRevision: request.beforeRevision,
            });
          case "Save":
            return await owner.save({
              profile: "PlatformBrandTemplateSaveV1",
              ...scope,
              operationReference: request.operationReference,
              templateReference: request.templateReference,
              expectedHead: request.expectedHead,
              content: request.content,
            });
          case "ResolveSave":
            return await owner.resolve({
              profile: "PlatformBrandTemplateResolveV1",
              ...scope,
              operationReference: request.operationReference,
              intentDigest: request.intentDigest,
            });
          default:
            return invalid();
        }
      } catch (error) {
        failed = true;
        throw error;
      }
    });
    if (calls !== 1 || !sealed || failed) return denied();
    for (const owner of owners) owner.assertFinalized();
    return result;
  }
  return Object.freeze({
    query: (input: unknown) => execute(input, false),
    command: (input: unknown) => execute(input, true),
  });
}

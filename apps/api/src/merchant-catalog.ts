import type { MenuPublicationCommand, MenuPublicationRecord } from "@rms/catalog";
import express, { type Request, type RequestHandler, type Response, type Router } from "express";

const uuidV7Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const cursorPattern = /^[A-Za-z0-9_-]{1,256}$/u;
const listQueryKeys = new Set(["cursor", "limit", "status"]);
const lifecycleStatuses = new Set([
  "Draft",
  "InReview",
  "Approved",
  "Published",
  "Superseded",
  "Archived",
]);

export const merchantCatalogRoutes = Object.freeze({
  list: "/api/v1/merchant/brands/:brand_id/catalog/menus",
  submitReview:
    "/api/v1/merchant/brands/:brand_id/catalog/menus/:menu_id/versions/:version_id/submit-review",
  approve: "/api/v1/merchant/brands/:brand_id/catalog/menus/:menu_id/versions/:version_id/approve",
  publish: "/api/v1/merchant/brands/:brand_id/catalog/menus/:menu_id/versions/:version_id/publish",
  archive: "/api/v1/merchant/brands/:brand_id/catalog/menus/:menu_id/versions/:version_id/archive",
} as const);

export interface MerchantMenuSummary {
  readonly menuReference: string;
  readonly menuVersionReference: string;
  readonly internalCode: string;
  readonly name: string;
  readonly lifecycle: "Draft" | "InReview" | "Approved" | "Published" | "Superseded" | "Archived";
  readonly version: number;
  readonly updatedAt: string;
}

export type MerchantMenuListResult =
  | {
      readonly status: "Found";
      readonly projection: {
        readonly name: "catalog_menu_management_v1";
        readonly version: 1;
        readonly asOfUtc: string;
        readonly stale: false;
        readonly partial: false;
      };
      readonly items: readonly MerchantMenuSummary[];
      readonly nextCursor: string | null;
    }
  | { readonly status: "Denied" | "Invalid" | "ProjectionStale" | "Unavailable" };

export type MerchantMenuCommandResult =
  | {
      readonly status: "Applied" | "AlreadyApplied";
      readonly record: MenuPublicationRecord;
    }
  | {
      readonly status: "Denied" | "Invalid" | "NotFound" | "Conflict" | "Unavailable";
    };

export interface MerchantCatalogPort {
  listMenus(input: {
    readonly brandReference: string;
    readonly cursor: string | null;
    readonly limit: number;
    readonly status: string | null;
  }): Promise<MerchantMenuListResult>;
  executeMenuPublication(input: {
    readonly brandReference: string;
    readonly command: MenuPublicationCommand;
  }): Promise<MerchantMenuCommandResult>;
}

export interface MerchantCatalogRouterOptions {
  readonly authorize: RequestHandler;
  readonly now?: () => string;
  readonly port: MerchantCatalogPort;
}

type PublicationAction = MenuPublicationCommand["action"];

function rawHeaderValues(request: Request, name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) {
      values.push(request.rawHeaders[index + 1] ?? "");
    }
  }
  return values;
}

function scalar(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new TypeError("invalid scalar");
  return value;
}

function routeReference(request: Request, name: string): string {
  return scalar(request.params[name], uuidV7Pattern);
}

function parseClock(now: () => string): string {
  const value = scalar(now(), instantPattern);
  if (new Date(Date.parse(value)).toISOString() !== value) throw new TypeError("invalid clock");
  return value;
}

function parseExpectedVersion(request: Request): number {
  const values = rawHeaderValues(request, "if-match");
  const match = /^"([1-9]\d{0,8})"$/u.exec(values.length === 1 ? (values[0] ?? "") : "");
  if (match?.[1] === undefined) throw new TypeError("invalid if-match");
  const version = Number.parseInt(match[1], 10);
  if (!Number.isSafeInteger(version)) throw new TypeError("invalid if-match");
  return version;
}

function parseOperationReference(request: Request): string {
  const values = rawHeaderValues(request, "idempotency-key");
  return scalar(values.length === 1 ? values[0] : undefined, uuidV7Pattern);
}

function closedBody(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key)) ||
    Reflect.ownKeys(value).length !== keys.length
  )
    throw new TypeError("invalid body");
  return value as Readonly<Record<string, unknown>>;
}

function command(
  request: Request,
  action: PublicationAction,
  now: () => string,
): MenuPublicationCommand {
  const body = closedBody(
    request.body,
    action === "Publish" ? ["snapshotDigest", "effectivePeriod"] : ["snapshotDigest"],
  );
  return {
    action,
    operationReference: parseOperationReference(request) as never,
    menuReference: routeReference(request, "menu_id") as never,
    menuVersionReference: routeReference(request, "version_id") as never,
    expectedVersion: parseExpectedVersion(request),
    snapshotDigest: scalar(body.snapshotDigest, digestPattern) as never,
    requestedAt: parseClock(now) as never,
    effectivePeriod:
      action === "Publish"
        ? (body.effectivePeriod as MenuPublicationCommand["effectivePeriod"])
        : null,
  };
}

function error(response: Response, code: string, status: number): void {
  if (status === 503) response.setHeader("Retry-After", "5");
  response.status(status).json({ schemaVersion: 1, error: { code } });
}

function mapFailure(response: Response, status: string): void {
  switch (status) {
    case "Denied":
      error(response, "catalog_management_denied", 403);
      return;
    case "Invalid":
      error(response, "catalog_management_invalid", 400);
      return;
    case "NotFound":
      error(response, "catalog_menu_not_found", 404);
      return;
    case "Conflict":
      error(response, "catalog_menu_conflict", 409);
      return;
    case "ProjectionStale":
      error(response, "catalog_projection_stale", 503);
      return;
    default:
      error(response, "catalog_management_unavailable", 503);
  }
}

function listInput(request: Request) {
  if (Object.keys(request.query).some((key) => !listQueryKeys.has(key))) {
    throw new TypeError("unknown query");
  }
  const cursor =
    request.query.cursor === undefined ? null : scalar(request.query.cursor, cursorPattern);
  let limit = 50;
  if (request.query.limit !== undefined) {
    const text = scalar(request.query.limit, /^\d{1,3}$/u);
    limit = Number.parseInt(text, 10);
    if (limit < 1 || limit > 100) throw new TypeError("invalid limit");
  }
  const status =
    request.query.status === undefined ? null : scalar(request.query.status, /^[A-Za-z]+$/u);
  if (status !== null && !lifecycleStatuses.has(status)) throw new TypeError("invalid status");
  return {
    brandReference: routeReference(request, "brand_id"),
    cursor,
    limit,
    status,
  };
}

function publicList(result: Extract<MerchantMenuListResult, { status: "Found" }>) {
  return {
    schemaVersion: 1,
    projection: {
      name: result.projection.name,
      version: result.projection.version,
      asOfUtc: result.projection.asOfUtc,
      stale: result.projection.stale,
      partial: result.projection.partial,
    },
    items: result.items.map((item) => ({
      menuReference: item.menuReference,
      menuVersionReference: item.menuVersionReference,
      internalCode: item.internalCode,
      name: item.name,
      lifecycle: item.lifecycle,
      version: item.version,
      updatedAt: item.updatedAt,
    })),
    nextCursor: result.nextCursor,
  };
}

function publicCommand(
  result: Extract<MerchantMenuCommandResult, { status: "Applied" | "AlreadyApplied" }>,
) {
  const record = result.record;
  const effectivePeriod =
    record.effectivePeriod === null
      ? null
      : {
          timeZone: record.effectivePeriod.timeZone,
          effectiveFrom: {
            instant: record.effectivePeriod.effectiveFrom.instant,
            localDateTime: record.effectivePeriod.effectiveFrom.localDateTime,
            utcOffsetMinutes: record.effectivePeriod.effectiveFrom.utcOffsetMinutes,
          },
          effectiveUntil:
            record.effectivePeriod.effectiveUntil === null
              ? null
              : {
                  instant: record.effectivePeriod.effectiveUntil.instant,
                  localDateTime: record.effectivePeriod.effectiveUntil.localDateTime,
                  utcOffsetMinutes: record.effectivePeriod.effectiveUntil.utcOffsetMinutes,
                },
        };
  return {
    schemaVersion: 1,
    status: result.status,
    publication: {
      menuReference: record.lifecycle.familyReference,
      menuVersionReference: record.lifecycle.snapshotReference,
      lifecycleReference: record.lifecycle.lifecycleId,
      lifecycle: record.lifecycle.state,
      version: record.lifecycle.version,
      snapshotDigest: record.lifecycle.snapshotDigest,
      changedAt: record.lifecycle.changedAt,
      releaseReference: record.release?.releaseId ?? null,
      releaseSequence: record.release?.sequence ?? null,
      effectivePeriod,
    },
  };
}

export function createMerchantCatalogRouter({
  authorize,
  now = () => new Date().toISOString(),
  port,
}: MerchantCatalogRouterOptions): Router {
  const router = express.Router();
  router.get(merchantCatalogRoutes.list, authorize, async (request, response) => {
    let input;
    try {
      input = listInput(request);
    } catch {
      mapFailure(response, "Invalid");
      return;
    }
    try {
      const result = await port.listMenus(input);
      if (result.status === "Found") response.status(200).json(publicList(result));
      else mapFailure(response, result.status);
    } catch {
      mapFailure(response, "Unavailable");
    }
  });
  const register = (path: string, action: PublicationAction) => {
    router.post(path, authorize, async (request, response) => {
      let input: MenuPublicationCommand;
      let brandReference: string;
      try {
        input = command(request, action, now);
        brandReference = routeReference(request, "brand_id");
      } catch {
        mapFailure(response, "Invalid");
        return;
      }
      try {
        const result = await port.executeMenuPublication({ brandReference, command: input });
        if (result.status === "Applied" || result.status === "AlreadyApplied") {
          response.status(200).json(publicCommand(result));
        } else mapFailure(response, result.status);
      } catch {
        mapFailure(response, "Unavailable");
      }
    });
  };
  register(merchantCatalogRoutes.submitReview, "SubmitReview");
  register(merchantCatalogRoutes.approve, "Approve");
  register(merchantCatalogRoutes.publish, "Publish");
  register(merchantCatalogRoutes.archive, "Archive");
  return router;
}

export function createUnavailableMerchantCatalogRouter(): Router {
  const router = express.Router();
  const unavailable: RequestHandler = (_request, response) => mapFailure(response, "Unavailable");
  router.get(merchantCatalogRoutes.list, unavailable);
  router.post(merchantCatalogRoutes.submitReview, unavailable);
  router.post(merchantCatalogRoutes.approve, unavailable);
  router.post(merchantCatalogRoutes.publish, unavailable);
  router.post(merchantCatalogRoutes.archive, unavailable);
  return router;
}

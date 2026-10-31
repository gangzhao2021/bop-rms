import { createPostgresCurrentStorePublicationProof } from "./current-publication-proof.js";
import { parseCanonicalInstant } from "@bop/tenant";
import { createPostgresStoreBusinessDateSource } from "./persistence/business-date-source.js";
import { createPostgresStoreWeeklyScheduleSource } from "./persistence/weekly-schedule-source.js";
import { createPostgresStoreExceptionContentSource } from "./persistence/exception-content-source.js";
import { createPostgresStorePauseHistorySource } from "./persistence/pause-history-source.js";
import { parseStoreOperatingContent } from "../contracts/store-operating-status.js";
import { resolveStoreOperatingLocalFields } from "../application/store-operating-status-service.js";
import { evaluateStoreOperatingStatus } from "../domain/evaluate-store-operating-status.js";
import { describeStoreUpcomingHours } from "../domain/describe-store-upcoming-hours.js";

type DateOptions = Parameters<typeof createPostgresStoreBusinessDateSource>[0];
type WeekOptions = Parameters<typeof createPostgresStoreWeeklyScheduleSource>[0];
type ExceptionOptions = Parameters<typeof createPostgresStoreExceptionContentSource>[0];
type PauseOptions = Parameters<typeof createPostgresStorePauseHistorySource>[0];
type Transaction = Parameters<ReturnType<typeof createPostgresStoreBusinessDateSource>>[0];
type BusinessDate = Awaited<ReturnType<ReturnType<typeof createPostgresStoreBusinessDateSource>>>;
export interface StoreOperatingContentProofInput {
  readonly businessDate: BusinessDate;
  readonly weeklySchedule: Parameters<WeekOptions["verifyContent"]>[1]["weeklySchedule"];
  readonly exceptions: readonly Parameters<ExceptionOptions["verifyContent"]>[1]["exception"][];
  readonly temporaryClosures: Awaited<
    ReturnType<ReturnType<typeof createPostgresStorePauseHistorySource>>
  >;
}
/** Same outer transaction required. Final proof must attest full configuration,
 * enabled modes, current Publishing/Live Gate and caller purpose. This reader does
 * not reuse CustomerEntry authorization or fabricate a release from reference IDs.
 */
export function createPostgresStoreOperatingStatusReader(
  options: DateOptions & {
    verifyWeeklyContent: WeekOptions["verifyContent"];
    verifyExceptionContent: ExceptionOptions["verifyContent"];
    verifyPauseOperation: PauseOptions["verifyOperation"];
    verifyOperatingContent(
      tx: Transaction,
      input: StoreOperatingContentProofInput,
      at: string,
    ): Promise<boolean>;
  },
) {
  const readDate = createPostgresStoreBusinessDateSource(options);
  const readPauses = createPostgresStorePauseHistorySource({
    brandReference: options.brandReference,
    storeReference: options.storeReference,
    authorize: options.authorize,
    verifyOperation: options.verifyPauseOperation,
  });
  return async (tx: Transaction, now: string) => {
    try {
      const at = parseCanonicalInstant(now);
      const businessDate = await readDate(tx, at);
      const scope = {
        brandReference: businessDate.brandReference,
        storeReference: businessDate.storeReference,
        configurationReference: businessDate.configurationReference,
        authorize: options.authorize,
      };
      const weeklySchedule = await createPostgresStoreWeeklyScheduleSource({
        ...scope,
        verifyContent: options.verifyWeeklyContent,
      })(tx, at);
      const exceptions = await createPostgresStoreExceptionContentSource({
        ...scope,
        verifyContent: options.verifyExceptionContent,
      })(tx, at);
      const temporaryClosures = await readPauses(tx, at);
      const proofInput = Object.freeze({
        businessDate,
        weeklySchedule,
        exceptions,
        temporaryClosures,
      });
      if ((await options.verifyOperatingContent(tx, proofInput, at)) !== true) throw new Error();
      const operatingIntervals = (intervals: (typeof weeklySchedule)[number]["intervals"]) =>
        intervals.map(({ startLocalTime, endLocalTime, endsNextDay, serviceModes }) => ({
          startLocalTime,
          endLocalTime,
          endsNextDay,
          serviceModes,
        }));
      const content = parseStoreOperatingContent({
        timeZone: businessDate.timeZone,
        weeklySchedule: weeklySchedule.map((day) => ({
          isoWeekday: day.isoWeekday,
          intervals: operatingIntervals(day.intervals),
        })),
        exceptions: exceptions.map((exception) => ({
          localDate: exception.localDate,
          intervals: operatingIntervals(exception.intervals),
        })),
        temporaryClosures,
      });
      const local = resolveStoreOperatingLocalFields(at, content.timeZone);
      const evaluation = evaluateStoreOperatingStatus({ evaluatedAt: at, ...local, ...content });
      // WP-2423 Q7: the service the published hours offer now, before any pause. Staff at the
      // counter keep serving walk-up guests while online ordering is paused.
      const scheduledServiceModes = evaluateStoreOperatingStatus({
        evaluatedAt: at,
        ...local,
        ...content,
        temporaryClosures: [],
      }).availableServiceModes;
      if ((await options.authorize(tx, at)) !== true) throw new Error();
      // WP-2423 Q4: today's published hours (a dated exception replaces the weekday), so a
      // customer arriving while the Store is closed can be told when it serves.
      const today =
        content.exceptions.find((exception) => exception.localDate === local.localDate)
          ?.intervals ??
        content.weeklySchedule.find((day) => day.isoWeekday === local.isoWeekday)?.intervals ??
        [];
      const todayHours = Object.freeze(
        today.map(({ startLocalTime, endLocalTime, endsNextDay }) =>
          Object.freeze({ startLocalTime, endLocalTime, endsNextDay }),
        ),
      );
      // WP-2423 item 8 ③ (decision 16): today's holiday or special hours, last orders, the next
      // 7 days' holidays and special hours, and the next opening, from the same published facts.
      const upcomingHours = describeStoreUpcomingHours({
        localDate: local.localDate,
        localTime: local.localTime,
        weeklySchedule,
        exceptions,
        days: 7,
      });
      return Object.freeze({
        businessDate,
        evaluatedAt: at,
        ...local,
        ...evaluation,
        scheduledServiceModes,
        todayHours,
        upcomingHours,
      });
    } catch {
      throw new Error("STORE_OPERATING_STATUS_UNAVAILABLE");
    }
  };
}

type PublishedOperatingOptions = Omit<
  Parameters<typeof createPostgresCurrentStorePublicationProof>[0],
  "configurationReference" | "hashContent"
> & {
  timeZone: string;
  hashContent(value: unknown): string;
  verifyPauseOperation: PauseOptions["verifyOperation"];
};
type PublicationProof = Awaited<
  ReturnType<ReturnType<typeof createPostgresCurrentStorePublicationProof>>
>;

/** Production composition: all schedule facts must match one current publication.
 * Proof is retained only for this invocation/transaction, never across requests.
 * Pause operation authority remains an explicit current public-owner dependency.
 */
export function createPostgresPublishedStoreOperatingStatusReader(
  options: PublishedOperatingOptions,
) {
  return readPublishedOperatingStatus(options, () => undefined);
}

/**
 * WP-2423 (DEC-PICKUP-CAPACITY-SCHEDULE): the hours of the one current publication, read through
 * the same proof as the operating status (publication, live gate, content digest, purpose), so a
 * consumer planning ahead (Fulfillment's pickup capacity schedule) sees exactly what the open gate
 * enforces. Same outer transaction; nothing is retained across calls.
 */
export function createPostgresPublishedStoreServiceCalendarReader(
  options: PublishedOperatingOptions,
) {
  return async (tx: Transaction, now: string) => {
    let proof: PublicationProof | undefined;
    const status = await readPublishedOperatingStatus(options, (current) => {
      proof = current;
    })(tx, now);
    const configuration = proof?.configuration;
    if (
      configuration === undefined ||
      String(configuration.configurationReference) !==
        String(status.businessDate.configurationReference) ||
      configuration.timeZone !== status.businessDate.timeZone
    )
      throw new Error("STORE_SERVICE_CALENDAR_UNAVAILABLE");
    const intervals = (values: (typeof configuration.weeklySchedule)[number]["intervals"]) =>
      Object.freeze(
        values.map(({ startLocalTime, endLocalTime, endsNextDay, serviceModes }) =>
          Object.freeze({ startLocalTime, endLocalTime, endsNextDay, serviceModes }),
        ),
      );
    return Object.freeze({
      evaluatedAt: status.evaluatedAt,
      configurationReference: configuration.configurationReference,
      configurationVersion: configuration.configurationVersion,
      contentDigest: status.businessDate.contentDigest,
      timeZone: configuration.timeZone,
      businessDayStartLocalTime: status.businessDate.businessDayStartLocalTime,
      enabledServiceModes: Object.freeze([...configuration.enabledServiceModes]),
      capacityConfigurationReference: configuration.capacityConfigurationReference,
      effectiveUntil: configuration.effectiveUntil,
      weeklySchedule: Object.freeze(
        configuration.weeklySchedule.map((day) =>
          Object.freeze({ isoWeekday: day.isoWeekday, intervals: intervals(day.intervals) }),
        ),
      ),
      exceptions: Object.freeze(
        configuration.exceptions.map((exception) =>
          Object.freeze({
            localDate: exception.localDate,
            intervals: intervals(exception.intervals),
          }),
        ),
      ),
    });
  };
}

function readPublishedOperatingStatus(
  options: PublishedOperatingOptions,
  onProof: (proof: PublicationProof) => void,
) {
  return async (tx: Transaction, now: string) => {
    let proof: PublicationProof | undefined;
    const read = async (reference: string, at: string) => {
      if (!proof)
        proof = await createPostgresCurrentStorePublicationProof({
          ...options,
          configurationReference: reference,
        })(tx, at);
      onProof(proof);
      if (
        proof.configuration.configurationReference !== reference ||
        proof.configuration.timeZone !== options.timeZone
      )
        throw new Error("STORE_OPERATING_STATUS_UNAVAILABLE");
      return proof;
    };
    const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
    return createPostgresStoreOperatingStatusReader({
      ...options,
      publicationProof: async (_tx, candidate, at) => {
        const current = await read(candidate.configurationReference, at);
        return {
          contentDigest: current.contentDigest,
          businessDayStartSource: current.businessDayStartSource,
        };
      },
      verifyWeeklyContent: async (_tx, input) =>
        equal(
          (await read(input.configurationReference, input.observedAt)).configuration.weeklySchedule,
          input.weeklySchedule,
        ),
      verifyExceptionContent: async (_tx, input) => {
        const expected = proof?.configuration.exceptions.find(
          (item) => item.localDate === input.exception.localDate,
        );
        return (
          expected !== undefined &&
          equal(expected, input.exception) &&
          options.hashContent(input.exception.intervals) === input.summaryDigest
        );
      },
      verifyPauseOperation: options.verifyPauseOperation,
      verifyOperatingContent: async (_tx, input, at) => {
        const current = await read(input.businessDate.configurationReference, at);
        return (
          equal(current.configuration.weeklySchedule, input.weeklySchedule) &&
          equal(current.configuration.exceptions, input.exceptions) &&
          current.contentDigest === input.businessDate.contentDigest
        );
      },
    })(tx, now);
  };
}

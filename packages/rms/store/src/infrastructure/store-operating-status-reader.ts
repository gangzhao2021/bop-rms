import { createPostgresCurrentStorePublicationProof } from "./current-publication-proof.js";
import { parseCanonicalInstant } from "@bop/tenant";
import { createPostgresStoreBusinessDateSource } from "./persistence/business-date-source.js";
import { createPostgresStoreWeeklyScheduleSource } from "./persistence/weekly-schedule-source.js";
import { createPostgresStoreExceptionContentSource } from "./persistence/exception-content-source.js";
import { createPostgresStorePauseHistorySource } from "./persistence/pause-history-source.js";
import { parseStoreOperatingContent } from "../contracts/store-operating-status.js";
import { resolveStoreOperatingLocalFields } from "../application/store-operating-status-service.js";
import { evaluateStoreOperatingStatus } from "../domain/evaluate-store-operating-status.js";

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
      if ((await options.authorize(tx, at)) !== true) throw new Error();
      return Object.freeze({ businessDate, evaluatedAt: at, ...local, ...evaluation });
    } catch {
      throw new Error("STORE_OPERATING_STATUS_UNAVAILABLE");
    }
  };
}

/** Production composition: all schedule facts must match one current publication.
 * Proof is retained only for this invocation/transaction, never across requests.
 * Pause operation authority remains an explicit current public-owner dependency.
 */
export function createPostgresPublishedStoreOperatingStatusReader(
  options: Omit<
    Parameters<typeof createPostgresCurrentStorePublicationProof>[0],
    "configurationReference" | "hashContent"
  > & {
    timeZone: string;
    hashContent(value: unknown): string;
    verifyPauseOperation: PauseOptions["verifyOperation"];
  },
) {
  return async (tx: Transaction, now: string) => {
    type Proof = Awaited<ReturnType<ReturnType<typeof createPostgresCurrentStorePublicationProof>>>;
    let proof: Proof | undefined;
    const read = async (reference: string, at: string) => {
      if (!proof)
        proof = await createPostgresCurrentStorePublicationProof({
          ...options,
          configurationReference: reference,
        })(tx, at);
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

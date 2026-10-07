import { parseCanonicalInstant } from "@bop/tenant";
import {
  createStoreConfigurationVersion,
  parseStoreAdministrationReference,
  validateStoreConfigurationForPublication,
  type StoreConfigurationVersion,
} from "../contracts/store-configuration-administration.js";
import type {
  StoreConfigurationAdministrationCommand,
  StoreConfigurationAdministrationPorts,
  StoreConfigurationOperation,
} from "./ports/store-configuration-administration-ports.js";

export type StoreConfigurationAdministrationServiceErrorCode =
  | "STORE_CONFIGURATION_COMMAND_INVALID"
  | "STORE_CONFIGURATION_PERMISSION_DENIED"
  | "STORE_CONFIGURATION_VERSION_CONFLICT"
  | "STORE_CONFIGURATION_IDEMPOTENCY_CONFLICT"
  | "STORE_CONFIGURATION_LIFECYCLE_CONFLICT"
  | "STORE_CONFIGURATION_REFERENCE_INVALID"
  | "STORE_CONFIGURATION_APPROVAL_INVALID"
  | "STORE_CONFIGURATION_PUBLISHING_INVALID"
  | "STORE_CONFIGURATION_LIVE_GATE_INVALID"
  | "STORE_CONFIGURATION_DEPENDENCY_UNAVAILABLE";

export class StoreConfigurationAdministrationServiceError extends Error {
  constructor(readonly code: StoreConfigurationAdministrationServiceErrorCode) {
    super("Store configuration administration operation is unavailable");
    this.name = "StoreConfigurationAdministrationServiceError";
  }
}
const fail = (code: StoreConfigurationAdministrationServiceErrorCode): never => {
  throw new StoreConfigurationAdministrationServiceError(code);
};
const dependency = (error: unknown): never => {
  if (error instanceof StoreConfigurationAdministrationServiceError) throw error;
  return fail("STORE_CONFIGURATION_DEPENDENCY_UNAVAILABLE");
};
const CODE = /^[A-Z][A-Z0-9_.:-]{0,63}$/u;

function parseInput(value: unknown) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return fail("STORE_CONFIGURATION_COMMAND_INVALID");
  const fields = [
    "operationReference",
    "actorReference",
    "purposeCode",
    "auditReference",
    "expectedVersion",
    "occurredAt",
    "configuration",
  ];
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        typeof key !== "string" ||
        !fields.includes(key) ||
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      );
    })
  )
    return fail("STORE_CONFIGURATION_COMMAND_INVALID");
  const input = value as Record<string, unknown>;
  try {
    if (
      typeof input.purposeCode !== "string" ||
      !CODE.test(input.purposeCode) ||
      typeof input.expectedVersion !== "number" ||
      !Number.isSafeInteger(input.expectedVersion) ||
      input.expectedVersion < 0
    )
      return fail("STORE_CONFIGURATION_COMMAND_INVALID");
    return Object.freeze({
      operationReference: parseStoreAdministrationReference(input.operationReference),
      actorReference: parseStoreAdministrationReference(input.actorReference),
      purposeCode: input.purposeCode,
      auditReference: parseStoreAdministrationReference(input.auditReference),
      expectedVersion: input.expectedVersion,
      occurredAt: parseCanonicalInstant(input.occurredAt),
      configuration: createStoreConfigurationVersion(input.configuration),
    });
  } catch {
    return fail("STORE_CONFIGURATION_COMMAND_INVALID");
  }
}
type Input = ReturnType<typeof parseInput>;
export type StoreConfigurationAdministrationInput = Input;

function same(
  left: StoreConfigurationVersion,
  right: StoreConfigurationVersion,
  ignored: readonly (keyof StoreConfigurationVersion)[],
): boolean {
  const skip = new Set(ignored);
  if (
    Object.keys(left).length !== Object.keys(right).length ||
    Object.keys(right).some((key) => !Object.hasOwn(left, key))
  )
    return false;
  return (Object.keys(left) as (keyof StoreConfigurationVersion)[]).every(
    (key) => skip.has(key) || JSON.stringify(left[key]) === JSON.stringify(right[key]),
  );
}

export function createStoreConfigurationAdministrationService(
  ports: StoreConfigurationAdministrationPorts,
) {
  async function execute(
    command: StoreConfigurationAdministrationCommand,
    raw: unknown,
    validate: (input: Input, current: StoreConfigurationVersion | null) => Promise<void>,
  ) {
    let input = parseInput(raw);
    const originalInput = input;
    let configuration = input.configuration;
    if (
      !(await ports.authorization
        .authorize({
          command,
          actorReference: input.actorReference,
          brandReference: configuration.brandReference,
          storeReference: configuration.storeReference,
          purposeCode: input.purposeCode,
          observedAt: input.occurredAt,
        })
        .catch(dependency))
    )
      return fail("STORE_CONFIGURATION_PERMISSION_DENIED");
    // Server reception time is execution metadata, not a new business intent.
    // Replay retains the original persisted Audit/operation and rechecks current permission.
    const digest = ports.references.hashIntent(
      JSON.stringify({
        command,
        operationReference: input.operationReference,
        actorReference: input.actorReference,
        purposeCode: input.purposeCode,
        auditReference: input.auditReference,
        expectedVersion: input.expectedVersion,
        configuration: input.configuration,
      }),
    );
    const existing = await ports.repository
      .resolveOperation(input.operationReference)
      .catch(dependency);
    if (existing !== null) {
      if (!ports.references.equals(existing.intentDigest, digest))
        return fail("STORE_CONFIGURATION_IDEMPOTENCY_CONFLICT");
      return Object.freeze({ status: "AlreadyApplied" as const, operation: existing });
    }
    const current = await ports.repository
      .loadLatest(configuration.brandReference, configuration.storeReference)
      .catch(dependency);
    if ((current?.configurationVersion ?? 0) !== input.expectedVersion)
      return fail("STORE_CONFIGURATION_VERSION_CONFLICT");
    if (
      configuration.setupBasis !== undefined &&
      ["Submit", "Approve", "Publish"].includes(command) &&
      ports.prepareFresh === undefined
    )
      return fail("STORE_CONFIGURATION_DEPENDENCY_UNAVAILABLE");
    if (ports.prepareFresh !== undefined) {
      const prepared = await ports
        .prepareFresh(command, input, current)
        .then(createStoreConfigurationVersion)
        .catch(dependency);
      const mutable: readonly (keyof StoreConfigurationVersion)[] =
        command === "Submit"
          ? ["lifecycle", "updatedAt"]
          : command === "Approve"
            ? ["lifecycle", "approvedByReference", "approvalEvidenceReference", "updatedAt"]
            : command === "Publish"
              ? ["lifecycle", "publicationReference", "liveGateEvidenceReference", "updatedAt"]
              : ["updatedAt"];
      if (!same(configuration, prepared, mutable))
        return fail("STORE_CONFIGURATION_COMMAND_INVALID");
      configuration = prepared;
      input = Object.freeze({ ...input, configuration });
    }
    await validate(input, current);
    const operation: StoreConfigurationOperation = Object.freeze({
      command,
      operationReference: input.operationReference,
      brandReference: configuration.brandReference,
      storeReference: configuration.storeReference,
      intentDigest: digest,
      resultingVersion: configuration.configurationVersion,
      configuration,
    });
    const committed = await ports.repository
      .commit({
        operation,
        expectedVersion: input.expectedVersion,
        originalInput,
        audit: {
          actorReference: input.actorReference,
          auditReference: input.auditReference,
          purposeCode: input.purposeCode,
          occurredAt: input.occurredAt,
        },
      })
      .catch(dependency);
    return Object.freeze({ status: "Applied" as const, operation: committed });
  }
  const requireSame = (
    current: StoreConfigurationVersion | null,
    next: StoreConfigurationVersion,
    from: StoreConfigurationVersion["lifecycle"],
    to: StoreConfigurationVersion["lifecycle"],
    ignored: readonly (keyof StoreConfigurationVersion)[],
  ) => {
    if (
      current === null ||
      current.lifecycle !== from ||
      next.lifecycle !== to ||
      !same(current, next, ignored)
    )
      fail("STORE_CONFIGURATION_LIFECYCLE_CONFLICT");
  };
  return Object.freeze({
    saveDraft: (raw: unknown) =>
      execute("SaveDraft", raw, async ({ configuration }, current) => {
        if (current?.setupBasis !== undefined && configuration.setupBasis === undefined)
          fail("STORE_CONFIGURATION_LIFECYCLE_CONFLICT");
        if (
          configuration.lifecycle !== "Draft" ||
          configuration.configurationVersion !== (current?.configurationVersion ?? 0) + 1 ||
          (current !== null &&
            configuration.supersedesConfigurationReference !== current.configurationReference)
        )
          fail("STORE_CONFIGURATION_LIFECYCLE_CONFLICT");
        if (!(await ports.references.validateControlledReferences(configuration).catch(dependency)))
          fail("STORE_CONFIGURATION_REFERENCE_INVALID");
        if (
          !(await ports.references.validateBrandBaseCompatibility(configuration).catch(dependency))
        )
          fail("STORE_CONFIGURATION_REFERENCE_INVALID");
      }),
    validate: (raw: unknown) =>
      execute("Validate", raw, async ({ configuration }, current) => {
        requireSame(current, configuration, "Draft", "Draft", ["updatedAt"]);
        if (!(await ports.references.validateControlledReferences(configuration).catch(dependency)))
          fail("STORE_CONFIGURATION_REFERENCE_INVALID");
        if (
          !(await ports.references.validateBrandBaseCompatibility(configuration).catch(dependency))
        )
          fail("STORE_CONFIGURATION_REFERENCE_INVALID");
      }),
    submit: (raw: unknown) =>
      execute("Submit", raw, async ({ configuration }, current) =>
        requireSame(current, configuration, "Draft", "PendingApproval", ["lifecycle", "updatedAt"]),
      ),
    approve: (raw: unknown) =>
      execute("Approve", raw, async (input, current) => {
        requireSame(current, input.configuration, "PendingApproval", "Approved", [
          "lifecycle",
          "approvedByReference",
          "approvalEvidenceReference",
          "updatedAt",
        ]);
        if (
          input.configuration.approvedByReference !== input.actorReference ||
          !(await ports.approval.validate(input.configuration).catch(dependency))
        )
          fail("STORE_CONFIGURATION_APPROVAL_INVALID");
      }),
    publish: (raw: unknown) =>
      execute("Publish", raw, async ({ configuration }, current) => {
        requireSame(current, configuration, "Approved", "Published", [
          "lifecycle",
          "publicationReference",
          "liveGateEvidenceReference",
          "updatedAt",
        ]);
        validateStoreConfigurationForPublication(configuration);
        if (!(await ports.publishing.validate(configuration).catch(dependency)))
          fail("STORE_CONFIGURATION_PUBLISHING_INVALID");
        if (!(await ports.liveGate.validate(configuration).catch(dependency)))
          fail("STORE_CONFIGURATION_LIVE_GATE_INVALID");
      }),
  });
}

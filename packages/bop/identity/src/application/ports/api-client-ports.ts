import type {
  ApiClientCredentialMetadata,
  ApiClientRecord,
  ApiClientReference,
  ApiClientScope,
} from "../../contracts/api-client.js";
export type ApiClientCommand =
  | "RequestApiClient"
  | "SubmitApiClientApproval"
  | "ActivateApiClient"
  | "SuspendApiClient"
  | "RotateApiClientCredential"
  | "RevokeApiClient";
export interface ApiClientOperation {
  readonly command: ApiClientCommand;
  readonly operationReference: ApiClientReference;
  readonly intentDigest: string;
  readonly client: ApiClientRecord;
}
export interface ApiClientPorts {
  readonly authorization: {
    authorize(input: {
      readonly command: ApiClientCommand;
      readonly actorReference: ApiClientReference;
      readonly targetReference: ApiClientReference;
      readonly scope: ApiClientScope;
      readonly purposeCode: string;
      readonly observedAt: string;
    }): Promise<boolean>;
  };
  readonly references: {
    hashIntent(value: string): string;
    equals(left: string, right: string): boolean;
  };
  readonly approval: {
    validate(input: {
      readonly clientReference: ApiClientReference;
      readonly approvalEvidenceReference: ApiClientReference;
      readonly requestedScopeCodes: ApiClientRecord["requestedScopeCodes"];
      readonly requestedGrantCodes: ApiClientRecord["requestedGrantCodes"];
      readonly observedAt: string;
    }): Promise<boolean>;
  };
  readonly grants: {
    validate(input: {
      readonly clientReference: ApiClientReference;
      readonly grantSetReference: ApiClientReference;
      readonly scope: ApiClientScope;
      readonly requestedGrantCodes: ApiClientRecord["requestedGrantCodes"];
      readonly observedAt: string;
    }): Promise<boolean>;
  };
  readonly credentials: {
    activate(input: {
      readonly client: ApiClientRecord;
      readonly observedAt: string;
    }): Promise<ApiClientCredentialMetadata>;
    rotate(input: {
      readonly client: ApiClientRecord;
      readonly current: ApiClientCredentialMetadata;
      readonly observedAt: string;
    }): Promise<ApiClientCredentialMetadata>;
    revoke(input: {
      readonly client: ApiClientRecord;
      readonly current: ApiClientCredentialMetadata;
      readonly observedAt: string;
    }): Promise<ApiClientCredentialMetadata>;
  };
  readonly audit: {
    append(input: {
      readonly command: ApiClientCommand;
      readonly actorReference: ApiClientReference;
      readonly clientReference: ApiClientReference;
      readonly auditSummaryReference: ApiClientReference;
      readonly purposeCode: string;
      readonly operationReference: ApiClientReference;
      readonly occurredAt: string;
    }): Promise<void>;
  };
  readonly repository: {
    resolveOperation(reference: ApiClientReference): Promise<ApiClientOperation | null>;
    loadLatest(reference: ApiClientReference): Promise<ApiClientRecord | null>;
    commit(input: {
      readonly operation: ApiClientOperation;
      readonly expectedRevision: number;
    }): Promise<ApiClientOperation>;
  };
}

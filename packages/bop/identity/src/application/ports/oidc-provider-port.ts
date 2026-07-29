import type { IdentityActor } from "../../contracts/identity-actor.js";

export interface OidcAuthorizationRequest {
  readonly issuer: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly nonce: string;
  readonly codeChallenge: string;
  readonly codeChallengeMethod: "S256";
}

export interface OidcCodeExchangeRequest {
  readonly issuer: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly code: string;
  readonly nonce: string;
  readonly codeVerifier: string;
}

export interface OidcCodeExchangeResult {
  readonly actor: IdentityActor;
  readonly tokenBundle: string;
}

export interface OidcProviderPort {
  createAuthorizationUrl(request: OidcAuthorizationRequest): Promise<string>;
  exchangeCode(request: OidcCodeExchangeRequest): Promise<OidcCodeExchangeResult>;
  revokeOrLogout(encryptedTokenBundle: string): Promise<"confirmed" | "unknown">;
}

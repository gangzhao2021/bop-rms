import type {
  EncryptedSecretEnvelope,
  RawBrowserCredential,
  SelectorHash,
} from "../../contracts/browser-session.js";

export interface BrowserCredentialGeneratorPort {
  generate(): RawBrowserCredential;
  generateUuidV7(): string;
}

export interface BrowserCredentialHasherPort {
  hash(value: RawBrowserCredential): SelectorHash;
  equals(left: SelectorHash, right: SelectorHash): boolean;
}

export interface SessionEnvelopeCryptoPort {
  encrypt(plaintext: string, encryptionContext: string): Promise<EncryptedSecretEnvelope>;
  decrypt(envelope: EncryptedSecretEnvelope, encryptionContext: string): Promise<string>;
}

export interface PkcePort {
  challenge(verifier: RawBrowserCredential): string;
}

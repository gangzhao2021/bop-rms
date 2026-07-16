export const moduleLayers = ["BOP", "RMS"] as const;
export type ModuleLayer = (typeof moduleLayers)[number];

export const moduleLifecycles = ["Phase 0", "Phase 1", "Later"] as const;
export type ModuleLifecycle = (typeof moduleLifecycles)[number];

export const piiClasses = [
  "none",
  "indirect_identifier",
  "personal",
  "sensitive_personal",
  "payment",
  "health",
  "credential",
] as const;
export type PiiClass = (typeof piiClasses)[number];

export interface ModuleDependency {
  readonly moduleName: string;
  readonly layer: ModuleLayer;
}

export interface OwnedDatabaseDeclaration {
  /** Future ownership metadata only. This contract creates no database object. */
  readonly schema: string | null;
  readonly tables: readonly string[];
}

export interface PiiClassification {
  readonly classes: readonly PiiClass[];
  readonly handling: {
    readonly logs: "prohibited" | "redacted";
    readonly urls: "prohibited";
    readonly analytics: "prohibited" | "deidentified";
    readonly fixtures: "synthetic-only";
  };
}

export interface ModuleManifest {
  readonly moduleName: string;
  readonly layer: ModuleLayer;
  readonly lifecycle: ModuleLifecycle;
  readonly publicExports: readonly string[];
  readonly allowedSynchronousDependencies: readonly ModuleDependency[];
  readonly consumedEvents: readonly string[];
  readonly publishedEvents: readonly string[];
  readonly ownedDatabase: OwnedDatabaseDeclaration;
  readonly ownedJobs: readonly string[];
  readonly featureFlags: readonly string[];
  readonly killSwitches: readonly string[];
  readonly piiClassification: PiiClassification;
  readonly moduleOwner: { readonly role: string };
}

export function defineModuleManifest<const T extends ModuleManifest>(manifest: T): T {
  return manifest;
}

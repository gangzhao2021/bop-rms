export { moduleManifest } from "./module.manifest.js";
export * from "./contracts/media.js";
export * from "./domain/evaluate-media-reference.js";
export * from "./application/media-service.js";
export * from "./application/ports/media-ports.js";
export {
  createPostgresMediaUnitOfWork,
  mediaPersistenceRequiredFields,
  type MediaPersistenceTransaction,
  type MediaPersistenceAuthorityInput,
  type PostgresMediaUnitOfWorkOptions,
} from "./infrastructure/persistence/media-upload-store.js";

export * from "./contracts/media-publication-read.js";
export {
  createPostgresMediaPublicationReadSource,
  createPostgresMediaOptionSetPublicationReadSource,
  type MediaOptionSetPublicationReadAuthorityInput,
  type MediaOptionSetPublicationReadSourceOptions,
  type MediaPublicationReadAuthorityInput,
  type MediaPublicationReadSourceOptions,
} from "./infrastructure/persistence/media-publication-read-store.js";

export * from "./contracts/media-editor-read.js";
export {
  createPostgresMediaEditorReadSource,
  type MediaEditorReadAuthorityInput,
  type MediaEditorReadSourceOptions,
} from "./infrastructure/persistence/media-publication-read-store.js";

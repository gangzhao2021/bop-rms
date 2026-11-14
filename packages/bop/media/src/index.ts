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

export * from "./contracts/product-image.js";
export type { MediaImageObjectStore } from "./application/ports/media-image-object-store.js";
export type {
  IngestProductImageInput,
  LoadProductImagesInput,
  PreparedProductImage,
  PrepareProductImageInput,
  ProductImageService,
  RecordProductImageInput,
} from "./application/product-image-service.js";
export {
  createProductImageService,
  loadProductImages,
} from "./infrastructure/product-image-runtime.js";
export { createLocalFilesystemMediaImageObjectStore } from "./infrastructure/storage/local-filesystem-image-object-store.js";

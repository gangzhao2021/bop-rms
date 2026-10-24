/** API aliases preserve the existing composition seam. Owning Catalog contracts
 * bind structure and semantics; the writer and current sources supply authority. */
export {
  bindCatalogProductPublicationQualificationContext as bindPublicationQualificationInput,
  bindCatalogProductWarningAcknowledgementQualificationContext as bindWarningAcknowledgementQualificationInput,
  type CatalogProductPublicationQualificationInput as PublicationQualificationInput,
  type CatalogProductWarningAcknowledgementQualificationInput as WarningAcknowledgementQualificationInput,
  type CatalogProductPublicationQualificationContext as PublicationQualificationContext,
  type CatalogProductWarningAcknowledgementQualificationContext as WarningAcknowledgementQualificationContext,
  type CatalogProductQualificationContext as ProductPublicationQualificationContext,
} from "@rms/catalog";

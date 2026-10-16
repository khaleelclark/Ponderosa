export class ProviderDisabledError extends Error {
  readonly code = "provider_disabled";
  constructor(readonly engineId: string) {
    super(`Provider ${engineId} is disabled by the operator. Enable it before creating executable work.`);
    this.name = "ProviderDisabledError";
  }
}

export class PrivacyGuardianError extends Error {
  constructor(message, details = undefined) {
    super(message);
    this.name = "PrivacyGuardianError";
    this.details = details;
  }
}

export class ProviderError extends PrivacyGuardianError {
  constructor(message, details = undefined) {
    super(message, details);
    this.name = "ProviderError";
  }
}


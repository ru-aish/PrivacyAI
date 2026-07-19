// Compatibility facade. Implementations and persistence policy are isolated in
// context-repository while this module preserves the historical public API.
export {
  MemoryContextVerificationStore,
  SqliteContextVerificationStore,
  openContextVerificationStore,
  verificationFingerprint
} from "./context-repository/index.js";

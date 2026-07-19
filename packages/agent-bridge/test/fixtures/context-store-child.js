import { openContextVerificationStore, retryContextStoreOperation } from "../../src/index.js";

const [dbPath, sessionKey, placeholder, original] = process.argv.slice(2);
const store = await openContextVerificationStore({
  verificationDbPath: dbPath,
  verificationBusyTimeoutMs: 10,
  verificationRetryTimeoutMs: 5000
});
try {
  await retryContextStoreOperation(
    () => store.saveThread(sessionKey, {
      parentSessionKeys: [`parent:${placeholder}`],
      sessionMap: { [placeholder]: original },
      policyFingerprint: `policy:${sessionKey}`
    }),
    { timeoutMs: 5000 }
  );
  process.stdout.write(JSON.stringify({ path: store.path }));
} finally {
  store.close();
}

export function beginImmediate(db) { db.exec("BEGIN IMMEDIATE"); }
export function commit(db) { db.exec("COMMIT"); }
export function rollbackWithoutMasking(db) {
  try {
    db.exec("ROLLBACK");
  } catch {
    // Preserve the original error and do not expose rollback details.
  }
}
export function withImmediateTransaction(db, operation) {
  beginImmediate(db);
  try { const value = operation(); commit(db); return value; }
  catch (error) { rollbackWithoutMasking(db); throw error; }
}

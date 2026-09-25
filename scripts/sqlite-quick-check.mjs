import { DatabaseSync } from "node:sqlite";

const databasePath = process.argv[2];
if (!databasePath) {
  console.error("用法：node scripts/sqlite-quick-check.mjs <database>");
  process.exit(2);
}
const db = new DatabaseSync(databasePath, { readOnly: true });
try {
  const result = db.prepare("PRAGMA quick_check").get().quick_check;
  if (result !== "ok") {
    console.error(`quick_check failed: ${result}`);
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify({ ok: true, quickCheck: result, databasePath }));
  }
} finally {
  db.close();
}

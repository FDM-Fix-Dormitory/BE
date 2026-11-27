import { readFile } from "node:fs/promises";
import { pool } from "./db.js";

try {
  const [existing] = await pool.query("SHOW TABLES");
  if ((existing as unknown[]).length)
    throw new Error(
      "Migration requires an empty database. Review the shared schema before applying.",
    );
  const sql = await readFile(
    new URL("../sql/001_initial.sql", import.meta.url),
    "utf8",
  );
  // This trusted file contains no stored programs or semicolons inside literals.
  for (const statement of sql
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean))
    await pool.query(statement);
  console.log("D.O.M initial schema applied.");
} finally {
  await pool.end();
}

import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import bcrypt from "bcryptjs";
import { pool } from "./db.js";
import {
  MAX_PASSWORD_BYTES,
  passwordWithinBcryptLimit,
} from "./auth-report-routes.js";

// 사용법: npm run user:create -- <loginId> <displayName> [STUDENT|ADMIN]
// 비밀번호는 명령줄 기록에 남지 않도록 표준 입력으로 받습니다.
try {
  const [loginId, displayName, role = "STUDENT"] = process.argv.slice(2);
  if (
    !loginId ||
    !/^[A-Za-z0-9._-]{1,50}$/.test(loginId) ||
    !displayName ||
    !["STUDENT", "ADMIN"].includes(role)
  ) {
    throw new Error(
      "사용법: npm run user:create -- <loginId(영문·숫자·._-)> <displayName> [STUDENT|ADMIN]",
    );
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const password = await rl.question("비밀번호(8자 이상): ");
  rl.close();
  if (password.length < 8 || password.length > 200)
    throw new Error("비밀번호는 8~200자여야 합니다.");
  if (!passwordWithinBcryptLimit(password))
    throw new Error(
      `비밀번호는 UTF-8 기준 ${MAX_PASSWORD_BYTES}바이트 이하여야 합니다.`,
    );
  const id = randomUUID();
  await pool.execute(
    "INSERT INTO users (id, role, display_name, login_id, password_hash) VALUES (?, ?, ?, ?, ?)",
    [id, role, displayName, loginId, await bcrypt.hash(password, 10)],
  );
  console.log(JSON.stringify({ id, loginId, role, displayName }));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}

import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";

type Role = "user" | "admin";

interface User {
  id: string;
  loginId: string;
  passwordHash: string;
  role: Role;
  displayName: string;
}

interface ReportImage {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  url: string;
  createdAt: string;
}

interface Report {
  id: string;
  authorId: string;
  title: string;
  content: string;
  images: ReportImage[];
  createdAt: string;
}

// ---------- 비밀번호 해시 ----------
function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, "hex");
  const actual = scryptSync(password, salt, expected.length);
  return timingSafeEqual(expected, actual);
}

// ---------- 인메모리 저장소 (서버 재시작 시 초기화됨) ----------
const users = new Map<string, User>();
const reports = new Map<string, Report>();

function createUser(loginId: string, password: string, displayName: string, role: Role = "user"): User {
  const user: User = { id: randomUUID(), loginId, passwordHash: hashPassword(password), role, displayName };
  users.set(user.id, user);
  return user;
}

function findUser(id: string): User | undefined {
  return users.get(id);
}

function findUserByLoginId(loginId: string): User | undefined {
  for (const user of users.values()) if (user.loginId === loginId) return user;
  return undefined;
}

function createReport(authorId: string, title: string, content: string): Report {
  const report: Report = {
    id: randomUUID(),
    authorId,
    title,
    content,
    images: [],
    createdAt: new Date().toISOString(),
  };
  reports.set(report.id, report);
  return report;
}

function findReport(id: string): Report | undefined {
  return reports.get(id);
}

function findReportsByAuthor(authorId: string): Report[] {
  return [...reports.values()]
    .filter((r) => r.authorId === authorId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// 개발용 시드 계정
createUser("admin", "admin1234", "관리자", "admin");
createUser("user", "user1234", "사용자");

export {
  createReport,
  createUser,
  findReport,
  findReportsByAuthor,
  findUser,
  findUserByLoginId,
  verifyPassword,
};
export type { Report, ReportImage, Role, User };

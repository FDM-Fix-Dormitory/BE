import { createHash, randomUUID } from "node:crypto";
import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { ApiError, type Actor, type Report, type Status } from "./domain.js";
import type { Cursor } from "./pagination.js";

export const scopes = ["COMMON", "ROOM"] as const;
export const facilityTypes = [
  "VENDING_MACHINE",
  "WASHING_MACHINE",
  "DRYER",
  "SHOWER",
  "LIGHT",
  "OTHER",
] as const;
export const MAX_IMAGES_PER_REPORT = 10;

export type User = Actor & { displayName: string };
export type Credentials = User & { passwordHash: string };
export type Session = { actor: Actor; tokenHash: string };
export type NewReport = {
  scope: (typeof scopes)[number];
  title: string;
  location: string;
  roomNumber: string | null;
  facilityType: (typeof facilityTypes)[number];
  description: string;
};
export type NewImage = { contentType: string; data: Buffer };
export type StoredImage = { id: string; reportId: string; contentType: string };
export type ImageFile = {
  contentType: string;
  data: Buffer;
  report: Pick<Report, "scope" | "reporterId">;
};
export type MyReportQuery = { status?: Status; limit: number; cursor?: Cursor };

export interface AuthReportRepository {
  findCredentials(loginId: string): Promise<Credentials | undefined>;
  createSession(
    userId: string,
    tokenHash: string,
    expiresAt: Date,
  ): Promise<void>;
  findSession(tokenHash: string): Promise<Actor | undefined>;
  revokeSession(tokenHash: string): Promise<void>;
  findUser(id: string): Promise<User | undefined>;
  createReport(reporterId: string, report: NewReport): Promise<Report>;
  listMyReports(reporterId: string, query: MyReportQuery): Promise<Report[]>;
  findReportOwner(
    id: string,
  ): Promise<Pick<Report, "scope" | "reporterId"> | undefined>;
  addImages(reportId: string, images: NewImage[]): Promise<StoredImage[]>;
  findImage(id: string): Promise<ImageFile | undefined>;
}

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

const reportColumns = `r.id, r.scope, r.title, r.location, r.room_number AS roomNumber,
  r.facility_type AS facilityType, r.description, r.status, r.reporter_id AS reporterId,
  r.created_at AS createdAt, r.updated_at AS updatedAt`;
const countSql =
  "(SELECT COUNT(*) FROM confirmations c WHERE c.report_id = r.id)";

export class MysqlAuthReportRepository implements AuthReportRepository {
  constructor(private readonly db: Pool) {}

  async findCredentials(loginId: string) {
    const [rows] = await this.db.execute<(RowDataPacket & Credentials)[]>(
      `SELECT id, role, display_name AS displayName, password_hash AS passwordHash
       FROM users WHERE login_id = ? AND password_hash IS NOT NULL`,
      [loginId],
    );
    return rows[0] ? { ...rows[0] } : undefined;
  }

  async createSession(userId: string, tokenHash: string, expiresAt: Date) {
    await this.db.execute(
      "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
      [tokenHash, userId, expiresAt],
    );
  }

  async findSession(tokenHash: string) {
    const [rows] = await this.db.execute<(RowDataPacket & Actor)[]>(
      `SELECT u.id, u.role FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > UTC_TIMESTAMP(3) AND s.revoked_at IS NULL`,
      [tokenHash],
    );
    const actor = rows[0];
    return actor && (actor.role === "STUDENT" || actor.role === "ADMIN")
      ? { id: actor.id, role: actor.role }
      : undefined;
  }

  async revokeSession(tokenHash: string) {
    await this.db.execute(
      "UPDATE sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE token_hash = ? AND revoked_at IS NULL",
      [tokenHash],
    );
  }

  async findUser(id: string) {
    const [rows] = await this.db.execute<(RowDataPacket & User)[]>(
      "SELECT id, role, display_name AS displayName FROM users WHERE id = ?",
      [id],
    );
    return rows[0]
      ? { id: rows[0].id, role: rows[0].role, displayName: rows[0].displayName }
      : undefined;
  }

  async createReport(reporterId: string, report: NewReport) {
    const id = randomUUID();
    await this.db.execute<ResultSetHeader>(
      `INSERT INTO reports (id, reporter_id, scope, title, location, room_number, facility_type, description)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        reporterId,
        report.scope,
        report.title,
        report.location,
        report.roomNumber,
        report.facilityType,
        report.description,
      ],
    );
    const [rows] = await this.db.execute<Report[]>(
      `SELECT ${reportColumns}, 0 AS sameIssueCount, 0 AS isConfirmedByMe FROM reports r WHERE r.id = ?`,
      [id],
    );
    return rows[0]!;
  }

  async listMyReports(reporterId: string, query: MyReportQuery) {
    const where = ["r.reporter_id = ?"];
    const params: (string | number | Date)[] = [reporterId];
    if (query.status) {
      where.push("r.status = ?");
      params.push(query.status);
    }
    if (query.cursor) {
      const time = new Date(query.cursor.createdAt);
      where.push("(r.created_at < ? OR (r.created_at = ? AND r.id < ?))");
      params.push(time, time, query.cursor.id);
    }
    params.push(query.limit + 1);
    const [rows] = await this.db.query<Report[]>(
      `SELECT ${reportColumns}, ${countSql} AS sameIssueCount, 0 AS isConfirmedByMe
       FROM reports r WHERE ${where.join(" AND ")} ORDER BY r.created_at DESC, r.id DESC LIMIT ?`,
      params,
    );
    return rows;
  }

  async findReportOwner(id: string) {
    const [rows] = await this.db.execute<
      (RowDataPacket & Pick<Report, "scope" | "reporterId">)[]
    >("SELECT scope, reporter_id AS reporterId FROM reports WHERE id = ?", [
      id,
    ]);
    return rows[0]
      ? { scope: rows[0].scope, reporterId: rows[0].reporterId }
      : undefined;
  }

  async addImages(reportId: string, images: NewImage[]) {
    const connection = await this.db.getConnection();
    try {
      await connection.beginTransaction();
      // Lock the report so concurrent uploads cannot exceed the per-report limit.
      await connection.execute(
        "SELECT id FROM reports WHERE id = ? FOR UPDATE",
        [reportId],
      );
      const [counts] = await connection.execute<
        (RowDataPacket & { count: number })[]
      >("SELECT COUNT(*) AS count FROM report_images WHERE report_id = ?", [
        reportId,
      ]);
      if (Number(counts[0]!.count) + images.length > MAX_IMAGES_PER_REPORT) {
        throw new ApiError(
          422,
          "VALIDATION_ERROR",
          `신고 한 건에 이미지는 최대 ${MAX_IMAGES_PER_REPORT}장까지 올릴 수 있습니다.`,
          [{ field: "images", reason: "TOO_MANY" }],
        );
      }
      const stored: StoredImage[] = [];
      for (const image of images) {
        const id = randomUUID();
        await connection.execute(
          `INSERT INTO report_images (id, report_id, content_type, storage_key, data, byte_size)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            id,
            reportId,
            image.contentType,
            `db:${id}`,
            image.data,
            image.data.length,
          ],
        );
        stored.push({ id, reportId, contentType: image.contentType });
      }
      await connection.commit();
      return stored;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async findImage(id: string) {
    const [rows] = await this.db.execute<RowDataPacket[]>(
      `SELECT i.content_type AS contentType, i.data, r.scope, r.reporter_id AS reporterId
       FROM report_images i JOIN reports r ON r.id = i.report_id WHERE i.id = ? AND i.data IS NOT NULL`,
      [id],
    );
    const row = rows[0];
    if (!row) return undefined;
    return {
      contentType: row.contentType,
      data: row.data as Buffer,
      report: { scope: row.scope, reporterId: row.reporterId },
    };
  }
}

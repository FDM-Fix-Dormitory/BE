import { Router, type Request } from "express";
import { z } from "zod";
import {
  adminCard,
  ApiError,
  publicCard,
  requireReadable,
  requireRole,
  statuses,
  type Actor,
} from "./domain.js";
import {
  decodeCursor,
  idSchema,
  pageKey,
  pageResult,
  pageSchema,
  sortSchema,
} from "./pagination.js";
import type { ManagementRepository } from "./repository.js";

/** 서버가 검증한 세션의 사용자를 돌려줍니다. 기본 구현은 `src/auth.ts`의 `sessionResolver`입니다. */
export type SessionResolver = (request: Request) => Promise<Actor | undefined>;

export function parse<T>(
  schema: z.ZodType<T>,
  value: unknown,
  status = 400,
): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ApiError(
      status,
      status === 422 ? "VALIDATION_ERROR" : "BAD_REQUEST",
      "요청 값을 확인해 주세요.",
      result.error.issues.map((issue) => ({
        field: issue.path.join(".") || "request",
        reason: issue.code.toUpperCase(),
      })),
    );
  }
  return result.data;
}

const reportQuery = z
  .object({ ...pageSchema, status: z.enum(statuses).optional() })
  .strict();
const adminQuery = z
  .object({
    ...pageSchema,
    status: z.enum(statuses).optional(),
    scope: z.enum(["COMMON", "ROOM"]).optional(),
    sort: sortSchema.default("createdAt_desc"),
  })
  .strict();
const notificationsQuery = z
  .object({
    ...pageSchema,
    unreadOnly: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
  })
  .strict();

export function managementRoutes(
  repository: ManagementRepository,
  resolver?: SessionResolver,
) {
  const router = Router();
  router.use(async (req, res, next) => {
    res.setHeader("Cache-Control", "private, no-store");
    res.vary("Authorization");
    let actor: Actor | undefined;
    if (resolver) {
      actor = await resolver(req);
    } else {
      const match = /^Bearer ([A-Za-z0-9._~-]{16,512})$/i.exec(
        req.get("Authorization") ?? "",
      );
      if (match) actor = await repository.findSession(match[1]!);
    }
    if (
      !actor ||
      !idSchema.safeParse(actor.id).success ||
      !["STUDENT", "ADMIN"].includes(actor.role)
    ) {
      throw new ApiError(401, "UNAUTHORIZED", "로그인이 필요합니다.");
    }
    res.locals.actor = actor;
    next();
  });

  router.get("/reports", async (req, res) => {
    const query = parse(reportQuery, req.query);
    const key = pageKey({ endpoint: "reports", status: query.status ?? null });
    const rows = await repository.listReports({
      ...query,
      scope: "COMMON",
      sort: "createdAt_desc",
      cursor: decodeCursor(query.cursor, key),
    });
    const result = pageResult(rows, query.limit, key);
    res.json({ ...result, data: result.data.map(publicCard) });
  });

  router.get("/reports/:reportId", async (req, res) => {
    parse(z.object({}).strict(), req.query);
    const id = parse(idSchema, req.params.reportId);
    const actor: Actor = res.locals.actor;
    const report = await repository.findReport(id, actor.id);
    requireReadable(report, actor);
    const images = await repository.images(id);
    res.json({
      data: {
        ...publicCard(report),
        roomNumber: report.roomNumber,
        description: report.description,
        isConfirmedByMe: Boolean(report.isConfirmedByMe),
        updatedAt: report.updatedAt.toISOString(),
        ...(actor.role === "ADMIN" || report.reporterId === actor.id
          ? { reporterId: report.reporterId }
          : {}),
        images: images.map((image) => ({
          id: image.id,
          reportId: image.reportId,
          contentType: image.contentType,
          url: `/api/v1/report-images/${image.id}`,
        })),
      },
    });
  });

  router.get("/admin/reports", async (req, res) => {
    requireRole(res.locals.actor, "ADMIN");
    const query = parse(adminQuery, req.query);
    const key = pageKey({
      endpoint: "admin/reports",
      scope: query.scope ?? null,
      status: query.status ?? null,
      sort: query.sort,
    });
    const rows = await repository.listReports({
      ...query,
      cursor: decodeCursor(query.cursor, key),
    });
    const result = pageResult(
      rows,
      query.limit,
      key,
      (row) => row.sameIssueCount,
    );
    res.json({ ...result, data: result.data.map(adminCard) });
  });

  router.patch("/admin/reports/:reportId/status", async (req, res) => {
    requireRole(res.locals.actor, "ADMIN");
    parse(z.object({}).strict(), req.query);
    const id = parse(idSchema, req.params.reportId);
    if (!req.is("application/json"))
      throw new ApiError(
        415,
        "UNSUPPORTED_MEDIA_TYPE",
        "application/json으로 보내 주세요.",
      );
    const { status } = parse(
      z.object({ status: z.enum(statuses) }).strict(),
      req.body,
      422,
    );
    const result = await repository.changeStatus(id, status, res.locals.actor);
    res.json({
      data: { ...result, updatedAt: result.updatedAt.toISOString() },
    });
  });

  router.post("/reports/:reportId/confirmations", async (req, res) => {
    requireRole(res.locals.actor, "STUDENT");
    parse(z.object({}).strict(), req.query);
    const id = parse(idSchema, req.params.reportId);
    if (req.body !== undefined) parse(z.object({}).strict(), req.body);
    // Reject bodies not handled by the JSON parser as well.
    if (
      req.body === undefined &&
      (Number(req.get("Content-Length") ?? 0) > 0 ||
        req.get("Transfer-Encoding"))
    ) {
      throw new ApiError(
        400,
        "BAD_REQUEST",
        "이 API는 요청 본문이 필요하지 않습니다.",
      );
    }
    const result = await repository.confirm(id, res.locals.actor);
    res.status(result.created ? 201 : 200).json({
      data: {
        reportId: id,
        isConfirmedByMe: true,
        sameIssueCount: result.count,
      },
    });
  });

  router.get("/me/notifications", async (req, res) => {
    const actor: Actor = res.locals.actor;
    requireRole(actor, "STUDENT");
    const query = parse(notificationsQuery, req.query);
    const key = pageKey({
      endpoint: "me/notifications",
      userId: actor.id,
      unreadOnly: query.unreadOnly,
    });
    const rows = await repository.notifications(actor.id, {
      ...query,
      cursor: decodeCursor(query.cursor, key),
    });
    const result = pageResult(rows, query.limit, key);
    res.json({
      ...result,
      data: result.data.map((row) => ({
        id: row.id,
        reportId: row.reportId,
        type: row.type,
        previousStatus: row.previousStatus,
        newStatus: row.newStatus,
        createdAt: row.createdAt.toISOString(),
        read: Boolean(row.read),
      })),
    });
  });

  return router;
}

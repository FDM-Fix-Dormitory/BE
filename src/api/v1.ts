import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { Router } from "express";
import multer from "multer";
import { requireAuth } from "../auth.js";
import {
  createReport,
  findReport,
  findReportsByAuthor,
  findUser,
  findUserByLoginId,
  verifyPassword,
  type Report,
} from "../store.js";

const UPLOAD_DIR = path.resolve("uploads");
mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_MIME: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => cb(null, `${randomUUID()}${ALLOWED_MIME[file.mimetype] ?? ""}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 5 },
  fileFilter: (_req, file, cb) => cb(null, file.mimetype in ALLOWED_MIME),
});

function isNonEmptyString(v: unknown, max: number): v is string {
  return typeof v === "string" && v.trim().length > 0 && v.length <= max;
}

function toReportDto(report: Report) {
  return {
    id: report.id,
    title: report.title,
    content: report.content,
    images: report.images,
    createdAt: report.createdAt,
  };
}

const app = Router();

app.get("/", (req, res) => {
  res.send("ok");
});

// 로그인
app.post("/auth/sessions", (req, res, next) => {
  const { loginId, password } = req.body ?? {};
  if (typeof loginId !== "string" || typeof password !== "string") {
    return res.status(400).send({ error: "loginId와 password가 필요합니다" });
  }

  const user = findUserByLoginId(loginId);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return res.status(401).send({ error: "아이디 또는 비밀번호가 올바르지 않습니다" });
  }

  // 세션 고정 공격 방지를 위해 로그인 시 세션 ID 재발급
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.userId = user.id;
    res.status(201).send({
      data: { id: user.id, role: user.role, displayName: user.displayName },
    });
  });
});

// 내 정보
app.get("/me", requireAuth, (req, res) => {
  const user = findUser(req.session.userId!);
  if (!user) {
    return req.session.destroy(() => res.status(401).send({ error: "로그인이 필요합니다" }));
  }
  return res.send({
    data: { id: user.id, role: user.role, displayName: user.displayName },
  });
});

// 로그아웃
app.post("/auth/sessions/me/delete", requireAuth, (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).send({ error: "로그아웃을 실패했습니다" });
    res.clearCookie("connect.sid");
    res.status(204).send();
  });
});

// 신고 작성
app.post("/reports", requireAuth, (req, res) => {
  const { title, content } = req.body ?? {};
  if (!isNonEmptyString(title, 100) || !isNonEmptyString(content, 5000)) {
    return res
      .status(400)
      .send({ error: "title(1~100자)과 content(1~5000자)가 필요합니다" });
  }
  const report = createReport(req.session.userId!, title.trim(), content.trim());
  res.status(201).send({ data: toReportDto(report) });
});

// 내 신고 목록
app.get("/me/reports", requireAuth, (req, res) => {
  const reports = findReportsByAuthor(req.session.userId!);
  res.send({ data: reports.map(toReportDto) });
});

// 신고 이미지 업로드 (multipart/form-data, 필드명: images)
app.post(
  "/reports/:reportId/images",
  requireAuth,
  (req, res, next) => {
    const report = findReport(req.params.reportId as string);
    if (!report) return res.status(404).send({ error: "신고를 찾을 수 없습니다" });
    if (report.authorId !== req.session.userId) {
      return res.status(403).send({ error: "권한이 없습니다" });
    }
    res.locals.report = report;
    next();
  },
  (req, res, next) => {
    upload.array("images", 5)(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        return res.status(400).send({ error: `업로드 실패: ${err.message}` });
      }
      if (err) return next(err);
      next();
    });
  },
  (req, res) => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0) {
      return res
        .status(400)
        .send({ error: "images 필드로 이미지(jpeg/png/webp/gif)를 1개 이상 보내야 합니다" });
    }
    const report = res.locals.report as Report;
    const added = files.map((f) => ({
      id: randomUUID(),
      filename: f.originalname,
      mimeType: f.mimetype,
      size: f.size,
      url: `/uploads/${f.filename}`,
      createdAt: new Date().toISOString(),
    }));
    report.images.push(...added);
    res.status(201).send({ data: added });
  },
);

export { app as v1, UPLOAD_DIR };

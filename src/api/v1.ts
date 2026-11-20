import { Router } from "express";
import multer from "multer";
import { requireAuth } from "../auth.js";
import {
  addReportImages,
  createReport,
  findImageFile,
  findReport,
  findReportsByAuthor,
  findUser,
  findUserByLoginId,
  verifyPassword,
  type Report,
} from "../store.js";

const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 5 },
  fileFilter: (_req, file, cb) => cb(null, ALLOWED_MIME.has(file.mimetype)),
});

// 클라이언트가 보낸 Content-Type이 아닌 실제 파일 시그니처로 형식 확인
function detectImageType(buf: Buffer): string | undefined {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return "image/png";
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString("latin1"))) return "image/gif";
  if (buf.length >= 12 && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP")
    return "image/webp";
  return undefined;
}

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
app.post("/auth/sessions", async (req, res, next) => {
  const { loginId, password } = req.body ?? {};
  if (typeof loginId !== "string" || typeof password !== "string") {
    return res.status(400).send({ error: "loginId와 password가 필요합니다" });
  }

  const user = await findUserByLoginId(loginId);
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
app.get("/me", requireAuth, async (req, res) => {
  const user = await findUser(req.session.userId!);
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
app.post("/reports", requireAuth, async (req, res) => {
  const { title, content } = req.body ?? {};
  if (!isNonEmptyString(title, 100) || !isNonEmptyString(content, 5000)) {
    return res
      .status(400)
      .send({ error: "title(1~100자)과 content(1~5000자)가 필요합니다" });
  }
  const report = await createReport(req.session.userId!, title.trim(), content.trim());
  res.status(201).send({ data: toReportDto(report) });
});

// 내 신고 목록
app.get("/me/reports", requireAuth, async (req, res) => {
  const reports = await findReportsByAuthor(req.session.userId!);
  res.send({ data: reports.map(toReportDto) });
});

// 신고 이미지 업로드 (multipart/form-data, 필드명: images)
app.post(
  "/reports/:reportId/images",
  requireAuth,
  async (req, res, next) => {
    const report = await findReport(req.params.reportId as string);
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
  async (req, res) => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0) {
      return res
        .status(400)
        .send({ error: "images 필드로 이미지(jpeg/png/webp/gif)를 1개 이상 보내야 합니다" });
    }
    const detected = files.map((f) => detectImageType(f.buffer));
    if (detected.some((t) => !t)) {
      return res.status(400).send({ error: "올바른 이미지 파일이 아닙니다 (jpeg/png/webp/gif)" });
    }
    const report = res.locals.report as Report;
    const added = await addReportImages(
      report.id,
      files.map((f, i) => ({
        filename: f.originalname,
        mimeType: detected[i]!,
        size: f.size,
        data: f.buffer,
      })),
    );
    res.status(201).send({ data: added });
  },
);

// 이미지 조회 (신고 작성자 또는 관리자만)
app.get("/images/:imageId", requireAuth, async (req, res) => {
  const image = await findImageFile(req.params.imageId as string);
  if (!image) return res.status(404).send({ error: "이미지를 찾을 수 없습니다" });
  if (image.authorId !== req.session.userId) {
    const user = await findUser(req.session.userId!);
    if (user?.role !== "admin") return res.status(403).send({ error: "권한이 없습니다" });
  }
  res.set({
    "Content-Type": image.mimeType,
    "Content-Length": String(image.data.length),
    "Cache-Control": "private, max-age=86400",
    "X-Content-Type-Options": "nosniff",
  });
  res.send(image.data);
});

export { app as v1 };

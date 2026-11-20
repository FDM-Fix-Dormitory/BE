import express, { type NextFunction, type Request, type Response } from "express";
import { v1, UPLOAD_DIR } from "./api/v1.js";
import { configDotenv } from "dotenv";
import { checkEnv } from "./checkEnv.js";
import session from "express-session";

configDotenv({ path: ".env" });
if (!checkEnv(process.env)) throw new Error("필요한 환경변수가 없습니다");
const PORT = parseInt(process.env.PORT!);

const app = express();

app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET!,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, httpOnly: true, maxAge: 1000 * 60 * 10 },
  }),
);
app.use("/uploads", express.static(UPLOAD_DIR));
app.use("/api/v1", v1);

app.use((req, res) => {
  res.status(404).send({ error: "존재하지 않는 경로입니다" });
});

app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
  if (err instanceof SyntaxError && "body" in err) {
    return res.status(400).send({ error: "잘못된 JSON 형식입니다" });
  }
  console.error(err);
  res.status(500).send({ error: "서버 오류가 발생했습니다" });
});

app.listen(PORT, () => {
  console.log(`http://localhost:${PORT} 에서 서버가 열렸습니다.`);
});

import { Router } from "express";

const app = Router();

app.get("/", (req, res) => {
  res.send("ok");
});

app.post("/auth/sessions", async (req, res) => {});
app.get("/me", async (req, res) => {
  const userid = findSessionFromcache(req.session.id);
  const user = findUser(userid);
  return res.send({
    data: { id: user.id, role: user.role, displayName: user.displayName },
  });
});
app.post("/auth/sessions/me/delete", async (req, res) => {
  req.session.destroy((err) => {
    return res.status(500).send("로그아웃을 실패했습니다");
  });
  res.clearCookie("connect.sid");
  res.status(204).send();
});
app.post("/reports", async (req, res) => {});
app.get("/me/reports", async (req, res) => {});
app.post("/reports/:reportId/images", async (req, res) => {});

export { app as v1 };

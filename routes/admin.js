const express = require("express");
const path = require("path");
const { listRectifications, getRectification, listLoginAudit, PDF_DIR } = require("../utils/adminStore");

const router = express.Router();

function requireAdmin(req, res, next) {
  if (req.session?.admin?.ok) return next();
  return res.redirect("/admin/login");
}

router.get("/login", (req, res) => {
  if (req.session?.admin?.ok) return res.redirect("/admin");
  res.render("admin_login", { error: null });
});

router.post("/login", (req, res) => {
  const pass = String(req.body.password || "");
  const correct = String(process.env.ADMIN_PASSWORD || "admin123"); // fallback (change!)
  if (pass !== correct) return res.render("admin_login", { error: "Contraseña incorrecta" });

  req.session.admin = { ok: true, at: Date.now() };
  return res.redirect("/admin");
});

router.post("/logout", (req, res) => {
  req.session.admin = null;
  res.redirect("/admin/login");
});

router.get("/", requireAdmin, async (req, res) => {
  const q = String(req.query.q || "").toLowerCase().trim();
  const rects = await listRectifications();
  const logins = await listLoginAudit();

  const filtered = q
    ? rects.filter(r =>
        String(r.student?.code || "").toLowerCase().includes(q) ||
        String(r.student?.dni || "").toLowerCase().includes(q) ||
        String(r.student?.name || "").toLowerCase().includes(q)
      )
    : rects;

  res.render("admin_dashboard", {
    rects: filtered,
    logins: logins.slice(0, 200), // show recent 200
    q
  });
});

router.get("/rectifications/:id", requireAdmin, async (req, res) => {
  const rec = await getRectification(req.params.id);
  if (!rec) return res.status(404).send("Not found");
  res.render("admin_rectification_detail", { rec });
});

router.get("/rectifications/:id/pdf", requireAdmin, async (req, res) => {
  const rec = await getRectification(req.params.id);
  if (!rec || !rec.pdfFile) return res.status(404).send("No PDF");

  const filePath = path.join(PDF_DIR, rec.pdfFile);
  return res.download(filePath, rec.pdfFile);
});

module.exports = router;

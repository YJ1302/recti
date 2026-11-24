// routes/admin.js
const express = require("express");
const path = require("path");
const storage = require("../storage");
const { PDF_DIR } = require("../utils/adminStore");

const router = express.Router();

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

function requireAdmin(req, res, next) {
  const ok = req.session?.admin?.ok === true;
  if (ok) return next();
  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ ok: false, error: "admin_required" });
  }
  return res.redirect("/admin/login");
}

function formatTurno(x = {}) {
  const sec = x.group || x.groupCode || "—";
  const day = x.day || "—";
  const time = x.time || x.hour || "—";
  const modality = x.modality || "—";
  return {
    sec,
    day,
    time,
    modality,
    label: `Sec. ${sec}, ${day} ${time} (${modality})`,
  };
}

/**
 * GET /admin/api/rectification-changes?codigo=2320606&period=20261
 */
router.get("/api/rectification-changes", requireAdmin, asyncHandler(async (req, res) => {
  const codigo = String(req.query.codigo || "").trim();
  const period_id = String(req.query.period || process.env.CURRENT_PERIOD_ID || "").trim();

  if (!codigo) return res.status(400).json({ ok: false, error: "codigo_required" });
  if (!period_id) return res.status(400).json({ ok: false, error: "period_required" });

  const all = await storage.listRectifications();
  const rec = all.find(
    (r) => String(r.student?.code || "") === codigo && String(r.student?.period || "") === period_id
  );

  if (!rec) return res.json({ ok: true, exists: false });

  const rawChanges = Array.isArray(rec.changes) ? rec.changes : [];
  const changes = rawChanges.map((ch, i) => ({
    index: i + 1,
    codigo,
    courseCode: ch.code || ch.courseCode || "—",
    courseName: ch.name || ch.courseName || "—",
    before: formatTurno(ch.from || {}),
    after: formatTurno(ch.to || {}),
  }));

  return res.json({
    ok: true,
    exists: true,
    codigo,
    period_id,
    submitted_at: rec.submitted_at,
    changes,
  });
}));

// --------------------
// Admin login routes
// --------------------
router.get("/login", (req, res) => {
  if (req.session?.admin?.ok) return res.redirect("/admin");
  res.render("admin_login", { error: null });
});

const { rateLimit } = require("../utils/rateLimit");
const adminLoginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  onLimit: (req, res, wait) =>
    res.status(429).render("admin_login", {
      error: `Demasiados intentos. Vuelve a intentarlo en ${Math.ceil(wait / 60)} minuto(s).`,
    }),
});

router.post("/login", adminLoginLimiter, (req, res) => {
  const pass = String(req.body.password || "");
  // No built-in fallback password: if ADMIN_PASSWORD is not set, nobody can log in.
  const correct = String(process.env.ADMIN_PASSWORD || "");
  if (!correct) {
    return res.render("admin_login", { error: "El acceso admin no está configurado (falta ADMIN_PASSWORD)." });
  }
  if (pass !== correct) {
    return res.render("admin_login", { error: "Contraseña incorrecta" });
  }
  req.session.admin = { ok: true, at: Date.now() };
  return res.redirect("/admin");
});

router.post("/logout", (req, res) => {
  req.session.admin = null;
  return res.redirect("/admin/login");
});

// --------------------
// Admin dashboard pages
// --------------------
router.get("/", requireAdmin, asyncHandler(async (req, res) => {
  const q = String(req.query.q || "").toLowerCase().trim();
  const rects = await storage.listRectifications();
  const logins = await storage.listLoginAudit(200);

  const filtered = q
    ? rects.filter(
        (r) =>
          String(r.student?.code || "").toLowerCase().includes(q) ||
          String(r.student?.dni_last4 || "").toLowerCase().includes(q) ||
          String(r.student?.name || "").toLowerCase().includes(q)
      )
    : rects;

  res.render("admin_dashboard", {
    rects: filtered,
    logins: logins.slice(0, 200),
    q,
  });
}));

router.get("/rectifications/:id", requireAdmin, asyncHandler(async (req, res) => {
  const rec = await storage.getRectification(req.params.id);
  if (!rec) return res.status(404).send("Not found");
  res.render("admin_rectification_detail", { rec });
}));

router.get("/rectifications/:id/pdf", requireAdmin, asyncHandler(async (req, res) => {
  const rec = await storage.getRectification(req.params.id);
  if (!rec) return res.status(404).send("Not found");

  // Redirect to Drive URL if available
  if (rec.pdfUrl) return res.redirect(rec.pdfUrl);

  // Local fallback for dev
  if (rec.pdfFile) {
    const filePath = path.join(PDF_DIR, rec.pdfFile);
    const fs = require("fs");
    if (fs.existsSync(filePath)) return res.download(filePath, rec.pdfFile);
  }

  return res.status(404).send("No PDF");
}));

router.use((err, req, res, next) => {
  console.error("ADMIN ROUTE ERROR:", err?.response?.data || err?.message || err);
  if (req.path.startsWith("/api/")) {
    return res.status(500).json({ ok: false, error: "admin_route_failed" });
  }
  return res.status(500).send("Error interno del servidor (Admin).");
});

module.exports = router;

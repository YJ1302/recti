// routes/admin.js
const express = require("express");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const {
  listRectifications,
  getRectification,
  listLoginAudit,
  PDF_DIR,
} = require("../utils/adminStore");

const router = express.Router();

// ✅ Prevent unhandled promise rejections in async routes
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// ✅ Supabase (service role key => server-side only)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

// ✅ One admin guard that works for BOTH pages and API
function requireAdmin(req, res, next) {
  const ok = req.session?.admin?.ok === true;

  if (ok) return next();

  // If it's an API call => return JSON 401
  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ ok: false, error: "admin_required" });
  }

  // Otherwise redirect to admin login page
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
 * ✅ API route:
 * GET /admin/api/rectification-changes?codigo=2320606&period=20261
 */
router.get("/api/rectification-changes", requireAdmin, asyncHandler(async (req, res) => {
  try {
    const codigo = String(req.query.codigo || "").trim();
    const period_id = String(
      req.query.period || process.env.CURRENT_PERIOD_ID || ""
    ).trim();

    if (!codigo) {
      return res.status(400).json({ ok: false, error: "codigo_required" });
    }
    if (!period_id) {
      return res.status(400).json({ ok: false, error: "period_required" });
    }

    const { data, error } = await supabase
      .from("rectification_requests")
      .select("student_code, period_id, submitted_at, changes")
      .eq("student_code", codigo)
      .eq("period_id", period_id)
      .single();

    // no row
    if (error && String(error.code) === "PGRST116") {
      return res.json({ ok: true, exists: false });
    }
    if (error) throw error;

    const rawChanges = Array.isArray(data.changes) ? data.changes : [];

    const changes = rawChanges.map((ch, i) => ({
      index: i + 1,
      codigo: data.student_code,
      courseCode: ch.code || ch.courseCode || "—",
      courseName: ch.name || ch.courseName || "—",
      before: formatTurno(ch.from || {}),
      after: formatTurno(ch.to || {}),
    }));

    return res.json({
      ok: true,
      exists: true,
      codigo: data.student_code,
      period_id: data.period_id,
      submitted_at: data.submitted_at,
      changes,
    });
  } catch (e) {
    console.error("rectification-changes error:", e.message || e);
    return res.status(500).json({ ok: false, error: "failed_to_load_changes" });
  }
}));


// --------------------
// Admin login routes
// --------------------
router.get("/login", (req, res) => {
  if (req.session?.admin?.ok) return res.redirect("/admin");
  res.render("admin_login", { error: null });
});

router.post("/login", (req, res) => {
  const pass = String(req.body.password || "");
  const correct = String(process.env.ADMIN_PASSWORD || "admin123"); // change in env

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
  const rects = await listRectifications();
  const logins = await listLoginAudit();

  const filtered = q
    ? rects.filter(
        (r) =>
          String(r.student?.code || "").toLowerCase().includes(q) ||
          String(r.student?.dni || "").toLowerCase().includes(q) ||
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

  const rec = await getRectification(req.params.id);
  if (!rec) return res.status(404).send("Not found");
  res.render("admin_rectification_detail", { rec });
}));

router.get("/rectifications/:id/pdf", requireAdmin, asyncHandler(async (req, res) => {

  const rec = await getRectification(req.params.id);
  if (!rec) return res.status(404).send("Not found");

  // ✅ If PDF is stored in Supabase (public or signed URL already saved)
  if (rec.pdfUrl) return res.redirect(rec.pdfUrl);

  // ✅ Fallback: local PDF generation
  if (!rec.pdfFile && !rec.pdfPath) return res.status(404).send("No PDF");

  const fileName = rec.pdfFile || rec.pdfPath;
  const filePath = path.join(PDF_DIR, fileName);
  return res.download(filePath, fileName);
}));
// ✅ Router-level error handler (prevents Node crash)
router.use((err, req, res, next) => {
  console.error("ADMIN ROUTE ERROR:", err?.response?.data || err?.message || err);

  // API requests get JSON errors
  if (req.path.startsWith("/api/")) {
    return res.status(500).json({ ok: false, error: "admin_route_failed" });
  }

  // Page requests get a simple message (or render an error page if you want)
  return res.status(500).send("Error interno del servidor (Admin).");
});


module.exports = router;

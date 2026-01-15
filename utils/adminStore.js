// utils/adminStore.js
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

// Keep PDFs stored locally on your server
const PDF_DIR = path.join(__dirname, "..", "pdfs");

// --------------------
// LOGIN AUDIT
// --------------------
async function addLoginAudit({ at, student_code, status, ip, ua }) {
  const row = {
    at: at || new Date().toISOString(),
    student_code: String(student_code || "").trim(),
    status: String(status || "SUCCESS").toUpperCase(),
    ip: ip || null,
    ua: ua || null,
  };

  const { error } = await supabase.from("login_audit").insert(row);
  if (error) throw error;
}

async function listLoginAudit(limit = 200) {
  const { data, error } = await supabase
    .from("login_audit")
    .select("id, at, student_code, status, ip, ua")
    .order("at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data || [];
}

// --------------------
// RECTIFICATIONS
// --------------------
async function listRectifications() {
  const { data, error } = await supabase
    .from("rectification_requests")
    .select(
      "id, period_id, student_code, student_name, mode, submitted_at, changes, pdf_storage_path"
    )
    .order("submitted_at", { ascending: false })
    .limit(500);

  if (error) throw error;

  // Map into the shape your EJS already expects
  return (data || []).map((r) => ({
    id: r.id,
    createdAt: r.submitted_at,          // ✅ important for your old UI
    submitted_at: r.submitted_at,
    pdfFile: r.pdf_storage_path || null,
    student: {
      code: r.student_code,
      name: r.student_name,
      period: r.period_id,              // shown as "Periodo"
      mode: r.mode || "",
    },
    changes: Array.isArray(r.changes) ? r.changes : [],
  }));
}

async function getRectification(id) {
  const { data, error } = await supabase
    .from("rectification_requests")
    .select("*")
    .eq("id", id)
    .single();

  if (error) return null;

  return {
    id: data.id,
    createdAt: data.submitted_at,
    submitted_at: data.submitted_at,
    pdfFile: data.pdf_storage_path || null,
    student: {
      code: data.student_code,
      name: data.student_name,
      period: data.period_id,
      mode: data.mode || "",
      dni_last4: data.dni_last4 || "",
      email: data.email || "",
      phone: data.phone || "",
      faculty: data.faculty_name || "",
      program: data.specialty_name || "",
    },
    changes: Array.isArray(data.changes) ? data.changes : [],
    final_courses: Array.isArray(data.final_courses) ? data.final_courses : [],
    current_courses: Array.isArray(data.current_courses) ? data.current_courses : [],
  };
}

module.exports = {
  PDF_DIR,
  addLoginAudit,
  listLoginAudit,
  listRectifications,
  getRectification,
};

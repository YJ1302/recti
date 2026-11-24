// storage/supabaseStore.js — the storage the live Render site already uses (Supabase tables + PDFs on local disk).
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const adminStore = require("../utils/adminStore");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

async function getPortalState(period_id, student_code) {
  const { data, error } = await supabase
    .from("portal_state")
    .select("status,message,final_data")
    .eq("period_id", period_id)
    .eq("student_code", student_code)
    .single();
  if (error && String(error.code) === "PGRST116") return null;
  if (error) throw error;
  return data;
}

async function upsertPortalState({ period_id, student_code, boleta_number, dni_last4 }) {
  // first_login_at is deliberately not sent (don't overwrite it on every login)
  const { error } = await supabase
    .from("portal_state")
    .upsert(
      { period_id, student_code, boleta_number: boleta_number || null, dni_last4: dni_last4 || null },
      { onConflict: "period_id,student_code" }
    );
  if (error) throw error;
}

async function markPortalDone({ period_id, student_code, message, final_data }) {
  const { error } = await supabase
    .from("portal_state")
    .update({ status: "DONE", message: message || null, final_data: final_data || {}, done_at: new Date().toISOString() })
    .eq("period_id", period_id)
    .eq("student_code", student_code);
  if (error) throw error;
}

async function upsertRectificationRequest(row) {
  // The app also sends Drive fields; the Supabase table only has pdf_storage_path.
  const { pdf_drive_file_id, pdf_url, ...rest } = row;
  const payload = { ...rest, pdf_storage_path: rest.pdf_storage_path || pdf_drive_file_id || null };
  const { error } = await supabase.from("rectification_requests").upsert(payload, { onConflict: "period_id,student_code" });
  if (error) throw error;
}

async function uploadPdf({ filename, pdfBuffer }) {
  await fs.promises.mkdir(adminStore.PDF_DIR, { recursive: true });
  await fs.promises.writeFile(path.join(adminStore.PDF_DIR, filename), pdfBuffer);
  return { fileId: filename, pdfUrl: null };
}

module.exports = {
  getPortalState,
  upsertPortalState,
  markPortalDone,
  upsertRectificationRequest,
  uploadPdf,
  listRectifications: adminStore.listRectifications,
  getRectification: adminStore.getRectification,
  addLoginAudit: adminStore.addLoginAudit,
  listLoginAudit: adminStore.listLoginAudit,
};

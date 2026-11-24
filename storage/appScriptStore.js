// storage/appScriptStore.js
const axios = require("axios");

const API_URL = process.env.APPS_SCRIPT_API_URL;
const API_SECRET = process.env.APPS_SCRIPT_API_SECRET;

async function call(action, payload = {}) {
  if (!API_URL) throw new Error("APPS_SCRIPT_API_URL is not set");
  const { data } = await axios.post(
    API_URL,
    { secret: API_SECRET, action, payload },
    { headers: { "Content-Type": "application/json" }, timeout: 30000 }
  );
  if (data && data.ok === false) throw new Error(data.error || "Apps Script error");
  return data;
}

async function getPortalState(period_id, student_code) {
  const res = await call("getPortalState", { period_id, student_code });
  return res.data || null;
}

async function upsertPortalState({ period_id, student_code, boleta_number, dni_last4 }) {
  await call("upsertPortalState", { period_id, student_code, boleta_number, dni_last4 });
}

async function markPortalDone({ period_id, student_code, message, final_data }) {
  await call("markPortalDone", { period_id, student_code, message, final_data });
}

async function upsertRectificationRequest(row) {
  await call("upsertRectificationRequest", row);
}

async function listRectifications() {
  const res = await call("listRectifications", {});
  return res.data || [];
}

async function getRectification(id) {
  const res = await call("getRectification", { id });
  return res.data || null;
}

async function addLoginAudit(row) {
  await call("addLoginAudit", row);
}

async function listLoginAudit(limit = 200) {
  const res = await call("listLoginAudit", { limit });
  return res.data || [];
}

async function uploadPdf({ filename, pdfBuffer }) {
  const base64Pdf = pdfBuffer.toString("base64");
  const res = await call("uploadPdf", { filename, base64Pdf });
  return { fileId: res.fileId || null, pdfUrl: res.pdfUrl || null };
}

module.exports = {
  getPortalState,
  upsertPortalState,
  markPortalDone,
  upsertRectificationRequest,
  listRectifications,
  getRectification,
  addLoginAudit,
  listLoginAudit,
  uploadPdf,
};

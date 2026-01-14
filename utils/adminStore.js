const fs = require("fs");
const path = require("path");

const RECT_DIR = path.join(__dirname, "..", "data", "rectifications");
const PDF_DIR  = path.join(RECT_DIR, "pdfs");
const RECT_DB  = path.join(RECT_DIR, "rectifications.json");

const AUDIT_DIR = path.join(__dirname, "..", "data", "audit");
const LOGIN_DB  = path.join(AUDIT_DIR, "logins.json");

async function ensureDirs() {
  await fs.promises.mkdir(PDF_DIR, { recursive: true });
  await fs.promises.mkdir(AUDIT_DIR, { recursive: true });
}

async function readJson(file, fallback) {
  try {
    const txt = await fs.promises.readFile(file, "utf8");
    return JSON.parse(txt);
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(file, data) {
  const dir = path.dirname(file);
  await fs.promises.mkdir(dir, { recursive: true });

  const tmp = file + ".tmp";
  await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.promises.rename(tmp, file);
}

async function addRectification(record) {
  await ensureDirs();
  const list = await readJson(RECT_DB, []);
  list.unshift(record);
  await writeJsonAtomic(RECT_DB, list);
}

async function listRectifications() {
  await ensureDirs();
  return await readJson(RECT_DB, []);
}

async function getRectification(id) {
  const list = await listRectifications();
  return list.find(r => r.id === id) || null;
}

async function addLoginAudit(entry) {
  await ensureDirs();
  const list = await readJson(LOGIN_DB, []);
  list.unshift(entry);
  await writeJsonAtomic(LOGIN_DB, list);
}

async function listLoginAudit() {
  await ensureDirs();
  return await readJson(LOGIN_DB, []);
}

function getClientIp(req) {
  const xf = req.headers["x-forwarded-for"];
  if (xf) return String(xf).split(",")[0].trim();
  return req.socket?.remoteAddress || "";
}

module.exports = {
  RECT_DIR, PDF_DIR, RECT_DB,
  addRectification, listRectifications, getRectification,
  addLoginAudit, listLoginAudit,
  getClientIp
};

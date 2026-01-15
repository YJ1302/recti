// app.js
require("dotenv").config();

const express = require("express");
const axios = require("axios");
const path = require("path");
const session = require("express-session");
const PDFDocument = require("pdfkit");
const fs = require("fs");
const crypto = require("crypto");
const { addRectification, addLoginAudit, PDF_DIR } = require("./utils/adminStore");
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);


// Optional require for nodemailer
let nodemailer = null;
try {
  nodemailer = require("nodemailer");
} catch (e) {
  console.warn(
    "'nodemailer' is not installed. Emails will be skipped. Run `npm i nodemailer` to enable emailing."
  );
}

const app = express();
const PORT = process.env.PORT || 5000;

// Base URLs and credentials
const LOGIN_URL = process.env.LOGIN_BASE_URL; // e.g. http://37.60.229.241:8085/service-uma
const DATA_URL = process.env.DATA_BASE_URL;   // e.g. http://37.60.229.241:8085/service-uma/grupoa
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASS = process.env.ADMIN_PASS;
const AI_BASE_URL = process.env.AI_BASE_URL || "http://127.0.0.1:5055";
// ✅ Current period (latest)
const CURRENT_PERIOD_ID = String(process.env.CURRENT_PERIOD_ID || "20261").replace(/[^0-9]/g, "");


// Logo path (for PDF)
const LOGO_PATH = path.join(__dirname, "public", "images", "logo.png");

// Boleta verification endpoint (rectification payments)
const BOLETA_URL =
  process.env.BOLETA_API_URL || (DATA_URL + "/rectification_payments");

// Express setup
app.disable("x-powered-by");
app.set("views", path.join(__dirname, "views"));
app.set("view engine", "ejs");
app.set("trust proxy", 1);
// ✅ Global defaults for EJS variables (prevents "done is not defined")
app.use((req, res, next) => {
  res.locals.done = false;
  res.locals.doneMessage = null;
  res.locals.doneData = null;
  next();
});


app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.use(
  session({
    secret: process.env.SESSION_SECRET || "uma-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    },
  })
);
const adminRoutes = require("./routes/admin");
app.use("/admin", adminRoutes);


// Mail transport (no-reply)
const FROM_EMAIL =
  process.env.FROM_EMAIL || process.env.SMTP_USER || "noreply@uma.edu.pe";

// ✅ Normalize env vars properly + give a safe default host for Microsoft 365
const SMTP_HOST = process.env.SMTP_HOST || "smtp.office365.com";
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = String(process.env.SMTP_SECURE || "false").toLowerCase() === "true";

// Build transporter only if nodemailer + creds exist
const mailer =
  nodemailer &&
  process.env.SMTP_USER &&
  process.env.SMTP_PASS &&
  nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,     // ✅ boolean
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },

    // ✅ Office365 on 587 uses STARTTLS
    requireTLS: true,
    tls: { minVersion: "TLSv1.2" },

    // ✅ prevent long hangs
    connectionTimeout: 20000,
    greetingTimeout: 20000,
    socketTimeout: 20000,
  });

  if (mailer) {
    console.log(
      "SMTP settings",
      JSON.stringify({
        host: process.env.SMTP_HOST,
        port: process.env.SMTP_PORT,
        secure: String(process.env.SMTP_SECURE),
        from: FROM_EMAIL,
      })
    );

    const shouldVerify = process.env.SMTP_VERIFY_ON_BOOT === "true";
    if (shouldVerify) {
      mailer.verify((err) => {
        if (err) console.error("SMTP verify failed:", err.message);
        else console.log("SMTP verify OK. From:", FROM_EMAIL);
      });
    } else {
      console.log("SMTP verify skipped (set SMTP_VERIFY_ON_BOOT=true to enable)");
    }
  }


// Helpers
function jsonHeaders(token) {
  const h = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (token) h.Authorization = "Bearer " + token;
  return { headers: h };
}

async function upsertPortalState({ period_id, student_code, boleta_number, dni_last4 }) {
  const payload = {
    period_id,
    student_code,
    boleta_number: boleta_number || null,
    dni_last4: dni_last4 || null,
    // ❌ do NOT send first_login_at here (avoid overwriting on every login)
  };

  const { error } = await supabase
    .from("portal_state")
    .upsert(payload, { onConflict: "period_id,student_code" });

  if (error) throw error;
}

function getClientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  return (
    req.ip ||
    req.connection?.remoteAddress ||
    req.socket?.remoteAddress ||
    req.connection?.socket?.remoteAddress ||
    null
  );
}


async function getPortalState(period_id, student_code) {
  const { data, error } = await supabase
    .from("portal_state")
    .select("status,message,final_data")
    .eq("period_id", period_id)
    .eq("student_code", student_code)
    .single();

  // If no row exists, return null
  if (error && String(error.code) === "PGRST116") return null;
  if (error) throw error;
  return data;
}

async function markPortalDone({ period_id, student_code, message, final_data }) {
  const patch = {
    status: "DONE",
    message: message || null,
    final_data: final_data || {},
    done_at: new Date().toISOString(),
  };

  const { error } = await supabase
    .from("portal_state")
    .update(patch)
    .eq("period_id", period_id)
    .eq("student_code", student_code);

  if (error) throw error;
}

async function upsertRectificationRequest(row) {
  const { error } = await supabase
    .from("rectification_requests")
    .upsert(row, { onConflict: "period_id,student_code" });

  if (error) throw error;
}



function log(label, url, body) {
  console.log(`\n${label}\nURL: ${url}\nBODY: ${JSON.stringify(body)}`);
}

function fmtPeriod(p) {
  const s = String(p || "");
  return s.length === 5 ? `${s.slice(0, 4)}-${s.slice(4)}` : s;
}

function dayNameFromNumber(n) {
  const map = {
    1: "Lunes",
    2: "Martes",
    3: "Miércoles",
    4: "Jueves",
    5: "Viernes",
    6: "Sábado",
    7: "Domingo",
  };
  return map[n] || "";
}

function norm(s) {
  return String(s || "").replace(/[^A-Z0-9]/gi, "").toUpperCase();
}

function stripAcc(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normMod(m) {
  const t = stripAcc(String(m || "").toUpperCase().trim());
  if (t.includes("LAB")) return "LABORATORIO PRESENCIAL";
  if (t.includes("VIRT") || t.includes("TEV")) return "TEORÍA VIRTUAL";
  if (
    t.includes("PRE") ||
    t.includes("TEP") ||
    t.includes("TEORIA PRESENCIAL") ||
    t.includes("TEORÍA PRESENCIAL")
  )
    return "TEORÍA PRESENCIAL";
  return t || "—";
}

function dayToNumber(d) {
  const k = stripAcc(String(d || "").toLowerCase());
  const map = {
    lunes: 1,
    martes: 2,
    miercoles: 3,
    miércoles: 3,
    jueves: 4,
    viernes: 5,
    sabado: 6,
    sábado: 6,
    domingo: 7,
  };
  return map[k] || 0;
}

function numberToDay(n) {
  const map = {
    1: "Lunes",
    2: "Martes",
    3: "Miércoles",
    4: "Jueves",
    5: "Viernes",
    6: "Sábado",
    7: "Domingo",
  };
  return map[n] || "—";
}

// Canonical day + time helpers
function canonicalDayName(s) {
  const k = stripAcc(String(s || "")).toLowerCase();
  const map = {
    lunes: "Lunes",
    martes: "Martes",
    miercoles: "Miércoles",
    miércoles: "Miércoles",
    jueves: "Jueves",
    viernes: "Viernes",
    sabado: "Sábado",
    sábado: "Sábado",
    domingo: "Domingo",
  };
  return map[k] || (s || "—");
}

function parseTimeRange(range) {
  const m = String(range || "").match(
    /(\d{1,2}):(\d{2}).*?(\d{1,2}):(\d{2})/
  );
  if (!m) return null;
  const a = +m[1] * 60 + +m[2];
  const b = +m[3] * 60 + +m[4];
  return a <= b ? { start: a, end: b } : { start: b, end: a };
}

function rangesOverlap(a, b) {
  return a && b && a.start < b.end && b.start < a.end;
}

function sameDayKey(d) {
  return stripAcc(String(d || "")).toLowerCase();
}

function normalizePeriodDigits(p) {
  return String(p || "").replace(/[^0-9]/g, "");
}

function asPeriodNumber(p) {
  const digits = normalizePeriodDigits(p);
  const n = Number(digits);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function extractArrayFromApi(payload) {
  if (!payload) return [];

  // ✅ MOST IMPORTANT: if API already returns an array
  if (Array.isArray(payload)) return payload;

  // common wrappers
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.rows)) return payload.rows;
  if (Array.isArray(payload.result)) return payload.result;
  if (Array.isArray(payload.results)) return payload.results;
  if (Array.isArray(payload.items)) return payload.items;

  // sometimes nested: { data: { data: [...] } }
  if (payload.data && typeof payload.data === "object") {
    const nested = extractArrayFromApi(payload.data);
    if (nested.length) return nested;
  }

  return [];
}




function periodCandidates(rawPeriod) {
  const digits = normalizePeriodDigits(rawPeriod);
  const asNum = digits ? Number(digits) : null;
  const dashed = digits && digits.length === 5 ? `${digits.slice(0, 4)}-${digits.slice(4)}` : null;

  // try: number, digits-string, dashed-string
  const out = [];
  if (Number.isFinite(asNum) && asNum > 0) out.push(asNum);
  if (digits) out.push(digits);
  if (dashed) out.push(dashed);

  // also include rawPeriod if it's something else
  if (rawPeriod && !out.includes(rawPeriod)) out.push(rawPeriod);

  // remove duplicates (but keep type differences)
  return out.filter((v, i, arr) => arr.findIndex(x => x === v) === i);
}

async function postAdmin(req, url, body) {
  let tok = await ensureAdminToken(req);
  try {
    return await axios.post(url, body, jsonHeaders(tok));
  } catch (e) {
    const st = e?.response?.status;
    if (st === 401 || st === 403) {
      req.session.adminToken = null;
      tok = await ensureAdminToken(req);
      return await axios.post(url, body, jsonHeaders(tok));
    }
    throw e;
  }
}

async function postAdminWithPeriodFallback(req, url, baseBody, rawPeriod, label = "POST") {
  const candidates = periodCandidates(rawPeriod);
  let lastErr = null;

  for (const p of candidates) {
    const body = { ...baseBody, period: p };
    log(`${label} (period=${String(p)})`, url, body);

    try {
      return await postAdmin(req, url, body);
    } catch (e) {
      lastErr = e;

      const st = e?.response?.status;
      const errors =
        e?.response?.data?.data?.errors ||
        e?.response?.data?.errors ||
        null;

      // Only retry another format if the API specifically complains about "period"
      if (st === 422 && errors && errors.period) {
        continue;
      }

      // Otherwise don't hide the real error
      throw e;
    }
  }

  throw lastErr || new Error("All period formats failed");
}


/**
 * ✅ Ensure admin token exists (and re-login if needed)
 */
async function ensureAdminToken(req) {
  let adminToken = req.session && req.session.adminToken;
  if (adminToken) return String(adminToken);

  const adminLoginUrl = LOGIN_URL + "/login";
  log("Admin login (ensureAdminToken)", adminLoginUrl, {
    email: ADMIN_EMAIL,
    password: "***",
  });

  const admin = await axios.post(
    adminLoginUrl,
    { email: ADMIN_EMAIL, password: ADMIN_PASS },
    jsonHeaders()
  );

  adminToken = admin.data && admin.data.access_token;
  if (!adminToken) throw new Error("Admin login failed (no token).");

  req.session.adminToken = String(adminToken);
  return String(adminToken);
}

async function autoVerifyBoletaForStudent(req) {
  const student = req.session.student;
  const profile = req.session.profile;

  if (!student || !profile) return { ok: false, ticket: null };

  const normalizeTicketKey = (s) =>
    String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

  const normalizeIdKey = (s) =>
    String(s || "").replace(/[^0-9]/g, "");

  const normalizePeriodDigits = (s) =>
    String(s || "").replace(/[^0-9]/g, "");

  // ensure admin token
  await ensureAdminToken(req);

  const rawPeriod = CURRENT_PERIOD_ID; // ✅ always verify against latest period

  const periodDigits = normalizePeriodDigits(rawPeriod);
  if (!periodDigits) return { ok: false, ticket: null };

  // call API (same as verify-boleta but without ticket)
  const resp = await postAdminWithPeriodFallback(
    req,
    BOLETA_URL,
    {},
    rawPeriod,
    "Auto boleta verification"
  );

  const rows = extractArrayFromApi(resp.data || {});
  if (!Array.isArray(rows) || rows.length === 0) return { ok: false, ticket: null };

  const myPeriod = normalizeIdKey(CURRENT_PERIOD_ID);

  const myCode = normalizeIdKey(student.codigo);
  const myDni = normalizeIdKey(profile.dni || student.dni || "");

  const match = rows.find((r) => {
    const rPeriod = normalizeIdKey(r.period);
    const rCode = normalizeIdKey(r.codAlu || r.codigo || r.code || r.c_codalu);
    const rDni = normalizeIdKey(r.dni || "");

    const sameStudent =
      (myCode && rCode && rCode === myCode) ||
      (myDni && rDni && rDni === myDni);

    return rPeriod === myPeriod && sameStudent;
  });

  if (!match) return { ok: false, ticket: null };

  const ticketRaw =
    match.number_ticket ||
    match.numberTicket ||
    match.boleta ||
    match.numBoleta ||
    match.nroBoleta ||
    "";

  const ticket = normalizeTicketKey(ticketRaw);

  return { ok: true, ticket: ticket || null };
}

function normalizeCourseNumberRows(rows) {
  const arr = Array.isArray(rows) ? rows : [];

  return arr.map((r) => {
    const groupCode =
      r.courseGroup ||
      r.course_group ||
      r.group ||
      r.section ||
      r.courseGroupCode ||
      r.course_group_code ||
      "";

    const numberEnrolledRaw =
      r.number_enrolled ?? r.numberEnrolled ?? r.enrolled ?? r.matriculados ?? 0;
    const totalVacationsRaw =
      r.total_vacations ??
      r.totalVacations ??
      r.total_vacantes ??
      r.totalVacantes ??
      r.vacantes ??
      0;

    const number_enrolled = Number(numberEnrolledRaw);
    const total_vacations = Number(totalVacationsRaw);

    const enrolledOk = Number.isFinite(number_enrolled) ? number_enrolled : 0;
    const vacOk = Number.isFinite(total_vacations) ? total_vacations : 0;

    // ✅ AVAILABLE = vacantes - matriculados
    const vacancies_left = Math.max(0, vacOk - enrolledOk);

    return {
      period: r.period,
      facultyCode: r.facultyCode,
      specialtyCode: r.specialtyCode,
      plan: r.plan,
      modalityCode: r.modalityCode,
      courseCode: r.courseCode,
      groupCode,

      number_enrolled: enrolledOk,
      total_vacations: vacOk,
      vacancies_left,
      is_full: vacancies_left <= 0,

      raw: r,
    };
  });
}


/**
 * ✅ Build a quick map by group for merging into /available results
 */
async function getVacancyMapForCourse(req, period, courseCode) {
  const url = DATA_URL + "/course-number-enrolled";
  const rawPeriod = String(period || "");
  const courseCodeClean = String(courseCode || "").trim();

  const resp = await postAdminWithPeriodFallback(
    req,
    url,
    { courseCode: courseCodeClean },
    rawPeriod,
    "Fetch vacancies (admin)"
  );

  const payload = resp.data || {};
  const rows = extractArrayFromApi(payload);

  const normalized = normalizeCourseNumberRows(rows);

  const map = {};
  normalized.forEach((x) => {
    const k = norm(x.groupCode);
    if (!k) return;
    map[k] = x;
  });

  return { normalized, map };
}


// Extract the courses map from API payload
function extractCoursesMap(root) {
  if (!root || typeof root !== "object") return {};
  if (root.courseList && typeof root.courseList === "object")
    return root.courseList;

  const wrappers = [
    "data",
    "result",
    "payload",
    "available",
    "availableCourses",
    "items",
    "courses",
  ];
  for (const w of wrappers) {
    const obj = root[w];
    if (
      obj &&
      typeof obj === "object" &&
      obj.courseList &&
      typeof obj.courseList === "object"
    ) {
      return obj.courseList;
    }
  }

  const metaKey =
    /^(period|student|specialty|status|message|code|.*_code|.*_id)$/i;
  const keys = Object.keys(root);
  const plausible = keys.filter((k) => !metaKey.test(k));
  if (plausible.length) {
    const sample = root[plausible[0]];
    if (
      sample &&
      typeof sample === "object" &&
      ("groups" in sample || "courseName" in sample)
    ) {
      return plausible.reduce((acc, k) => {
        acc[k] = root[k];
        return acc;
      }, {});
    }
  }
  return {};
}

// Flatten available for UI
function flattenAvailable(coursesMap) {
  const out = [];
  const codes = Object.keys(coursesMap || {});

  for (const code of codes) {
    const courseObj = coursesMap[code] || {};
    const name = courseObj.courseName || "";
    const theCycle = courseObj.courseCycle || null;
    const groups = courseObj.groups || {};

    const groupEntries = Array.isArray(groups)
      ? groups.map((g) => [g.courseGroup || g.group || g.section || "", g])
      : Object.entries(groups);

    const groupMap = {};
    let courseHasTheory = false;
    let courseHasLab = false;

    for (const [gKey, gRaw] of groupEntries) {
      const g = gRaw || {};
      const groupCode = g.courseGroup || g.group || g.section || gKey;
      if (!groupCode) continue;

      const mapKey = norm(groupCode);
      if (!groupMap[mapKey]) {
        groupMap[mapKey] = {
          groupCode,
          sessions: [],
        };
      }

      const sessions = Array.isArray(g.sessions)
        ? g.sessions
        : Array.isArray(g)
        ? g
        : [];

      sessions.forEach((s) => {
        const day = s.dayName || dayNameFromNumber(s.day);
        const start = s.start || s.hourStart || s.hourIni || "";
        const end = s.end || s.hourEnd || s.hourFin || "";
        const modalityRaw = s.modality || g.modality || courseObj.modality || "";
        const modalityNorm = normMod(modalityRaw);

        let type = "O";
        if (modalityNorm.includes("LABORATORIO")) type = "L";
        else if (
          modalityNorm.includes("TEORÍA") ||
          modalityNorm.includes("TEORIA") ||
          modalityNorm.includes("VIRTUAL")
        )
          type = "T";

        if (type === "T") courseHasTheory = true;
        if (type === "L") courseHasLab = true;

        groupMap[mapKey].sessions.push({
          day,
          start,
          end,
          modality: modalityRaw,
          modalityNorm,
          type,
        });
      });
    }

    const requirePair = courseHasTheory && courseHasLab;

    Object.values(groupMap).forEach((gInfo) => {
      const hasT = gInfo.sessions.some((s) => s.type === "T");
      const hasL = gInfo.sessions.some((s) => s.type === "L");

      if (requirePair && !(hasT && hasL)) {
        return;
      }

      const pieces = gInfo.sessions.map((s) => {
        const t = [s.start, s.end].filter(Boolean).join("–");
        const modSuffix = s.modality ? ` (${s.modality})` : "";
        return `${s.day} ${t}${modSuffix}`;
      });

      const first = gInfo.sessions[0] || {};
      out.push({
        courseCode: code,
        courseName: name,
        courseCycle: theCycle,
        groupCode: gInfo.groupCode,
        scheduleText: pieces.join(" • "),
        modality: first.modality || "",
        teacherName: "—",
        day: "",
        hour: "",
        sessions: gInfo.sessions,

        // ✅ new fields (merged later in /available)
        number_enrolled: null,
        total_vacations: null,
        vacancies_left: null,
        is_full: false,
      });
    });
  }

  out.sort((a, b) => String(a.groupCode).localeCompare(String(b.groupCode)));
  return out;
}

// Flatten available for AI
function flattenAvailableForAI(coursesMap) {
  const out = {};
  Object.keys(coursesMap || {}).forEach((code) => {
    const courseObj = coursesMap[code] || {};
    const groups = courseObj.groups || {};
    const groupEntries = Array.isArray(groups)
      ? groups.map((g) => [g.courseGroup || g.group || g.section || "", g])
      : Object.entries(groups);

    const rows = [];
    groupEntries.forEach(([gKey, gRaw]) => {
      const g = gRaw || {};
      const group = g.courseGroup || g.group || g.section || gKey;
      const sessions = Array.isArray(g.sessions) ? g.sessions : [];

      if (!sessions.length) {
        rows.push({
          courseCode: code,
          courseName: courseObj.courseName || "",
          group,
          day: "",
          time: "",
          teacherName: g.teacherName || "",
          modality: g.modality || "",
        });
      } else {
        sessions.forEach((s) => {
          const day = s.dayName || dayNameFromNumber(s.day);
          const time = (s.hour ||
            s.time ||
            s.schedule ||
            `${s.start || ""}-${s.end || ""}`
          ).replace(/\s+–\s+|\s+-\s+| – | - /g, "-");
          rows.push({
            courseCode: code,
            courseName: courseObj.courseName || "",
            group,
            day,
            time,
            teacherName: s.teacherName || g.teacherName || "",
            modality: s.modality || g.modality || courseObj.modality || "",
          });
        });
      }
    });

    out[code] = rows;
  });
  return out;
}

function pickBestKey(requestedCode, keys) {
  const nReq = norm(requestedCode);
  if (!nReq) return null;
  for (const k of keys) if (norm(k) === nReq) return k;
  for (const k of keys)
    if (norm(k).startsWith(nReq) || nReq.startsWith(norm(k))) return k;
  for (const k of keys)
    if (norm(k).includes(nReq) || nReq.includes(norm(k))) return k;
  return null;
}

// Collect PDFDocument into Buffer
function pdfToBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on("data", (d) => chunks.push(d));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}

async function requireVerifiedStudent(req, res, next) {
  const s = req.session?.student;
  const profile = req.session?.profile;

  // Not logged in
  if (!s || !profile) {
    if (req.accepts("html")) return res.redirect("/");
    return res.status(401).json({ error: "not_logged_in" });
  }

  // Already verified
  if (req.session.boletaVerified) return next();

  // If session lost the flag, auto-verify again
  try {
    const { ok, ticket } = await autoVerifyBoletaForStudent(req);
    req.session.boletaVerified = ok;
    req.session.boletaNumber = ticket || null;

    if (ok) return next();
  } catch (e) {
    console.error("autoVerifyBoletaForStudent failed:", e?.message || e);
  }

  // Still not verified => block access and force login again
  if (req.accepts("html")) return res.redirect("/?err=boleta");
  return res.status(403).json({ error: "boleta_not_verified" });
}



// Health check
app.get("/healthz", (_, res) => res.status(200).send("ok"));

// Root: login form or main portal (rendered by EJS)
app.get("/", (_, res) => {
  res.render("index", {
    firstName: null,
    lastName: null,
    studentId: null,
    semester: null,
    department: null,
    schedules: [],
    available: [],
    dni: null,
    email_institucional: null,
    phone: null,
    facultyName: null,
    specialtyName: null,
    facultyCode: null,
    specialtyCode: null,
    gender: null,
    age: null,
    mode: null,
    period: null,
    periodCode: null,
    error: null,
  });
});

// Login: student + admin + profile + schedules, then show boleta screen
app.post("/login", async (req, res) => {
  const codigo = req.body.codigo;
  const dni = req.body.dni;

  try {
    // 1) Student login
    const loginAlumnoUrl = LOGIN_URL + "/login-alumno";
    log("Student login", loginAlumnoUrl, { codigo, dni });
    const stud = await axios.post(
      loginAlumnoUrl,
      { codigo, dni },
      jsonHeaders()
    );
    const studentToken = stud.data && stud.data.access_token;
    const periodCode = stud.data && stud.data.periodCode;
    const studentCode =
      (stud.data && stud.data.user && stud.data.user.c_codalu) ||
      String(codigo);
    if (!studentToken) throw new Error("Student login failed (no token).");

    const code = String(studentCode);

    try {
    await addLoginAudit({
      at: new Date().toISOString(),
      student_code: String(code),
      status: "SUCCESS",
      ip: getClientIp(req),
      ua: req.headers["user-agent"] || "",
    });
  } catch (e) {
    console.warn("addLoginAudit failed:", e?.message || e);
  }

    const periodFromLogin = String(periodCode || "");

    // 2) Admin login for grupoa endpoints
    // (store in session, also used later)
    req.session.adminToken = null;
    const adminToken = await ensureAdminToken(req);

    // 3) Profile
    const profileUrl = DATA_URL + "/student";
    const profileBody = { code, period: periodFromLogin || undefined };
    log("Profile fetch", profileUrl, profileBody);
    const prof = await axios.post(
      profileUrl,
      profileBody,
      jsonHeaders(adminToken)
    );
    const info = prof.data && prof.data.data;
    if (!info) throw new Error("Profile endpoint returned no data.");

    const firstName = info.name || info.c_nomalu || "";
    const lastName = info.lastname || info.c_apealu || "";
    const fullName = `${firstName} ${lastName}`.trim();

    const profileOut = {
    dni: info.dni || "",
    email_institucional: info.email_institucional || "",
    phone: info.phone || "",
    facultyName: info.facultyName || "",
    specialtyName: info.specialtyName || "",
    facultyCode: info.facultyCode || "",
    specialtyCode: info.specialtyCode || "",
    gender: info.gender || "",
    age: info.age !== undefined && info.age !== null ? String(info.age) : "",
    mode: info.mode || "",
    period: String(info.period || periodFromLogin || ""),
    periodCode: info.periodCode || "",

    // ✅ NEW (these are likely required by course-number-enrolled)
    plan: info.plan ?? info.planCode ?? info.plan_code ?? null,
    modalityCode: info.modalityCode ?? info.modality_code ?? info.modeCode ?? info.mode_code ?? null,
  };
  // ✅ BLOCK if student's period is not the latest
const loginPeriodDigits = String(profileOut.period || "").replace(/[^0-9]/g, "");
if (loginPeriodDigits !== CURRENT_PERIOD_ID) {
  req.session.destroy(() => {});
  return res.render("index", {
    firstName: null,
    lastName: null,
    studentId: null,
    semester: null,
    department: null,
    schedules: [],
    available: [],
    dni: null,
    email_institucional: null,
    phone: null,
    facultyName: null,
    specialtyName: null,
    facultyCode: null,
    specialtyCode: null,
    gender: null,
    age: null,
    mode: null,
    period: null,
    periodCode: null,
    error: `No puedes ingresar. Tu periodo es ${fmtPeriod(loginPeriodDigits)} pero el portal solo permite rectificación del periodo ${fmtPeriod(CURRENT_PERIOD_ID)}.`,
    
    done: false,
    doneMessage: null,
    doneData: null,

  });
}

    // 4) Enrolled schedules
    const schedulesUrl = DATA_URL + "/course-schedules";
    const schBody = { code, period: profileOut.period };
    log("Course schedules", schedulesUrl, schBody);
    const sch = await axios.post(
      schedulesUrl,
      schBody,
      jsonHeaders(adminToken)
    );
    const list = sch?.data && Array.isArray(sch.data.data) ? sch.data.data : [];

    const schedules = list.map((s) => ({
      courseCode: s.courseCode || s.c_codcur || "—",
      courseName: s.courseName || "—",
      groupCode: s.groupCode || s.section || "—",
      modality: s.modality || s.modalityDescription || "—",
      day: s.day || "—",
      hour: s.hour || "—",
      teacherName: s.teacherName || "—",
      credits: Number(s.credits || s.credit || 0),
      period: String(s.period || profileOut.period || ""),
    }));

    // Save session
req.session.student = {
  token: String(studentToken),
  codigo: code,
  dni: String(dni || ""),
  defaultPeriod: String(profileOut.period || periodFromLogin || ""),
  name: fullName,
};
req.session.profile = profileOut;
req.session.enrolled = schedules;
req.session.firstName = firstName;
req.session.lastName = lastName;

// ✅ Auto verify boleta during login (no user input)
const { ok, ticket } = await autoVerifyBoletaForStudent(req);
req.session.boletaVerified = ok;
req.session.boletaNumber = ticket || null;

// =========================
// ✅ Supabase portal_state check (after boleta verification)
// =========================
const period_id = CURRENT_PERIOD_ID;
const student_code = String(code);
const dni_last4 = String(profileOut.dni || dni || "").slice(-4) || null;

// If no boleta => don't create portal_state; just block as you already do
if (ok) {
  await upsertPortalState({
    period_id,
    student_code,
    boleta_number: ticket || "—",
    dni_last4,
  });

  const ps = await getPortalState(period_id, student_code);

  // ✅ If DONE => block login and show details/message
  if (ps && ps.status === "DONE") {
    req.session.destroy(() => {});
    return res.render("index", {
      firstName: null,
      lastName: null,
      studentId: null,
      semester: null,
      department: null,
      schedules: [],
      available: [],
      dni: null,
      email_institucional: null,
      phone: null,
      facultyName: null,
      specialtyName: null,
      facultyCode: null,
      specialtyCode: null,
      gender: null,
      age: null,
      mode: null,
      period: null,
      periodCode: null,
      error: null,
      done: true,
      doneMessage:
        ps.message ||
        "Tu solicitud ya fue enviada. No puedes ingresar nuevamente.",
      doneData: ps.final_data || {},
    });
  }
}


// ❌ If no boleta exists for this student+period, block access (NO boleta page)
if (!ok) {
  req.session.destroy(() => {});
  return res.render("index", {
    firstName: null,
    lastName: null,
    studentId: null,
    semester: null,
    department: null,
    schedules: [],
    available: [],
    dni: null,
    email_institucional: null,
    phone: null,
    facultyName: null,
    specialtyName: null,
    facultyCode: null,
    specialtyCode: null,
    gender: null,
    age: null,
    mode: null,
    period: null,
    periodCode: null,
    error:
      "No se encontró una boleta válida para este periodo y código. Contacta con soporte.",
  });
}

// ✅ If ok, go directly to portal (index)
return res.render("index", {
  firstName,
  lastName,
  studentId: code,
  semester: fmtPeriod(profileOut.period),
  department: profileOut.specialtyName,
  schedules,
  available: [],
  dni: profileOut.dni,
  email_institucional: profileOut.email_institucional,
  phone: profileOut.phone,
  facultyName: profileOut.facultyName,
  specialtyName: profileOut.specialtyName,
  facultyCode: profileOut.facultyCode,
  specialtyCode: profileOut.specialtyCode,
  gender: profileOut.gender,
  age: profileOut.age,
  mode: profileOut.mode,
  period: profileOut.period,
  periodCode: profileOut.periodCode,
  error: null,
});

  } catch (err) {
    try {
    await addLoginAudit({
      at: new Date().toISOString(),
      student_code: String(req.body?.codigo || ""),
      status: "FAIL",
      ip: getClientIp(req),
      ua: req.headers["user-agent"] || "",
    });
  } catch (e) {
    console.warn("addLoginAudit failed:", e?.message || e);
  }

    console.error(
      "Login error:",
      err.response && err.response.status,
      err.response ? err.response.data : err.message
      
    );
    return res.render("index", {
      firstName: null,
      lastName: null,
      studentId: null,
      semester: null,
      department: null,
      schedules: [],
      available: [],
      dni: null,
      email_institucional: null,
      phone: null,
      facultyName: null,
      specialtyName: null,
      facultyCode: null,
      specialtyCode: null,
      gender: null,
      age: null,
      mode: null,
      period: null,
      periodCode: null,
      error: "Error al iniciar sesión u obtener datos. Revisa tus credenciales.",
    });
  }
});

/* ------------ verify boleta after login ------------ */
app.post("/verify-boleta", (req, res) => {
  return res.redirect("/"); // not used anymore
});


// AJAX: available groups for one course (+ vacancies merge)
app.post("/available", requireVerifiedStudent, async (req, res) => {
  try {
    const s = req.session.student;
    if (!s || !s.token) return res.status(401).json({ error: "not_logged_in" });

    const period = String((req.body && req.body.period) || s.defaultPeriod || "");
    const courseCode = (req.body && req.body.courseCode) || "";

    const body = { codigo: s.codigo, period };
    if (s.dni) body.dni = s.dni;

    const saUrl = LOGIN_URL + "/student/schedule-available";
    log("Schedule available (student token, RAW JSON)", saUrl, body);

    const sa = await axios.post(saUrl, body, jsonHeaders(s.token));

    const root = (sa.data && sa.data.data) || sa.data;
    const coursesMap = extractCoursesMap(root);
    const theKeys = Object.keys(coursesMap || {});
    const bestKey = pickBestKey(courseCode, theKeys);

    let filtered = [];
    const usedCourseCode = bestKey || courseCode;

    if (bestKey && coursesMap[bestKey]) {
      filtered = flattenAvailable({ [bestKey]: coursesMap[bestKey] });
    } else if (coursesMap[courseCode]) {
      filtered = flattenAvailable({ [courseCode]: coursesMap[courseCode] });
    }

    // ✅ NEW: merge vacancies info into each turno row
    if (filtered.length && usedCourseCode) {
      try {
        const { map } = await getVacancyMapForCourse(req, period, usedCourseCode);
        filtered = filtered.map((g) => {
          const rec = map[norm(g.groupCode)];
          if (!rec) return g;
          return {
            ...g,
            number_enrolled: rec.number_enrolled,
            total_vacations: rec.total_vacations,
            vacancies_left: rec.vacancies_left,
            is_full: rec.is_full,
          };
        });
      } catch (e) {
        console.warn("Vacancy merge failed (available):", e?.response?.data || e.message);
      }
    }

    return res.json({
      data: filtered,
      courseKeys: theKeys,
      bestKey,
      requestedCode: courseCode,
      usedCourseCode,
    });
  } catch (e) {
    console.error(
      "/available error:",
      e.response && e.response.status,
      e.response ? e.response.data : e.message
    );
    res.status(500).json({ error: "failed_to_load_available" });
  }
});

// AJAX: number of enrolled students per group for one course (normalized + vacancies_left + is_full)
app.post("/course-number-enrolled", requireVerifiedStudent, async (req, res) => {
  try {
    const student = req.session.student;
    if (!student || !student.codigo) {
      return res.status(401).json({ status: 401, message: "not_logged_in", data: [] });
    }

    const period = String((req.body && req.body.period) || student.defaultPeriod || "");
    const courseCode = String((req.body && req.body.courseCode) || "").trim();

    if (!period || !courseCode) {
      return res.status(400).json({
        status: 400,
        message: "period and courseCode required",
        data: [],
      });
    }

    const { normalized } = await getVacancyMapForCourse(req, period, courseCode);

    return res.json({
      status: 200,
      data: normalized,
    });
  } catch (err) {
    console.error(
      "/course-number-enrolled error:",
      err.response && err.response.status,
      err.response ? err.response.data : err.message
    );
    return res.status(500).json({
      status: 500,
      message: "failed_to_load_course_number_enrolled",
      data: [],
    });
  }
});

// Proxy to external AI microservice (optional)
app.post("/ai-suggest", requireVerifiedStudent, async (req, res) => {
  try {
    const s = req.session.student;
    const prof = req.session.profile || {};
    const enrolled = req.session.enrolled || [];
    if (!s || !s.token) return res.status(401).json({ error: "not_logged_in" });

    const current = enrolled.map((e) => ({
      courseCode: e.courseCode,
      courseName: e.courseName,
      groupCode: e.groupCode,
      day: e.day,
      hour: e.hour,
      teacherName: e.teacherName,
      modality: e.modality,
    }));

    const body = {
      codigo: s.codigo,
      period: prof.period || s.defaultPeriod || undefined,
    };
    if (s.dni) body.dni = s.dni;

    const saUrl = LOGIN_URL + "/student/schedule-available";
    const sa = await axios.post(saUrl, body, jsonHeaders(s.token));
    const root = (sa.data && sa.data.data) || sa.data;
    const coursesMap = extractCoursesMap(root);
    const available = flattenAvailableForAI(coursesMap);

    const preferences = {
      timePreference:
        req.body?.preferences?.timePreference ??
        req.body?.timePreference ??
        "no-preference",
      freeDays:
        (Array.isArray(req.body?.preferences?.freeDays) &&
          req.body.preferences.freeDays) ||
        (Array.isArray(req.body?.freeDays) && req.body.freeDays) ||
        [],
      keepChangesLow:
        req.body?.preferences?.keepChangesLow ??
        (req.body?.keepChangesLow !== false),
    };

    const { data } = await axios.post(
      `${AI_BASE_URL}/generate`,
      { current, available, preferences },
      jsonHeaders()
    );

    return res.json(data);
  } catch (e) {
    console.error(
      "/ai-suggest error:",
      e.response?.status,
      e.response?.data || e.message
    );
    res.status(500).json({ error: "ai_suggest_failed" });
  }
});

// Local AI-like generator (server-side heuristic)
app.post("/ai-local", requireVerifiedStudent, async (req, res) => {
  try {
    const s = req.session.student;
    const profile = req.session.profile || {};
    const enrolled = req.session.enrolled || [];

    if (!s || !s.token) {
      return res.status(401).json({ error: "not_logged_in" });
    }

    

    const rawPrefs = (req.body && (req.body.preferences || req.body)) || {};
    const freeDays = Array.isArray(rawPrefs.freeDays) ? rawPrefs.freeDays : [];
    const freeDayKeys = new Set(freeDays.map((d) => sameDayKey(d)));
    const wantsFreeDays = freeDayKeys.size > 0;

    // ✅ IMPORTANT FIX:
    // If keepChangesLow is TRUE (default), we ONLY try to change courses
    // that violate the requested freeDays. Otherwise, your system changes
    // groups even when it doesn't help (same day/time).
    const keepChangesLow = rawPrefs.keepChangesLow !== false;

    // 1) fetch all available once
    const body = {
      codigo: s.codigo,
      period: profile.period || s.defaultPeriod || undefined,
    };
    if (s.dni) body.dni = s.dni;

    const saUrl = LOGIN_URL + "/student/schedule-available";
    log("Schedule available (AI-local)", saUrl, body);
    const sa = await axios.post(saUrl, body, jsonHeaders(s.token));

    const root = (sa.data && sa.data.data) || sa.data;
    const coursesMap = extractCoursesMap(root);
    const availableByCode = flattenAvailableForAI(coursesMap);

    // 2) group current timetable by course
    const currentByCode = {};
    enrolled.forEach((e) => {
      const code = e.courseCode || e.c_codcur || "";
      if (!code) return;
      if (!currentByCode[code]) {
        currentByCode[code] = {
          courseCode: code,
          courseName: e.courseName || "",
          group: e.groupCode || e.section || "",
          segments: [],
        };
      }
      currentByCode[code].segments.push({
        day: canonicalDayName(e.day || ""),
        time: String(e.hour || e.time || "").trim(),
        modality: e.modality || "",
      });
    });

    // 3) build initial slots (conflict tracking)
    let planSlots = [];
    Object.values(currentByCode).forEach((c) => {
      c.segments.forEach((seg) => {
        const rng = parseTimeRange(seg.time);
        if (!rng) return;
        planSlots.push({
          code: c.courseCode,
          day: seg.day,
          start: rng.start,
          end: rng.end,
        });
      });
    });

    const changes = [];
    const finalCourses = [];
    const unsatisfied = [];
    const blocked = [];  
    const skippedFullGroups = [];

    function groupAvailableRows(code, rows, fallbackName) {
      const byGroup = {};
      rows.forEach((r) => {
        const g = r.group || r.groupCode || r.section || "";
        if (!g) return;
        if (!byGroup[g]) {
          byGroup[g] = {
            group: g,
            courseName: r.courseName || fallbackName || "",
            segments: [],
          };
        }
        byGroup[g].segments.push({
          day: canonicalDayName(r.day || r.dayName || ""),
          time: String(r.time || "").trim(),
          modality: r.modality || "",
        });
      });
      return Object.values(byGroup);
    }

    function testCandidate(code, candidate, strictFreeDays) {
      for (const seg of candidate.segments) {
        const dayKey = sameDayKey(seg.day);
        if (strictFreeDays && wantsFreeDays && freeDayKeys.has(dayKey)) {
          return { reason: "freeDay" };
        }
        const rng = parseTimeRange(seg.time);
        if (!rng) continue;

        for (const slot of planSlots.filter((p) => p.code !== code)) {
          if (sameDayKey(slot.day) !== dayKey) continue;
          if (rangesOverlap(rng, slot)) {
            return { reason: "conflict", with: slot };
          }
        }
      }
      return null;
    }

    function segmentsSignature(segments) {
      const sig = segments
        .map((s) => `${sameDayKey(s.day)}|${String(s.time || "").trim()}`)
        .sort()
        .join(";");
      return sig;
    }

    // ✅ cache vacancies by course
    const vacancyCache = {};
    async function getVacMap(code) {
      if (vacancyCache[code]) return vacancyCache[code];
      try {
        const period = profile.period || s.defaultPeriod || "";
        const { map } = await getVacancyMapForCourse(req, period, code);
        vacancyCache[code] = map;
      } catch (e) {
        vacancyCache[code] = {};
      }
      return vacancyCache[code];
    }

    for (const [code, cur] of Object.entries(currentByCode)) {
      // ✅ If no free-days requested, and keepChangesLow => keep everything
      if (keepChangesLow && !wantsFreeDays) {
        cur.segments.forEach((seg) => {
          finalCourses.push({
            code,
            name: cur.courseName,
            group: cur.group,
            day: seg.day,
            time: seg.time,
            modality: seg.modality,
          });
        });
        continue;
      }

      const touchesFreeDay =
        wantsFreeDays &&
        cur.segments.some((seg) => freeDayKeys.has(sameDayKey(seg.day)));

      // ✅ KEY FIX: if keepChangesLow and course doesn't violate free-day, don't change it
      if (keepChangesLow && !touchesFreeDay) {
        cur.segments.forEach((seg) => {
          finalCourses.push({
            code,
            name: cur.courseName,
            group: cur.group,
            day: seg.day,
            time: seg.time,
            modality: seg.modality,
          });
        });
        continue;
      }

      const avaRows = availableByCode[code] || [];
      if (!avaRows.length) {
        cur.segments.forEach((seg) => {
          finalCourses.push({
            code,
            name: cur.courseName,
            group: cur.group,
            day: seg.day,
            time: seg.time,
            modality: seg.modality,
          });
        });
        continue;
      }

      const allGroups = groupAvailableRows(code, avaRows, cur.courseName);
      const currentGroup = cur.group;

      // ✅ Vacancy filter: skip FULL turnos
      const vacMap = await getVacMap(code);
      const hasVacancies = (groupCode) => {
        const rec = vacMap[norm(groupCode)];
        if (!rec) return true; // unknown => allow
        return !rec.is_full;
      };

      let candidateGroups = allGroups.filter((g) => g.group !== currentGroup);

      // Remove full groups
      candidateGroups = candidateGroups.filter((g) => {
        const ok = hasVacancies(g.group);
        if (!ok) skippedFullGroups.push(`${code}:${g.group}`);
        return ok;
      });

      if (!candidateGroups.length) {
        unsatisfied.push(`${code} - ${cur.courseName} (sin vacantes)`);

        blocked.push({
          code,
          name: cur.courseName,
          reason: "SIN_VACANTES",
          detail: "Todos los turnos alternativos están llenos."
        });

        cur.segments.forEach((seg) => {
          finalCourses.push({
            code,
            name: cur.courseName,
            group: cur.group,
            day: seg.day,
            time: seg.time,
            modality: seg.modality,
          });
        });
        continue;
      }


      // If we are trying to free a day, prefer candidates that remove that day
      // Pass 1: strict free-day + no conflicts
      const viable = [];
      for (const g of candidateGroups) {
        const err = testCandidate(code, g, true);
        if (!err) viable.push(g);
      }

      let chosen = null;

      if (viable.length) {
        // ✅ choose closest schedule to current (min diff) to reduce changes
        const curSig = segmentsSignature(cur.segments);
        let bestScore = Infinity;
        for (const g of viable) {
          const candSig = segmentsSignature(g.segments);
          const score = candSig === curSig ? 9999 : 0; // avoid pointless same schedule group change
          if (score < bestScore) {
            bestScore = score;
            chosen = g;
          }
        }
        // if still null, fallback to first viable
        if (!chosen) chosen = viable[0];
      } else {
        // Pass 2: ignore free-days but keep no conflicts
        // ✅ BUT only do this if keepChangesLow is FALSE
        if (!keepChangesLow) {
          for (const g of candidateGroups) {
            const err = testCandidate(code, g, false);
            if (!err) {
              chosen = g;
              break;
            }
          }
        }
      }

      if (!chosen) {
      // Detect why: conflict vs freeDay restriction
      let conflictCount = 0;
      let freeDayCount = 0;

      for (const g of candidateGroups) {
        const err = testCandidate(code, g, true);
        if (!err) continue;
        if (err.reason === "conflict") conflictCount++;
        if (err.reason === "freeDay") freeDayCount++;
      }

      let reason = "CONFLICTO";
      let detail = "No hay turnos alternativos sin cruce con otros cursos.";

      if (freeDayCount > 0 && conflictCount === 0) {
        reason = "DIA_LIBRE";
        detail = "No hay turnos que eviten el día seleccionado.";
      } else if (conflictCount > 0) {
        reason = "CONFLICTO";
        detail = "Los turnos alternativos generan conflicto con el horario actual.";
      }

      unsatisfied.push(`${code} - ${cur.courseName}`);
      blocked.push({ code, name: cur.courseName, reason, detail });

      cur.segments.forEach((seg) => {
        finalCourses.push({
          code,
          name: cur.courseName,
          group: cur.group,
          day: seg.day,
          time: seg.time,
          modality: seg.modality,
        });
      });
      continue;
    }


      const beforeSeg = cur.segments[0] || { day: "", time: "", modality: "" };
      const afterSeg = chosen.segments[0] || { day: "", time: "", modality: "" };

      changes.push({
        code,
        name: cur.courseName,
        from: {
          group: cur.group || "—",
          day: canonicalDayName(beforeSeg.day || "—"),
          time: beforeSeg.time || "—",
          modality: beforeSeg.modality || "—",
        },
        to: {
          group: chosen.group || "—",
          day: canonicalDayName(afterSeg.day || "—"),
          time: afterSeg.time || "—",
          modality: afterSeg.modality || "—",
        },
      });

      planSlots = planSlots.filter((p) => p.code !== code);
      chosen.segments.forEach((seg) => {
        const rng = parseTimeRange(seg.time);
        if (!rng) return;
        planSlots.push({
          code,
          day: seg.day,
          start: rng.start,
          end: rng.end,
        });
        finalCourses.push({
          code,
          name: cur.courseName,
          group: chosen.group,
          day: seg.day,
          time: seg.time,
          modality: seg.modality,
        });
      });
    }

    return res.json({
      ok: true,
      changes,
      finalCourses,
      unsatisfied,
      blocked,
      skippedFullGroups,
    });

  } catch (e) {
    console.error("/ai-local error:", e.response?.data || e.message);
    return res.status(500).json({ error: "ai_local_failed" });
  }
});

// Confirm: generate PDF + (optional) email to admins
app.post("/confirm", requireVerifiedStudent, async (req, res) => {
  try {
    const clientStudent = req.body?.student || {};
    const clientChanges = Array.isArray(req.body?.changes) ? req.body.changes : [];
    const clientFinal = Array.isArray(req.body?.finalCourses) ? req.body.finalCourses : [];

    const profile = (req.session && req.session.profile) || {};
    const studentS = (req.session && req.session.student) || {};
    const enrolled = Array.isArray(req.session?.enrolled) ? req.session.enrolled : [];

    const info = {
      name:
        clientStudent.name ||
        `${profile.name || profile.c_nomalu || ""} ${profile.lastname || profile.c_apealu || ""}`.trim() ||
        "—",
      code: clientStudent.code || studentS.codigo || "—",
      dni: clientStudent.dni || studentS.dni || profile.dni || "—",
      program: clientStudent.specialtyName || profile.specialtyName || "—",
      faculty: clientStudent.facultyName || profile.facultyName || "—",
      period: clientStudent.period || (profile.period && String(profile.period)) || "—",
      mode: clientStudent.mode || profile.mode || "—",
      email: clientStudent.email || profile.email_institucional || "",
    };

    const currentSchedule = enrolled.map((s) => ({
      courseCode: s.courseCode || s.c_codcur || "",
      courseName: s.courseName || "",
      groupCode: s.groupCode || s.section || "",
      modality: s.modality || s.modalityDescription || "",
      day: s.day || "",
      hour: s.hour || "",
      teacherName: s.teacherName || "",
      credits: Number(s.credits || s.credit || 0),
    }));

  

    const finalPlan =
      clientFinal && clientFinal.length
        ? clientFinal
        : currentSchedule.map((c) => ({
            code: c.courseCode,
            name: c.courseName,
            group: c.groupCode,
            day: c.day,
            time: c.hour,
            modality: c.modality,
          }));


    const changesList = clientChanges || [];

    // PDF generation
    const doc = new PDFDocument({ margin: 50 });
    if (fs.existsSync(LOGO_PATH)) {
      try {
        doc.image(LOGO_PATH, 50, 40, { width: 130 });
      } catch (e) {
        console.warn("Failed to load logo in PDF:", e.message);
      }
    }

    doc
      .fontSize(16)
      .font("Helvetica-Bold")
      .text("UNIVERSIDAD MARÍA AUXILIADORA", 200, 50, { align: "right" })
      .moveDown(0.3);

    doc
      .fontSize(12)
      .font("Helvetica")
      .text("Solicitud de Rectificación de Matrícula", { align: "right" });

    doc.moveDown(2);

    doc
      .fontSize(13)
      .font("Helvetica-Bold")
      .text("Datos del estudiante", { underline: true });

    doc.moveDown(0.5);
    doc.fontSize(11).font("Helvetica");

    const addInfoRow = (label, value) => {
      doc.text(`${label}: `, { continued: true, width: 120 });
      doc.font("Helvetica-Bold").text(String(value || "—")).font("Helvetica");
    };

    addInfoRow("Nombre completo", info.name);
    addInfoRow("Código de estudiante", info.code);
    addInfoRow("DNI", info.dni);
    addInfoRow("Facultad", info.faculty);
    addInfoRow("Programa", info.program);
    addInfoRow("Periodo académico", fmtPeriod(info.period));
    addInfoRow("Modalidad", info.mode);
    addInfoRow("Correo institucional", info.email);

    doc.moveDown(1.5);

    // Section: current schedule
    doc
      .fontSize(13)
      .font("Helvetica-Bold")
      .text("Horario actual matriculado", { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(10).font("Helvetica");

    if (!currentSchedule.length) {
      doc.text("No se encontraron cursos matriculados en el sistema.");
    } else {
      const colWidths = [60, 200, 50, 60, 70, 80];
      const startX = doc.x;
      const startY = doc.y;

      const drawHeaderCell = (text, width) => {
        doc.font("Helvetica-Bold").text(text, { width, continued: true });
        doc.font("Helvetica");
      };
      const drawCell = (text, width) => {
        doc.text(text, { width, continued: true });
      };

      drawHeaderCell("Código", colWidths[0]);
      drawHeaderCell("Curso", colWidths[1]);
      drawHeaderCell("Sec.", colWidths[2]);
      drawHeaderCell("Día", colWidths[3]);
      drawHeaderCell("Horario", colWidths[4]);
      doc.text("Modalidad", { width: colWidths[5] });
      doc.moveDown(0.4);

      doc
        .moveTo(startX, startY - 3)
        .lineTo(startX + colWidths.reduce((a, b) => a + b, 0), startY - 3)
        .stroke();

      currentSchedule.forEach((c) => {
        const modalityShort =
          c.modality && c.modality.length > 30 ? c.modality.slice(0, 27) + "..." : c.modality || "";
        drawCell(c.courseCode || "", colWidths[0]);
        drawCell(c.courseName || "", colWidths[1]);
        drawCell(c.groupCode || "", colWidths[2]);
        drawCell(c.day || "", colWidths[3]);
        drawCell(c.hour || "", colWidths[4]);
        doc.text(modalityShort, { width: colWidths[5] });
      });
    }

    doc.moveDown(1.5);

    // Section: final suggested plan
    doc
      .fontSize(13)
      .font("Helvetica-Bold")
      .text("Horario propuesto (después de IA)", { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(10).font("Helvetica");

    if (!finalPlan.length) {
      doc.text("No se recibió una propuesta de cambios. Se asume que se mantiene el horario actual.");
    } else {
      const colWidths2 = [60, 200, 50, 60, 70, 80];
      const startX2 = doc.x;
      const startY2 = doc.y;

      const drawHeaderCell2 = (text, width) => {
        doc.font("Helvetica-Bold").text(text, { width, continued: true });
        doc.font("Helvetica");
      };
      const drawCell2 = (text, width) => {
        doc.text(text, { width, continued: true });
      };

      drawHeaderCell2("Código", colWidths2[0]);
      drawHeaderCell2("Curso", colWidths2[1]);
      drawHeaderCell2("Sec.", colWidths2[2]);
      drawHeaderCell2("Día", colWidths2[3]);
      drawHeaderCell2("Horario", colWidths2[4]);
      doc.text("Modalidad", { width: colWidths2[5] });
      doc.moveDown(0.4);

      doc
        .moveTo(startX2, startY2 - 3)
        .lineTo(startX2 + colWidths2.reduce((a, b) => a + b, 0), startY2 - 3)
        .stroke();

      finalPlan.forEach((c) => {
        const code = c.code || c.courseCode || "";
        const name = c.name || c.courseName || "";
        const group = c.group || c.groupCode || "";
        const day = c.day || "";
        const time = c.time || c.hour || "";
        const modality =
          c.modality && c.modality.length > 30 ? c.modality.slice(0, 27) + "..." : c.modality || "";

        drawCell2(code, colWidths2[0]);
        drawCell2(name, colWidths2[1]);
        drawCell2(group, colWidths2[2]);
        drawCell2(day, colWidths2[3]);
        drawCell2(time, colWidths2[4]);
        doc.text(modality, { width: colWidths2[5] });
      });
    }

    doc.moveDown(1.5);

    // Section: list of changes
    doc
      .fontSize(13)
      .font("Helvetica-Bold")
      .text("Resumen de cambios sugeridos por IA", { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(11).font("Helvetica");

    if (!changesList.length) {
      doc.text("No se registran cambios de sección; el horario propuesto coincide con el actual.");
    } else {
      changesList.forEach((ch, idx) => {
        const title = `${idx + 1}. ${ch.code || ""} - ${ch.name || ""}`;
        doc.font("Helvetica-Bold").text(title);
        doc.font("Helvetica").moveDown(0.1);

        const from = ch.from || {};
        const to = ch.to || {};

        doc.text(
          `   De: Sección ${from.group || "—"}, ${from.day || "—"} ${from.time || "—"} (${from.modality || "—"})`
        );
        doc.text(
          `   A:  Sección ${to.group || "—"}, ${to.day || "—"} ${to.time || "—"} (${to.modality || "—"})`
        );
        doc.moveDown(0.4);
      });
    }

    doc.moveDown(2);

    const today = new Date();
    const dateStr = today.toLocaleDateString("es-PE", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
    doc.fontSize(11).font("Helvetica").text(`Fecha de generación: ${dateStr}`, { align: "right" });

    doc.moveDown(3);
    doc.fontSize(11).font("Helvetica").text("Firma del estudiante:", 50).moveDown(2);
    doc.moveTo(50, doc.y).lineTo(250, doc.y).stroke();
    doc.text(info.name, 50, doc.y + 2);

    // Convert to buffer
    const pdfBuffer = await pdfToBuffer(doc);

    // =========================
    // ✅ STEP 6: SAVE PDF + SAVE RECORD FOR ADMIN
    // =========================
    const id = crypto.randomUUID
      ? crypto.randomUUID()
      : crypto.randomBytes(16).toString("hex");

    // Make a safe unique filename (avoid overwriting)
    const safeCode = String(info.code || "student").replace(/[^a-zA-Z0-9_-]/g, "");
    const safePeriod = String(info.period || "period").replace(/[^a-zA-Z0-9_-]/g, "");
    const pdfFile = `rectificacion_${safeCode}_${safePeriod}_${Date.now()}_${id}.pdf`;

    await fs.promises.mkdir(PDF_DIR, { recursive: true });
    await fs.promises.writeFile(path.join(PDF_DIR, pdfFile), pdfBuffer);

  // =========================
// ✅ Supabase: save request + lock portal
// =========================
const period_id = CURRENT_PERIOD_ID;
const student_code = String(info.code || safeCode);
const nowIso = new Date().toISOString();

// (Optional) Prevent double-submit
const psBefore = await getPortalState(period_id, student_code);
if (psBefore && psBefore.status === "DONE") {
  return res.status(403).json({
    ok: false,
    error: "already_submitted",
    message: psBefore.message || "Ya enviaste tu solicitud.",
  });
}

    // 1) Save rectification payload (admin will later approve/reject here)
    await upsertRectificationRequest({
      period_id,
      student_code,
      student_name: info.name || null,
      dni_last4: String(info.dni || "").slice(-4) || null,
      email: info.email || null,
      phone: profile.phone || null,
      faculty_name: info.faculty || null,
      specialty_name: info.program || null,
      mode: info.mode || null,

      boleta_number: req.session.boletaNumber || null,
      boleta_verified: true,

      status: "SUBMITTED",
      locked: true,
      admin_message: null,

      changes: Array.isArray(changesList) ? changesList : [],
      final_courses: Array.isArray(finalPlan) ? finalPlan : [],
      current_courses: Array.isArray(currentSchedule) ? currentSchedule : [],

      pdf_storage_path: pdfFile, // you saved it locally
      pdf_url: null,

      submitted_at: nowIso,
      ip: getClientIp(req),
      user_agent: req.headers["user-agent"] || null,
    });

    // 2) Ensure portal_state exists + mark DONE
    await upsertPortalState({
      period_id,
      student_code,
      boleta_number: req.session.boletaNumber || "—",
      dni_last4: String(info.dni || "").slice(-4) || null,
    });

    // 2) Mark DONE
await markPortalDone({
  period_id,
  student_code,
  message: "Tu solicitud fue enviada correctamente. Ya no puedes ingresar nuevamente.",
  final_data: {
    submitted_at: nowIso,
    changes: Array.isArray(changesList) ? changesList : [],
    finalCourses: Array.isArray(finalPlan) ? finalPlan : [],
    currentCourses: Array.isArray(currentSchedule) ? currentSchedule : [],
    pdfFile,
  },
});




    // Try emailing to admins
    if (mailer && process.env.ADMIN_PDF_TO) {
      const toList = process.env.ADMIN_PDF_TO.split(",").map((s) => s.trim()).filter(Boolean);
      if (toList.length) {
        try {
          await mailer.sendMail({
            from: FROM_EMAIL,
            to: toList,
            subject: `Rectificación de matrícula - ${info.code} - ${fmtPeriod(info.period)}`,
            text: "Se adjunta la solicitud de rectificación de matrícula generada desde el portal.",
            attachments: [
              {
                filename: `rectificacion_${info.code}_${info.period}.pdf`,
                content: pdfBuffer,
              },
            ],
          });
          console.log("PDF enviado por correo a:", toList.join(", "));
        } catch (mailErr) {
          console.error("Error enviando correo con PDF:", mailErr.message);
        }
      }
    }

    
    // Send PDF to browser (clean name for student download)
    const downloadName = `rectificacion_${info.code}_${info.period}.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${downloadName}"`);
    return res.end(pdfBuffer);

  } catch (e) {
    console.error("/confirm error:", e.response?.data || e.message);
    return res.status(500).json({ ok: false, error: "confirm_failed" });
  }
});

// Logout
app.post("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

// 404 handler
app.use((_, res) => {
  res.status(404).render("index", {
    firstName: null,
    lastName: null,
    studentId: null,
    semester: null,
    department: null,
    schedules: [],
    available: [],
    dni: null,
    email_institucional: null,
    phone: null,
    facultyName: null,
    specialtyName: null,
    facultyCode: null,
    specialtyCode: null,
    gender: null,
    age: null,
    mode: null,
    period: null,
    periodCode: null,
    error: "Página no encontrada",
  });
});
app.use((err, req, res, next) => {
  console.error("🔥 Express error:", err?.response?.data || err?.message || err);

  if (res.headersSent) return next(err);

  if (req.accepts("html")) {
    return res.status(500).send("Error interno del servidor");
  }

  return res.status(500).json({ ok: false, error: "server_error" });
});

// Start server
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});

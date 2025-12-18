// app.js
require("dotenv").config();

const express = require("express");
const axios = require("axios");
const path = require("path");
const session = require("express-session");
const PDFDocument = require("pdfkit");
const fs = require("fs");

// ---- optional require for nodemailer (prevents crash if not installed)
let nodemailer = null;
try {
  // install with: npm i nodemailer
  nodemailer = require("nodemailer");
} catch (e) {
  console.warn(
    " 'nodemailer' is not installed. Emails will be skipped. Run `npm i nodemailer` to enable emailing."
  );
}

const app = express();
const PORT = process.env.PORT || 5000;

// ---- external services (env) ----
const LOGIN_URL   = process.env.LOGIN_BASE_URL;   // e.g. http://37.60.229.241:8085/service-uma
const DATA_URL    = process.env.DATA_BASE_URL;    // e.g. http://37.60.229.241:8085/service-uma/grupoa
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;      // used for API login only
const ADMIN_PASS  = process.env.ADMIN_PASS;
const AI_BASE_URL = process.env.AI_BASE_URL || "http://127.0.0.1:5055";

const LOGO_PATH = path.join(__dirname, "public", "images", "logo.png");

/* ------------ express setup ------------ */
app.disable("x-powered-by");
app.set("views", path.join(__dirname, "views"));
app.set("view engine", "ejs");

// trust proxy for Render so secure cookies can be used when https
app.set("trust proxy", 1);

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
      secure: process.env.NODE_ENV === "production", // auto-secure on Render
    },
  })
);

/* ------------ mail transport (no-reply) ------------ */
const FROM_EMAIL =
  process.env.FROM_EMAIL || process.env.SMTP_USER || "noreply@uma.edu.pe";

const mailer =
  nodemailer &&
  nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || "false").toLowerCase() === "true",
    auth:
      process.env.SMTP_USER && process.env.SMTP_PASS
        ? {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
          }
        : undefined,
  });

  if (mailer) {
  // Verify transport connectivity (avoid forcing logger/debug properties directly on the transport)
  mailer.verify((err, success) => {
    if (err) {
      console.error("SMTP verify failed:", err.message);
    } else {
      console.log("SMTP verify OK. From:", FROM_EMAIL);
    }
  });
  console.log("SMTP settings",
    JSON.stringify({
      host: process.env.SMTP_HOST,
      port: process.env.SMTP_PORT,
      secure: String(process.env.SMTP_SECURE),
      from: FROM_EMAIL
    })
  );
}

/* ------------ helpers ------------ */
function jsonHeaders(token) {
  const h = { "Content-Type": "application/json" };
  if (token) h.Authorization = "Bearer " + token;
  return { headers: h };
}
function log(label, url, body) {
  console.log(`\n ${label}\nURL: ${url}\nBODY: ${JSON.stringify(body)}`);
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
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
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

/** Pick the real { CODE: {...} } map from the API payload. */
function extractCoursesMap(root) {
  if (!root || typeof root !== "object") return {};
  if (root.courseList && typeof root.courseList === "object") return root.courseList;

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

  const metaKey = /^(period|student|specialty|status|message|code|.*_code|.*_id)$/i;
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

/** Flatten for the UI replacement-panel
 *  - Aggregates sessions by groupCode
 *  - If a course has both TEORÍA and LAB, only keeps groups that have BOTH
 */
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

    // 1) Aggregate all sessions by groupCode
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
          sessions: []
        };
      }

      const sessions = Array.isArray(g.sessions)
        ? g.sessions
        : (Array.isArray(g) ? g : []);

      sessions.forEach((s) => {
        const day = s.dayName || dayNameFromNumber(s.day);
        const start = s.start || s.hourStart || s.hourIni || "";
        const end   = s.end   || s.hourEnd   || s.hourFin || "";
        const modalityRaw = s.modality || g.modality || courseObj.modality || "";
        const modalityNorm = normMod(modalityRaw);

        // classify modality
        let type = "O";
        if (modalityNorm.includes("LABORATORIO")) type = "L";
        else if (
          modalityNorm.includes("TEORÍA") ||
          modalityNorm.includes("TEORIA") ||
          modalityNorm.includes("VIRTUAL")
        ) type = "T";

        if (type === "T") courseHasTheory = true;
        if (type === "L") courseHasLab = true;

        groupMap[mapKey].sessions.push({
          day,
          start,
          end,
          modality: modalityRaw,
          modalityNorm,
          type
        });
      });
    }

    // 2) If course has BOTH theory and lab, require each group to have both
    const requirePair = courseHasTheory && courseHasLab;

    Object.values(groupMap).forEach((gInfo) => {
      const hasT = gInfo.sessions.some((s) => s.type === "T");
      const hasL = gInfo.sessions.some((s) => s.type === "L");

      if (requirePair && !(hasT && hasL)) {
        // e.g. groups NS1 / NS2 in your example: only theory or only lab → skip
        return;
      }

      // Build pretty text
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
        // keep first modality just for display; real logic uses sessions[]
        modality: first.modality || "",
        teacherName: "—",
        day: "",
        hour: "",
        // NEW: full list of segments of this turno
        sessions: gInfo.sessions
      });
    });
  }

  out.sort((a, b) => String(a.groupCode).localeCompare(String(b.groupCode)));
  return out;
}


/** Flatten for AI: { CODE: [ {courseCode, group, day, time, teacherName, modality} ] } */
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
          group,
          day: "",
          time: "",
          teacherName: g.teacherName || "",
          modality: g.modality || "",
        });
      } else {
        sessions.forEach((s) => {
          const day = s.dayName || dayNameFromNumber(s.day);
          const time = (s.hour || s.time || s.schedule || `${s.start || ""}-${s.end || ""}`)
            .replace(/\s+–\s+|\s+-\s+| – | - /g, "-");
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

/** Given requested course code and keys returned by server, pick the best match. */
function pickBestKey(requestedCode, keys) {
  const nReq = norm(requestedCode);
  if (!nReq) return null;
  for (const k of keys) if (norm(k) === nReq) return k;
  for (const k of keys) if (norm(k).startsWith(nReq) || nReq.startsWith(norm(k))) return k;
  for (const k of keys) if (norm(k).includes(nReq) || nReq.includes(norm(k))) return k;
  return null;
}

/** Collect a PDFDocument output into a Buffer. */
function pdfToBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on("data", (d) => chunks.push(d));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}

/* ------------ health check (Render) ------------ */
app.get("/healthz", (_, res) => res.status(200).send("ok"));

/* ------------ routes ------------ */
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

app.post("/login", async (req, res) => {
  const codigo = req.body.codigo;
  const dni = req.body.dni;

  try {
    // 1) Student login
    const loginAlumnoUrl = LOGIN_URL + "/login-alumno";
    log("Student login", loginAlumnoUrl, { codigo, dni });
    const stud = await axios.post(loginAlumnoUrl, { codigo, dni }, jsonHeaders());
    const studentToken = stud.data && stud.data.access_token;
    const periodCode = stud.data && stud.data.periodCode;
    const studentCode =
      (stud.data && stud.data.user && stud.data.user.c_codalu) || String(codigo);
    if (!studentToken) throw new Error("Student login failed (no token).");

    req.session.student = {
      token: String(studentToken),
      codigo: String(studentCode),
      dni: String(dni || ""),
      defaultPeriod: String(periodCode || ""),
    };

    // 2) Admin login (for /grupoa/*)
    const adminLoginUrl = LOGIN_URL + "/login";
    log("Admin login", adminLoginUrl, { email: ADMIN_EMAIL, password: "***" });
    const admin = await axios.post(
      adminLoginUrl,
      { email: ADMIN_EMAIL, password: ADMIN_PASS },
      jsonHeaders()
    );
    const adminToken = admin.data && admin.data.access_token;
    if (!adminToken) throw new Error("Admin login failed (no token).");

    // keep admin token in session for /grupoa/* calls (course-number-enrolled, etc.)
    req.session.adminToken = String(adminToken);

    // 3) Profile
    const code = req.session.student.codigo;
    const periodFromLogin = req.session.student.defaultPeriod;
    const profileUrl = DATA_URL + "/student";
    const profileBody = { code, period: periodFromLogin || undefined };
    log("Profile fetch", profileUrl, profileBody);
    const prof = await axios.post(profileUrl, profileBody, jsonHeaders(adminToken));
    const info = prof.data && prof.data.data;
    if (!info) throw new Error("Profile endpoint returned no data.");

    const firstName = info.name || info.c_nomalu || "";
    const lastName = info.lastname || info.c_apealu || "";

    const profileOut = {
      dni: info.dni || "",
      email_institucional: info.email_institucional || "",
      phone: info.phone || "",
      facultyName: info.facultyName || "",
      specialtyName: info.specialtyName || "",
      facultyCode: info.facultyCode || "",
      specialtyCode: info.specialtyCode || "",
      gender: info.gender || "",
      age:
        info.age !== undefined && info.age !== null ? String(info.age) : "",
      mode: info.mode || "",
      period: String(info.period || periodFromLogin || ""),
      periodCode: info.periodCode || "",
    };

    // 4) Enrolled schedules
    const schedulesUrl = DATA_URL + "/course-schedules";
    const schBody = { code, period: profileOut.period };
    log("Course schedules", schedulesUrl, schBody);
    const sch = await axios.post(schedulesUrl, schBody, jsonHeaders(adminToken));
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

    // store for later
    req.session.profile = profileOut;
    req.session.enrolled = schedules;

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
    console.error(
      " Error:",
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
      error: "Error al iniciar sesión u obtener datos. Revisa la consola.",
    });
  }
});

/** AJAX: available groups for ONE course */
app.post("/available", async (req, res) => {
  try {
    const s = req.session.student;
    if (!s || !s.token) return res.status(401).json({ error: "not_logged_in" });

    const period = String(
      (req.body && req.body.period) || s.defaultPeriod || ""
    );
    const courseCode = (req.body && req.body.courseCode) || "";

    const body = { codigo: s.codigo, period };
    if (s.dni) body.dni = s.dni;

    const saUrl = LOGIN_URL + "/student/schedule-available";
    log("Schedule available (student token, RAW JSON)", saUrl, body);

    const sa = await axios.post(saUrl, body, jsonHeaders(s.token));

    const root = (sa.data && sa.data.data) || sa.data;
    const coursesMap = extractCoursesMap(root);
    const theKeys = Object.keys(coursesMap || {}); // fixed: no accidental global
    const bestKey = pickBestKey(courseCode, theKeys);

    let filtered = [];
    if (bestKey && coursesMap[bestKey]) {
      filtered = flattenAvailable({ [bestKey]: coursesMap[bestKey] });
    } else if (coursesMap[courseCode]) {
      filtered = flattenAvailable({ [courseCode]: coursesMap[courseCode] });
    }

    return res.json({
      data: filtered,
      courseKeys: theKeys,
      bestKey,
      requestedCode: courseCode,
    });
  } catch (e) {
    console.error(
      " /available error:",
      e.response && e.response.status,
      e.response ? e.response.data : e.message
    );
    res.status(500).json({ error: "failed_to_load_available" });
  }
});

/** AJAX: number of students enrolled per group for ONE course */
app.post("/course-number-enrolled", async (req, res) => {
  try {
    const student = req.session.student;
    if (!student || !student.codigo) {
      return res
        .status(401)
        .json({ status: 401, message: "not_logged_in", data: [] });
    }

    const period = String(
      (req.body && req.body.period) || student.defaultPeriod || ""
    );
    const courseCode = String((req.body && req.body.courseCode) || "").trim();

    if (!period || !courseCode) {
      return res
        .status(400)
        .json({ status: 400, message: "period and courseCode required", data: [] });
    }

    // get admin token (from session or login again as fallback)
    let adminToken = req.session.adminToken;
    if (!adminToken) {
      const adminLoginUrl = LOGIN_URL + "/login";
      console.log("Admin login (fallback) for course-number-enrolled");
      const admin = await axios.post(
        adminLoginUrl,
        { email: ADMIN_EMAIL, password: ADMIN_PASS },
        jsonHeaders()
      );
      adminToken = admin.data && admin.data.access_token;
      if (!adminToken) throw new Error("Admin login failed (no token).");
      req.session.adminToken = String(adminToken);
    }

    const url = DATA_URL + "/course-number-enrolled";
    const body = { period, courseCode };
    log("Course number enrolled", url, body);

    const resp = await axios.post(url, body, jsonHeaders(adminToken));
    const payload = resp.data || {};
    const data = Array.isArray(payload.data) ? payload.data : [];

    return res.json({
      status: payload.status || 200,
      data,
    });
  } catch (err) {
    console.error(
      " /course-number-enrolled error:",
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


/* ---------- AI suggest route (proxy to your Python microservice) ---------- */
app.post("/ai-suggest", async (req, res) => {
  try {
    const s = req.session.student;
    const prof = req.session.profile || {};
    const enrolled = req.session.enrolled || [];
    if (!s || !s.token) return res.status(401).json({ error: "not_logged_in" });

    // 1) current timetable (from session)
    const current = enrolled.map((e) => ({
      courseCode: e.courseCode,
      courseName: e.courseName,
      groupCode: e.groupCode,
      day: e.day,
      hour: e.hour,
      teacherName: e.teacherName,
      modality: e.modality,
    }));

    // 2) all available options (once)
    const body = { codigo: s.codigo, period: prof.period || s.defaultPeriod || undefined };
    if (s.dni) body.dni = s.dni;
    const saUrl = LOGIN_URL + "/student/schedule-available";
    const sa = await axios.post(saUrl, body, jsonHeaders(s.token));
    const root = (sa.data && sa.data.data) || sa.data;
    const coursesMap = extractCoursesMap(root);
    const available = flattenAvailableForAI(coursesMap);

    // 3) preferences from client (pass through)
    const preferences = {
      timePreference:
        (req.body?.preferences?.timePreference) ??
        (req.body?.timePreference) ??
        "no-preference",
      freeDays:
        (Array.isArray(req.body?.preferences?.freeDays) && req.body.preferences.freeDays) ||
        (Array.isArray(req.body?.freeDays) && req.body.freeDays) ||
        [],
      keepChangesLow:
        (req.body?.preferences?.keepChangesLow) ??
        (req.body?.keepChangesLow !== false),
    };

    // 4) call AI microservice
    const { data } = await axios.post(
      `${AI_BASE_URL}/generate`,
      { current, available, preferences },
      jsonHeaders()
    );

    return res.json(data);
  } catch (e) {
    console.error(" /ai-suggest error:", e.response?.status, e.response?.data || e.message);
    res.status(500).json({ error: "ai_suggest_failed" });
  }
});

/** Generate PDF + email only to admins (student email kept as commented block) */
app.post("/confirm", async (req, res) => {
  try {
    const clientStudent = req.body?.student || {};
    const clientChanges = Array.isArray(req.body?.changes) ? req.body.changes : [];
    const clientFinal   = Array.isArray(req.body?.finalCourses) ? req.body.finalCourses : [];

    const profile  = (req.session && req.session.profile)  || {};
    const studentS = (req.session && req.session.student)  || {};

    const info = {
      name:
        clientStudent.name ||
        `${profile.name || profile.c_nomalu || ""} ${profile.lastname || profile.c_apealu || ""}`.trim() ||
        "—",
      code: clientStudent.code || studentS.codigo || "—",
      dni:  clientStudent.dni  || studentS.dni    || profile.dni || "—",
      program: clientStudent.specialtyName || profile.specialtyName || "—",
      faculty: clientStudent.facultyName   || profile.facultyName   || "—",
      period:  clientStudent.period  || (profile.period && String(profile.period)) || "—",
      mode:    clientStudent.mode    || profile.mode || "—",
      email:   clientStudent.email   || profile.email_institucional || "",
    };

    // ======== PDF UTILS ========
    const DAY_MAP   = { lunes:"Lunes", martes:"Martes", miercoles:"Miércoles", jueves:"Jueves", viernes:"Viernes", sabado:"Sábado", domingo:"Domingo" };
    const DAY_ORDER = { Lunes:1, Martes:2, Miércoles:3, Jueves:4, Viernes:5, Sábado:6, Domingo:7 };

    const canonicalDay = (s) => {
      const k = String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase();
      return DAY_MAP[k] || (s || "");
    };
    const displayTime = (range) => {
      const t = String(range || "").trim().replace(/\s{2,}/g,' ');
      const m1 = t.match(/^(\d{1,2}:\d{2})\s*[–-]?\s*(\d{1,2}:\d{2})$/);
      if (m1) return `${m1[1]}–${m1[2]}`;
      const m2 = t.match(/(\d{1,2}):(\d{2}).*?(\d{1,2}):(\d{2})/);
      if (m2) return `${m2[1]}:${m2[2]}–${m2[3]}:${m2[4]}`;
      return t.replace('-', '–');
    };

    // Changes (normalized) — accept {from,to} or {before,after} and sanitize values
    const toDisp = (t) => (t ? displayTime(t) : "—");

    const changesList = (Array.isArray(clientChanges) ? clientChanges : []).map(ch => {
      const from = ch.from || ch.before || {};
      const to   = ch.to   || ch.after  || {};
      return {
        code: ch.code || ch.courseCode || "—",
        name: ch.name || ch.courseName || "",
        before: {
          group: from.group || "—",
          day:   canonicalDay(from.day || "—"),
          time:  toDisp(from.time),
          modality: from.modality || "—"
        },
        after: {
          group: to.group || "—",
          day:   canonicalDay(to.day || "—"),
          time:  toDisp(to.time),
          modality: to.modality || "—"
        }
      };
    }).filter(row =>
      (row.before.group !== "—" || row.after.group !== "—" ||
       row.before.day   !== "—" || row.after.day   !== "—" ||
       row.before.time  !== "—" || row.after.time  !== "—")
    );

    const finalCourses = clientFinal.map(e => ({
      code: e.code,
      name: e.name || "",
      group: e.group || "—",
      day: canonicalDay(e.day || "—"),
      time: displayTime(e.time || "—"),
      modality: e.modality || "—"
    })).sort((a, b) => {
      const da = DAY_ORDER[canonicalDay(a.day)] || 99;
      const db = DAY_ORDER[canonicalDay(b.day)] || 99;
      if (da !== db) return da - db;
      const toMinutes = (str) => {
        const m = /(\d{1,2}):(\d{2})/.exec(String(str || ""));
        return m ? (+m[1])*60 + (+m[2]) : 9e6;
      };
      const aStart = (a.time || "").match(/(\d{1,2}:\d{2})/)?.[1] || "";
      const bStart = (b.time || "").match(/(\d{1,2}:\d{2})/)?.[1] || "";
      return toMinutes(aStart) - toMinutes(bStart);
    });

    // ======== PDF SETUP ========
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 36, bottom: 36, left: 36, right: 36 },
      bufferPages: true
    });

    const COLORS = {
      primary: '#f02454',
      textDark: '#111827',
      textMedium: '#374151',
      textLight: '#6b7280',
      background: '#f8fafc',
      border: '#e5e7eb'
    };

    function drawSectionHeader(text, y) {
      doc.save().fillColor(COLORS.primary).rect(doc.page.margins.left, y, 4, 16).fill().restore();
      doc.font("Helvetica-Bold").fontSize(12).fillColor(COLORS.textDark)
        .text(text, doc.page.margins.left + 12, y + 2);
      return y + 24;
    }
    function drawArrowPath(cx, cy) {
      doc.save().lineWidth(1.2).strokeColor(COLORS.textLight);
      doc.moveTo(cx - 8, cy).lineTo(cx + 8, cy).stroke();
      doc.moveTo(cx + 3, cy - 6).lineTo(cx + 9, cy).lineTo(cx + 3, cy + 6).stroke();
      doc.restore();
    }

    // ----- Header with ribbon + white title + logo
    const headerX = doc.page.margins.left;
    const headerW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const barH    = 42;
    const barY    = doc.page.margins.top - 8;

    const LOGO_AREA_W = 86;
    const GUTTER      = 14;

    const ribbonX = headerX + LOGO_AREA_W + GUTTER;
    const ribbonW = headerW - (LOGO_AREA_W + GUTTER);

    doc.save();
    doc.rect(ribbonX, barY, ribbonW, barH).fill(COLORS.primary);
    doc.restore();

    const logoPaths = [
      path.join(__dirname, "public", "images", "logo_white_transparent.png"),
      LOGO_PATH
    ];
    const logoPath = logoPaths.find(p => fs.existsSync(p));
    if (logoPath) {
      const LOGO_H = barH - 8;
      const LOGO_Y = barY + (barH - LOGO_H) / 2;
      const LOGO_X = headerX + 8;
      doc.image(logoPath, LOGO_X, LOGO_Y, { height: LOGO_H });
    }

    doc.font("Helvetica-Bold").fontSize(14).fillColor("#fff").text(
      "Universidad María Auxiliadora — Rectificación de Matrícula",
      ribbonX + 16,
      barY + (barH - 14) / 2,
      { width: ribbonW - 24, align: "left" }
    );

    // ----- Student card
    doc.moveDown(1.5);
    const cardX   = doc.page.margins.left;
    const cardW   = headerW;
    const cardTop = doc.y - 6;
    const cardH   = 110;

    doc.roundedRect(cardX, cardTop, cardW, cardH, 10).stroke(COLORS.border);
    doc.font("Helvetica-Bold").fontSize(14).fillColor(COLORS.textDark)
       .text(info.name || "—", cardX + 16, cardTop + 14, { width: cardW - 32 });

    const colW = Math.floor((cardW - 32) / 4);
    const line1Y = cardTop + 44;
    function drawKV(colIndex, label, value) {
      const x = cardX + 16 + colIndex * colW;
      doc.font("Helvetica").fontSize(10).fillColor(COLORS.textMedium)
         .text(label, x, line1Y, { width: colW - 16 });
      doc.font("Helvetica-Bold").fontSize(10).fillColor(COLORS.textDark)
         .text(String(value || "—"), x + 62, line1Y, { width: colW - 78 });
    }
    drawKV(0, "Código:",  info.code);
    drawKV(1, "DNI:",     info.dni);
    drawKV(2, "Periodo:", String(info.period || "").replace(/^(\d{4})(\d)$/, "$1-$2"));
    drawKV(3, "Modalidad:", info.mode);

    const line2Y = cardTop + 66;
    function drawRowLabelValue(y, label, value) {
      doc.font("Helvetica").fontSize(10).fillColor(COLORS.textMedium)
         .text(label, cardX + 16, y, { width: 80 });
      doc.font("Helvetica-Bold").fontSize(10).fillColor(COLORS.textDark)
         .text(String(value || "—"), cardX + 106, y, { width: cardW - 138 });
    }
    drawRowLabelValue(line2Y, "Programa:", info.program);
    drawRowLabelValue(line2Y + 16, "Facultad:", info.faculty);
    if (info.email) drawRowLabelValue(line2Y + 32, "Email:", info.email);

    doc.y = cardTop + cardH + 8;

    // ----- Changes
    let currentY = drawSectionHeader("Cambios solicitados", doc.y);
    const CHG_GAP   = 50;
    const CHG_BOX_W = Math.floor((headerW - CHG_GAP) / 2);
    const CHG_LEFT  = doc.page.margins.left;
    const CHG_RIGHT = CHG_LEFT + CHG_BOX_W + CHG_GAP;

    function measureChangeBoxHeight(lines) {
      const contentWidth = CHG_BOX_W - 20;
      const padTop = 26, padBottom = 10, lineGap = 4;
      let h = padTop;
      lines.forEach((t, i) => {
        const th = doc.heightOfString(String(t || "—"), { width: contentWidth, align: "left" });
        h += th + (i < lines.length - 1 ? lineGap : 0);
      });
      return Math.ceil(h + padBottom);
    }
    function drawChangeRow(ch) {
      const leftLines = [
        `Grupo: ${ch.before?.group || "—"}`,
        `Día: ${ch.before?.day || "—"}`,
        `Hora: ${ch.before?.time || "—"}`,
        `Modalidad: ${ch.before?.modality || "—"}`
      ];
      const rightLines = [
        `Grupo: ${ch.after?.group || "—"}`,
        `Día: ${ch.after?.day || "—"}`,
        `Hora: ${ch.after?.time || "—"}`,
        `Modalidad: ${ch.after?.modality || "—"}`
      ];

      const boxH = Math.max(
        measureChangeBoxHeight(leftLines),
        measureChangeBoxHeight(rightLines)
      );

      const needed = 18 + boxH + 16;
      if (currentY + needed > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
        currentY = doc.page.margins.top;
      }

      doc.font("Helvetica-Bold").fontSize(11).fillColor(COLORS.primary)
        .text(`${ch.code || "—"} — ${ch.name || ""}`, CHG_LEFT, currentY, { width: headerW });
      currentY += 18;

      const yBox = Math.round(currentY);
      doc.roundedRect(CHG_LEFT,  yBox, CHG_BOX_W, boxH, 6).stroke(COLORS.border);
      doc.roundedRect(CHG_RIGHT, yBox, CHG_BOX_W, boxH, 6).stroke(COLORS.primary);

      doc.font("Helvetica-Bold").fontSize(9).fillColor(COLORS.textMedium)
        .text("ORIGINAL", CHG_LEFT + 10, yBox + 8);
      doc.font("Helvetica-Bold").fontSize(9).fillColor(COLORS.primary)
        .text("NUEVO", CHG_RIGHT + 10, yBox + 8);

      const contentWidth = CHG_BOX_W - 20;
      doc.font("Helvetica").fontSize(9).fillColor(COLORS.textDark);
      let yL = yBox + 26, yR = yBox + 26;

      leftLines.forEach((t, i) => {
        const txt = String(t || "—");
        doc.text(txt, CHG_LEFT + 10, yL, { width: contentWidth, align: "left" });
        yL += doc.heightOfString(txt, { width: contentWidth }) + (i < leftLines.length - 1 ? 4 : 0);
      });
      rightLines.forEach((t, i) => {
        const txt = String(t || "—");
        doc.text(txt, CHG_RIGHT + 10, yR, { width: contentWidth, align: "left" });
        yR += doc.heightOfString(txt, { width: contentWidth }) + (i < rightLines.length - 1 ? 4 : 0);
      });

      const midX = CHG_LEFT + CHG_BOX_W + Math.floor(CHG_GAP / 2);
      const midY = yBox + Math.floor(boxH / 2);
      drawArrowPath(midX, midY);

      currentY = yBox + boxH + 16;
    }

    if (!changesList.length) {
      doc.font("Helvetica").fontSize(10).fillColor(COLORS.textLight)
         .text("No se han seleccionado cambios.", doc.page.margins.left, currentY);
      currentY += 24;
    } else {
      changesList.forEach(drawChangeRow);
    }

    // ----- Final timetable
    currentY = drawSectionHeader("Horario final", currentY);

    const ORDER_DAYS = ["Lunes","Martes","Miércoles","Jueves","Viernes","Sábado","Domingo"];
    const buckets = Object.fromEntries(ORDER_DAYS.map(d => [d, []]));
    finalCourses.forEach(e => { const d = (e.day); if (buckets[d]) buckets[d].push(e); });
    ORDER_DAYS.forEach(d => buckets[d].sort((a,b) => {
      const toMinutes = (str) => {
        const m = /(\d{1,2}):(\d{2})/.exec(String(str || ""));
        return m ? (+m[1])*60 + (+m[2]) : 9e6;
      };
      const aStart = (a.time || "").match(/(\d{1,2}:\d{2})/)?.[1] || "";
      const bStart = (b.time || "").match(/(\d{1,2}:\d{2})/)?.[1] || "";
      return toMinutes(aStart) - toMinutes(bStart);
    }));

    const ttMarginL  = doc.page.margins.left;
    const ttContentW = headerW;
    const ttGap      = 6;
    const ttColW     = Math.floor((ttContentW - ttGap * (ORDER_DAYS.length - 1)) / ORDER_DAYS.length);

    function drawDayHeaders(yStart) {
      let x = ttMarginL;
      ORDER_DAYS.forEach(day => {
        doc.save();
        doc.rect(x, yStart, ttColW, 20).fill(COLORS.background);
        doc.fillColor(COLORS.textDark).font("Helvetica-Bold").fontSize(9)
           .text(day.slice(0,3).toUpperCase(), x + 6, yStart + 5, { width: ttColW - 12, align: "left" });
        doc.restore();
        x += ttColW + ttGap;
      });
      return yStart + 24;
    }

    function drawCourseCard(x, y, course) {
      const padX = 8, padY = 8;
      const contentW = ttColW - padX * 2;

      const line1 = `${course.time || "—"} • Gr. ${course.group || "—"}`;
      const line2 = String(course.modality || "—");

      doc.font("Helvetica").fontSize(8);
      const h1 = doc.heightOfString(line1, { width: contentW });
      const h2 = doc.heightOfString(line2, { width: contentW });

      const pillH = 16;
      const gap   = 6;
      const boxH  = padY + pillH + gap + h1 + 4 + h2 + padY;

      doc.save();
      doc.roundedRect(x, y, ttColW, boxH, 6).fillAndStroke("#fff", COLORS.border);

      const codeText = course.code || "—";
      doc.font("Helvetica-Bold").fontSize(9);
      const pillW = Math.min(contentW, doc.widthOfString(codeText) + 14);
      const pillX = x + padX;
      const pillY = y + padY;
      doc.fillColor(COLORS.primary).roundedRect(pillX, pillY, pillW, pillH, 8).fill();

      const codeH = doc.heightOfString(codeText, { width: pillW, align: "center" });
      const codeY = pillY + (pillH - codeH) / 2;
      doc.fillColor("#fff").text(codeText, pillX, codeY, { width: pillW, align: "center" });

      let ty = pillY + pillH + gap;
      doc.fillColor(COLORS.textDark).font("Helvetica").fontSize(8)
         .text(line1, x + padX, ty, { width: contentW });
      ty += h1 + 4;
      doc.fillColor(COLORS.textMedium)
         .text(line2, x + padX, ty, { width: contentW });

      doc.restore();
      return boxH + 4;
    }

    function drawTimetable(startY) {
      const headersTop = startY;
      let y = drawDayHeaders(headersTop);

      const pageBottom = doc.page.height - doc.page.margins.bottom;
      doc.save().lineWidth(0.6).strokeColor(COLORS.border);
      for (let i = 0; i < ORDER_DAYS.length - 1; i++) {
        const x = ttMarginL + (i + 1) * ttColW + i * ttGap + ttGap / 2;
        doc.moveTo(x, headersTop).lineTo(x, pageBottom).stroke();
      }
      doc.restore();

      let heights = ORDER_DAYS.map(() => y);
      const maxRows = Math.max(...ORDER_DAYS.map(d => buckets[d].length));

      for (let r = 0; r < maxRows; r++) {
        ORDER_DAYS.forEach((day, col) => {
          const c = buckets[day][r];
          if (!c) return;

          const x = ttMarginL + col * (ttColW + ttGap);
          const yCol = heights[col];

          if (yCol > doc.page.height - doc.page.margins.bottom - 70) {
            doc.addPage();
            const newHeadersTop = doc.page.margins.top;
            const newY = drawDayHeaders(newHeadersTop);

            const pb = doc.page.height - doc.page.margins.bottom;
            doc.save().lineWidth(0.6).strokeColor(COLORS.border);
            for (let i = 0; i < ORDER_DAYS.length - 1; i++) {
              const sx = ttMarginL + (i + 1) * ttColW + i * ttGap + ttGap / 2;
              doc.moveTo(sx, newHeadersTop).lineTo(sx, pb).stroke();
            }
            doc.restore();

            heights = ORDER_DAYS.map(() => newY);
          }

          const used = drawCourseCard(x, heights[col], c);
          heights[col] += used;
        });
      }
    }

    drawTimetable(currentY);

    // Footer
    const headerW2 = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      doc.font("Helvetica").fontSize(8).fillColor(COLORS.textLight)
         .text(
           `Documento generado el ${new Date().toLocaleDateString()} por el Portal de Rectificación UMA`,
           doc.page.margins.left,
           doc.page.height - doc.page.margins.bottom + 4,
           { width: headerW2, align: 'right' }
         );
    }

    // Finish PDF → Buffer
    const pdfBuffer = await pdfToBuffer(doc);

    // ======== EMAIL ONLY TO ADMINS ========
    const adminTargets = (process.env.ADMIN_PDF_TO || process.env.ADMIN_CC || ADMIN_EMAIL || "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);

    if (mailer && adminTargets.length) {
      try {
        await mailer.sendMail({
          from: FROM_EMAIL, // your no-reply address
          to: adminTargets.join(","),
          subject: `Rectificación de Matrícula – ${info.name} (${info.code})`,
          text:
            `No responder a este correo (noreply).\n\n` +
            `Adjunto PDF de rectificación para ${info.name} (${info.code}).\n` +
            `Periodo: ${String(info.period).replace(/^(\d{4})(\d)$/, "$1-$2")}\n`,
          attachments: [
            { filename: `rectification_${info.code}.pdf`, content: pdfBuffer }
          ]
        });
      } catch (e) {
        console.error("  Email send failed:", e.message);
      }
    } else if (!mailer) {
      console.warn("  Skipping email: nodemailer not available. Run `npm i nodemailer`.");
    }

    // ======== STUDENT EMAIL (disabled for now) ========
    // const studentRecipient = info.email; // institutional student email
    // if (mailer && studentRecipient) {
    //   await mailer.sendMail({
    //     from: FROM_EMAIL,
    //     to: studentRecipient,
    //     subject: `Tu rectificación de matrícula – ${info.code}`,
    //     text: `Hola ${info.name}, adjuntamos tu PDF de rectificación.`,
    //     attachments: [{ filename: `rectification_${info.code}.pdf`, content: pdfBuffer }]
    //   });
    // }

    // Return the same PDF in the HTTP response (download)
    const filename = `rectification_${info.code || "alumno"}_${Date.now()}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.end(pdfBuffer);

  } catch (e) {
    console.error(" /confirm error:", e.response?.data || e.message);
    res.status(500).json({ ok: false, error: "confirm_failed" });
  }
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

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

/* ------------ start server ------------ */
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});

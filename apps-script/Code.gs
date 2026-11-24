// apps-script/Code.gs
// Deploy as Web App: Execute as Me, Anyone can access

var PROPS = PropertiesService.getScriptProperties();

function jsonOk(data) {
  return ContentService.createTextOutput(JSON.stringify({ ok: true, data: data }))
    .setMimeType(ContentService.MimeType.JSON);
}

function jsonErr(msg) {
  return ContentService.createTextOutput(JSON.stringify({ ok: false, error: msg }))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var secret = PROPS.getProperty("API_SECRET");
    if (!secret || body.secret !== secret) return jsonErr("unauthorized");

    var action = body.action;
    var payload = body.payload || {};

    if (action === "health") return jsonOk({ status: "ok" });
    if (action === "getPortalState") return jsonOk(getPortalState(payload));
    if (action === "upsertPortalState") { upsertPortalState(payload); return jsonOk(null); }
    if (action === "markPortalDone") { markPortalDone(payload); return jsonOk(null); }
    if (action === "upsertRectificationRequest") { upsertRectificationRequest(payload); return jsonOk(null); }
    if (action === "listRectifications") return jsonOk(listRectifications());
    if (action === "getRectification") return jsonOk(getOneRectification(payload));
    if (action === "addLoginAudit") { addLoginAudit(payload); return jsonOk(null); }
    if (action === "listLoginAudit") return jsonOk(listLoginAudit(payload));
    if (action === "uploadPdf") return uploadPdf(payload);

    return jsonErr("unknown_action");
  } catch (err) {
    return jsonErr(err.message || "internal_error");
  }
}

// ---- Spreadsheet helpers ----

function getSheet(name) {
  var ssId = PROPS.getProperty("SPREADSHEET_ID");
  var ss = SpreadsheetApp.openById(ssId);
  return ss.getSheetByName(name);
}

function ensureHeaders(sheet, headers) {
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
  } else {
    var first = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
    var needsUpdate = first.join("|") !== headers.join("|");
    if (needsUpdate) sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
}

function sheetData(sheet, headers) {
  if (sheet.getLastRow() < 2) return [];
  var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues();
  return rows.map(function(row) {
    var obj = {};
    headers.forEach(function(h, i) { obj[h] = row[i]; });
    return obj;
  });
}

function findRowIndex(sheet, headers, keyCol, keyVal) {
  if (sheet.getLastRow() < 2) return -1;
  var colIdx = headers.indexOf(keyCol);
  if (colIdx < 0) return -1;
  var vals = sheet.getRange(2, colIdx + 1, sheet.getLastRow() - 1, 1).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][0]) === String(keyVal)) return i + 2; // 1-based sheet row
  }
  return -1;
}

function findRowByTwoCols(sheet, headers, col1, val1, col2, val2) {
  if (sheet.getLastRow() < 2) return -1;
  var idx1 = headers.indexOf(col1);
  var idx2 = headers.indexOf(col2);
  if (idx1 < 0 || idx2 < 0) return -1;
  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues();
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][idx1]) === String(val1) && String(data[i][idx2]) === String(val2)) {
      return i + 2;
    }
  }
  return -1;
}

function rowToArray(headers, obj) {
  return headers.map(function(h) {
    var v = obj[h];
    if (v === undefined || v === null) return "";
    if (typeof v === "object") return JSON.stringify(v);
    return v;
  });
}

// ---- PortalState ----

var PS_HEADERS = ["id","period_id","student_code","dni_last4","boleta_number","status","first_login_at","done_at","message","final_data_json","updated_at"];

function getPortalState(payload) {
  var sheet = getSheet("PortalState");
  ensureHeaders(sheet, PS_HEADERS);
  var rowIdx = findRowByTwoCols(sheet, PS_HEADERS, "period_id", payload.period_id, "student_code", payload.student_code);
  if (rowIdx < 0) return null;
  var row = sheet.getRange(rowIdx, 1, 1, PS_HEADERS.length).getValues()[0];
  var obj = {};
  PS_HEADERS.forEach(function(h, i) { obj[h] = row[i]; });
  obj.final_data = obj.final_data_json ? tryParse(obj.final_data_json) : {};
  return obj;
}

function upsertPortalState(payload) {
  var sheet = getSheet("PortalState");
  ensureHeaders(sheet, PS_HEADERS);
  var now = new Date().toISOString();
  var rowIdx = findRowByTwoCols(sheet, PS_HEADERS, "period_id", payload.period_id, "student_code", payload.student_code);
  if (rowIdx < 0) {
    var newRow = rowToArray(PS_HEADERS, {
      id: Utilities.getUuid(),
      period_id: payload.period_id,
      student_code: payload.student_code,
      dni_last4: payload.dni_last4 || "",
      boleta_number: payload.boleta_number || "",
      status: "PENDING",
      first_login_at: now,
      done_at: "",
      message: "",
      final_data_json: "",
      updated_at: now,
    });
    sheet.appendRow(newRow);
  } else {
    var idxMap = {};
    PS_HEADERS.forEach(function(h, i) { idxMap[h] = i; });
    if (payload.boleta_number !== undefined) sheet.getRange(rowIdx, idxMap["boleta_number"] + 1).setValue(payload.boleta_number);
    if (payload.dni_last4 !== undefined) sheet.getRange(rowIdx, idxMap["dni_last4"] + 1).setValue(payload.dni_last4);
    sheet.getRange(rowIdx, idxMap["updated_at"] + 1).setValue(now);
  }
}

function markPortalDone(payload) {
  var sheet = getSheet("PortalState");
  ensureHeaders(sheet, PS_HEADERS);
  var now = new Date().toISOString();
  var rowIdx = findRowByTwoCols(sheet, PS_HEADERS, "period_id", payload.period_id, "student_code", payload.student_code);
  var idxMap = {};
  PS_HEADERS.forEach(function(h, i) { idxMap[h] = i; });
  if (rowIdx < 0) {
    var newRow = rowToArray(PS_HEADERS, {
      id: Utilities.getUuid(),
      period_id: payload.period_id,
      student_code: payload.student_code,
      dni_last4: "",
      boleta_number: "",
      status: "DONE",
      first_login_at: now,
      done_at: now,
      message: payload.message || "",
      final_data_json: JSON.stringify(payload.final_data || {}),
      updated_at: now,
    });
    sheet.appendRow(newRow);
  } else {
    sheet.getRange(rowIdx, idxMap["status"] + 1).setValue("DONE");
    sheet.getRange(rowIdx, idxMap["done_at"] + 1).setValue(now);
    sheet.getRange(rowIdx, idxMap["message"] + 1).setValue(payload.message || "");
    sheet.getRange(rowIdx, idxMap["final_data_json"] + 1).setValue(JSON.stringify(payload.final_data || {}));
    sheet.getRange(rowIdx, idxMap["updated_at"] + 1).setValue(now);
  }
}

// ---- RectificationRequests ----

var RR_HEADERS = ["id","created_at","submitted_at","period_id","student_code","student_name","dni_last4","email","phone","faculty_name","specialty_name","mode","boleta_number","boleta_verified","status","locked","admin_message","changes_json","final_courses_json","current_courses_json","pdf_drive_file_id","pdf_url","ip","user_agent","updated_at"];

function upsertRectificationRequest(payload) {
  var sheet = getSheet("RectificationRequests");
  ensureHeaders(sheet, RR_HEADERS);
  var now = new Date().toISOString();
  var rowIdx = findRowByTwoCols(sheet, RR_HEADERS, "period_id", payload.period_id, "student_code", payload.student_code);
  var obj = {
    id: payload.id || Utilities.getUuid(),
    created_at: payload.created_at || now,
    submitted_at: payload.submitted_at || now,
    period_id: payload.period_id || "",
    student_code: payload.student_code || "",
    student_name: payload.student_name || "",
    dni_last4: payload.dni_last4 || "",
    email: payload.email || "",
    phone: payload.phone || "",
    faculty_name: payload.faculty_name || "",
    specialty_name: payload.specialty_name || "",
    mode: payload.mode || "",
    boleta_number: payload.boleta_number || "",
    boleta_verified: payload.boleta_verified ? "true" : "false",
    status: payload.status || "SUBMITTED",
    locked: payload.locked ? "true" : "false",
    admin_message: payload.admin_message || "",
    changes_json: JSON.stringify(payload.changes || payload.changes_json || []),
    final_courses_json: JSON.stringify(payload.final_courses || payload.final_courses_json || []),
    current_courses_json: JSON.stringify(payload.current_courses || payload.current_courses_json || []),
    pdf_drive_file_id: payload.pdf_drive_file_id || "",
    pdf_url: payload.pdf_url || "",
    ip: payload.ip || "",
    user_agent: payload.user_agent || "",
    updated_at: now,
  };
  if (rowIdx < 0) {
    sheet.appendRow(rowToArray(RR_HEADERS, obj));
  } else {
    sheet.getRange(rowIdx, 1, 1, RR_HEADERS.length).setValues([rowToArray(RR_HEADERS, obj)]);
  }
}

function listRectifications() {
  var sheet = getSheet("RectificationRequests");
  ensureHeaders(sheet, RR_HEADERS);
  var rows = sheetData(sheet, RR_HEADERS);
  return rows.map(function(r) {
    return {
      id: r.id,
      createdAt: r.submitted_at,
      submitted_at: r.submitted_at,
      pdfFile: r.pdf_drive_file_id || null,
      pdfUrl: r.pdf_url || null,
      student: {
        code: r.student_code,
        name: r.student_name,
        period: r.period_id,
        mode: r.mode || "",
        dni_last4: r.dni_last4 || "",
        email: r.email || "",
        phone: r.phone || "",
        faculty: r.faculty_name || "",
        program: r.specialty_name || "",
      },
      boleta_number: r.boleta_number || "",
      status: r.status || "",
      changes: tryParse(r.changes_json) || [],
      final_courses: tryParse(r.final_courses_json) || [],
      current_courses: tryParse(r.current_courses_json) || [],
    };
  });
}

function getOneRectification(payload) {
  var sheet = getSheet("RectificationRequests");
  ensureHeaders(sheet, RR_HEADERS);
  var rowIdx = findRowIndex(sheet, RR_HEADERS, "id", payload.id);
  if (rowIdx < 0) return null;
  var row = sheet.getRange(rowIdx, 1, 1, RR_HEADERS.length).getValues()[0];
  var r = {};
  RR_HEADERS.forEach(function(h, i) { r[h] = row[i]; });
  return {
    id: r.id,
    createdAt: r.submitted_at,
    submitted_at: r.submitted_at,
    pdfFile: r.pdf_drive_file_id || null,
    pdfUrl: r.pdf_url || null,
    student: {
      code: r.student_code,
      name: r.student_name,
      period: r.period_id,
      mode: r.mode || "",
      dni_last4: r.dni_last4 || "",
      email: r.email || "",
      phone: r.phone || "",
      faculty: r.faculty_name || "",
      program: r.specialty_name || "",
    },
    boleta_number: r.boleta_number || "",
    status: r.status || "",
    changes: tryParse(r.changes_json) || [],
    final_courses: tryParse(r.final_courses_json) || [],
    current_courses: tryParse(r.current_courses_json) || [],
  };
}

// ---- LoginAudit ----

var LA_HEADERS = ["id","at","student_code","status","ip","ua"];

function addLoginAudit(payload) {
  var sheet = getSheet("LoginAudit");
  ensureHeaders(sheet, LA_HEADERS);
  sheet.appendRow([
    Utilities.getUuid(),
    payload.at || new Date().toISOString(),
    payload.student_code || "",
    payload.status || "SUCCESS",
    payload.ip || "",
    payload.ua || "",
  ]);
}

function listLoginAudit(payload) {
  var sheet = getSheet("LoginAudit");
  ensureHeaders(sheet, LA_HEADERS);
  var rows = sheetData(sheet, LA_HEADERS);
  rows.reverse();
  var limit = (payload && payload.limit) ? Number(payload.limit) : 200;
  return rows.slice(0, limit);
}

// ---- uploadPdf ----

function uploadPdf(payload) {
  try {
    var folderId = PROPS.getProperty("DRIVE_FOLDER_ID");
    var bytes = Utilities.base64Decode(payload.base64Pdf);
    var blob = Utilities.newBlob(bytes, "application/pdf", payload.filename);
    var folder = DriveApp.getFolderById(folderId);
    var file = folder.createFile(blob);
    var fileId = file.getId();
    var pdfUrl = file.getUrl();
    return ContentService.createTextOutput(JSON.stringify({ ok: true, fileId: fileId, pdfUrl: pdfUrl }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return jsonErr("uploadPdf_failed: " + err.message);
  }
}

// ---- Utility ----

function tryParse(s) {
  try { return JSON.parse(s); } catch(e) { return null; }
}

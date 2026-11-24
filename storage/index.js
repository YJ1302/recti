// storage/index.js — STORAGE_DRIVER=supabase | appscript. If unset: Supabase when its keys exist (the live site), otherwise Apps Script.
const hasSupabase = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
const driver = String(process.env.STORAGE_DRIVER || (hasSupabase ? "supabase" : "appscript")).toLowerCase();

let store;
if (driver === "supabase") {
  store = require("./supabaseStore");
} else if (driver === "appscript") {
  store = require("./appScriptStore");
} else {
  throw new Error(`Unknown STORAGE_DRIVER: ${driver}`);
}

module.exports = store;

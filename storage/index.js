// storage/index.js
const driver = String(process.env.STORAGE_DRIVER || "appscript").toLowerCase();

let store;
if (driver === "appscript") {
  store = require("./appScriptStore");
} else {
  throw new Error(`Unknown STORAGE_DRIVER: ${driver}`);
}

module.exports = store;

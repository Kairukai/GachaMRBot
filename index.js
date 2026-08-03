// Root launcher for panel hosts whose "main file" field is length-limited
// (fps.ms caps it at 16 characters, and "dist/src/start.js" is 17).
//
// Deliberately plain JavaScript, not TypeScript — it must run without a build
// step. package.json sets "type": "module", so this is ESM.
import "./dist/src/start.js";

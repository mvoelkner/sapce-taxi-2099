// Puts the game into the server's static directory, so Phoenix serves both.
//
// That is the arrangement the architecture spec settles on: one origin, so
// netUrl() derives the WebSocket address from the page it was loaded from.
// Nothing to configure, no CORS to arrange, and a phone on the same network
// only needs one address.
//
//   node scripts/serve-client.js
//
// Unlike the native package this copies sw.js as well: over http(s) the service
// worker is wanted, and only the Capacitor bundle skips it.

const fs = require("fs");
const nodePath = require("path");
const { build, WWW } = require("./build-www.js");

const ROOT = nodePath.resolve(__dirname, "..");
const STATIC = nodePath.join(ROOT, "server", "priv", "static");

// Everything Plug.Static is told to serve. Kept in step with static_paths/0 in
// server/lib/space_taxi_web.ex — a file missing there is a 404 no matter what
// this copies.
const EXTRA = ["sw.js"];

function copyInto(dest) {
  const { missing, uncovered } = build();
  if (uncovered.length) {
    throw new Error(`index.html references uncopied files: ${uncovered.join(", ")}`);
  }
  if (missing.length) throw new Error(`missing files: ${missing.join(", ")}`);

  const copied = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const from = nodePath.join(dir, entry.name);
      if (entry.isDirectory()) { walk(from); continue; }
      const rel = nodePath.relative(WWW, from);
      const to = nodePath.join(dest, rel);
      fs.mkdirSync(nodePath.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      copied.push(rel);
    }
  };
  walk(WWW);

  for (const rel of EXTRA) {
    const from = nodePath.join(ROOT, rel);
    if (!fs.existsSync(from)) continue;
    fs.copyFileSync(from, nodePath.join(dest, rel));
    copied.push(rel);
  }

  return copied;
}

if (require.main === module) {
  fs.mkdirSync(STATIC, { recursive: true });
  const copied = copyInto(STATIC);
  console.log(`served ${copied.length} files from server/priv/static:`);
  for (const f of copied.sort()) console.log(`  ${f}`);
}

module.exports = { copyInto, STATIC };

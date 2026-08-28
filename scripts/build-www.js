// Collects the files the native package needs into www/.
//
// Capacitor copies one directory into the app bundle. The repository root is
// not that directory: it also holds the server, the tests, the scripts and a
// pile of source images that never ship. So this copies exactly what index.html
// references, and fails loudly if something is missing rather than shipping an
// app with a hole in it.
//
//   node scripts/build-www.js
//
// The plain web build needs none of this — index.html is still opened directly.

const fs = require("fs");
const nodePath = require("path");

const ROOT = nodePath.resolve(__dirname, "..");
const WWW = nodePath.join(ROOT, "www");

// Everything index.html asks for by name, plus the install metadata. Checked
// against the file's actual references below, so this list cannot quietly rot.
const FILES = [
  "index.html",
  "manifest.webmanifest",
  "explosion3.png",
  "explosion.mp3",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
];

// The service worker is deliberately left out: inside the shell the app is
// already served from the bundle, and registerServiceWorker() skips it there.

// Pull every local file index.html names, so a newly added asset is caught here
// instead of at runtime on a device.
function referencedByIndex() {
  const html = fs.readFileSync(nodePath.join(ROOT, "index.html"), "utf8");
  const found = new Set();
  const patterns = [
    /url\(\s*['"]?([^'")]+)['"]?\s*\)/g,
    /(?:src|href)\s*=\s*"([^"]+)"/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(html))) {
      const ref = m[1].trim();
      if (/^(https?:|data:|#|\/\/)/.test(ref)) continue;   // not ours to copy
      found.add(ref.replace(/^\.\//, ""));
    }
  }
  return [...found];
}

// The web build is pointed at a server with ?server=. An app never launches
// with a query string, so the address is baked into the copied page instead:
//
//   TAXI_SERVER=wss://host/socket/websocket npm run www
//
// Left out, the app falls back to localhost:4000, which is only useful in a
// simulator on the build machine.
function injectServer(html, server) {
  if (!server) return html;
  const tag = `<meta name="taxi-server" content="${server.replace(/"/g, "&quot;")}">`;
  return html.replace(/<link rel="manifest"/, `${tag}\n<link rel="manifest"`);
}

function build({ server } = {}) {
  const missing = [];
  const referenced = referencedByIndex();
  const uncovered = referenced.filter(r => r !== "sw.js" && !FILES.includes(r));

  fs.rmSync(WWW, { recursive: true, force: true });
  fs.mkdirSync(WWW, { recursive: true });

  for (const rel of FILES) {
    const from = nodePath.join(ROOT, rel);
    if (!fs.existsSync(from)) { missing.push(rel); continue; }
    const to = nodePath.join(WWW, rel);
    fs.mkdirSync(nodePath.dirname(to), { recursive: true });

    if (rel === "index.html" && server) {
      const html = injectServer(fs.readFileSync(from, "utf8"), server);
      if (!html.includes('name="taxi-server"')) {
        throw new Error("could not inject the server address: no manifest link to anchor to");
      }
      fs.writeFileSync(to, html);
    } else {
      fs.copyFileSync(from, to);
    }
  }

  return { copied: FILES.length - missing.length, missing, uncovered, server };
}

if (require.main === module) {
  const { copied, missing, uncovered, server } = build({ server: process.env.TAXI_SERVER });

  if (uncovered.length) {
    console.error(`index.html references files this script does not copy:\n  ${uncovered.join("\n  ")}`);
    console.error("Add them to FILES in scripts/build-www.js.");
    process.exit(1);
  }
  if (missing.length) {
    console.error(`missing files:\n  ${missing.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`wrote www/ (${copied} files)` +
              (server ? `, server ${server}`
                      : ", no TAXI_SERVER set - the app will try localhost:4000"));
}

module.exports = { build, referencedByIndex, FILES, WWW };

// Generates the server's copy of the level data from index.html.
//
// The levels stay embedded in index.html: the game has to keep working from a
// plain file:// double-click, and fetch() of a local JSON fails there on CORS
// grounds — the same reason hey-taxi.mp3 is base64 in the page. So instead of
// both sides reading one file at runtime, one side generates the other's copy,
// and the harness fails if the committed copy has drifted.
//
// Only what the server actually needs crosses over. It runs no physics, so
// gravity, obstacles and fuel stations stay behind; pad geometry comes along,
// because "no second truth about pad positions" is the whole point.
//
//   node scripts/extract-levels.js            writes server/priv/levels.json
//   node scripts/extract-levels.js --check    exits 1 if the file is out of date

const { ROOT, fs, nodePath } = require("../test/game-env.js");

const OUT = nodePath.join(ROOT, "server", "priv", "levels.json");

function serverView(lvl, index) {
  const cols = lvl.cols || 1;
  const rows = lvl.rows || 1;
  return {
    index,
    name: lvl.name,
    cols, rows,
    worldW: cols * SECTOR_W,
    worldH: rows * SECTOR_H,
    fares: lvl.fares,
    policy: farePolicy(lvl),
    pads: lvl.pads.map((p, i) => ({
      index: i,
      x: p.x, y: p.y, w: p.w,
      label: p.label,
    })),
  };
}

function build() {
  return {
    // Bump when the shape changes, so a stale server rejects a new client
    schema: 1,
    viewport: { w: VIEW_W, h: VIEW_H },
    sector: { w: SECTOR_W, h: SECTOR_H },
    levels: LEVELS.map(serverView),
  };
}

function render() {
  return JSON.stringify(build(), null, 2) + "\n";
}

if (require.main === module) {
  const wanted = render();
  if (process.argv.includes("--check")) {
    const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : null;
    if (current === wanted) {
      console.log("levels.json is up to date");
      process.exit(0);
    }
    console.error("levels.json is out of date - run: node scripts/extract-levels.js");
    process.exit(1);
  }
  fs.mkdirSync(nodePath.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, wanted);
  console.log(`wrote ${nodePath.relative(ROOT, OUT)} (${LEVELS.length} levels)`);
}

module.exports = { build, render, OUT };

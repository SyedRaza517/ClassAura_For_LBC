// Regenerate every app icon from the ClassAura mark.
//
// The mark is defined here as SVG, so this script is the single source of truth for
// every icon: favicon, PWA, iOS, Android and both store listings. Nothing is drawn by
// hand and nothing is traced from a screenshot — change the shape here and every size
// follows, which is the only way a set of eleven PNGs stays consistent.
//
// Run from client/:  node scripts/make-icons.mjs   (then: npx cap sync)
//
// ── WHAT THE MARK IS, AND WHY ────────────────────────────────────────────────
//
// A solid disc with three arcs radiating from it: a presence being detected. The whole
// product is one question — is this person in this room — answered by a phone near a
// sticker, a camera near a code, or a device inside a boundary. Every one of those is
// proximity, and proximity has a visual language everybody already reads: the signal
// arc. "Aura" is that shape given a name.
//
// It is deliberately NOT a mortarboard, a book or a tick. Those say "education" and
// "done" — generic, and already worn out across the category. The arcs say the specific
// thing this product does, and they survive being 40px on a home screen, which a
// mortarboard's tassel does not.
//
// The arcs GROW in gap and thin as they go out, so the mark reads as emanating rather
// than as three concentric rings. That difference is the whole legibility of it at small
// sizes: even spacing reads as a target, uneven spacing reads as a pulse.
//
// The previous mark — a royal-blue fanlight semicircle, the EdTech/LBC emblem — is in
// git history at the commit that replaced it. It belongs to uk.co.edtech.hub, which is
// still published and still uses it; ClassAura is a different app and needs a different
// face, or the two are indistinguishable in a phone's app switcher.
import sharp from "sharp";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// Indigo, one step off the blue every other education app reaches for, and dark enough
// that the white arcs hold their contrast at 48px. Matches nothing in brand.properties on
// purpose: those colours drive the app's CHROME (status bar, splash field), which is
// deliberately neutral so a college's own branding leads inside the app. The icon is the
// product's own face and is the one place it may have a colour of its own.
const INK = "#4338ca";
const WHITE = "#ffffff";

/**
 * A square SVG containing the centred ClassAura mark.
 *   bg    — background fill, or null for transparent
 *   fill  — the disc colour
 *   line  — the arc colour
 *   scale — mark size as a fraction; use ~0.72 for the Android adaptive inset
 */
function emblem({ S, bg = null, fill = INK, line = WHITE, scale = 1 }) {
  const cx = S / 2;
  const cy = S / 2;
  // The disc is the anchor: everything else is a multiple of it, so the mark keeps its
  // proportions at every size rather than drifting as numbers round.
  const r = S * 0.095 * scale;

  // Three arcs, opening to the upper right. Each one is thinner and further out than the
  // last — a pulse leaving, not a target being aimed at.
  const arcs = [1, 2, 3].map((i) => {
    const ar = r * (1 + i * 0.95);
    const sw = r * (0.46 - i * 0.075);
    // SWEPT ACROSS THE RIGHT SIDE, from about 5 o'clock up through 3 o'clock to about
    // 1 o'clock — 140 degrees, centred on the direction the pulse travels.
    //
    // An earlier version used 165 to 325 degrees, which looks like the same span written
    // differently and is not: an SVG arc between two points can take either way round, and
    // that pair sent it the long way, under the disc. The arcs came out below the mark
    // instead of beside it. Angles measured from the direction of travel are the ones that
    // survive somebody changing the sweep later.
    const a0 = -70, a1 = 70;
    const rad = (d) => (d * Math.PI) / 180;
    const x0 = (cx + ar * Math.cos(rad(a0))).toFixed(1);
    const y0 = (cy - ar * Math.sin(rad(a0))).toFixed(1);
    const x1 = (cx + ar * Math.cos(rad(a1))).toFixed(1);
    const y1 = (cy - ar * Math.sin(rad(a1))).toFixed(1);
    // sweep-flag 0 so the arc bulges upward, away from the disc.
    return `<path d="M${x0},${y0} A${ar},${ar} 0 0 0 ${x1},${y1}" stroke-width="${sw.toFixed(2)}"/>`;
  }).join("");

  // OPTICALLY CENTRED, not centred on the disc. The mark's visual mass sits entirely on
  // one side of the disc — that is what makes it read as radiating — so centring the disc
  // centres the wrong thing: the first version pushed the outermost arc against the right
  // edge, where iOS's rounded corner mask clips it, and left a hole on the left.
  //
  // The group spans from the disc's far edge (r behind the centre) to the outermost arc
  // (arcMax ahead of it), so shifting back by half that difference puts the whole mark in
  // the middle of the square. Derived rather than eyeballed, so it stays true if the arc
  // count or spacing ever changes.
  const arcMax = r * (1 + 3 * 0.95);
  const shift = -(arcMax - r) / 2;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
  ${bg ? `<rect width="${S}" height="${S}" fill="${bg}"/>` : ""}
  <g transform="translate(${shift.toFixed(1)} 0)">
    <g stroke="${fill}" stroke-linecap="round" fill="none">
      ${arcs}
    </g>
    <circle cx="${cx}" cy="${cy}" r="${r.toFixed(1)}" fill="${fill}"/>
  </g>
</svg>`;
}

const out = async (path, buf) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, buf); console.log(`  ${path}`); };
const png = (opts) => sharp(Buffer.from(emblem(opts))).png();
// A filled (no-alpha) square — the App Store and Play both reject alpha in the icon.
const solid = async (S, opts = {}) => (await png({ S, bg: WHITE, ...opts })).flatten({ background: WHITE }).removeAlpha().toBuffer();

// --- Favicon (scalable) ---
console.log("Favicon + PWA:");
await out("public/icon.svg", Buffer.from(emblem({ S: 512, bg: WHITE })));
await out("public/icon-192.png", await solid(192));
await out("public/icon-512.png", await solid(512));
await out("public/apple-touch-icon.png", await solid(180));

// --- Play Store listing ---
console.log("\nPlay Store listing:");
await out("store/play-icon-512.png", await solid(512));

// 1024x500 feature banner: emblem left, wordmark right, on white.
console.log("\nPlay feature graphic:");
const FEATURE = `<svg width="1024" height="500" xmlns="http://www.w3.org/2000/svg">
  <rect width="1024" height="500" fill="${WHITE}"/>
  <text x="430" y="238" font-family="Helvetica,Arial,sans-serif" font-size="70" font-weight="bold" fill="${INK}">ClassAura</text>
  <text x="434" y="298" font-family="Helvetica,Arial,sans-serif" font-size="28" fill="#334155">Timetables, attendance and check-in</text>
</svg>`;
const featureLogo = await png({ S: 300 }).toBuffer();
await out("store/play-feature-1024x500.png",
  await sharp(Buffer.from(FEATURE)).composite([{ input: featureLogo, top: 100, left: 110 }]).flatten({ background: WHITE }).removeAlpha().png().toBuffer());

// --- iOS app icon (no alpha) ---
console.log("\niOS app icon:");
await out("ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png", await solid(1024));

// --- Android launcher icons ---
console.log("\nAndroid launcher icons:");
const DENSITIES = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
for (const [density, size] of Object.entries(DENSITIES)) {
  const dir = `android/app/src/main/res/mipmap-${density}`;
  await out(`${dir}/ic_launcher.png`, await solid(size));
  await out(`${dir}/ic_launcher_round.png`, await solid(size));
  // Adaptive foreground: emblem inset on transparent; the system draws the white background.
  await out(`${dir}/ic_launcher_foreground.png`, await png({ S: size, scale: 0.72 }).toBuffer());
}

console.log("\nDone.");

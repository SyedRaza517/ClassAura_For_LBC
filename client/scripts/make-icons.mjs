// Regenerate every app icon from the EdTech fanlight emblem.
//
// The emblem is defined here as SVG (a solid royal-blue semicircle with a white
// fanlight — outer ring, hub and radial spokes), so this script is the single source
// of truth for every icon: favicon, PWA, iOS, Android and the store listing.
//
// Run from client/:  node scripts/make-icons.mjs   (then: npx cap sync)
import sharp from "sharp";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const BLUE = "#1e40af";   // emblem blue (matches src/Brand.jsx BRAND_BLUE)
const WHITE = "#ffffff";

// A square SVG containing the centred fanlight emblem.
//   bg    — background fill, or null for transparent
//   fill  — the semicircle disc colour
//   line  — the fanlight line colour
//   scale — emblem size as a fraction (1 ≈ 0.88·S wide); use ~0.8 for adaptive inset
function emblem({ S, bg = null, fill = BLUE, line = WHITE, scale = 1 }) {
  const cx = S / 2;
  const R = S * 0.44 * scale;        // outer radius
  const by = S / 2 + R / 2;          // baseline (centres the bounding box)
  const rO = R * 0.86, rI = R * 0.30, sw = R * 0.072;
  const pt = (r, deg) => { const a = (deg * Math.PI) / 180; return [(cx + r * Math.cos(a)).toFixed(1), (by - r * Math.sin(a)).toFixed(1)]; };
  const arc = (r) => `M${cx - r},${by} A${r},${r} 0 0 1 ${cx + r},${by}`;
  const spokes = [1, 2, 3, 4, 5, 6].map((i) => (i * 180) / 7).map((a) => { const [ix, iy] = pt(rI, a), [ox, oy] = pt(rO, a); return `<line x1="${ix}" y1="${iy}" x2="${ox}" y2="${oy}"/>`; }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
  ${bg ? `<rect width="${S}" height="${S}" fill="${bg}"/>` : ""}
  <path d="${arc(R)} Z" fill="${fill}"/>
  <g stroke="${line}" stroke-width="${sw}" stroke-linecap="round" fill="none">
    <path d="${arc(rO)}"/><path d="${arc(rI)}"/>${spokes}
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
  <text x="430" y="238" font-family="Georgia,'Times New Roman',serif" font-size="70" font-weight="bold" fill="${BLUE}">Staff Hub</text>
  <text x="434" y="298" font-family="Helvetica,Arial,sans-serif" font-size="28" fill="#334155">EdTech</text>
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

// Capture every screen of the staff app and lay each out as a Play Store screenshot.
//
// Runs against a LOCAL dev server signed in as a throwaway demo account, never the live
// database — a store listing is public, and real captures would put employees' names,
// job titles and holiday balances on it.
//
// Prerequisites (both already running when this is invoked):
//   server/  node src/index.js        → API on :4000
//   client/  npm run dev              → app on :5173  (client/.env points it at :4000)
//
// Run from client/:  node scripts/capture-store-screenshots.mjs
import { chromium, devices } from "playwright";
import sharp from "sharp";
import { mkdir, rm, writeFile } from "node:fs/promises";

const APP = process.env.APP_URL || "http://localhost:5173";
const EMAIL = "demo.screenshots@edtech.co.uk";
const PASSWORD = "Demo!Shots123";

// Play keeps phone, 7-inch tablet and 10-inch tablet as three separate asset sets, each
// with its own size. The viewport is chosen to match the real device so the app lays
// itself out as a tablet user would actually see it — capturing a phone-width render and
// upscaling it would show a phone layout claiming to be a tablet.
const TARGETS = {
  phone:    { out: "store/screenshots",          w: 1080, h: 1920, vw: 412, vh: 915,  dsf: 3 },
  tablet7:  { out: "store/screenshots-tablet7",  w: 1200, h: 1920, vw: 600, vh: 960,  dsf: 2 },
  tablet10: { out: "store/screenshots-tablet10", w: 1600, h: 2560, vw: 800, vh: 1280, dsf: 2 },
};
const TARGET = process.argv[2] || "phone";
if (!TARGETS[TARGET]) { console.error(`Unknown target "${TARGET}". Use: ${Object.keys(TARGETS).join(" | ")}`); process.exit(1); }
const { out: OUT, w: W, h: H, vw: VW, vh: VH, dsf: DSF } = TARGETS[TARGET];
const RAW = `${OUT}-raw`;

// Every screen the staff app can show, in the order a new user meets them. The keys are
// the app's own screen names; `push:open` is the event the app already uses to jump to a
// screen when a push notification is tapped, which is far more reliable than clicking
// through tiles that move as the layout changes.
const ALL_SCREENS = [
  ["home",          "Everything in one place"],
  ["checkin",       "Check in and out each day"],
  ["balance",       "See your holiday balance"],
  ["request",       "Request leave in seconds"],
  ["calendar",      "Know who's off and when"],
  ["summary",       "Log what you did today"],
  ["timesheet",     "Submit your monthly hours"],
  ["documents",     "College policies to hand"],
  ["reflection",    "Complete your self-reflection"],
  ["studentreview", "Record a student's progress"],
  ["approval",      "Approve your team's leave"],
  ["more",          "Your profile and settings"],
];
// Play accepts at most 8 per set. For the tablet sets, drop Approvals (most staff never
// see it) and More (a settings screen sells nothing), and keep the eight that show what
// the app is actually for.
const KEEP_8 = ["home", "checkin", "balance", "request", "summary", "timesheet", "reflection", "studentreview"];
const SCREENS = TARGET === "phone" ? ALL_SCREENS : ALL_SCREENS.filter(([k]) => KEEP_8.includes(k));

const BG = Buffer.from(
  `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
     <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
       <stop offset="0%" stop-color="#243888"/><stop offset="55%" stop-color="#5c2a60"/><stop offset="100%" stop-color="#941d39"/>
     </linearGradient></defs>
     <rect width="${W}" height="${H}" fill="url(#g)"/>
   </svg>`
);

// fullPage renders the whole scroll height, so a short screen comes back with a long
// band of flat page background under it. Scanning up from the bottom for the last row
// that differs from that background trims the dead space, so the app fills the frame
// instead of floating in the top two-thirds of it.
async function trimBottom(png) {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const ch = info.channels, row = info.width * ch;
  const bg = [data[(info.height - 1) * row], data[(info.height - 1) * row + 1], data[(info.height - 1) * row + 2]];
  const differs = (y) => {
    for (let x = 0; x < info.width; x += 4) {
      const i = y * row + x * ch;
      if (Math.abs(data[i] - bg[0]) > 6 || Math.abs(data[i + 1] - bg[1]) > 6 || Math.abs(data[i + 2] - bg[2]) > 6) return true;
    }
    return false;
  };
  let last = info.height - 1;
  while (last > 0 && !differs(last)) last--;
  const height = Math.min(info.height, last + 48); // leave a little breathing room
  if (height >= info.height - 8) return png;       // nothing worth trimming
  return sharp(png).extract({ left: 0, top: 0, width: info.width, height }).png().toBuffer();
}

const CAP_H = Math.round(H * 0.078);
const caption = (text) => Buffer.from(
  `<svg width="${W}" height="${CAP_H}" xmlns="http://www.w3.org/2000/svg">
     <text x="${W / 2}" y="${Math.round(CAP_H * 0.64)}" text-anchor="middle" font-family="Helvetica,Arial,sans-serif"
           font-size="${Math.round(H * 0.029)}" font-weight="bold" fill="#ffffff">${text.replace(/&/g, "&amp;")}</text>
   </svg>`
);

await rm(OUT, { recursive: true, force: true });
await rm(RAW, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
await mkdir(RAW, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: VW, height: VH }, deviceScaleFactor: DSF, isMobile: true, hasTouch: true });
// Make the app lay itself out as the packaged native shell, which on a real device it is.
//
// PhoneShell picks its layout from `isNativeApp() || matchMedia("(max-width: 640px), …")`.
// In the installed Android app Capacitor.isNativePlatform() is true on EVERY device,
// tablets included, so the app draws its full-screen mobile layout. A plain browser at
// tablet width instead gets the desktop presentation: a decorative phone frame floating
// mid-page, a desktop top bar and a copyright footer — what a web visitor sees and a
// tablet owner of the app never does. Capturing that would put a phone mockup inside the
// tablet screenshots.
//
// Stubbing Capacitor itself does not survive: @capacitor/core assigns window.Capacitor
// when it loads, replacing anything an init script set. So force the OTHER branch —
// report the handset media query as matching, which is the same decision by a route the
// app's own bundle cannot overwrite.
await ctx.addInitScript(() => {
  const real = window.matchMedia.bind(window);
  window.matchMedia = (q) =>
    String(q).includes("max-width: 640px")
      ? { matches: true, media: q, onchange: null,
          addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }
      : real(q);
});

const page = await ctx.newPage();

console.log(`Target: ${TARGET} — ${W}x${H} (viewport ${VW}x${VH} @${DSF}x)
Signing in at ${APP} …`);
await page.goto(APP, { waitUntil: "networkidle" });
// In a browser the app opens on a chooser (Staff App vs Admin Dashboard). In native
// mode it goes straight to the sign-in form, so the chooser may not be there at all.
const chooser = page.getByRole("button", { name: /Staff App/i });
if (await chooser.isVisible().catch(() => false)) {
  await chooser.click();
  await page.waitForTimeout(900);
}
await page.locator('input[type="email"]').fill(EMAIL);
await page.locator('input[type="password"]').fill(PASSWORD);
await page.getByRole("button", { name: /^Sign in$/i }).click();
await page.waitForSelector("text=/Good (morning|afternoon|evening)/i", { timeout: 30000 });
console.log("Signed in.\n");

let n = 1;
for (const [screen, text] of SCREENS) {
  // Jump straight to the screen rather than hunting for a tile.
  await page.evaluate((s) => window.dispatchEvent(new CustomEvent("push:open", { detail: s })), screen);
  await page.waitForTimeout(1400); // let data load and the entrance animations settle

  // fullPage so nothing below the fold is cut off — several screens are taller than the
  // viewport, and a cropped screenshot misrepresents the app.
  const shot = await trimBottom(await page.screenshot({ fullPage: true }));
  await writeFile(`${RAW}/${screen}.png`, shot);

  const meta = await sharp(shot).metadata();
  const TOP = CAP_H, PAD = Math.round(H * 0.016);
  const availH = H - TOP - PAD;
  // Scale by WIDTH, not into a fixed box: `fit: contain` pads a short screen out to the
  // full box with transparency, so it ends up floating with dead gradient above and
  // below. Sizing by width gives the true height, which is then centred in what's left
  // under the caption — tall screens fill the frame, short ones sit centred.
  const byWidth = await sharp(shot).resize({ width: W - Math.round(W * 0.11) }).toBuffer();
  let fitted = byWidth;
  let fm = await sharp(byWidth).metadata();
  if (fm.height > availH) {
    fitted = await sharp(shot).resize({ height: availH }).toBuffer();
    fm = await sharp(fitted).metadata();
  }
  const top = TOP + Math.max(0, Math.round((availH - fm.height) / 2));

  const file = `${OUT}/${String(n).padStart(2, "0")}-${screen}.png`;
  await writeFile(file, await sharp(BG)
    .composite([
      { input: caption(text), top: 0, left: 0 },
      { input: fitted, top, left: Math.round((W - fm.width) / 2) },
    ])
    .flatten({ background: "#243888" }).removeAlpha().png().toBuffer());

  console.log(`  ${file}  (raw ${meta.width}x${meta.height})`);
  n++;
}

await browser.close();
console.log(`\n${SCREENS.length} screens captured at ${W}x${H}. Full-height originals in ${RAW}/.`);

// Push client/brand.properties into every file that cannot read it for itself.
//
// Why a script at all: Gradle can load a .properties file at build time, so
// android/app/build.gradle reads brand.properties directly and nothing has to be
// generated for Android. Xcode cannot — an Info.plist and a .pbxproj are static
// data, and the one mechanism that would let them read a variable (an .xcconfig
// holding $(BUNDLE_ID)) breaks Codemagic's `xcode-project use-profiles`, which
// matches provisioning profiles by literal bundle id and cannot resolve a build
// variable. So iOS gets the values written in, by this script, before the build.
//
// It is idempotent: running it when nothing has changed rewrites the same bytes.
// It runs automatically before `npm run sync`, `run android` and `run ios`, and in
// codemagic.yaml before `cap sync ios`, so the native projects can never drift away
// from brand.properties without someone noticing.
//
// Run from anywhere:  node client/scripts/apply-brand.mjs
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const CLIENT = dirname(dirname(fileURLToPath(import.meta.url)));
const BRAND_FILE = join(CLIENT, "brand.properties");

// --- read brand.properties -------------------------------------------------
// A deliberately tiny java.util.Properties parser: key=value, # or ! comments,
// values kept verbatim. The format is chosen so Gradle can read the same file
// natively (see android/app/build.gradle) without a JSON library or a plugin.
function readProperties(file) {
  const out = {};
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

if (!existsSync(BRAND_FILE)) {
  console.error(`FATAL: ${BRAND_FILE} is missing. It is the single source of truth for
the app name, bundle id and native chrome colours — without it a build would ship
whatever happened to be left in the native projects.`);
  process.exit(1);
}

const p = readProperties(BRAND_FILE);
const need = (key) => {
  const v = p[key];
  if (!v) {
    console.error(`FATAL: brand.properties is missing "${key}".`);
    process.exit(1);
  }
  return v;
};

const APP_NAME = need("app.name");
const APP_ID = need("app.id");
const APP_DESC = p["app.description"] ?? "";
// Capacitor wants #RRGGBBAA; brand.properties keeps the human #RRGGBB form.
const rgba = (hex) => (/^#[0-9a-fA-F]{6}$/.test(hex) ? `${hex}ff` : hex).toLowerCase();
const BACKGROUND = need("color.background");
const STATUS_BAR = p["color.statusBar"] ?? BACKGROUND;
const STATUS_STYLE = (p["color.statusBarStyle"] ?? "DARK").toUpperCase();

if (!/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/i.test(APP_ID)) {
  console.error(`FATAL: app.id "${APP_ID}" is not a valid reverse-DNS identifier.
Both stores reject anything else, and Android will not even compile it.`);
  process.exit(1);
}

let failed = 0;
const changes = [];

// Replace once, and shout if the anchor has moved — a silent no-op here would ship
// the previous institution's name on somebody else's build.
function patch(file, label, edits, { required = true } = {}) {
  const path = join(CLIENT, file);
  if (!existsSync(path)) {
    if (required) { console.error(`FATAL: ${file} not found.`); failed++; }
    return;
  }
  let text = readFileSync(path, "utf8");
  const before = text;
  for (const [pattern, replacement] of edits) {
    if (!pattern.test(text)) {
      const msg = `${required ? "FATAL" : "warning"}: ${file} — no match for ${pattern}`;
      console.error(`  ${msg}`);
      if (required) failed++;
      continue;
    }
    text = text.replace(pattern, replacement);
    pattern.lastIndex = 0;
  }
  if (text !== before) {
    writeFileSync(path, text);
    changes.push(`${label}  ${file}`);
  }
}

// --- Capacitor config ------------------------------------------------------
// Parsed and re-serialised rather than regexed, so hand-added keys (plugin config,
// server settings) survive untouched.
function patchCapacitorConfig(file, { required }) {
  const path = join(CLIENT, file);
  if (!existsSync(path)) {
    if (required) { console.error(`FATAL: ${file} not found.`); failed++; }
    return;
  }
  const cfg = JSON.parse(readFileSync(path, "utf8"));
  cfg.appId = APP_ID;
  cfg.appName = APP_NAME;
  cfg.backgroundColor = rgba(BACKGROUND);
  if (cfg.android) cfg.android.backgroundColor = rgba(BACKGROUND);
  if (cfg.ios) cfg.ios.backgroundColor = rgba(BACKGROUND);
  if (cfg.plugins?.SplashScreen) cfg.plugins.SplashScreen.backgroundColor = rgba(BACKGROUND);
  if (cfg.plugins?.StatusBar) {
    cfg.plugins.StatusBar.style = STATUS_STYLE;
    cfg.plugins.StatusBar.backgroundColor = STATUS_BAR;
  }
  const next = JSON.stringify(cfg, null, 2) + "\n";
  if (next !== readFileSync(path, "utf8")) {
    writeFileSync(path, next);
    changes.push(`capacitor  ${file}`);
  }
}

patchCapacitorConfig("capacitor.config.json", { required: true });
// `cap sync ios` copies the config into the app bundle; refresh the copy too so a
// stale one never confuses anybody reading the native project.
patchCapacitorConfig("ios/App/App/capacitor.config.json", { required: false });

// --- iOS -------------------------------------------------------------------
// CFBundleDisplayName is the home-screen label. CFBundleName stays $(PRODUCT_NAME).
patch("ios/App/App/Info.plist", "ios name  ", [
  [/(<key>CFBundleDisplayName<\/key>\s*)<string>[^<]*<\/string>/,
    (_m, key) => `${key}<string>${APP_NAME}</string>`],
]);

// Both the Debug and the Release configuration carry the bundle id, so replace all.
patch("ios/App/App.xcodeproj/project.pbxproj", "ios id    ", [
  [/PRODUCT_BUNDLE_IDENTIFIER = [^;]+;/g, `PRODUCT_BUNDLE_IDENTIFIER = ${APP_ID};`],
]);

// --- Web shell (also what the packaged apps load) ---------------------------
// Not required: another branch may legitimately be reworking these, and a missing
// <meta> is a cosmetic problem, not a mis-signed binary.
patch("index.html", "web shell ", [
  [/<title>[^<]*<\/title>/, `<title>${APP_NAME}</title>`],
  [/(<meta name="description" content=")[^"]*(")/, `$1${APP_DESC}$2`],
  [/(<meta name="theme-color" content=")[^"]*(")/, `$1${BACKGROUND}$2`],
  [/(<meta name="apple-mobile-web-app-title" content=")[^"]*(")/, `$1${APP_NAME}$2`],
], { required: false });

const manifestPath = join(CLIENT, "public/manifest.webmanifest");
if (existsSync(manifestPath)) {
  const m = JSON.parse(readFileSync(manifestPath, "utf8"));
  m.name = APP_NAME;
  m.short_name = APP_NAME;
  if (APP_DESC) m.description = APP_DESC;
  m.theme_color = BACKGROUND;
  m.background_color = BACKGROUND;
  const next = JSON.stringify(m, null, 2) + "\n";
  if (next !== readFileSync(manifestPath, "utf8")) {
    writeFileSync(manifestPath, next);
    changes.push("web shell  public/manifest.webmanifest");
  }
}

// --- report ----------------------------------------------------------------
console.log(`Brand: "${APP_NAME}" (${APP_ID}), chrome ${BACKGROUND}`);
console.log(`  from ${relative(process.cwd(), BRAND_FILE) || BRAND_FILE}`);
if (changes.length) {
  console.log("  updated:");
  for (const c of changes) console.log(`    ${c}`);
} else {
  console.log("  native projects already match — nothing to write.");
}
console.log("  android/ reads brand.properties directly at build time (see app/build.gradle)");

if (failed) {
  console.error(`\n${failed} required substitution(s) failed — NOT safe to build.`);
  process.exit(1);
}

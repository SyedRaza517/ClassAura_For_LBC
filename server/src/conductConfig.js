// The behaviour/merit vocabulary a lecturer taps in class — this college's words,
// this college's points.
//
// WHY THE VOCABULARY IS DATA AND NOT CONSTANTS. "Merit +1 / Disruption −1" is one
// institution's behaviour policy written down, exactly as the attendance bands are
// its monitoring policy. A sixth-form runs house points; an FE college with an
// apprenticeship cohort logs "safety violation" and nothing called a house point; a
// college that has adopted restorative practice may not want negative entries at
// all. Which button a lecturer can press against a student's record is the college's
// decision, and hardcoding it makes every wording change a deploy — the exact thing
// configuration.md exists to prevent.
//
// The shape is attendanceBandConfig.js's, unchanged: ONE row for this institution
// (constant "singleton" key), defaults merged under it, an allowlist on the way out,
// a short cache invalidated on save. Read that file for the long argument on each
// half; comments here cover only what differs.
//
// WHY THE WHOLE LIST IS ONE JSON COLUMN AND NOT A ROW PER ENTRY. The list is only
// valid as a SET — keys unique, at least one entry active — and a row per entry
// would make those invariants something to defend across several statements. One
// column replaces the set atomically: the sheet on a lecturer's phone sees the old
// complete vocabulary or the new one, never half of either.
//
// WHAT EVENTS DO WITH IT. A ConductEvent FREEZES key, label, points and tone at log
// time (routes/conduct.js). The vocabulary is how new events are offered; it is
// never joined back through by history, so renaming "Merit" to "House point"
// tomorrow rewrites nothing a student already carries.
const prisma = require("./db");

const CONFIG_ID = "singleton";

// Short TTL, one slot, in-process — correct for one Node process, Redis for a
// cluster, same caveat as every cache and limiter in this codebase.
const TTL_MS = Number(process.env.CONDUCT_VOCAB_CACHE_MS ?? 30_000);
let cached = null; // { value, at } | null
const invalidate = () => { cached = null; };

// What a caller outside this module may see, in fixed order. An allowlist rather
// than the stored blob, so a field added tomorrow stays private until published.
const ENTRY_FIELDS = ["key", "label", "points", "tone", "notifyStudent", "active"];
const toPublic = (e) => { const out = {}; for (const f of ENTRY_FIELDS) out[f] = e[f]; return out; };

// The platform defaults: four positives, three negatives, told-the-student OFF on
// every one. Notifying is the college's choice per entry — a push that says "you
// were logged for disruption" is a safeguarding conversation some colleges want in
// person and never on a lock screen, so nothing here presumes it.
const DEFAULT_VOCABULARY = [
  { key: "merit", label: "Merit", points: 1, tone: "positive", notifyStudent: false, active: true },
  { key: "excellent-contribution", label: "Excellent contribution", points: 2, tone: "positive", notifyStudent: false, active: true },
  { key: "helping-others", label: "Helping others", points: 1, tone: "positive", notifyStudent: false, active: true },
  { key: "outstanding-work", label: "Outstanding work", points: 3, tone: "positive", notifyStudent: false, active: true },
  { key: "late-to-class", label: "Late to class", points: -1, tone: "negative", notifyStudent: false, active: true },
  { key: "disruption", label: "Disruption", points: -1, tone: "negative", notifyStudent: false, active: true },
  { key: "no-materials", label: "Missing materials/kit", points: -1, tone: "negative", notifyStudent: false, active: true },
];

const TONES = ["positive", "negative"];
const KEY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_ENTRIES = 30;

/**
 * Validate a submitted vocabulary. Pure — no database, no clock — so the rules a
 * college's save is judged by are testable in milliseconds, and get() can re-run
 * them on the way out against a row that predates a rule.
 *
 * Returns { ok: true, vocabulary } with entries reduced to ENTRY_FIELDS, or
 * { ok: false, error } where the error names the entry and the problem — it is the
 * message the administrator is shown.
 */
function normaliseVocabulary(list) {
  if (!Array.isArray(list) || list.length === 0) {
    return { ok: false, error: "The vocabulary needs at least one entry. To stop using conduct points, remove the page from staff instead of emptying the list." };
  }
  if (list.length > MAX_ENTRIES) return { ok: false, error: `That is ${list.length} entries — the limit is ${MAX_ENTRIES}.` };

  const out = [];
  const seen = new Set();
  for (const raw of list) {
    if (raw === null || typeof raw !== "object") return { ok: false, error: "Each entry must be an object." };
    const key = typeof raw.key === "string" ? raw.key.trim() : "";
    if (!KEY_RE.test(key)) {
      return { ok: false, error: `The key "${key}" is not usable. Keys are lowercase letters, digits and hyphens, up to 40 characters — they are the stable handle events are recorded against, so they must survive relabelling.` };
    }
    if (seen.has(key)) return { ok: false, error: `The key "${key}" appears twice. Keys are the handle events freeze against, so each may appear once.` };
    seen.add(key);

    const label = typeof raw.label === "string" ? raw.label.trim() : "";
    if (!label || label.length > 60) return { ok: false, error: `"${key}" needs a label of 1–60 characters.` };

    const tone = raw.tone;
    if (!TONES.includes(tone)) return { ok: false, error: `"${key}" has tone "${tone}" — it must be "positive" or "negative".` };

    // A whole number whose sign matches the tone, never zero. A positive entry
    // scoring −1 is a configuration error no lecturer can see at tap time, and a
    // zero-point event is a note — PAT is the notes feature.
    const points = raw.points;
    const signOk = tone === "positive" ? points >= 1 : points <= -1;
    if (!Number.isInteger(points) || Math.abs(points) > 10 || !signOk) {
      return { ok: false, error: `"${key}" scores ${points}. Points are whole numbers from 1 to 10 (positive entries) or −1 to −10 (negative entries).` };
    }

    // STRICT booleans, never coerced: Boolean("false") is true, and a stringifying
    // form must not switch "tell the student" on for a college that never chose it —
    // the same reasoning, verbatim, as the two booleans in prediction/settings.js.
    if (typeof raw.notifyStudent !== "boolean") return { ok: false, error: `"${key}"'s "tell the student" setting is "${raw.notifyStudent}", which is not true or false.` };
    if (typeof raw.active !== "boolean") return { ok: false, error: `"${key}"'s "active" setting is "${raw.active}", which is not true or false.` };

    out.push(toPublic({ key, label, points, tone, notifyStudent: raw.notifyStudent, active: raw.active }));
  }

  if (!out.some((e) => e.active)) {
    return { ok: false, error: "Every entry is inactive, so the sheet would offer a lecturer nothing. Keep at least one active, or reset to the defaults." };
  }
  return { ok: true, vocabulary: out };
}

/**
 * This institution's vocabulary: what it saved, or the platform defaults. Always a
 * complete, valid list — a stored row that fails today's rules falls back to the
 * defaults with a logged error, so the sheet never renders half a vocabulary.
 */
async function get() {
  if (TTL_MS > 0 && cached && Date.now() - cached.at < TTL_MS) return cached.value;

  let row = null;
  try {
    row = await prisma.conductVocabularyConfig.findFirst();
  } catch {
    row = null; // table not migrated yet — the defaults are correct, not an error
  }

  let value = DEFAULT_VOCABULARY.map(toPublic);
  if (row && Array.isArray(row.vocabulary)) {
    const checked = normaliseVocabulary(row.vocabulary);
    if (checked.ok) value = checked.vocabulary;
    else console.error(`[conduct-vocabulary] the stored vocabulary is unusable (${checked.error}) — using the defaults`);
  }

  cached = { value, at: Date.now() };
  return value;
}

/**
 * Replace the vocabulary, or reset with null. Validated here so no caller can write
 * a list get() would then refuse. upsert on the constant key — see
 * attendanceBandConfig.save for why find-then-create is the rejected shape.
 */
async function save(list, updatedBy) {
  if (list === null) {
    await prisma.conductVocabularyConfig.deleteMany({});
    invalidate();
    return { ok: true, vocabulary: DEFAULT_VOCABULARY.map(toPublic), reset: true };
  }
  const checked = normaliseVocabulary(list);
  if (!checked.ok) return { ok: false, error: checked.error };

  const data = { vocabulary: checked.vocabulary, updatedBy: updatedBy || null };
  await prisma.conductVocabularyConfig.upsert({
    where: { id: CONFIG_ID },
    update: data,
    create: { id: CONFIG_ID, ...data },
  });
  invalidate();
  return { ok: true, vocabulary: checked.vocabulary };
}

/** Whether this college has a vocabulary of its own, or runs on the defaults. */
async function isCustomised() {
  try {
    return Boolean(await prisma.conductVocabularyConfig.findFirst({ select: { id: true } }));
  } catch {
    return false;
  }
}

module.exports = { DEFAULT_VOCABULARY, normaliseVocabulary, get, save, invalidate, isCustomised, ENTRY_FIELDS };

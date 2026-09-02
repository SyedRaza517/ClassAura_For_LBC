// The Admission Tracker's single-row configuration: intake targets, and which
// documents this college actually requires.
//
// The shape CLAUDE.md documents for every config table in this codebase, and the
// reason it survived de-tenanting unchanged: platform defaults in code → one JSON
// column merged over them → no row until the college edits something → an allowlist on
// the way out. An administrator changes these from a screen; a value only changeable by
// a deploy is not a setting.
//
// PURE: no Prisma, no Express. The route reads the row and hands the blob in.
//
// WHY `requiredDocTypes` IS CONFIGURABLE AT ALL. ADMISSION_DOC_TYPES has ten entries
// and NONE of them is marked optional. Reading "documents complete" as all ten makes
// the funnel stage read artificially low — an immigration share code does not apply to
// a UK national, and most colleges do not chase one. The alternative was to invent a
// required subset in code, which imposes one institution's admissions policy on every
// other; the same reason integration credentials and attendance bands are settings
// rather than constants.
const { DOC_KEYS } = require("../admissionDocs");

// Every target a college can set. Each is NULL by default and null means "no target",
// which renders "—" — never 0, which is a target everything beats and which would put
// a college that has set nothing at the top of its own scoreboard.
const TARGET_KEYS = ["applications", "admitRate", "yieldRate", "enrolled", "revenuePence"];

const emptyTargets = () => Object.fromEntries(TARGET_KEYS.map((k) => [k, null]));

const DEFAULTS = {
  targets: {
    // Applied to whatever is in scope when no intake-specific target exists.
    default: emptyTargets(),
    // Keyed by the intake LABEL ("September 2026") — the same string the applicant
    // picked on the form and `Admission.intake` stores. Not by AdmissionIntake.id: the
    // admin can delete an intake from the list, and a target keyed by a dead id is
    // unreachable and unfixable through the screen that set it.
    byIntake: {},
  },
  requiredDocTypes: DOC_KEYS,
};

// A target must be a real, non-negative, finite number, or it is not a target. Anything
// else answers null rather than being coerced — Number("lots") is NaN, Number(null) is
// 0, and a target of 0 arrived at by coercion is indistinguishable from one somebody
// meant. Zero typed on purpose is kept; zero arrived at by accident never happens.
const cleanTarget = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

const cleanTargetSet = (stored) => {
  const out = emptyTargets();
  if (!stored || typeof stored !== "object") return out;
  for (const k of TARGET_KEYS) if (k in stored) out[k] = cleanTarget(stored[k]);
  return out;
};

/**
 * Merge a stored `data` blob over the code defaults, dropping anything unrecognised.
 *
 * Total on its input by design: the column is JSON and nothing in the database stops a
 * hand-edit or a bad migration leaving a string, an array or null in it. Serving the
 * defaults beats throwing on every read of the dashboard.
 */
function merge(stored) {
  const s = stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
  const t = s.targets && typeof s.targets === "object" ? s.targets : {};

  // An ALLOWLIST, not a filter of known-bad values: a doc type that is not in
  // ADMISSION_DOC_TYPES cannot be uploaded, so requiring one would make "documents
  // complete" unreachable for every applicant and flatten the funnel at that stage
  // with nothing on screen to say why.
  const requested = Array.isArray(s.requiredDocTypes)
    ? s.requiredDocTypes.filter((k) => DOC_KEYS.includes(k))
    : [];
  // An EMPTY list falls back to the defaults rather than meaning "nothing is required".
  // "This college requires no documents at all" is not a real admissions policy, while
  // a bad save writing [] is a real failure mode, and after the fact the two are
  // indistinguishable. The consequence of guessing wrong the other way is that every
  // applicant counts as documents-complete and a funnel stage silently reads 100%.
  const requiredDocTypes = requested.length ? requested : [...DOC_KEYS];

  const byIntake = {};
  if (t.byIntake && typeof t.byIntake === "object" && !Array.isArray(t.byIntake)) {
    for (const [label, v] of Object.entries(t.byIntake)) {
      // Kept sparse on purpose — see targetsFor. Only the keys the college actually
      // set for this intake are stored, so the rest can inherit.
      const set = {};
      if (v && typeof v === "object") {
        for (const k of TARGET_KEYS) if (k in v) set[k] = cleanTarget(v[k]);
      }
      byIntake[label] = set;
    }
  }

  return { targets: { default: cleanTargetSet(t.default), byIntake }, requiredDocTypes };
}

/**
 * The targets in force for one intake: its own overrides layered over the defaults,
 * field by field.
 *
 * A NULL INTAKE FALLS BACK TO THE DEFAULTS, and that is not merely a convenience. The
 * dashboard opens with every intake in scope, and measuring that combined figure
 * against one intake's target compares a year's applications to a term's goal.
 */
function targetsFor(config, intakeLabel) {
  const base = (config && config.targets && config.targets.default) || emptyTargets();
  const over = (intakeLabel && config?.targets?.byIntake?.[intakeLabel]) || {};
  const out = { ...base };
  // Only keys the intake actually names override. A sparse override is what lets
  // "September's application target is higher, everything else as usual" be expressed.
  for (const k of TARGET_KEYS) if (k in over) out[k] = over[k];
  return out;
}

module.exports = { DEFAULTS, TARGET_KEYS, merge, targetsFor };

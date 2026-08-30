// What a timetable looks like: the platform's defaults, what one college sets for
// everybody, and what one member of staff sets for themselves.
//
// The pattern is the one attendanceBandConfig.js and branding.js established —
// platform defaults in code, a JSON column merged over them, an allowlist on the way
// out — with ONE LAYER ADDED. The source system's "My Settings" is per person, and
// these staff use both the website and the phone app, so localStorage would mean a
// lecturer's hidden weekend followed them on one device and not the other.
//
//   defaults (here)  ->  tenant blob (TENANT_FIELDS)  ->  user blob (USER_FIELDS)
//
// Pure. No database, no cache, no Prisma — settings.js does that part, and keeping
// the rules here is what makes them testable without one.

// The display shape. Every key here is what an unconfigured college sees, and those
// values are deliberately the plainest reading of a timetable rather than anyone's
// house style.
const DEFAULTS = {
  view: "week",              // day | week | month | timeline
  layout: "grid",            // grid | list
  // Mon-Fri. Not Mon-Sun: a college that teaches at weekends turns those on, and
  // starting with two permanently empty columns makes the grid harder to read for
  // everyone who does not.
  days: [1, 2, 3, 4, 5],     // ISO weekdays, 1 = Monday
  // Hour bands, as the source system shows them. An explicit list rather than a
  // start/end pair because a college running 50-minute periods, or a lunch gap, can
  // then say so — which a pair cannot express.
  periods: [
    { start: "09:00", end: "10:00" }, { start: "10:00", end: "11:00" },
    { start: "11:00", end: "12:00" }, { start: "12:00", end: "13:00" },
    { start: "13:00", end: "14:00" }, { start: "14:00", end: "15:00" },
    { start: "15:00", end: "16:00" }, { start: "16:00", end: "17:00" },
    { start: "17:00", end: "18:00" }, { start: "18:00", end: "19:00" },
    { start: "19:00", end: "20:00" }, { start: "20:00", end: "21:00" },
  ],
  // Colour is a CHOSEN DIMENSION, not a fixed palette — the source system's "Event
  // colour key" lets a reader ask what colour should mean.
  colourBy: "category",      // category | module | room | group | course
  colourVariant: "normal",   // normal | light
  showEventTimes: true,
  showEventId: false,
  showAvailability: false,
  swapAxes: false,
  // 0 = do not highlight. A day count, applied to the changedAt TIMESTAMP at render
  // time — never a day count stored against the event, which would be wrong by the
  // next morning with nothing to correct it.
  highlightChangedDays: 0,
  // What prints inside an event tile, in this order. The ORDER is the setting.
  annotations: ["title", "unit", "category", "room", "staff", "group"],
  // The college's own statement across the top of every timetable. Institutional,
  // and therefore not something an individual can edit — see USER_FIELDS.
  notice: { enabled: false, text: "" },
};

const VIEWS = new Set(["day", "week", "month", "timeline"]);
const LAYOUTS = new Set(["grid", "list"]);
const COLOUR_BY = new Set(["category", "module", "room", "group", "course"]);
const VARIANTS = new Set(["normal", "light"]);
const ANNOTATIONS = new Set(["title", "unit", "category", "room", "staff", "group", "department", "eventId"]);

// A college sets everything, including the banner.
const TENANT_FIELDS = [
  "view", "layout", "days", "periods", "colourBy", "colourVariant",
  "showEventTimes", "showEventId", "showAvailability", "swapAxes",
  "highlightChangedDays", "annotations", "notice",
];
// A person sets everything EXCEPT the banner. The banner carries compliance wording
// — at the reference institution, what a student must do to stay eligible for a
// maintenance loan — so it is an institutional statement, and a lecturer editing
// their copy would be editing what every reader of their timetable is told.
const USER_FIELDS = TENANT_FIELDS.filter((f) => f !== "notice");

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const isBool = (v) => typeof v === "boolean";
const str = (v) => (typeof v === "string" ? v.trim() : "");

/**
 * One field, validated. Returns `undefined` when the value is unusable, and the
 * caller then leaves the key out entirely — so an unusable value falls through to
 * the layer beneath rather than blanking it.
 */
function cleanField(key, value) {
  switch (key) {
    case "view":          return VIEWS.has(value) ? value : undefined;
    case "layout":        return LAYOUTS.has(value) ? value : undefined;
    case "colourBy":      return COLOUR_BY.has(value) ? value : undefined;
    case "colourVariant": return VARIANTS.has(value) ? value : undefined;

    case "showEventTimes":
    case "showEventId":
    case "showAvailability":
    case "swapAxes":
      return isBool(value) ? value : undefined;

    case "highlightChangedDays": {
      // Clamped rather than refused: this is a number somebody types, and rejecting
      // the whole save over a stray keystroke would lose their other edits with it.
      const n = Number(value);
      if (!Number.isFinite(n)) return undefined;
      return Math.min(90, Math.max(0, Math.round(n)));
    }

    case "days": {
      if (!Array.isArray(value)) return undefined;
      const days = [...new Set(value.map(Number).filter((d) => Number.isInteger(d) && d >= 1 && d <= 7))].sort((a, b) => a - b);
      // A timetable showing no days at all is a bug report, not a preference.
      return days.length ? days : undefined;
    }

    case "periods": {
      if (!Array.isArray(value)) return undefined;
      const out = [];
      for (const p of value) {
        const start = str(p?.start), end = str(p?.end);
        // HH:MM and zero-padded, because these compare as strings everywhere else
        // in this module and "9:00" < "10:00" is false.
        if (!TIME_RE.test(start) || !TIME_RE.test(end) || end <= start) return undefined;
        out.push({ start, end });
      }
      if (!out.length || out.length > 24) return undefined;
      return out.sort((a, b) => a.start.localeCompare(b.start));
    }

    case "annotations": {
      if (!Array.isArray(value)) return undefined;
      // Order preserved — it is what prints first inside a tile — but de-duplicated,
      // since the same field twice would print twice.
      const seen = new Set(), out = [];
      for (const a of value) if (ANNOTATIONS.has(a) && !seen.has(a)) { seen.add(a); out.push(a); }
      return out.length ? out : undefined;
    }

    case "notice": {
      if (!value || typeof value !== "object") return undefined;
      return { enabled: !!value.enabled, text: str(value.text).slice(0, 2000) };
    }

    default: return undefined;
  }
}

/** `patch` reduced to the fields `allowed` permits, each validated. */
function clean(patch, allowed) {
  const out = {};
  if (!patch || typeof patch !== "object") return out;
  for (const key of allowed) {
    // Own properties only — a payload carrying __proto__ or constructor must not
    // reach the switch above.
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    const v = cleanField(key, patch[key]);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

const cleanTenant = (patch) => clean(patch, TENANT_FIELDS);
const cleanUser = (patch) => clean(patch, USER_FIELDS);

/**
 * The settings this reader actually gets: defaults, then the college's, then their
 * own. Always complete — never null, never partial — so no caller needs a fallback.
 *
 * Both blobs are re-cleaned on the way OUT as well as in. A row can predate a rule
 * or be edited by hand in a console, and a stored `view: "spiral"` would otherwise
 * reach a client that has no such view and render nothing at all.
 */
function mergeSettings(tenantBlob, userBlob) {
  return {
    ...DEFAULTS,
    ...cleanTenant(tenantBlob),
    ...cleanUser(userBlob),
  };
}

module.exports = {
  DEFAULTS, TENANT_FIELDS, USER_FIELDS,
  mergeSettings, cleanTenant, cleanUser,
};

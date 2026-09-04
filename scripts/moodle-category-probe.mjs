// READ-ONLY probe. Answers one question: can this Moodle token see the course
// categories that would carry the academic department?
//
// Two web service calls, both reads. Writes nothing, to Moodle or the database.
// Prints course counts, category ids and category names. Never prints the token,
// and never touches enrolled users, grades or anything about a student.
import { readFileSync } from "node:fs";

const ENV = new URL("../server/.env", import.meta.url).pathname.replace(/^/([A-Za-z]:)/, "$1");

function fromEnvFile(key) {
  const line = readFileSync(ENV, "utf8").split(/\r?\n/).find((l) => l.startsWith(key + "="));
  if (!line) return null;
  return line.slice(key.length + 1).trim().replace(/^["']|["']$/g, "");
}

const BASE = (fromEnvFile("MOODLE_URL") || "").replace(/\/+$/, "");
const TOKEN = fromEnvFile("MOODLE_TOKEN");
if (!BASE || !TOKEN) { console.error("MOODLE_URL / MOODLE_TOKEN not found in server/.env"); process.exit(1); }

// Same request shape as server/src/moodle.js:48-76.
async function call(wsfunction, params = {}) {
  const body = new URLSearchParams({ wstoken: TOKEN, moodlewsrestformat: "json", wsfunction });
  for (const [k, v] of Object.entries(params)) body.set(k, String(v));
  const res = await fetch(`${BASE}/webservice/rest/server.php`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`${wsfunction}: not JSON (HTTP ${res.status}) — ${text.slice(0, 200)}`); }
  if (data && data.exception) throw new Error(`${wsfunction}: ${data.errorcode} — ${data.message}`);
  return data;
}

const line = (s = "") => console.log(s);

line(`Moodle: ${BASE}`);
line();

// ---- 1. Does the course listing carry categoryid? (0 extra calls in the real sync)
line("=== core_course_get_courses ===");
let courses = [];
try {
  courses = (await call("core_course_get_courses")).filter((c) => c.format !== "site");
  line(`courses returned: ${courses.length}`);
  const withCat = courses.filter((c) => c.categoryid != null);
  line(`carrying categoryid: ${withCat.length} / ${courses.length}`);
  const byCat = new Map();
  for (const c of courses) {
    const k = c.categoryid ?? "(none)";
    if (!byCat.has(k)) byCat.set(k, []);
    byCat.get(k).push(c.shortname || c.fullname || `id ${c.id}`);
  }
  line(`distinct categories in use: ${byCat.size}`);
  line();
  line("category id → course count → sample courses");
  for (const [k, names] of [...byCat.entries()].sort((a, b) => b[1].length - a[1].length)) {
    line(`  ${String(k).padEnd(8)} ${String(names.length).padStart(4)}  ${names.slice(0, 4).join(", ")}${names.length > 4 ? " …" : ""}`);
  }
} catch (e) {
  line(`FAILED: ${e.message}`);
}
line();

// ---- 2. Can we read the category tree? (1 extra call per sync, needs the function enabled)
line("=== core_course_get_categories ===");
try {
  const cats = await call("core_course_get_categories");
  line(`PERMITTED — ${cats.length} categories returned`);
  line();
  line("id → parent → name (course count)");
  for (const c of cats) {
    line(`  ${String(c.id).padEnd(6)} parent ${String(c.parent).padEnd(6)} ${c.name}  (${c.coursecount})`);
  }
} catch (e) {
  line(`NOT PERMITTED: ${e.message}`);
  line();
  line("→ Falls back to bare category ids from the listing above, which the mapping");
  line("  screen can still show as 'category N — X courses — [name it]'.");
}
line();
line("Probe complete. Nothing was written.");

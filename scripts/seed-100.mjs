// Adds 100 staff to the running API (POST /api/staff as admin).
// Usage: node scripts/seed-100.mjs [count]
// Exercises the real auth + validation path, not a direct DB insert.
const BASE = process.env.API_BASE || "http://localhost:4000/api";
const ADMIN = { email: "admin@edtech.co.uk", password: "password123" };
const COUNT = Number(process.argv[2]) || 100;
const CONCURRENCY = 10;

const FIRST = ["James", "Aisha", "Daniel", "Sofia", "Priya", "Liam", "Maya", "Noah", "Zara", "Omar",
  "Ella", "Hassan", "Grace", "Yusuf", "Chloe", "Idris", "Nadia", "Leo", "Fatima", "Ethan",
  "Ruby", "Samuel", "Layla", "Oscar", "Amara", "Theo", "Iris", "Musa", "Esme", "Reuben"];
const LAST = ["Whitfield", "Rahman", "Okoye", "Marin", "Nair", "Patel", "Khan", "Bennett", "Adeyemi", "Fischer",
  "Hughes", "Santos", "Walsh", "Ahmed", "Clarke", "Dube", "Novak", "Reed", "Ivanova", "Mensah"];
const TITLES = ["Mathematics Teacher", "Science Tutor", "English Tutor", "Exams Officer", "Admissions Lead",
  "Teaching Assistant", "Head of Department", "Pastoral Lead", "Lab Technician", "Librarian"];
const DEPTS = ["Sixth Form", "Tuition Centre", "Exam Centre", "Administration", "Student Services"];

const pick = (arr, i) => arr[i % arr.length];

async function login() {
  const r = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ADMIN),
  });
  if (!r.ok) throw new Error(`Login failed: ${r.status} ${await r.text()}`);
  return (await r.json()).token;
}

async function createStaff(token, i) {
  const first = pick(FIRST, i);
  const last = pick(LAST, Math.floor(i / FIRST.length) + i);
  const name = `${first} ${last}`;
  // Unique email per record so re-runs don't collide.
  const email = `loadtest.${i}.${first}.${last}@edtech.co.uk`.toLowerCase();
  const body = {
    name,
    role: pick(TITLES, i),
    dept: pick(DEPTS, i),
    email,
    allowance: 25 + (i % 6),
  };
  const r = await fetch(`${BASE}/staff`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { ok: r.ok, status: r.status, email, err: r.ok ? null : await r.text() };
}

async function main() {
  console.log(`Logging in as ${ADMIN.email}…`);
  const token = await login();
  console.log(`Creating ${COUNT} staff (concurrency ${CONCURRENCY})…`);

  const indices = Array.from({ length: COUNT }, (_, i) => i);
  let created = 0, failed = 0;
  const failures = [];
  const t0 = Date.now();

  // Simple worker pool.
  async function worker() {
    let i;
    while ((i = indices.shift()) !== undefined) {
      const res = await createStaff(token, i);
      if (res.ok) created++;
      else { failed++; failures.push(res); }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const secs = ((Date.now() - t0) / 1000).toFixed(2);
  console.log(`\nDone in ${secs}s — created ${created}, failed ${failed}`);
  if (failures.length) {
    console.log("First few failures:");
    failures.slice(0, 5).forEach((f) => console.log(`  ${f.status} ${f.email} — ${f.err}`));
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

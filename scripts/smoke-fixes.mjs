// Smoke-tests the bug fixes against the running API.
const BASE = "http://localhost:4000/api";
const login = async (email, password) => {
  const r = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  return (await r.json()).token;
};
const j = (t) => ({ "Content-Type": "application/json", Authorization: `Bearer ${t}` });
let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "✓" : "✗"} ${name}${detail ? "  — " + detail : ""}`); ok ? pass++ : fail++; };

const admin = await login("admin@edtech.co.uk", "password123");
const staff = await login("j.whitfield@edtech.co.uk", "password123");

// 1) /staff reduced shape for staff, full for admin
const adminStaff = await (await fetch(`${BASE}/staff`, { headers: j(admin) })).json();
const staffStaff = await (await fetch(`${BASE}/staff`, { headers: j(staff) })).json();
check("admin sees emails for all staff", adminStaff.every(s => "email" in s));
const others = staffStaff.filter(s => s.email !== "j.whitfield@edtech.co.uk");
check("staff does NOT see colleagues' email", others.length > 0 && others.every(s => s.email === undefined));
const self = staffStaff.find(s => s.role && s.dept && s.name === "James Whitfield");
check("staff still sees OWN full record (allowance present)", self && self.allowance !== undefined, `allowance=${self?.allowance}`);

// 2) adjustments validation
const adjBad = await fetch(`${BASE}/adjustments`, { method: "POST", headers: j(admin), body: JSON.stringify({ staffId: "s1", days: "abc", note: "x" }) });
check("adjustment days='abc' rejected (400)", adjBad.status === 400);
const adjZero = await fetch(`${BASE}/adjustments`, { method: "POST", headers: j(admin), body: JSON.stringify({ staffId: "s1", days: 0, note: "x" }) });
check("adjustment days=0 rejected (400)", adjZero.status === 400);
const adjOk = await fetch(`${BASE}/adjustments`, { method: "POST", headers: j(admin), body: JSON.stringify({ staffId: "s1", days: 2, note: "smoke +2" }) });
check("adjustment days=2 accepted (201)", adjOk.status === 201);

// 3) PUT allowance validation
const alwBad = await fetch(`${BASE}/staff/s1`, { method: "PUT", headers: j(admin), body: JSON.stringify({ allowance: -5 }) });
check("PUT allowance=-5 rejected (400)", alwBad.status === 400);

// 4) admin check-in upsert with unknown staff -> clean 400 (not 500)
const ciBad = await fetch(`${BASE}/checkins`, { method: "PUT", headers: j(admin), body: JSON.stringify({ staffId: "nope-xyz", date: "2026-05-30", in: "09:00" }) });
check("admin check-in for unknown staff -> 400 (not 500)", ciBad.status === 400, `got ${ciBad.status}`);

// 5) re-decision guard: create a leave, approve, then try to re-decide
const created = await (await fetch(`${BASE}/leave`, { method: "POST", headers: j(admin), body: JSON.stringify({ staffId: "s3", type: "personal", start: "2026-07-01", end: "2026-07-01", reason: "smoke" }) })).json();
const dec1 = await fetch(`${BASE}/leave/${created.id}/decision`, { method: "PUT", headers: j(admin), body: JSON.stringify({ status: "approved" }) });
const dec2 = await fetch(`${BASE}/leave/${created.id}/decision`, { method: "PUT", headers: j(admin), body: JSON.stringify({ status: "rejected" }) });
check("first decision succeeds (200)", dec1.status === 200);
check("re-deciding an already-decided request rejected (409)", dec2.status === 409, `got ${dec2.status}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

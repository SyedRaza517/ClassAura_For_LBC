// Closed-loop load test against the running API.
// Usage: node scripts/stress-test.mjs [concurrency] [durationSeconds]
//   e.g. node scripts/stress-test.mjs 50 15
// Spins up N concurrent workers that hammer a mixed read-heavy workload for
// the given duration, then reports throughput, latency percentiles, errors.
const BASE = process.env.API_BASE || "http://localhost:4000/api";
const ADMIN = { email: "admin@edtech.co.uk", password: "password123" };
const CONCURRENCY = Number(process.argv[2]) || 50;
const DURATION_MS = (Number(process.argv[3]) || 15) * 1000;

async function login() {
  const r = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ADMIN),
  });
  if (!r.ok) throw new Error(`Login failed: ${r.status}`);
  return (await r.json()).token;
}

// Weighted mix of realistic read traffic. Login is included but rare because
// bcrypt makes it ~100x heavier than a token-authed read.
function buildWorkload(token) {
  const auth = { Authorization: `Bearer ${token}` };
  return [
    { weight: 50, name: "GET /staff", run: () => fetch(`${BASE}/staff`, { headers: auth }) },
    { weight: 20, name: "GET /leave", run: () => fetch(`${BASE}/leave`, { headers: auth }) },
    { weight: 15, name: "GET /checkins", run: () => fetch(`${BASE}/checkins`, { headers: auth }) },
    { weight: 10, name: "GET /health", run: () => fetch(`${BASE}/health`) },
    { weight: 5,  name: "POST /auth/login", run: () => fetch(`${BASE}/auth/login`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(ADMIN),
      }) },
  ];
}

function weightedPicker(workload) {
  const total = workload.reduce((s, w) => s + w.weight, 0);
  return (rnd) => {
    let x = rnd * total;
    for (const w of workload) { if ((x -= w.weight) < 0) return w; }
    return workload[0];
  };
}

const pct = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0;

async function main() {
  console.log(`Logging in…`);
  const token = await login();
  const workload = buildWorkload(token);
  const pickByWeight = weightedPicker(workload);

  const stats = {}; // name -> { count, errors, latencies[] }
  for (const w of workload) stats[w.name] = { count: 0, errors: 0, latencies: [] };
  let total = 0, errors = 0;

  console.log(`Stress test: ${CONCURRENCY} concurrent workers for ${DURATION_MS / 1000}s against ${BASE}\n`);
  const endAt = Date.now() + DURATION_MS;
  const t0 = Date.now();

  async function worker() {
    while (Date.now() < endAt) {
      // deterministic-ish spread without Math.random dependency concerns
      const w = pickByWeight((total % 100) / 100);
      const s = stats[w.name];
      const start = Date.now();
      try {
        const r = await w.run();
        // drain body so the connection is freed
        await r.arrayBuffer();
        const ms = Date.now() - start;
        s.latencies.push(ms);
        s.count++; total++;
        if (!r.ok) { s.errors++; errors++; }
      } catch (e) {
        s.errors++; errors++; s.count++; total++;
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const secs = (Date.now() - t0) / 1000;

  // Report
  const allLat = [];
  for (const w of workload) allLat.push(...stats[w.name].latencies);
  allLat.sort((a, b) => a - b);

  console.log("=".repeat(78));
  console.log(`SUMMARY  —  ${total} requests in ${secs.toFixed(1)}s  =  ${(total / secs).toFixed(0)} req/s`);
  console.log(`Errors: ${errors} (${((errors / total) * 100).toFixed(2)}%)`);
  console.log(`Overall latency (ms):  p50 ${pct(allLat, 50)}  p90 ${pct(allLat, 90)}  p99 ${pct(allLat, 99)}  max ${allLat[allLat.length - 1] ?? 0}`);
  console.log("=".repeat(78));
  console.log("Per-endpoint:");
  const pad = (s, n) => String(s).padEnd(n);
  const padL = (s, n) => String(s).padStart(n);
  console.log(`  ${pad("endpoint", 20)} ${padL("reqs", 7)} ${padL("err", 5)} ${padL("p50", 6)} ${padL("p90", 6)} ${padL("p99", 7)} ${padL("max", 7)}`);
  for (const w of workload) {
    const s = stats[w.name];
    const lat = s.latencies.slice().sort((a, b) => a - b);
    console.log(`  ${pad(w.name, 20)} ${padL(s.count, 7)} ${padL(s.errors, 5)} ${padL(pct(lat, 50), 6)} ${padL(pct(lat, 90), 6)} ${padL(pct(lat, 99), 7)} ${padL(lat[lat.length - 1] ?? 0, 7)}`);
  }
  console.log("=".repeat(78));
}

main().catch((e) => { console.error(e); process.exit(1); });

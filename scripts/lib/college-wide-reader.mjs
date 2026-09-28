// A college-wide token, for the few assertions that legitimately need one.
//
// WHY THIS EXISTS. Since 28 Sep 2026 the audit trail is college-wide only
// (requireCollegeWide in server/src/routes/audit.js): its summaries and before/after
// snapshots are free text naming students from every department, so there is nothing for
// the departmental guard to filter and a narrowed admin was reading the whole college's
// history. The refusal is the product being right.
//
// It also breaks four suites under `SMOKE_SCOPED_DEPARTMENT=1`, and NOT because their
// fixtures are wrong — the shape fixture-department.mjs exists for. scope-all-staff.js
// narrows EVERY account, including the Super Admin, so in that pass no account can read
// the trail at all. The assertions it stops are the ones that matter most: that the trail
// records a mitigating-circumstance decision and never its reason, that it carries no
// intervention notes, that a referral's audit row says who and where and never why. Those
// are Article 9 privacy properties, and losing them in the scoped pass to gain the gate
// would be a bad trade.
//
// So: in the ordinary pass this returns the caller's own token unchanged and creates
// nothing at all. In the scoped pass it makes ONE throwaway college-wide admin, hands back
// its token, and the caller disposes of it. Reading the rows straight from Prisma was the
// rejected alternative — it would prove what was written but stop covering what the
// ENDPOINT serialises, which is where a leak would actually reach a browser.
//
// SELF-CONTAINED ON PURPOSE: it asks /auth/me whether the caller is college-wide and owns
// its own Prisma client for the one write no route will do. smoke-prediction.mjs has no
// client of its own, and a helper that only worked in suites that happened to have one
// would be a helper the next caller quietly works around.
//
// Not a smoke suite itself (it lives under lib/, which the runner does not scan).
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "server");
// createRequire, not a dynamic import: the server is CommonJS, and the suites reach into
// it the same way.
const serverRequire = createRequire(pathToFileURL(join(SERVER, "package.json")));

// Both spellings of a suite's HTTP result. They are split roughly evenly across scripts/
// and neither is going to be renamed for this.
const payload = (res) => res?.body ?? res?.data ?? null;

/**
 * @param {object} opts
 * @param {(path: string, init?: object) => Promise<object>} opts.call  the suite's HTTP helper
 * @param {string} opts.token  the caller's token, returned as-is when it is college-wide
 * @param {string} [opts.label]  folded into the throwaway account's email
 * @returns {Promise<{ token: string, narrowedPass: boolean, dispose: () => Promise<void> }>}
 */
export async function collegeWideReader({ call, token, label = "cwr" }) {
  const me = payload(await call("/auth/me", { token }));
  // The ordinary pass: already college-wide, so nothing to make and nothing to clean up.
  // `!== false` rather than `=== true`: an older build that does not report the flag at
  // all must behave as it always did, not silently start creating accounts.
  if (me?.collegeWide !== false) return { token, narrowedPass: false, dispose: async () => {} };

  const { PrismaClient } = serverRequire(join(SERVER, "node_modules", "@prisma", "client"));
  const { hashPassword } = serverRequire(join(SERVER, "src", "auth.js"));
  const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

  const email = `${label}.collegewide.${Date.now()}@edtech.co.uk`;
  const password = "CollegeWideReader123!";
  let row = null;
  try {
    // Written through Prisma rather than POST /staff, because that route needs a page
    // grant this suite's account may not hold and because no route sets collegeWide on
    // create. The password goes through the server's own hash so the sign-in below uses
    // the real login path rather than a fixture short-cut.
    row = await db.staff.create({
      data: {
        name: "College-wide Reader", email, initials: "CW", colour: "#334155",
        // jobTitle and dept are NOT NULLABLE on Staff, and `dept` here is the free-text HR
        // label -- nothing to do with the academic department this account is being made
        // college-wide across. Two meanings of one word; academicDepartments.js says so.
        jobTitle: "Smoke fixture", dept: "Smoke",
        passwordHash: await hashPassword(password),
        accountRole: "ADMIN", adminPages: null, isSuperAdmin: false,
        mustChangePassword: false, collegeWide: true,
      },
    });
    const login = payload(await call("/auth/login", { method: "POST", body: { email, password } }));
    if (!login?.token) throw new Error(`could not sign in as the college-wide reader — ${JSON.stringify(login)}`);
    return {
      token: login.token,
      narrowedPass: true,
      // Deleted rather than left behind: every suite shares one seeded database in a
      // single `npm test` run, and a college-wide admin left lying about is a permission
      // this suite silently granted to every suite that sorts after it. smoke-audit.mjs
      // states the same rule about the Super Admin it promotes.
      dispose: async () => {
        await db.staffAcademicDepartment.deleteMany({ where: { staffId: row.id } }).catch(() => {});
        await db.staff.deleteMany({ where: { id: row.id } }).catch(() => {});
        await db.$disconnect().catch(() => {});
      },
    };
  } catch (e) {
    if (row) await db.staff.deleteMany({ where: { id: row.id } }).catch(() => {});
    await db.$disconnect().catch(() => {});
    throw e;
  }
}

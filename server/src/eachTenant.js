// Runs a background job once per active institution.
//
// The schedulers (timesheet reminders, month-end attendance emails, the daily
// notification sweep, the 02:00 Moodle import) run on a timer, outside any request,
// so nothing has resolved a tenant for them. Under the isolation extension in db.js
// that means their queries now THROW rather than quietly reading every institution's
// rows — which is the correct failure, but it does mean each job has to say which
// institution it is acting for.
//
// One tenant's failure must never stop the others. A college with a broken Moodle
// token or an unreachable mailbox should not silently cancel month-end attendance
// emails for every other customer, so each tenant is isolated in its own try/catch
// and failures are logged and stepped over.
const prisma = require("./db");
const { crossTenant, runInTenant } = require("./db");

async function forEachTenant(label, fn) {
  let tenants;
  try {
    tenants = await crossTenant(() => prisma.tenant.findMany({ where: { active: true }, orderBy: { slug: "asc" } }));
  } catch (e) {
    console.error("[" + label + "] could not list tenants:", e.message);
    return { ran: 0, failed: 0 };
  }

  let ran = 0;
  let failed = 0;
  for (const t of tenants) {
    try {
      await runInTenant(t.id, () => fn(t));
      ran++;
    } catch (e) {
      failed++;
      console.error("[" + label + "] tenant " + t.slug + " failed:", e.message);
    }
  }
  if (failed) console.error("[" + label + "] " + failed + " of " + tenants.length + " institutions failed");
  return { ran, failed };
}

module.exports = { forEachTenant };

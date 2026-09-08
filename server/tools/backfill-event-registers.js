// Build the registers for events that already exist.
//
// Registers are created on save from 8 Sep 2026 onward, and by "Publish this period"
// over a date range. Neither reaches a term saved BEFORE that change: those events are
// published, wanted and attached to a module, and still have no attendance behind them.
// This is the one-off that closes that, and it is the same call the API makes rather
// than a second implementation of the rules -- syncEventRegisters upserts on the event
// and group, so running it over events that already have registers updates them rather
// than duplicating, and running this twice is harmless.
//
// It runs COLLEGE-WIDE on purpose. db.js is scoped, and a bare script has no request to
// take a scope from; binding a narrower one would silently skip every event belonging to
// a school this script had not been told about, and report success.
//
//   node tools/backfill-event-registers.js                 # dry run
//   node tools/backfill-event-registers.js --apply
//
// ALWAYS pass DATABASE_URL explicitly. server/.env points at a live database.
const { PrismaClient } = require("@prisma/client");
const { runWithAcademicScope } = require("../src/academicScope");
const { syncEventRegisters } = require("../src/timetabling/registers");

const bare = new PrismaClient();
const APPLY = process.argv.includes("--apply");

(async () => {
  const url = process.env.DATABASE_URL || "";
  if (!url) { console.error("FAILED: DATABASE_URL is not set. Pass it explicitly."); process.exit(1); }
  console.log(`Database: ${url.replace(/^.*@/, "").split("/")[0]}`);
  console.log(APPLY ? "MODE: APPLY\n" : "MODE: dry run. Nothing will be written. Add --apply.\n");

  try {
    // Read with the BARE client: the scoped one would apply a filter this script has no
    // business having, and the question here is "every event in the college".
    const events = await bare.timetableEvent.findMany({
      where: { published: true, createRegisters: true, unitId: { not: null } },
      select: { id: true, date: true, title: true },
      orderBy: { date: "asc" },
    });
    const already = await bare.hndSession.count({ where: { timetableEventId: { not: null } } });
    console.log(`  events eligible for a register  ${events.length}`);
    console.log(`  registers already linked        ${already}`);
    if (!events.length) { console.log("\nNothing to do."); return; }
    if (!APPLY) {
      console.log(`\nWould build registers for ${events.length} event(s), ${events[0].date} .. ${events[events.length - 1].date}.`);
      return;
    }

    const acc = { created: 0, updated: 0, frozen: 0 };
    const skips = new Map();
    await runWithAcademicScope({ academicDepartmentIds: [], collegeWide: true }, async () => {
      for (const e of events) {
        const r = await syncEventRegisters(e.id);
        acc.created += r.created;
        acc.updated += r.updated;
        acc.frozen += r.frozen.length;
        for (const s of r.skipped) skips.set(s.reason, (skips.get(s.reason) || 0) + 1);
      }
    });

    console.log(`\n  created ${acc.created}`);
    console.log(`  updated ${acc.updated}`);
    console.log(`  frozen  ${acc.frozen}  (already marked — left where they were)`);
    for (const [reason, n] of skips) console.log(`  skipped ${n}  ${reason}`);
    console.log(`\n  registers linked now            ${await bare.hndSession.count({ where: { timetableEventId: { not: null } } })}`);
  } finally {
    await bare.$disconnect();
  }
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });

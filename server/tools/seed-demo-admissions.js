#!/usr/bin/env node
// Demo applications, so the Admission Tracker has a funnel to draw.
//
// WHY THIS IS SAFE TO RUN AGAINST PRODUCTION, stated plainly because that is not a
// sentence to take on trust. At the time of writing BOTH databases hold zero Admission
// rows — the tracker is a new feature and no real application has ever been entered —
// so nothing here mixes with a real applicant's record. It does NOT touch Student,
// AttendanceMark, Staff or anything else: the only tables written are Admission, Ism,
// and the two small lookup tables the tracker's filters need.
//
// EVERY ROW IS MARKED AND EVERY ROW IS REMOVABLE. Each demo applicant's email is
// `demo.NN@<DEMO_DOMAIN>`, and `.invalid` is reserved by RFC 2606 precisely so it can
// never belong to anybody — so the marker cannot collide with a real person, and
// `--remove` deletes exactly the rows this script created and nothing else.
//
// Usage:
//   DATABASE_URL="postgresql://..." node server/tools/seed-demo-admissions.js           # dry run
//   DATABASE_URL="postgresql://..." node server/tools/seed-demo-admissions.js --apply
//   DATABASE_URL="postgresql://..." node server/tools/seed-demo-admissions.js --remove
const { PrismaClient } = require("@prisma/client");
const { merge: mergeTrackerSettings } = require("../src/admissions/trackerSettings");

const APPLY = process.argv.includes("--apply");
const REMOVE = process.argv.includes("--remove");
const DEMO_DOMAIN = "demo.invalid";

const die = (m) => { console.error(`\nREFUSING: ${m}\n`); process.exit(1); };

// The funnel, widest first. Each number is a COUNT REACHING THAT STAGE, so they must
// descend — stats.js walks the stages backwards and treats a later stage as implying
// every earlier one, which means a wider lower stage would be silently absorbed rather
// than showing up as the mistake it is.
const FUNNEL = {
  enquiries: 120,
  applications: 92,
  documentsComplete: 64,
  interviewed: 48,
  offers: 34,
  accepted: 23,
  enrolled: 15,
};

const COURSES = [
  { name: "HND Business", feeAmountPence: 925000 },
  { name: "HND Computing", feeAmountPence: 925000 },
  { name: "HND Healthcare Practice", feeAmountPence: 880000 },
];
const INTAKES = [{ label: "September 2026" }, { label: "January 2027" }];

const FOUND_VIA = ["Google", "Friend or family", "Facebook", "Open day", "Agent", "UCAS"];
// Used ONLY for rows that are not applications, and "apply" is deliberately absent:
// stats.js treats source === "apply" as evidence of an application on its own, so an
// enquiry carrying it is counted as one whatever its dates say.
const ENQUIRY_SOURCES = ["walkin", "phone", "manual", "event"];
const CITIZENSHIP = ["United Kingdom", "Nigeria", "India", "Pakistan", "Romania", "Ghana"];
const POSTCODES = ["E1 6AN", "SE15 4TP", "N4 3HF", "CR0 2RF", "IG1 1AA", "HA9 0WS"];
const FIRST = ["Alex", "Priya", "Daniel", "Fatima", "Marcus", "Chloe", "Omar", "Grace", "Liam", "Aisha"];
const LAST = ["Demo", "Sample", "Example", "Testcase", "Fixture"];

// Deterministic, so two runs produce the same spread and a re-run after --remove
// reproduces the same picture. Math.random() would make the tracker look different
// every time somebody reseeded, which is confusing rather than random.
const pick = (arr, i) => arr[i % arr.length];

// Spread arrivals over the last five months so the monthly trend chart has a shape.
// Newest first, so the most recent month is busiest — what a live intake looks like.
function arrivedAt(i, total) {
  const daysAgo = Math.round((i / Math.max(1, total - 1)) * 150);
  return new Date(Date.now() - daysAgo * 86400000);
}
const plusDays = (d, n) => new Date(d.getTime() + n * 86400000);
const ymd = (d) => d.toISOString().slice(0, 10);

(async () => {
  if (!process.env.DATABASE_URL) die("DATABASE_URL is not set. Pass it on the command line.");
  const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  const host = (process.env.DATABASE_URL.match(/@([^/:]+)/) || [])[1];
  const dbname = (process.env.DATABASE_URL.match(/\/([^/?]+)(\?|$)/) || [])[1];
  console.log(`\nDatabase: ${dbname} at ${host}`);

  // "Complete" means whatever THIS college's tracker settings require, read from the
  // same place the tracker reads it. A hardcoded list here would seed data that looks
  // complete to this script and incomplete to the screen.
  const settingsRow = await db.admissionTrackerSettings.findFirst().catch(() => null);
  const REQUIRED_DOCS = mergeTrackerSettings(settingsRow && settingsRow.data).requiredDocTypes;
  console.log("Documents required for \"complete\": " + REQUIRED_DOCS.length + "\n");

  const existing = await db.admission.findMany({
    where: { email: { endsWith: "@" + DEMO_DOMAIN } }, select: { id: true },
  });
  const real = await db.admission.count({ where: { NOT: { email: { endsWith: "@" + DEMO_DOMAIN } } } });
  console.log(`Demo applications already present: ${existing.length}`);
  console.log(`NON-demo applications present:     ${real}\n`);

  if (REMOVE) {
    if (!existing.length) { console.log("Nothing to remove.\n"); await db.$disconnect(); return; }
    const ids = existing.map((a) => a.id);
    // Interviews first — Ism.admissionId points at the row being deleted.
    const isms = await db.ism.deleteMany({ where: { admissionId: { in: ids } } });
    // These cascade on delete, but removing them explicitly means the count can be
    // reported rather than assumed.
    const docs = await db.admissionDocument.deleteMany({ where: { admissionId: { in: ids } } });
    const gone = await db.admission.deleteMany({ where: { id: { in: ids } } });
    console.log(`Removed ${gone.count} demo applications, ${isms.count} interviews and ${docs.count} documents.`);
    console.log(`Left alone: ${real} real applications, and the course/intake lists.\n`);
    await db.$disconnect();
    return;
  }

  // A re-seed replaces the previous demo set rather than doubling it.
  const plan = [
    { what: "AdmissionCourse", n: COURSES.length, note: "created if missing, fee set so revenue shows" },
    { what: "AdmissionIntake", n: INTAKES.length, note: "created if missing" },
    { what: "Admission (demo)", n: FUNNEL.enquiries, note: existing.length ? `replacing ${existing.length}` : "new" },
    { what: "Ism (interviews)", n: FUNNEL.interviewed, note: "one per interviewed applicant" },
    { what: "AdmissionDocument", n: "varies", note: "full set for complete applicants, partial for the rest" },
  ];
  console.table(plan);
  console.table(FUNNEL);

  if (!APPLY) {
    console.log("Dry run only. Re-run with --apply to write these.\n");
    await db.$disconnect();
    return;
  }

  if (existing.length) {
    const ids = existing.map((a) => a.id);
    await db.ism.deleteMany({ where: { admissionId: { in: ids } } });
    await db.admissionDocument.deleteMany({ where: { admissionId: { in: ids } } });
    await db.admission.deleteMany({ where: { id: { in: ids } } });
    console.log(`Cleared ${ids.length} previous demo applications.`);
  }

  // Lookup lists. Upserted by name/label so a college that already has its own courses
  // keeps them and simply gains a fee where one was missing.
  for (const [i, c] of COURSES.entries()) {
    const found = await db.admissionCourse.findFirst({ where: { name: c.name } });
    if (found) await db.admissionCourse.update({ where: { id: found.id }, data: { feeAmountPence: c.feeAmountPence } });
    else await db.admissionCourse.create({ data: { ...c, active: true, sortOrder: i } });
  }
  for (const [i, t] of INTAKES.entries()) {
    const found = await db.admissionIntake.findFirst({ where: { label: t.label } });
    if (!found) await db.admissionIntake.create({ data: { ...t, active: true, sortOrder: i } });
  }

  const total = FUNNEL.enquiries;
  let interviews = 0;
  let documents = 0;
  for (let i = 0; i < total; i++) {
    const created = arrivedAt(i, total);
    const isApplication = i < FUNNEL.applications;
    const hasAllDocs = i < FUNNEL.documentsComplete;
    const isInterviewed = i < FUNNEL.interviewed;
    const isOffer = i < FUNNEL.offers;
    const isAccepted = i < FUNNEL.accepted;
    const isEnrolled = i < FUNNEL.enrolled;

    const row = await db.admission.create({
      data: {
        firstName: pick(FIRST, i),
        surname: pick(LAST, i) + " " + String(i + 1).padStart(2, "0"),
        email: `demo.${String(i + 1).padStart(2, "0")}@${DEMO_DOMAIN}`,
        course: pick(COURSES, i).name,
        intake: pick(INTAKES, i).label,
        intakeYear: pick(INTAKES, i).label.split(" ")[1],
        foundVia: pick(FOUND_VIA, i),
        countryOfCitizenship: pick(CITIZENSHIP, i),
        postCode: pick(POSTCODES, i),
        createdAt: created,
        // An enquiry that never became an application has no submitted date and did not
        // come through the apply form — that absence is exactly what stats.js reads.
        source: isApplication ? "apply" : pick(ENQUIRY_SOURCES, i),
        applicationSubmittedAt: isApplication ? plusDays(created, 2) : null,
        offerStatus: isAccepted ? "accepted" : isOffer ? "sent" : null,
        offerSentAt: isOffer ? plusDays(created, 14) : null,
        offerAcceptedAt: isAccepted ? plusDays(created, 21) : null,
        enrollStatus: isEnrolled ? "Enroll" : null,
        enrolEmailSentAt: isEnrolled ? plusDays(created, 28) : null,
        active: false,
      },
      select: { id: true },
    });

    // Real documents, rather than letting "Documents complete" be INFERRED from the
    // interviewed count by the backward-implication rule. A stage standing in for one
    // nobody has evidence for is the opposite of what the funnel is meant to show.
    // A partial set for the next few, so an incomplete applicant is visibly incomplete.
    const docsFor = hasAllDocs ? REQUIRED_DOCS : (isApplication ? REQUIRED_DOCS.slice(0, 3) : []);
    if (docsFor.length) {
      await db.admissionDocument.createMany({
        data: docsFor.map((docType) => ({
          admissionId: row.id,
          docType,
          fileName: docType + "-demo.pdf",
          mimeType: "application/pdf",
          sizeBytes: 120000,
          confirmed: hasAllDocs,
          confirmedAt: hasAllDocs ? plusDays(created, 6) : null,
        })),
      });
      documents += docsFor.length;
    }

    if (isInterviewed) {
      await db.ism.create({
        data: {
          admissionId: row.id,
          name: "Demo interview",
          interviewDate: ymd(plusDays(created, 9)),
          interviewerName: "Demo Interviewer",
          admitted: isOffer ? "Yes" : "No",
        },
      });
      interviews++;
    }
  }

  const after = await db.admission.count({ where: { email: { endsWith: "@" + DEMO_DOMAIN } } });
  console.log(`\nWrote ${after} demo applications, ${interviews} interviews and ${documents} documents.`);
  console.log(`Real applications untouched: ${real}.`);
  console.log(`\nTo undo: node server/tools/seed-demo-admissions.js --remove\n`);
  await db.$disconnect();
})().catch((e) => { console.error("\nFAILED:", e.message, "\n"); process.exit(1); });

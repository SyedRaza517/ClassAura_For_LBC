// The department a smoke suite's fixtures must carry, so the suite holds in BOTH passes.
//
// `SMOKE_SCOPED_DEPARTMENT=1 npm test` narrows every seeded account to one academic
// department that owns every seeded course, unit and student, then runs the suites again
// through the guard's FILTERED branch. A suite that builds its own units through a bare
// Prisma client used to build them with no department — invisible to the narrowed admin
// it then signed in as, so GET /hnd/sessions/:id/qr-code answered 404 and the suite was
// listed as "cannot run scoped". The product was right; the fixtures were not.
//
// This asks the database what the signing-in admin is narrowed to. College-wide (the
// ordinary pass): null, and the fixtures stay exactly as they were. Narrowed (the scoped
// pass): that department's id, stamped on every unit, course and cohort the suite makes,
// so the same assertions run unchanged on the other side of the branch — which is the
// entire point of the flag.
//
// Not a smoke suite itself (it lives under lib/, which the runner does not scan).

/**
 * @param {import("@prisma/client").PrismaClient} db  the suite's bare client
 * @param {string} adminEmail  the account the suite signs in as
 * @returns {Promise<string|null>}  academicDepartmentId to stamp, or null for college-wide
 */
export async function fixtureDepartmentFor(db, adminEmail) {
  const admin = await db.staff.findUnique({
    where: { email: adminEmail },
    select: { collegeWide: true, academicDepartments: { select: { academicDepartmentId: true }, take: 1 } },
  });
  if (!admin || admin.collegeWide !== false) return null;
  return admin.academicDepartments[0]?.academicDepartmentId ?? null;
}

/** `{ academicDepartmentId }` to spread into a fixture's data, or nothing at all. */
export const stamp = (deptId) => (deptId ? { academicDepartmentId: deptId } : {});

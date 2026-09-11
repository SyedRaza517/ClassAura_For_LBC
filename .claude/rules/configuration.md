---
paths:
  - "server/prisma/schema.prisma"
  - "server/src/*Config*.js"
  - "server/src/branding.js"
  - "server/src/secrets.js"
  - "server/src/mailFrom.js"
  - "server/src/prediction/settings.js"
  - "server/src/routes/integrations.js"
  - "server/src/routes/branding.js"
  - "server/src/routes/admissionConfig.js"
  - "client/src/*Settings*.jsx"
---

## Per-institution configuration, not hardcoded identity

**This is still true, and still the pattern to match.** The college supplies its own
integrations, branding, letters, email wording and academic thresholds; what changed is
that there is one college rather than many. Configuration did **not** move to environment
variables when tenancy went, and should not: an administrator changes these from the
Settings screen, and a value only changeable by a deploy is not a setting.

> platform defaults in code → one JSON column merged over them → no row until the
> college edits something → an allowlist on the way out → a short cache invalidated on
> save.

`attendanceBandConfig.js` and `prediction/settings.js` are the reference
implementations. Integration secrets are AES-256-GCM encrypted at rest via
`secrets.js`; the secret is never returned to any client.

**The single-row guarantee is now a constant primary key.** `TenantBranding`,
`AttendanceBandConfig`, `PredictionModelSettings`, `AttendanceTapConfig` and
`TimetableSettings` each held one row per institution, guaranteed by `@@unique([tenantId])`.
That column is gone, so `id String @id @default("singleton")` is what replaced it, and the
save path **upserts on the literal `"singleton"`**. Not find-then-create: that is not
atomic, so two administrators saving at the same moment both find nothing, both insert,
and `findFirst` afterwards returns whichever row the planner picks — a college's branding,
attendance bands or progression thresholds becoming a coin toss between two rows. The
constant key makes the second writer collide with the first instead, which is the whole
point of it. Reads stay on `findFirst`, because a read that must not create a row should
not be able to, and the key is what guarantees there is at most one row to find. Any
further config table of this shape wants the same two halves.

**There are nine of them now, not five.** `AttendanceEmailConfig`,
`SupportDepartmentConfig`, `AdmissionTrackerSettings` and `Tenant` itself carry the same
constant key; `grep 'default("singleton")' server/prisma/schema.prisma` is the count that
is actually true. This paragraph said "any sixth" for four tables longer than that was
right, which is exactly how somebody comes to believe they are adding the first new one.

`integrationConfig.js` holds the provider registry (`moodle`, `canvas`, `blackboard`,
`email`, `sharepoint`). Precedence is: what the college saved through Settings, then
`process.env`. That env fallback **used to be fenced** to the single tenant named by
`DEFAULT_TENANT_SLUG`, because `MOODLE_*` / `SMTP_*` / `SP_*` describe one institution's
systems and handing them to a college that had not configured its own is how a student
receives an offer letter "from" the wrong institution. The fence is gone, and correctly:
the host's environment now describes the only institution there is, so inheriting it is
right rather than a leak. A deployment configured entirely by environment keeps working
unchanged.


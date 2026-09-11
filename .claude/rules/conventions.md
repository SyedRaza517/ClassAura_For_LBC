## Conventions that are load-bearing

**Null means "not measurable"; zero means zero.** Throughout the academic and
prediction code, a figure that could not be measured is `null` and is excluded from
denominators — never coerced to 0. A student whose register was never taken has no
attendance percentage, and scoring that as 0 puts them top of a risk list for something
nobody measured. Match this when adding columns: make them nullable.

**Serialise through allowlists, never blocklists.** `sAdmission` once stripped a fixed
list of secrets, so every column added afterwards shipped to the browser by default.

**Rate limiters and locks are in-process** module-level `Map`s. Correct for one Node
process; a clustered deployment needs Redis. Each one says so in a comment.

**Dates are strings.** `YYYY-MM-DD` for academic dates, compared as strings.
`src/clock.js` pins `APP_TIMEZONE` — never use the host clock for a user-facing date.

**Comments explain WHY**, often at length, including why an alternative was rejected.
Match that density; it is the house style and it is load-bearing.


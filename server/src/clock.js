// Organisation "wall clock" — always the local time in a fixed zone, independent
// of where the server runs. Render and most hosts run in UTC; without pinning a
// zone a 9:30 London check-in gets stamped 8:30 (BST is UTC+1 in summer, GMT in
// winter). Every user-facing date/time the server generates must go through here.
// Override APP_TIMEZONE if this is ever deployed for a non-UK organisation.
const ZONE = process.env.APP_TIMEZONE || "Europe/London";

// Today's date as YYYY-MM-DD in the configured zone. "en-CA" formats dates in ISO
// order (2026-07-24), so this is a safe way to get a zoned ISO date string.
const localDate = () => new Date().toLocaleDateString("en-CA", { timeZone: ZONE });

// Current time as HH:MM, 24-hour, in the configured zone.
const localTime = () => new Date().toLocaleTimeString("en-GB", { timeZone: ZONE, hour: "2-digit", minute: "2-digit" });

// Current time as HH:MM:SS, 24-hour, in the configured zone. Used ONLY for the recorded
// arrival time (AttendanceMark.checkedInAt), where the second a student actually scanned
// is worth keeping — NOT for the HH:MM logic (statusFor, session windows), which compares
// against HH:MM session times and must stay minute-precision.
const localTimeSeconds = () => new Date().toLocaleTimeString("en-GB", { timeZone: ZONE, hour: "2-digit", minute: "2-digit", second: "2-digit" });

module.exports = { ZONE, localDate, localTime, localTimeSeconds };

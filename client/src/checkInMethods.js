// How a self check-in was captured, in words — ONE copy, read by every screen that shows it.
//
// There were two, and a third was due. StaffHub's register held the table and
// AdminLiveAttendance re-derived the same three sentences inline from the same tokens, so
// the two screens a lecturer switches between could describe the same mark differently, and
// a capture method added on the server appeared on one and not the other. That is not
// hypothetical: it is exactly what happened when the tokens replaced the frozen English
// stamps, and the comment left behind in StaffHub says so.
//
// KEYED ON THE SERVER'S TOKEN, never on `takenBy`. The stamp is a database column full of
// frozen English; the token is an identifier with no wording to change, derived on the
// server from the same map its `isSelfCheckIn` predicate reads. Reword a stamp and nothing
// here moves.
//
// Three registers of language for the same fact, because they are read in three places:
//   words  — a tooltip and a screen-reader label, where there is room for a sentence
//   short  — a summary line counting a whole register, where there is room for a clause
//   csv    — the exported file somebody attaches to an email when a mark is challenged,
//            which has no icon and no title attribute and must say the whole thing in one cell
import { QrCode, Nfc, Hand } from "lucide-react";

export const CHECK_IN_METHODS = {
  qr: {
    Icon: QrCode,
    words: "Scanned the code on screen",
    short: "scanned the code",
    csv: "Student scanned the code on screen (QR)",
  },
  nfc: {
    Icon: Nfc,
    words: "Tapped in on their phone",
    short: "tapped in",
    csv: "Student tapped in on their phone (NFC)",
  },
  // THE ONE WORTH TELLING APART. The other two put the student in the room — a phone
  // within centimetres of a tag that is physically there, a camera pointed at the
  // projector while the code is still live. This one is the student's word for it, and
  // the wording says so everywhere rather than being softened into "checked in": an
  // administrator defending a funding claim, or a student appealing an absence, is asking
  // exactly this question about exactly this row.
  declared: {
    Icon: Hand,
    words: "Said they were here — no sticker or code",
    short: "said they were here",
    csv: "Student declared themselves present, with no sticker or code (declared)",
  },
};

// A token this build has not been taught about — a newer API, or an older one that sends no
// token at all. Still shown, still labelled as a self check-in, because it IS one and the
// server said so; but described in the stamp's own words rather than illustrated with the
// wrong icon and an outright false sentence.
export function selfCheckInMethod(method, takenBy) {
  const known = CHECK_IN_METHODS[method];
  if (known) return known;
  const words = `Marked by the student — ${takenBy || "method not recorded"}`;
  return { Icon: Nfc, words, short: "marked themselves", csv: words };
}

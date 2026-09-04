// Which action a session row (or the paper register) offers for the live view.
//
// Pure, because the rule matters more than the markup: a button that leads only to
// "switched off" is a dead end, and the platform does not ship those. Null means offer
// nothing; otherwise the label names what the lecturer will actually get.
export function liveAction(settings) {
  const qr = settings?.qrEnabled === true;
  const tap = settings?.tapEnabled === true;
  if (qr) return { kind: "qr", label: "QR code" };
  if (tap) return { kind: "live", label: "Live register" };
  return null;
}

import { createPortal } from "react-dom";

// Renders its children into document.body instead of where the component sits in the
// tree. Every full-screen overlay in the admin console needs this, and the reason is
// specific enough to be worth stating once here rather than in each of them.
//
// `.fade-up` — the console's entrance animation, applied to the whole view — is
// declared `animation: … both`. The forwards half of that fill holds the final
// keyframe for ever, and although that keyframe says `transform: none`, the browser
// computes it as `matrix(1, 0, 0, 1, 0, 0)`. Any computed transform other than the
// keyword `none` does two things to that element at once:
//
//   1. it becomes the CONTAINING BLOCK for its fixed-position descendants, so
//      `fixed inset-0` sizes itself to the view container — measured at 1465px tall
//      in an 1100px window — rather than to the viewport. An overlay that believes it
//      is centred on the screen is centred in that taller box, which puts it low and
//      can push its buttons off the bottom entirely; and
//   2. it becomes a STACKING CONTEXT, which caps every z-index inside it at the
//      container's own level. An overlay at `z-[120]` therefore loses to anything
//      rendered into document.body at `z-50`, because the comparison that decides it
//      is between the container and the portal, not between 120 and 50.
//
// Both halves were found the expensive way. (1) was measured on the event modal in
// AdminTimetablePlanner.jsx, whose Save button sat 159px below the bottom of the
// screen; (2) was reported as the delete confirmation disappearing behind the very
// modal it was asked about — the "Keep it / Delete" buttons visible under the modal's
// bottom edge, unreachable until the modal was closed.
//
// Fixing `.fade-up` itself would fix every overlay at once, and was rejected: it is
// used in over a hundred places, and changing a shared entrance animation to repair a
// layering bug is a far wider blast radius than taking the overlays out of the
// container they should never have been inside. A modal is not part of the view that
// opened it, so a portal is the right thing on its own merits, not only as a remedy.
//
// `.fade-up` IS DESKTOP-ONLY — App.jsx applies it as `handset ? "min-h-0 flex-1" :
// "fade-up"` — so the containing-block half of the story above is a desktop bug. The
// portal is still right on a handset, because PhoneShell's own frame carries
// `.scale-in`, which is another `animation: … both` with a transform keyframe and so
// another containing block and stacking context. Worth stating rather than implying:
// the responsive work in ConfirmDialog is an independent improvement, not a knock-on
// of this one.
//
// A PORTALLED OVERLAY ALSO LEAVES PhoneShell's DECORATIVE DESKTOP FRAME, and that is
// accepted rather than overlooked. On a desktop the staff and student apps render
// inside a simulated 390x820 handset, and `.scale-in` was clipping overlays into it;
// a portalled one now covers the browser window instead. student/screens/CheckIn.jsx
// already portals out of PhoneShell deliberately and gives the same reasoning: a
// confirmation is a statement about the whole screen, not decoration inside a picture
// of a phone. Anyone who wants the old clipping back wants a different component, not
// a change here.
//
// No `typeof document` guard, unlike StaffHub.jsx's own inline portal: this is a Vite
// SPA wrapped by Capacitor, with no SSR and no prerender step, so there is no render
// pass anywhere in this project where `document` is undefined. The guard there is
// harmless habit; repeating it here would imply a case that does not exist.
export default function ModalPortal({ children }) {
  return createPortal(children, document.body);
}

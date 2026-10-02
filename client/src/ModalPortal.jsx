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
export default function ModalPortal({ children }) {
  return createPortal(children, document.body);
}

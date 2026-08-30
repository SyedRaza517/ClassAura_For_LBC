// Turning the flat admin nav into collapsible parents. PURE: no React, no lucide, no
// DOM — the group metadata (label, icon) is passed IN, so this file can be tested under
// plain node the way timetableView.js is.
//
// WHY IT IS WORTH A TEST AT ALL, in a client with no test framework.
//
// A group is presentation only. It is not a page, holds no permission of its own, and
// every access decision stays on the CHILD — which means the one thing that can go
// wrong here is a group surviving after permissions have removed everything inside it.
// That renders an admin a parent tab that expands to nothing, and worse, advertises the
// existence of screens they were never granted. The invariant is therefore: A GROUP
// EXISTS ONLY IF AT LEAST ONE CHILD REACHED IT.
//
// The caller passes `items` ALREADY FILTERED by permission. This function must never
// filter on permission itself — a second place that decides who sees what is a second
// place for it to be got wrong.

/**
 * Group a flat nav list into [{kind:"item"} | {kind:"group", children}] in order.
 *
 * Ordering comes from the FIRST child of each group, so a group sits exactly where its
 * leading item sat in the flat list and the rest of the sidebar does not shuffle when
 * grouping is introduced.
 *
 * @param items  nav entries, already permission-filtered. An entry with a truthy
 *               `group` joins that group; everything else passes through untouched.
 * @param groups metadata by group id, e.g. { "assessments-record": { label, I } }.
 */
export function groupNav(items, groups = {}) {
  const out = [];
  const seen = new Map();
  for (const n of items || []) {
    if (!n?.group) { out.push({ kind: "item", item: n }); continue; }
    if (!seen.has(n.group)) {
      // An unknown group id keeps the id as its label rather than rendering `undefined`.
      // Silently dropping the items instead would make a typo in one nav entry hide a
      // screen with nothing to say why.
      const meta = groups[n.group] || { label: n.group };
      const node = { kind: "group", id: n.group, ...meta, children: [] };
      seen.set(n.group, node);
      out.push(node);
    }
    seen.get(n.group).children.push(n);
  }
  // The invariant, stated once. A group node is only created when a child reaches it,
  // so this cannot currently fire — it is here so that adding a group with no items,
  // or a later refactor that pre-seeds nodes from `groups`, cannot reintroduce the
  // empty-parent bug without this line having to be deleted on purpose.
  return out.filter((n) => n.kind !== "group" || n.children.length > 0);
}

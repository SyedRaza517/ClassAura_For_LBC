# App Options — admin-managed tiles for the staff and student apps

**Date:** 14 Sep 2026 · **Status:** approved in chat, awaiting spec review
**Decided with:** the user, via brainstorming (approach A chosen over a full
screen-builder and over visibility-toggles-only)

## What this is

Today every tile on the staff app home ("All tools", `HomeGrid` in
`client/src/StaffHub.jsx`) and the student app home is a hardcoded array in React.
Changing what a college's staff or students see means a code change and a deploy.

This feature makes those surfaces admin-managed. From a new **App Options** admin
screen, an administrator can:

- **hide** any built-in tool (and un-hide it later),
- **rename** any built-in tool,
- **reorder** everything,
- **create a completely new option**: a tile with an admin-chosen label, icon,
  colour and audience (staff / student / both) that opens an **info page** the
  admin writes — structured text content, not code.

## Rulings (made by the user, 14 Sep 2026)

1. **Any built-in tool can be hidden, including Clock in.** No protected core set.
   The bottom tab bar (Home / Clock in / More) is out of scope for v1 and keeps
   core navigation reachable regardless of what is hidden.
2. **Hides apply to the home grid AND the More-tab directory.** A hidden tool is
   hidden everywhere it is listed; a "home only" hide would leave a back door and
   make the feature look broken.
3. **Info pages are text-only in v1.** Headings, paragraphs, bullet lists, link
   buttons, contact rows. No image uploads — they add file storage and moderation
   questions that nothing yet justifies.
4. **New options are info pages only in v1.** External-link tiles, document lists
   and custom forms were offered and not chosen; the block set below leaves room
   for them later (a `link` block already covers "open this URL" inside a page).

## Non-goals (v1)

- No changes to the bottom tab bars of either app.
- No admin-created *functionality* — no forms, no data widgets, no screen builder.
  That was approach B, rejected as a months-long project for which the only
  concrete need (info pages) has a much smaller answer.
- No applicant-portal changes.
- No per-role targeting beyond staff/student (e.g. "only lecturers see this tile").
  Role *gates* on built-in tools still apply — see the safety rails.

## Data model

One new table. One row is either an **override** of a built-in tool or a
**custom option**. One table rather than two because every consumer (the admin
list, the app read endpoints, the ordering) wants them interleaved in one
sequence; two tables would re-join them on every read for no isolation benefit.

```prisma
model AppTile {
  id         String   @id @default(cuid())
  kind       String   // "builtin" (an override) | "page" (a custom option)
  app        String   // "staff" | "student" | "both" ("both" only for kind=page)
  builtinKey String?  // kind=builtin: the tool key the apps already use (e.g. "timesheet")
  label      String?  // builtin: null = keep the code's label; page: required
  icon       String?  // page only; a name from the shared icon allowlist
  tone       String?  // page only; a key from the curated tint/ink palette
  hidden     Boolean  @default(false)   // builtin only; pages are deleted, not hidden
  sortOrder  Int?     // null = keep default position (builtins keep code order)
  title      String?  // page only; the info page's heading
  blocks     Json?    // page only; the content blocks, shape below
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt

  @@unique([app, builtinKey])
}
```

- Forward-only migration, per `migrations.md`. Nullable columns throughout —
  null means "not set / keep the built-in value", never zero or empty-string,
  matching the null≠zero convention.
- `builtinKey` is a **free string** (length-capped), deliberately not validated
  against a server-side copy of the client's tool list. The project already
  hand-syncs two `ADMIN_PAGES` copies and that is two too many; a third list
  would drift. An override whose key matches no tool is inert — it hides
  nothing, renames nothing — so the failure mode of a typo is "nothing
  happens", which is acceptable and visible in the admin preview.

### Block shape (`blocks` JSON)

An array, max 40 entries. Every text field is plain text — **no HTML, no
markdown** — because these pages render on every staff and student phone and an
admin account must not be able to inject markup into them. The client renders
each block with fixed styling.

| type        | fields                                    | caps |
| ----------- | ----------------------------------------- | ---- |
| `heading`   | `text`                                    | 200 chars |
| `paragraph` | `text`                                    | 2000 chars |
| `bullets`   | `items` (array of strings)                | 20 items × 300 chars |
| `link`      | `label`, `url`                            | url must be `https:` |
| `contact`   | `name`, plus optional `phone` / `email`   | phone 40, email 200 |

Unknown block types are rejected at write time and skipped at render time (a
newer admin build must not blank a page for an older app build).

## Server

New router `server/src/routes/appTiles.js`, mounted at `/api/app-options`.

**Admin CRUD** — all behind `requirePage("app-options")`:

- `GET /api/app-options` — every row, both apps, for the admin screen.
- `POST /api/app-options` — create a custom option (`kind: "page"`).
- `POST /api/app-options/override` — upsert an override by `(app, builtinKey)`.
  Upsert rather than create+edit because the admin UI's mental model is "change
  this tool's row", and two taps on Hide must not create two rows.
- `PATCH /api/app-options/:id` — edit either kind (validation per kind).
- `DELETE /api/app-options/:id` — custom options only. Deleting an override row
  is how a built-in returns to stock; deleting is refused for nothing.

`"app-options"` joins **both** `ADMIN_PAGES` copies (`server/src/validate.js`
and `client/src/StaffHub.jsx`); `adminPages-contract.test.js` enforces the sync.

**App reads** — no page grant needed, but confined by identity kind:

- `GET /api/app-options/staff` — any staff token; returns rows where
  `app IN ("staff","both")`.
- `GET /api/student/app-options` — must live inside the **student router**,
  because `STUDENT_ROUTERS` in `auth.js` is an allowlist and a student token
  cannot reach `/api/app-options/*` at all. Returns rows where
  `app IN ("student","both")`.

**Validation, server-side** (`validate.js` or beside the router, unit-tested):
icon names against the shared allowlist, tone keys against the curated palette,
block shapes and caps as above, `https:` URLs only. The serialiser is an
**allowlist** of the columns above, per `conventions.md`.

## The apps (client)

**Merge, not replace.** The built-in arrays stay in code — they carry the role
gates, screen keys and icons that only code can express. Each app fetches its
config once per load and merges:

1. start from the built-in list in code order;
2. drop entries whose override says `hidden`;
3. apply override labels and `sortOrder`s;
4. append custom tiles (label/icon/tone/sortOrder from the row);
5. stable-sort by `(sortOrder ?? default position)`.

The merge is a small pure function per app. There is no client test framework,
so it is kept deliberately trivial (filter/map/sort) and its behaviour is proven
end-to-end by the smoke suite plus the admin preview; the *validation* logic,
which is where the real branching lives, sits on the server beside its unit
tests, per `testing.md`.

**Safety rails:**

- **Role gates always win.** `teaches`, `canDecideLeave` and friends filter the
  built-in list *before* the merge. An admin can narrow what people see, never
  widen it — the server's own route guards are unchanged and would 403 anyway;
  this just keeps the client honest about it.
- **Config is an enhancement, never a gate.** If the fetch fails (offline,
  server error), the apps render today's built-in defaults. A broken config
  system must degrade to exactly the current app, not to a blank home.

**Rendering a custom option:** screen key `custom:<id>`. One new generic
`InfoPage` screen per app shell renders the blocks — fixed typography, the
tile's tone for accents. The student copy's dark styles are `.dark`-scoped,
never media-queried (per the student theme ruling). The staff More tab shows
custom staff tiles in a new "From your college" group; the student More screen
does the equivalent.

## Admin UI

New **App Options** screen in the admin dashboard (behind the new page grant):

- Two tabs: **Staff app** and **Student app**. Each lists every tile — built-in
  and custom — in the order the app will show them: up/down to reorder,
  a visibility toggle on built-ins, rename inline. Tiles a role gate would hide
  for some users are marked ("lecturers only") so the admin isn't confused when
  their own phone shows fewer tiles than the list.
- **New option**: label, icon picker (curated ~30 lucide icons), tone picker
  (the same curated tint/ink pairs the built-in tools use, so every combination
  stays legible), audience (staff / student / both), then the page editor —
  add/remove/reorder blocks.
- **Live preview**: a phone-frame pane rendered by the *same* `InfoPage`
  component the apps use, so what the admin sees is what ships. This is also
  the honest answer to "you design it yourself" — the design surface is the
  picker set, and the preview proves the result.
- Built-ins: hide/rename/move only. Custom options: full edit + delete
  (with confirm).

## Testing

- **Unit** (`server/src`, beside the code): block validation (every type, every
  cap, the https rule, unknown types), override upsert semantics, serialiser
  allowlist.
- **Smoke** (`scripts/smoke-app-options.mjs`): admin creates a staff-only
  option → staff read returns it → student read does not → audience "both" →
  both see it → hide a built-in → staff read carries the override → un-hide →
  delete the custom option → gone. Also: student token GETs
  `/api/app-options/staff` → 403 (the router allowlist doing its job).
- **Visual**: Playwright screenshot pass of staff home + an info page, per the
  established local visual-check route.

## Rollout

Migration adds a table nobody reads until the new code mounts, so ship as one
deploy to staging (`main`), verify with the 401/404 probe plus a real
walkthrough, then promote to `production`. With zero rows the merge is an
identity function: **the apps look exactly as they do today until an admin
changes something.** No backfill, no feature flag needed.

## Rejected alternatives

- **Approach B, a screen builder** — months of work; the chosen block set
  answers the actual need. Approach A's data model does not block growing
  toward it later (a new `kind` is a column value, not a migration).
- **Approach C, toggles only** — cannot create new options, which was half the
  request.
- **Raw HTML / markdown page content** — an XSS-shaped hole through every phone
  in the college, for formatting nobody asked for. Structured blocks are the
  fence.
- **Image uploads in v1** — storage plumbing and moderation questions with no
  driving need yet; the block set can gain an `image` type later without
  reshaping anything.
- **Storing the built-in tools in the database** — the gates (`teaches`,
  `canDecideLeave`) and screen wiring are code; moving their *names* to the
  database would create a second source of truth that drifts from the only one
  that can actually render them. Overrides-on-top keeps code authoritative.

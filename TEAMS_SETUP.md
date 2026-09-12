# Teams setup for automatic online-class attendance

This guide walks you through connecting the **EdTech Hub API** to your college's
**Microsoft Teams** so it can read who attended each online class and fill the register
for you — Present, Late or Absent, worked out from how long a student was actually in
the meeting. You will do this by creating an **app registration** in Microsoft — a kind
of "robot account" that lets the server talk to Microsoft on its own, without a person
having to sign in each time — and then two Microsoft **application access policies**
that tell that robot account exactly whose calendars and meetings it may look at.

You do **not** need to be a developer to follow this, but this guide has more steps than
the SharePoint one (`SHAREPOINT_SETUP.md`), because the two access policies below are
what stand between "the server reads the online classes it is supposed to" and "the
server can read the calendar and meetings of every person in the organisation" — and the
second of those is not something any college should grant lightly, or that Microsoft
lets you skip. Expect 30–45 minutes, most of it PowerShell you paste and run.

**A few terms explained up front** (you'll see these on the screens, and they mean the
same thing here as they do in `SHAREPOINT_SETUP.md`):

- **Microsoft Entra ID** — the new name for **Azure AD** (Azure Active Directory).
- **App registration** — the "robot account" you're creating for the Staff Hub server.
- **Microsoft Graph** — the doorway ("API") apps use to read and write things in
  Microsoft 365, including calendars, Teams meetings and their attendance reports.
- **App-only (client credentials)** — the server signs in *as itself*, with an ID and a
  secret password, with no human logging in.
- **Organizer account** — a dedicated Microsoft 365 mailbox your college schedules its
  online classes from (for example `scheduling@yourcollege.ac.uk`). Not a teacher's own
  mailbox — see "Why organizer accounts, and why not every mailbox" below.
- **Application access policy** — a Microsoft feature that narrows an app's
  *application* permission from "every mailbox/calendar in the tenant" down to "only the
  mailboxes in this named group". There are two, covering two different Microsoft
  services (Exchange/calendars, and Teams), and this feature needs both.

> **What you'll walk away with:** four pieces of text to paste into the server's
> settings (tenant ID, client ID, client secret, and the organizer accounts), plus two
> access policies applied once from PowerShell.

---

## Before you start: do you have the right access?

To create an app registration, grant its permissions, and apply the two access policies
below, you need to be a **Microsoft 365 administrator** — specifically Global
Administrator, or Application Administrator plus Privileged Role Administrator for the
app registration steps, **and** Teams Administrator plus Exchange Administrator (or
Global Administrator) for the two PowerShell steps, since each runs against a different
Microsoft service.

If you are not sure whether you have these rights, ask your **IT administrator** — the
person or company that manages your college's Microsoft 365 — to either do these steps
for you or grant you access. **Step 4 (admin consent)** and **Steps 6–7 (the two access
policies)** can *only* be done by an administrator; none of them are optional.

---

## Step 1 — Sign in to the Azure / Entra portal

1. Open a web browser and go to **<https://portal.azure.com>**
   (<https://entra.microsoft.com> takes you to the same place — either is fine).
2. Sign in with your **Microsoft 365 admin account**.
3. If you see a message saying you don't have permission to view something, that's the
   sign you need admin rights — go back to the section above and ask your IT admin.

---

## Step 2 — Create the app registration

**Use a separate app registration from SharePoint's.** It is tempting to reuse the one
`SHAREPOINT_SETUP.md` had you create, since it is already sitting there with admin
consent granted — but that app holds `Sites.ReadWrite.All`, and adding calendar and
meeting permissions to it would mean one leaked secret compromises SharePoint files
**and** every online class's attendance data at once. A separate app keeps the blast
radius of losing either secret to the one system it actually touches.

1. In the search bar at the top of the page, type **Microsoft Entra ID** and click it.
2. In the left-hand menu, click **App registrations**.
3. Click **+ New registration**.
4. Fill in the form:
   - **Name:** something clear, for example **`EdTech Hub – Teams attendance`**.
   - **Supported account types:** **"Accounts in this organizational directory only
     (Single tenant)"**.
   - **Redirect URI:** leave **blank**.
5. Click **Register**.

Keep the **Overview** page open — you need it next.

---

## Step 3 — Copy the two IDs

On the app's **Overview** page, copy these into your notepad:

1. **Application (client) ID** → this becomes **`TEAMS_CLIENT_ID`**.
2. **Directory (tenant) ID** → this becomes **`TEAMS_TENANT_ID`**.

These are the same **shape** of value as `SP_TENANT_ID`/`SP_CLIENT_ID` — a long string of
letters, numbers and dashes — but they are **not** the same values, because this is a
different app. Label them clearly so the two integrations don't get crossed on the
settings screen later.

> Not secret — just identifiers. The password comes in Step 5.

---

## Step 4 — Give the app its three permissions (and approve them)

This app reads three things, and no more: calendars, meeting details, and attendance
reports. Everything else about a class — the register, who is enrolled, whether a
lecturer has already marked someone — is decided by the server from its own database;
Teams is only ever asked "did this meeting happen, and who was in it".

1. In the left-hand menu of your app, click **API permissions**.
2. Click **+ Add a permission → Microsoft Graph → Application permissions** (not
   "Delegated" — the same reasoning as SharePoint's Step 4: nobody is signed in, the
   server acts as itself).
3. Add all three of these, one at a time:
   - **`Calendars.Read`** — reads the organizer accounts' calendars, to find which
     meeting belongs to which timetabled class.
   - **`OnlineMeetings.Read.All`** — reads a Teams meeting's own details (its join URL,
     resolved to a meeting ID) once discovery has narrowed it down to one.
   - **`OnlineMeetingArtifact.Read.All`** — reads the meeting's **attendance report**
     after it ends: who joined, when, and for how long. This is the permission the whole
     feature exists to use.
4. Click **"Grant admin consent for `<your org>`"**, then **Yes**.
5. Check all three show a green tick under **Status**. If any still shows a warning, an
   administrator needs to click the grant button.

**Why `Calendars.Read` must be scoped, not left tenant-wide.** Granted on its own,
`Calendars.Read` lets the app read **every mailbox's calendar in your organisation** —
every member of staff's personal meetings, one-to-ones, appraisals, anything anyone has
ever put in their diary. This feature only ever needs the calendars of the handful of
accounts that schedule online classes. Step 6 below (the Exchange application access
policy) is what actually narrows `Calendars.Read` down to those accounts; granting the
permission here and skipping Step 6 leaves the tenant-wide reach in place with nothing
stopping it. Do not treat Step 6 as optional hardening — it is the scoping.

---

## Step 5 — Create the client secret

1. In the left-hand menu, click **Certificates & secrets → Client secrets → + New
   client secret**.
2. Description e.g. `Staff Hub server — Teams attendance`, expiry **24 months** is a
   reasonable default.
3. Click **Add**, then copy the **Value** column — this becomes **`TEAMS_CLIENT_SECRET`**.

> **⚠️ Copy the Value now.** Leaving or refreshing the page hides it forever, exactly as
> in `SHAREPOINT_SETUP.md`'s Step 5 — if you miss it, delete the secret and make a new
> one. Copy the **Value**, not the **Secret ID**. Store it in a password manager, never
> in a committed file.
>
> **Expiry reminder:** when this secret expires, the sync starts failing every run with
> an authentication error, and the settings screen's "Sync now" will say so. Put a
> reminder in your calendar before the expiry date.

---

## Step 6 — Set up the organizer accounts, then scope the Exchange calendar permission

**Decide the organizer accounts first.** These are ordinary Microsoft 365 mailboxes —
not shared mailboxes, not distribution lists — that your college already has, or creates
for this purpose. A small college might use one (`scheduling@yourcollege.ac.uk`); a
larger one might use one per department, so a department's own staff can be added as
delegates without touching another department's classes. Write down every organizer
account's email address before continuing — you need the exact list twice more, once
here and once for the Teams policy in Step 7, and once again on the Settings screen.

**Why organizer accounts, and why not every teacher's own mailbox.** The alternative —
letting any teacher's own mailbox be read — would mean `Calendars.Read`,
`OnlineMeetings.Read.All` and `OnlineMeetingArtifact.Read.All`, scoped to *nobody in
particular*, could in practice reach every member of teaching staff's personal calendar
and every meeting they have ever created, teaching or otherwise. Naming a small, fixed
set of organizer accounts is what makes "reads calendars" mean "reads the class schedule"
rather than "reads the timetable of anyone who happens to teach online" — and it is also
what the two access policies below actually enforce: they name accounts, not people, and
an app cannot be scoped to "whoever happens to teach a Teams class this term" any more
precisely than that.

1. Create a **mail-enabled security group** containing exactly the organizer accounts
   (Microsoft 365 admin centre → **Groups** → **Add a group** → *Mail-enabled security*,
   or `New-DistributionGroup -Type Security` in Exchange Online PowerShell). Add every
   organizer account as a member, and no one else — this group's membership **is** the
   scope of the calendar permission, so a stray member is a mailbox the app can read that
   it has no reason to.

2. Connect to Exchange Online PowerShell (`Connect-ExchangeOnline`, requires the
   ExchangeOnlineManagement module — your IT administrator will likely have this
   already) and run:

   ```powershell
   New-ApplicationAccessPolicy `
     -AppId "<TEAMS_CLIENT_ID from Step 3>" `
     -PolicyScopeGroupId "<the mail-enabled security group's email address>" `
     -AccessRight RestrictAccess `
     -Description "EdTech Hub Teams attendance — organizer accounts only"
   ```

   `RestrictAccess` is not a typo for "grant access" — it is Exchange's own name for
   "this app may reach **only** the mailboxes named by the scope group, and nothing
   else", which is exactly the restriction this feature needs. Without this policy
   applied, `Calendars.Read` reaches the whole tenant regardless of anything configured
   on the Settings screen.

3. Verify it took effect (allow a few minutes to propagate):

   ```powershell
   Test-ApplicationAccessPolicy -AppId "<TEAMS_CLIENT_ID>" -Identity "<one organizer account's email>"
   Test-ApplicationAccessPolicy -AppId "<TEAMS_CLIENT_ID>" -Identity "<some OTHER mailbox not in the group>"
   ```

   The first should report access **granted**; the second should report it **denied**.
   If the second one is also granted, the policy has not applied yet or the scope group
   is wrong — do not proceed to production use until it denies correctly.

---

## Step 7 — Scope the Teams application access policy

`Calendars.Read` and Exchange's policy above cover the calendar half. Teams draws its
own, separate line around `OnlineMeetings.Read.All` and `OnlineMeetingArtifact.Read.All`,
using the **same organizer accounts** but a **different PowerShell module and a
different policy object** — Microsoft did not unify these, so both steps are needed.

1. Connect to Microsoft Teams PowerShell (`Connect-MicrosoftTeams`, requires the
   MicrosoftTeams module).
2. Create the policy once:

   ```powershell
   New-CsApplicationAccessPolicy `
     -Identity "EdTechHubTeamsAttendance" `
     -AppIds "<TEAMS_CLIENT_ID from Step 3>" `
     -Description "EdTech Hub — reads online-meeting attendance for scheduled classes"
   ```

3. Grant it to **each** organizer account individually — this command does not take a
   group, unlike Exchange's version, so repeat it once per organizer account:

   ```powershell
   Grant-CsApplicationAccessPolicy -PolicyName "EdTechHubTeamsAttendance" -Identity "<organizer account email>"
   ```

4. Confirm it landed:

   ```powershell
   Get-CsApplicationAccessPolicy -Identity "EdTechHubTeamsAttendance"
   ```

Without this policy granted to an organizer account, `OnlineMeetingArtifact.Read.All`
refuses to read that account's meetings even though the Graph permission itself was
consented to in Step 4 — Teams' own policy is a second gate on top of the tenant-wide
Graph consent, the same relationship the Exchange policy has with `Calendars.Read`.

---

## Step 8 — How classes must actually be scheduled

The matching logic on the server (`teamsSync.js`, `teamsAttendance.js`) narrows a
discovered meeting down to one timetabled class by its date, start time and, when two
classes share a slot, its title — and it refuses to guess rather than write a wrong mark
onto a real student's record. That only works if classes are scheduled a particular way:

- **Meetings must be *scheduled*, never started with "Meet now".** A Teams "Meet now"
  meeting has no calendar entry for `Calendars.Read` to find, and therefore cannot be
  discovered at all — the class will simply never be matched, with no error to see,
  because from the server's point of view no meeting for that slot ever existed.
- **Scheduled from an organizer account**, not from a teacher's own calendar. Only the
  organizer accounts named in Steps 6–7 are ones the app is permitted to read at all;
  a meeting created from anyone else's calendar is invisible to it regardless of the
  Graph permissions above.
- **At the class's actual timetabled time.** The matcher's first pass is exact date and
  start time against the timetable — a meeting created for "sometime this afternoon"
  rather than the lecture's real slot narrows to nothing, or to the wrong class if
  another one happens to share that slot.
- **With the class name somewhere in the meeting title.** Only needed as a tiebreaker,
  when two classes are timetabled in the same slot (a split group, for instance) — but
  when it is needed, an empty or generic title (`"Online class"`, `"Meeting"`) cannot
  distinguish which of the two the meeting belongs to, and the sync reports that class as
  **ambiguous** rather than guess. Including the unit code or name in the meeting subject
  (most colleges already do this, since it is what students see when they join) is what
  lets the tiebreak resolve automatically instead of needing a human to paste the join
  link onto the right timetable entry by hand.
- **Teachers should be added as co-organizers**, not as the meeting's organizer. The
  Graph permissions above are scoped to the organizer accounts specifically — a teacher
  who creates their own meeting and adds the organizer account merely as an attendee
  produces a meeting the app has no permission to read at all. Co-organizer gives the
  teacher the in-meeting controls (admit from lobby, mute, remove) without changing whose
  calendar and whose meeting the app is reading.

## Step 9 — Leave attendance reports switched on

In the **Teams admin center** (admin.teams.microsoft.com) → **Meetings → Meeting
policies** → the policy applied to your organizer accounts, confirm **"Attendance
report"** is left **On** (it is Microsoft's default). This is what makes
`OnlineMeetingArtifact.Read.All` return anything at all — with reporting switched off for
an organizer account, every meeting that account schedules produces no report to read,
and every class it organises will be reported by the sync as a report that could not be
fetched, with no mark written for anybody on that register.

---

## Step 10 — Where to paste the variables

Same two places as `SHAREPOINT_SETUP.md`'s Step 7, with **Teams-prefixed** names so the
two integrations' credentials are never confused with each other on the same screen or
in the same `.env` file.

### For the live service (production) — Render

1. Sign in to **Render** and open the **`edtech-hub-api`** service.
2. Click the **Environment** tab.
3. Add each variable below, then **Save Changes** — Render redeploys automatically.

### For testing on your own computer (local) — `server/.env`

```dotenv
# --- Teams (online-class auto-attendance) ---
TEAMS_TENANT_ID=<your-tenant-id>
TEAMS_CLIENT_ID=<your-client-id>
TEAMS_CLIENT_SECRET=<your-client-secret-value>
TEAMS_ORGANIZER_ACCOUNTS=<comma-separated organizer account emails>
```

**These environment variables are only ever the fallback.** The credentials are normally
entered on the Settings screen (Connected systems → Teams attendance), encrypted at rest,
and require `CREDENTIALS_KEY` to be set on the server before they can be saved at all —
see `server/.env.example`. The environment variables above exist for the same reason
`SP_*` does: a deployment configured entirely by environment variables before anyone has
opened Settings keeps working unchanged. **The organizer accounts DO have an
environment-variable form**, `TEAMS_ORGANIZER_ACCOUNTS` (comma-separated) —
`integrationConfig.js`'s registry maps it beside the other three (see the `env:` block
for `teams` in that file) on exactly the same precedence as everything else here:
whatever the college saved on the Settings screen wins, and the environment variable is
read only when nothing has been saved yet. This paragraph used to say there was no
environment-variable form for that list at all, which was wrong the day it was written —
the mapping was already there — and is corrected here rather than quietly fixed, because
a setup guide that once asserted a variable does not exist is exactly the kind of thing
an administrator will trust and not go looking for again.

---

## Step 11 — Switch it on and check it worked

1. On the **Settings → Connected systems** screen, open **Teams attendance**, paste in
   the tenant ID, client ID, client secret and the organizer accounts' emails, and save.
2. Press **Test connection**. It reports exactly which step above is still missing if
   anything is — an unconsented permission, a policy not yet propagated, or the secret
   itself — rather than a single "failed".
3. On the **Check-in: QR & NFC** settings page, find the **Teams online classes** section.
   Once the test above passes, switch **Teams auto-attendance** on and set the
   Present-attendance threshold (defaults to 50% of the class).
4. Press **Sync now** for an immediate run, or wait for the hourly scheduled one. The run
   history on that same screen lists what each run found — meetings discovered, classes
   matched, and, most importantly, anything **ambiguous** or **unmatched** that needs a
   person to look at it. A class that never appears there at all is usually one still
   scheduled the wrong way — recheck Step 8.

If nothing gets marked, the most common causes, in the order they are worth checking:
the meeting was started with "Meet now" rather than scheduled (Step 8); the two access
policies have not finished propagating yet, or were scoped to the wrong group (Steps 6–7,
re-run the `Test-ApplicationAccessPolicy` check); attendance reporting is switched off
for the organizer account (Step 9); or the feature itself is still switched off on the
Settings screen (Step 11.3) — it ships off for every college by default and stays that
way until an administrator turns it on.

---

## Step 12 — A note on security

- **The client secret is sensitive**, exactly as SharePoint's is — a password that lets
  its holder read every organizer account's calendar and every class's attendance data.
  Rotate it before it expires; if you suspect it has leaked, delete it in
  **Certificates & secrets** and issue a new one immediately.
- **The two access policies are not optional hardening — they are the permission's real
  scope.** `Calendars.Read`, `OnlineMeetings.Read.All` and `OnlineMeetingArtifact.Read.All`
  are, by themselves, tenant-wide application permissions with no concept of "just these
  mailboxes". The Exchange and Teams policies in Steps 6–7 are the only mechanism
  Microsoft provides to narrow that down to the organizer accounts — skip either one and
  the app can read every mailbox's calendar and every Teams meeting in the tenant, not
  only the ones this feature is meant to look at.
- **Adding a new organizer account** means three things, not one: add it to the
  mail-enabled security group (Step 6), grant it the Teams policy individually
  (`Grant-CsApplicationAccessPolicy`, Step 7), and add its email to the Settings screen's
  organizer list. Missing any of the three leaves that account's classes silently
  undiscovered — there is no error, because from the server's point of view a meeting on
  an unlisted calendar simply does not exist.
- **Removing an organizer account** should happen in the same three places, in reverse,
  and promptly — Microsoft has no automatic expiry on either policy grant, so a leaver's
  account keeps being readable until someone removes it by hand.

---

## Environment variables summary

| Variable                     | Required?                          | What it is                                                                                  | Example                                                    |
| ----------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `TEAMS_TENANT_ID`             | **Yes**                             | Your organisation's **Directory (tenant) ID** (Step 3). Same shape as `SP_TENANT_ID`, but not the same value — a separate app registration. | `11111111-2222-3333-4444-555555555555`                     |
| `TEAMS_CLIENT_ID`             | **Yes**                             | This app's **Application (client) ID** (Step 3).                                             | `aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`                      |
| `TEAMS_CLIENT_SECRET`         | **Yes**                             | The client secret **Value** — a password (Step 5). **Not** the Secret ID.                    | `abc7Q~xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`                  |
| `TEAMS_ORGANIZER_ACCOUNTS`    | **Yes**                             | Comma-separated emails of the dedicated scheduling accounts (Step 6) — never a teacher's own mailbox. | `scheduling@yourcollege.ac.uk,dept2@yourcollege.ac.uk`      |

> **The short version:** all four rows are required for the environment-variable
> fallback to work at all — unlike SharePoint's site-location rows, none of these are
> optional, because there is no usable default for a tenant, an app, a secret or a list
> of organizer accounts. As with every integration in this codebase, **the Settings
> screen is preferred**; these four exist so a deployment configured entirely by
> environment variables before anyone has opened Settings keeps working unchanged (see
> Step 10 above and `server/.env.example`'s "Integration credentials" section).

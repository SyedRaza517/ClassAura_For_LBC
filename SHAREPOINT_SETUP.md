# SharePoint setup for the Admissions document feature

This guide walks you through connecting the **EdTech Hub API** to your college's
**SharePoint** so it can create a folder for each applicant and store the documents
they email in. You will do this by creating an **app registration** in Microsoft — a
kind of "robot account" that lets the server talk to Microsoft on its own, without a
person having to sign in each time.

You do **not** need to be a developer to follow this. If you have set up Render or
Codemagic before, this is a similar "fill in the boxes, copy the values" job. It takes
about 15–20 minutes.

**A few terms explained up front** (you'll see these on the screens):

- **Microsoft Entra ID** — the new name for **Azure AD** (Azure Active Directory).
  It is the part of Microsoft 365 that manages sign-ins and app permissions. Same thing,
  two names — Microsoft is mid-rename, so both appear.
- **App registration** — the "robot account" you're creating for the Staff Hub server.
- **Microsoft Graph** — the doorway (technically an "API") that apps use to read and
  write things in Microsoft 365, including SharePoint files and folders.
- **App-only (client credentials)** — the server signs in *as itself*, using an ID and a
  secret password, with no human logging in. That's why we grant it its own permissions.
- **Tenant** — your organisation's Microsoft 365 account as a whole.

> **What you'll walk away with:** six pieces of text to paste into the server's settings.
> Three are required (tenant ID, client ID, client secret), plus one way to point at the
> right SharePoint site. Keep a blank notepad open to paste them into as you go.

---

## Before you start: do you have the right access?

To create an app registration and approve its permissions you need to be a **Microsoft 365
administrator** (specifically a Global Administrator, or someone with the "Application
Administrator" and "Privileged Role Administrator" roles).

If you are not sure whether you have admin rights, you almost certainly need to ask your
**IT administrator** — the person or company that manages your college's Microsoft 365 —
to either do these steps for you or grant you access. Step 4 in particular (**Grant admin
consent**) can *only* be done by an administrator.

---

## Step 1 — Sign in to the Azure / Entra portal

1. Open a web browser and go to **<https://portal.azure.com>**
   (the address **<https://entra.microsoft.com>** takes you to the same place — either is fine).
2. Sign in with your **Microsoft 365 admin account** (the same kind of account you use for
   the Microsoft 365 admin centre).
3. If you see a message saying you don't have permission to view something, that's the sign
   you need admin rights — go back to the section above and ask your IT admin.

---

## Step 2 — Create the app registration

1. In the search bar at the very top of the page, type **Microsoft Entra ID** and click it
   in the results.
2. In the left-hand menu, click **App registrations**.
3. Click **+ New registration** (near the top).
4. Fill in the form:
   - **Name:** type something clear, for example **`EdTech Hub – SharePoint`**.
     (This is just a label so you recognise it later — it can be anything.)
   - **Supported account types:** choose **"Accounts in this organizational directory only
     (Single tenant)"**. This keeps the app private to your college.
   - **Redirect URI:** leave this **blank**. The server doesn't need one.
5. Click **Register**.

You'll land on the app's **Overview** page. Keep it open — you need it for the next step.

---

## Step 3 — Copy the two IDs (tenant ID and client ID)

On the app's **Overview** page you'll see a list of values. Copy these two into your notepad:

1. **Application (client) ID** → this becomes **`SP_CLIENT_ID`**.
2. **Directory (tenant) ID** → this becomes **`SP_TENANT_ID`**.

Each is a long string of letters, numbers and dashes (for example
`11111111-2222-3333-4444-555555555555`). There's a little copy icon next to each — click it
to copy, then paste into your notepad and label which is which.

> These two IDs are **not** secret — they're just identifiers. The password comes in Step 5.

---

## Step 4 — Give the app permission to use SharePoint (and approve it)

The server acts *as itself*, not on behalf of a signed-in person, so we grant it
**Application permissions** and then an admin **approves** them once. This one-time approval
is why an administrator is required.

1. In the left-hand menu of your app, click **API permissions**.
2. Click **+ Add a permission**.
3. Choose **Microsoft Graph**.
4. Choose **Application permissions** — this is important. **Do not** choose "Delegated
   permissions".
   - *Why?* "Delegated" means "on behalf of a person who is signed in". Our server has no
     person signed in — it runs on its own — so it needs **Application** permissions.
5. In the search box, type **`Sites.ReadWrite.All`**, tick its box, and click **Add
   permissions**.
   - *(Optional but recommended)* repeat and also add **`Files.ReadWrite.All`**. This helps
     if you later use a specific document library.
6. Back on the API permissions list, click the **"Grant admin consent for <your org>"**
   button (it shows your organisation's name), then click **Yes** to confirm.
7. Check the **Status** column now shows a **green tick** ("Granted for <your org>") next to
   each permission. If it still shows a warning, the consent didn't go through — an admin
   needs to click the grant button.

> **If the "Grant admin consent" button is greyed out**, you don't have the rights to
> approve it — send your IT admin a link to the app and ask them to click it.

---

## Step 5 — Create the client secret (the app's password)

The secret is the password the server uses to prove it's really your app.

1. In the left-hand menu, click **Certificates & secrets**.
2. On the **Client secrets** tab, click **+ New client secret**.
3. Give it a description (e.g. `Staff Hub server`) and choose an **expiry**. A good default
   is **24 months**. (Shorter is more secure but means you'll have to redo this sooner — see
   the note below.)
4. Click **Add**.
5. You'll now see the new secret in a table with two columns: **Value** and **Secret ID**.
   Copy the **Value** — this becomes **`SP_CLIENT_SECRET`**.

> **⚠️ Copy the Value now — you only get one chance.** The moment you leave or refresh this
> page, the **Value** is hidden forever and shows only dots. If you miss it, just delete the
> secret and make a new one.
>
> **Copy the _Value_, not the _Secret ID_.** The Secret ID is not what the server wants —
> it's just a reference number. You need the long **Value** string.
>
> Treat this Value like a password to your SharePoint. Anyone who has it can act as this app.
> Store it somewhere safe (a password manager), never email it in plain text, and never put
> it in a file that gets committed to code.

> **Expiry reminder:** the secret stops working on its expiry date, and when it does the
> Admissions upload feature will quietly stop saving to SharePoint. Put a reminder in your
> calendar a couple of weeks before, then repeat this step to make a fresh secret and update
> **`SP_CLIENT_SECRET`** in Render (Step 7).

---

## Step 6 — Find your SharePoint site (and, optionally, the library)

The server needs to know **which** SharePoint site to put folders in. You have **two ways**
to tell it — pick whichever is easier for you.

### Option A (simplest): let the server find the site for you

Instead of hunting for an ID, you can just give the server the site's web address in two
parts:

- **`SP_SITE_HOST`** — your SharePoint domain, e.g. **`contoso.sharepoint.com`**
- **`SP_SITE_PATH`** — the site path, e.g. **`/sites/Admissions`**

You can read both straight from the browser address bar when you're on the SharePoint site:
`https://`**`contoso.sharepoint.com`**`/sites/`**`Admissions`**`/...`. The server will look up
the exact ID itself. If you use this option, you can **skip** `SP_SITE_ID` entirely.

### Option B: get the exact site ID yourself

If you'd rather provide the precise ID (**`SP_SITE_ID`**), use Microsoft's free **Graph
Explorer** tool:

1. Go to **<https://developer.microsoft.com/graph/graph-explorer>**.
2. Click **Sign in** (top left) and sign in with your Microsoft 365 account.
3. In the query box near the top, make sure the method is **GET**, then paste a web address
   in this shape (replace the bold parts with your own domain and site path):

   ```
   GET https://graph.microsoft.com/v1.0/sites/contoso.sharepoint.com:/sites/Admissions
   ```

   Notice the **colon `:`** between the domain and the `/sites/...` path — that punctuation
   matters, keep it exactly as shown.
4. Click **Run query**.
5. In the response below, find the line that starts with **`"id":`**. Its value is a long
   string made of three parts joined by commas, for example:

   ```
   "id": "contoso.sharepoint.com,7b8c...e1,3f2a...c9"
   ```

   Copy that **whole** value (all three parts and the commas) — that is **`SP_SITE_ID`**.

### Optional: choose a specific document library

By default the server saves into the site's main document library, the one simply called
**"Documents"** — most colleges won't need to change this, so you can leave `SP_DRIVE_ID`
unset.

If you want the files to go into a **different** library, you can find its ID in Graph
Explorer:

1. Run: `GET https://graph.microsoft.com/v1.0/sites/{site-id}/drives`
   (put your `SP_SITE_ID` where it says `{site-id}`).
2. In the response, find the library you want by its **`"name"`**, then copy that entry's
   **`"id"`** value into **`SP_DRIVE_ID`**.

---

## Step 7 — Where to paste the variables

The server reads these settings from **environment variables** — named boxes you fill in on
the hosting dashboard. The names must be **exactly** as written (capital letters, underscores).

### For the live service (production) — Render

1. Sign in to **Render** and open the **`edtech-hub-api`** service.
2. Click the **Environment** tab in the left menu.
3. For each variable in the summary table below, click **Add Environment Variable**, type the
   **Key** (e.g. `SP_TENANT_ID`) and paste its **Value**.
4. Click **Save Changes**. Render will **redeploy** the service automatically — that's normal,
   and it's how the new settings take effect.

### For testing on your own computer (local) — `server/.env`

If someone is running the server locally, add the same lines to the file **`server/.env`**.
That file is **gitignored** (it never gets uploaded with the code), which is exactly why the
secret is safe to put there — **never** commit or share this file.

A filled-in example (replace the placeholders in `< >` with your real values from the steps
above — and delete the two lines you're not using depending on whether you chose Option A or
Option B in Step 6):

```dotenv
# --- SharePoint (Admissions document uploads) ---
SP_TENANT_ID=<your-tenant-id>
SP_CLIENT_ID=<your-client-id>
SP_CLIENT_SECRET=<your-client-secret-value>

# Point at the site — EITHER this one line (Option B)...
SP_SITE_ID=<your-site-id>
# ...OR these two lines instead (Option A):
# SP_SITE_HOST=contoso.sharepoint.com
# SP_SITE_PATH=/sites/Admissions

# Optional — only if you need a non-default library or base folder:
# SP_DRIVE_ID=<your-drive-id>
# SP_ROOT_FOLDER=Admissions
```

> **`SP_ROOT_FOLDER`** is the top-level folder inside SharePoint under which each student's
> folder is created. If you leave it unset, the server uses **`Admissions`**.

---

## Step 8 — How to check it worked

1. After you save the variables and the service finishes redeploying, open the server's
   **startup log** (in Render: the **Logs** tab). It will report that **SharePoint is
   configured** — that confirms the three required values were read correctly. If instead it
   says SharePoint is *not* configured, re-check the variable names and values.
2. For a real end-to-end test: go to the **Admissions** tab in the Staff Hub, use **"Request
   documents"** for a test applicant, then upload a test file the way an applicant would.
3. Open SharePoint and look inside your **`SP_ROOT_FOLDER`** folder (by default **Admissions**).
   You should see a **new folder named after the student**, with the test file inside it. 🎉

If nothing appears, the most common causes are: the admin consent in **Step 4** didn't get
its green tick, the wrong value was pasted for the secret (Secret ID instead of Value), or the
site details in **Step 6** point at the wrong site.

---

## Step 9 — A note on security

- **The client secret is sensitive.** It is a password to your SharePoint. Keep it in a
  password manager, rotate it before it expires, and if you ever suspect it's been exposed,
  delete it in **Certificates & secrets** and create a new one straight away.
- **`Sites.ReadWrite.All` is broad** — it lets the app read and write **every** SharePoint
  site in your organisation, not just the Admissions one. That's the simplest setup and is
  fine for many colleges, but if your IT team prefers tighter security, see the advanced
  option below.

### Advanced (optional): lock the app to one site with `Sites.Selected`

Instead of `Sites.ReadWrite.All`, IT administrators can grant the app the narrower
**`Sites.Selected`** permission and then *separately* give the app write access to **only the
Admissions site**. This means the app can touch that one site and nothing else. It takes an
extra admin step (granting the per-site permission via a Graph/PowerShell command), so it's
best left to your IT administrator — mention it to them if they ask about tightening access.

---

## Environment variables summary

| Variable            | Required?                                   | What it is                                                                                 | Example                                   |
| ------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------- |
| `SP_TENANT_ID`      | **Yes**                                     | Your organisation's **Directory (tenant) ID** (Step 3).                                     | `11111111-2222-3333-4444-555555555555`    |
| `SP_CLIENT_ID`      | **Yes**                                     | The app's **Application (client) ID** (Step 3).                                             | `aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`     |
| `SP_CLIENT_SECRET`  | **Yes**                                     | The client secret **Value** — a password (Step 5). **Not** the Secret ID.                  | `abc7Q~xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` |
| `SP_SITE_ID`        | Yes, **unless** you use `SP_SITE_HOST` + `SP_SITE_PATH` | The Graph **site id** of the target SharePoint site (Step 6, Option B).        | `contoso.sharepoint.com,7b8c…,3f2a…`      |
| `SP_SITE_HOST`      | Only if not using `SP_SITE_ID`              | Your SharePoint domain — the server resolves the site id from this + path (Step 6, Option A). | `contoso.sharepoint.com`                |
| `SP_SITE_PATH`      | Only if not using `SP_SITE_ID`              | The site path — used with `SP_SITE_HOST` (Step 6, Option A).                                | `/sites/Admissions`                       |
| `SP_DRIVE_ID`       | No (optional)                               | A specific document library id. If omitted, the site's default library ("Documents") is used. | `b!xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`    |
| `SP_ROOT_FOLDER`    | No (optional)                               | The base folder under which per-student folders are made. Defaults to `Admissions`.        | `Admissions`                              |

> **The short version:** you must always set the three **Yes** rows, plus **either**
> `SP_SITE_ID` **or** the pair `SP_SITE_HOST` + `SP_SITE_PATH`. Everything else is optional.

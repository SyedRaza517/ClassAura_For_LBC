# EdTech Hub — App Store & Play Store Submission Checklist

Everything you need to submit without getting rejected. The three biggest rejection
causes are handled here: **(1) reviewer demo accounts, (2) privacy declarations, (3) privacy policy.**

---

## 0. Before you submit — must be true
- [ ] **Render backend deployed with the latest code** (reviewers hit live features — if one errors, it's a rejection). Do a **Manual Deploy** first.
- [ ] **Privacy Policy live** at a public URL (see §3).
- [ ] App builds installed & tested on a real device via TestFlight / Play testing.
- [ ] A **reviewer demo account** exists and works (see §1).

---

## 1. Reviewer demo accounts (REQUIRED — apps with login get rejected without these)

Both Apple and Google reviewers must be able to sign in. Create **dedicated review accounts**
so you're not handing over a real person's credentials, and so 2FA never blocks them.

Provide **both** a staff and a student account (your app has two sign-in types):

| Purpose | Email | Password |
| --- | --- | --- |
| Staff / Admin | `reviewer.staff@edtech.co.uk` | *(set a simple strong one)* |
| Student | `reviewer.student@edtech.co.uk` | *(set a simple strong one)* |

**Important:**
- Make sure these accounts are **approved/active** (not pending) so login works immediately.
- Ensure **2FA is OFF** for the reviewer staff account (it already is app-wide — you commented it out — but confirm login doesn't prompt for a code).
- The student account must have some **attendance + assessment data** visible, so the reviewer sees a working screen (not an empty state that looks broken).

### Where to enter them
- **Apple:** App Store Connect → your app → **App Review Information** → *Sign-In required* = Yes → enter username/password + any notes (e.g. "Choose 'Staff' or 'Student' on the sign-in screen").
- **Google:** Play Console → **App content → App access** → *All or some functionality is restricted* → add the login instructions + credentials for each user type.

**Notes field text (paste this):**
> The app has two account types selected at sign-in: Staff and Student.
> Staff/Admin login: reviewer.staff@edtech.co.uk / <password>
> Student login: reviewer.student@edtech.co.uk / <password>
> New sign-ups require admin approval, so please use the accounts above.

---

## 2. Data collection declarations

Your app collects (confirmed from the database schema):
- **Name** (first/last), **Email address**, **College/Student ID (student reference)**, **Job title & department** (staff)
- **Password** (hashed)
- **User content** — queries/messages, leave reasons
- **App activity / records** — attendance, assessment grades, check-in times, leave requests
- **Device ID** — push notification token (only if notifications enabled)
- **NO** location, **NO** advertising, **NO** third-party analytics, **NO** data selling

### 2A. Apple — App Privacy (App Store Connect → App Privacy)

Declare **"Data Not Linked to You"? No — most is Linked to the user's identity.**
Set **Used for Tracking = NO** for everything (you don't track across other companies' apps).

| Data type | Collected? | Linked to identity? | Purpose | Used for tracking? |
| --- | --- | --- | --- | --- |
| **Name** | Yes | Yes | App Functionality | No |
| **Email Address** | Yes | Yes | App Functionality | No |
| **User ID** (College/Student ID) | Yes | Yes | App Functionality | No |
| **Sensitive Info** | No | — | — | — |
| **Other User Content** (queries, messages, leave reasons) | Yes | Yes | App Functionality | No |
| **Device ID** (push token) | Yes | Yes | App Functionality | No |
| **Product Interaction / Other Usage Data** (attendance, grades, check-ins) | Yes | Yes | App Functionality | No |
| **Coarse/Precise Location** | No | — | — | — |
| **Contacts, Photos, Health, Financial, Browsing** | No | — | — | — |

> Purpose for everything = **App Functionality** only. Do **not** tick Analytics,
> Advertising, or Product Personalization.

### 2B. Google — Data Safety (Play Console → App content → Data safety)

**Does your app collect or share user data? → Yes (collect). Shared with third parties? → No**
(hosting providers like Supabase/Render are processors, not "sharing" in Google's sense — but Firebase for push is a "collect", not "share").

For **each** item below: **Collected = Yes, Shared = No, Processed ephemerally = No,
Required (not optional) = Yes, Purpose = App functionality (+ Account management where noted).**

| Category → Data type | Collected | Purpose |
| --- | --- | --- |
| **Personal info → Name** | Yes | App functionality, Account management |
| **Personal info → Email address** | Yes | App functionality, Account management |
| **Personal info → User IDs** (College/Student ID) | Yes | App functionality, Account management |
| **App activity → Other user-generated content** (queries, messages) | Yes | App functionality |
| **App activity → Other actions** (attendance, grades, check-ins) | Yes | App functionality |
| **Device or other IDs → Device or other IDs** (push token) | Yes | App functionality (notifications) |

**Security section (tick these — they're true):**
- [x] **Data is encrypted in transit** (HTTPS/TLS) — YES
- [x] **Users can request that data be deleted** — YES (in-app: More → Delete account)
- [x] You follow the Play Families policy? — **N/A / No** (not a kids app)

**Do NOT declare:** Location, Financial info, Health, Photos/Videos, Contacts, Calendar,
Browsing history, or any Advertising/Analytics purpose.

---

## 3. Privacy Policy (REQUIRED by both stores)

A ready policy is included in your repo and will deploy with your web app:
- File: `client/public/privacy.html`
- **Public URL (after next Vercel deploy):** `https://edtech-hub-client.vercel.app/privacy.html`

**Before submitting:**
- [ ] Replace the bracketed placeholders in the policy: **contact email** (e.g. privacy@edtech.co.uk) and **College address**.
- [ ] Redeploy the web app (Vercel auto-deploys on push) and confirm the URL loads.
- [ ] Paste that URL into:
  - **Apple:** App Store Connect → App Information → **Privacy Policy URL**
  - **Google:** Play Console → App content → **Privacy policy** (also Store listing)

---

## 4. Store listing content (prepare once, use on both)

- [ ] **App name:** EdTech Hub
- [ ] **Short description** (Google, 80 chars): e.g. "Attendance, leave and student records for EdTech."
- [ ] **Full description** (what staff & students can do)
- [ ] **App icon** (1024×1024, no transparency/rounded corners for Apple)
- [ ] **Screenshots** — required sizes:
  - Apple: 6.7" iPhone (1290×2796) — at least 3; iPad only if you support it
  - Google: phone screenshots (min 2), plus feature graphic 1024×500
- [ ] **Category:** Education (or Business) · **Content rating:** Everyone / 4+
- [ ] **Support URL / contact email**

---

## 5. Content rating & app access (Google-specific, in "App content")
- [ ] **Privacy policy** ✓ (§3)
- [ ] **App access** ✓ (§1 reviewer credentials)
- [ ] **Ads:** Declare **No ads** (you have none)
- [ ] **Content rating questionnaire:** complete honestly → will come out Everyone/PEGI 3
- [ ] **Target audience:** select the appropriate age groups (not primarily children)
- [ ] **Data safety** ✓ (§2B)
- [ ] **Government apps / Financial features:** No
- [ ] **Health:** No

---

## 6. Apple-specific extras
- [ ] **Export Compliance:** Uses HTTPS only → answer "Uses encryption" = Yes → "Exempt"
      (standard encryption / HTTPS) → no export docs needed. (Set `ITSAppUsesNonExemptEncryption=false`
      in Info.plist to skip this question every build — optional.)
- [ ] **Sign in with Apple:** Not required (you don't use third-party social logins, so the
      "must offer Sign in with Apple" rule does **not** apply).
- [ ] **Age rating:** 4+
- [ ] **Demo account + notes** in App Review Information (§1)

---

## 7. Expected timelines
| Stage | Time |
| --- | --- |
| Apple App Store review | ~24–48h (first one can be a few days) |
| Google closed testing requirement (personal accounts) | **14 days, 12+ testers** before production |
| Google production review | hours to ~7 days (new accounts slower) |

---

## Quick pre-submit sanity test
```bash
# Backend live?
curl https://edtech-hub-api.onrender.com/api/health
# Reviewer login works?
curl -X POST https://edtech-hub-api.onrender.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"reviewer.staff@edtech.co.uk","password":"<password>"}'
# Privacy policy live?
curl -I https://edtech-hub-client.vercel.app/privacy.html
```
All three green → you're ready to submit.

## Deployment

**`main` IS production in this repository. There is one environment, not two.**

- API — Render service **`classaura-lbc-api`**, deploys from `main`, serving
  `https://classaura-lbc-api.onrender.com`.
- Client — Vercel project **`classaura-lbc-client`**, production target is `main`,
  serving `https://classaura-lbc-client.vercel.app`.
- Database — Supabase **eu-central-1 (Frankfurt)**, co-located with the API.

A push to `main` therefore reaches the college's live system directly. There is no
staging deployment to catch a mistake first, which is the single most important thing
on this page.

**This file used to say "`main` → staging, `production` branch → production", with two
frontends, two APIs and two databases.** That was true of EdTech, the repository this
one was forked from, and it was never true here. Corrected 16 Oct 2026 after it had
misled a reader into believing a push to `main` was safe because it only touched
staging.

The `production` branch still exists and is **dead**: it came with the fork, nothing
deploys from it, and at the time of writing it was eleven commits behind `main`.
Pushing to it releases nothing. Deleting it would be a kindness; it is left alone here
only because this file is not the place to do it.

`render.yaml` still carries `branch: production` for the same reason, and it is inert —
see the note at the foot of this page about when a Blueprint applies. Do not "fix" the
service by editing that line; it will not move anything.

`/api/health` answers 200 on *any* build, but it also returns `version` — the first
seven characters of the commit Render built. Comparing that against the commit you
pushed is the quickest honest answer to "did it land?".

For a route rather than a build, probe one only the new code has: **401 means mounted,
404 means not deployed**, with an existing route as the control.

```bash
API=https://classaura-lbc-api.onrender.com/api
curl -s $API/health                                    # {"ok":true,"version":"<sha>"}
curl -s -o /dev/null -w '%{http_code}\n' $API/staff    # control: expect 401
curl -s -o /dev/null -w '%{http_code}\n' $API/<new>    # 401 deployed, 404 not
```

The client is checked the same way and must be: fetch the deployed bundle and grep it,
rather than trusting a local build. `curl -s https://classaura-lbc-client.vercel.app/`
names the entry chunk, which names the lazy chunks.

`render.yaml` declares the API service; note that a Blueprint only applies its settings
when a service is **created**, so editing it does not move an existing service.

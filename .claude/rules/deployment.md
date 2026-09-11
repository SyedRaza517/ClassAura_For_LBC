## Deployment

`main` → staging, `production` branch → production. Both auto-deploy: Render for the
API, Vercel for the client. The two frontends and two APIs are separate services with
separate databases. Staging and production are two *environments*, not two customers —
now that a deployment serves one college, a second college means another pair of
services and another database, not another row.

`/api/health` answers 200 on *any* build and proves nothing about which code is
running. To tell whether a deploy landed, probe a route only the new code has: **401
means mounted, 404 means not deployed**, with an existing route as the control.

`render.yaml` declares the API service; note that a Blueprint only applies its settings
when a service is **created**, so editing it does not move an existing service.

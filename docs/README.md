# GitHub Pages — privacy policy

Google Play requires a **publicly reachable** privacy-policy URL. The app's own copy
lives at `client/public/privacy.html` and ships with the web build, but that build was
not reachable at the URL recorded in this repo, so Play had nothing to point at.

This folder is served by GitHub Pages, which needs no deployment of its own:

    Settings → Pages → Source: "Deploy from a branch"
                       Branch: main   Folder: /docs   → Save

That publishes:

    https://syedraza517.github.io/EdTech/

`index.html` and `privacy.html` here are copies of `client/public/privacy.html`.
When the policy changes, update that file and copy it here so the two do not drift.

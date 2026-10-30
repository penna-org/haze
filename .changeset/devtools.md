---
'@hazejs/devtools': minor
'@hazejs/vite': minor
'@hazejs/cli': patch
---

New `@hazejs/devtools` package (experimental), built on [devframe](https://devfra.me): install it as a dev dependency and `haze dev` serves a DevTools hub at `/__devtools/` with an app overview (name, mode, reload status, modules, sub-apps), a searchable route table, the `/__haze` dev dashboard and terminals with one-click `haze` commands. The hub runs in the dev server process, so its connection and state survive hot reloads; failed reloads show up as a status badge and a notification. In full-stack Vite projects the `haze()` plugin mounts it on the Vite server and injects a floating dock into the frontend. Browsers authorize once with a one-time code printed in the terminal. Configure or turn it off with `devtools` in `haze.config.ts` or the `haze()` options; production builds never include it.

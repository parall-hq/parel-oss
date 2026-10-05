---
"@parel/sandbox-e2b": patch
---

Pin `@e2b/code-interpreter` to 2.7.2. Plugin dependency ranges are resolved when the hosted runtime bundles the plugin, and `^2.6.1` now resolves to 2.8.0, which imports `E2B` from `e2b` — an export the pinned `e2b@2.32.0` doesn't have. The bundle failed ("No matching export … for import \"E2B\""), so every fresh deploy of sandbox-e2b returned 500 since 2026-09-09. 2.7.2 only imports names 2.32.0 exports. Move both pins together when `e2b` is unpinned.

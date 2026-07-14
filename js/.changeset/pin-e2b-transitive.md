---
"@parel/sandbox-e2b": patch
---

Pin the transitive `e2b` SDK to 2.32.0 (exact).

`e2b@2.33.0` switched its bundler to rolldown, whose runtime shim executes
`createRequire(import.meta.url)` at module evaluation. In runtimes where
`import.meta.url` is `undefined` — e.g. dynamically-loaded Cloudflare
Workers — the `node:module` polyfill throws

    The argument 'path' The argument must be a file URL object, a file URL
    string, or an absolute path string.. Received 'undefined'

at plugin load. `@e2b/code-interpreter`'s own range (`e2b: ^2.28.0`) dedupes
onto this exact pin at install/bundle time.

Remove the pin once `e2b` ships a build without the eager module-scope
`createRequire(import.meta.url)` IIFE.

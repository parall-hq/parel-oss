---
"@parel/sandbox-e2b": patch
---

Fix: the hand-rolled legacy `filesystem` capability view dropped the options argument, so `readFile(path, {encoding: "base64"})` silently returned UTF-8-mangled text — breaking `workspace_read_file`'s image branch (its magic-byte self-check rejected every image) on the filesystem-tools × sandbox-e2b combination. The legacy view now forwards options with a binary-safe base64 read, with a combination-level regression test.

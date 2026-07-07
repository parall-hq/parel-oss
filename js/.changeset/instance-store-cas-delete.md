---
"@parel/core": minor
---

`InstanceStore.casDelete?(key, expectedVersion)` — compare-and-delete for retiring shared resource handles. An unconditional `delete()` can erase a sibling session's just-swapped-in replacement handle without killing the resource it points at; `casDelete` makes the retire race explicit. Optional: probe and fall back to `delete()` on hosts that predate it.

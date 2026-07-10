---
"@parel/core": minor
---

Additive media-part contract fields for the multimodal input path: `ImagePart.width`/`ImagePart.height` (pixel dimensions when known at intake) and `dataOmitted` on `ImagePart`/`FilePart` — set only on stripped read surfaces (WS sync snapshot, derived query mirrors) where bytes are omitted for transport bounds; the HTTP transcript read keeps full `data`. See the runtime's multimodal-media design doc.

---
'@flue/runtime': minor
---

Add `imageRetention` to tool definitions. The default, `'conversation'`, keeps today's behavior: every later model request carries a tool result's images. `'turn'` sends a result's images only in the model request right after it; later requests carry the result's text and `<attachments>` manifest, and the omitted images are not loaded from the attachment store. A tool declaring `'turn'` also adds the framework `view_attachment` tool, which shows up to four manifest images again for one request.

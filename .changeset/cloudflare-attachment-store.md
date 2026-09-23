---
'@flue/runtime': minor
---

Add an `attachmentStore` option to `extend()` from `@flue/runtime/cloudflare`. An agent module can return its own `AttachmentStore` (for example R2-backed) from the per-instance factory, which receives `env`, the agent and Durable Object identity, and the default Durable Object SQLite store for composition. Without the option, attachments stay in Durable Object SQLite.

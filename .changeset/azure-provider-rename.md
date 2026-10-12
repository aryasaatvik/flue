---
'@flue/runtime': patch
---

Renames the Azure provider to `azure`, matching Pi. Use `azure/...` model specifiers, and name `azure` in the `providers` config. The old `azure-openai-responses` name still resolves and prints a one-time deprecation notice, but it will be removed in a future major release. Your `AZURE_OPENAI_*` environment variables keep working.

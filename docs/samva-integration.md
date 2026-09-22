# Samva integration packages

Samva consumes Flue as a coordinated package set while its integration needs are being proved and
prepared for extraction upstream. The producer checkpoint contains `@flue/runtime`, `@flue/sdk`,
`@flue/react`, and `@flue/vite` from one committed Flue source tree. Install all four artifacts from
the same manifest; mixing workspace, registry, and integration builds can create incompatible or
duplicate runtime identities.

## Build and test locally

Create a local package set from a clean committed worktree:

```bash
pnpm pack:integration
```

The packer builds the four packages, assigns one source-and-tree-fingerprinted version, packs each
archive, and installs them into a fresh Bun consumer. The consumer imports representative public
exports and proves that React resolves the consumer's SDK and Vite resolves the consumer's runtime.
Every archive also carries the same `samvaIntegrationPackageSet` value.

The staged integration manifests express React-to-SDK and Vite-to-runtime links as peer dependencies.
This flattening is specific to the package-set distribution: it lets Bun use the consumer's exact
file tarballs instead of materializing nested Flue copies. It does not modify the workspace package
manifests.

For fast Samva iteration, install the four `file:` tarball paths recorded in the generated manifest.
Treat the producer build, fresh-consumer install, and Samva acceptance as separate evidence. A Flue
consumer check does not prove the Samva authoring flow.

## Create an immutable checkpoint

Preview or publish the current verified package set with:

```bash
pnpm checkpoint:integration -- --dry-run
pnpm checkpoint:integration
```

The command requires a clean worktree. It reuses an exact current-commit manifest only when all four
archives are present, their SHA-256 digests match, and the manifest records successful fresh-consumer
verification. It then looks up Scratchpad production uploads by both filename and content hash. An
existing immutable upload is reused; a real run uploads only missing files and verifies all URLs by
reading the upload index back. The dry run performs no upload.

Record the source commit and tree, package-set version, each archive digest and URL, and manifest
digest and URL. A checkpoint is a portable producer artifact; it does not authorize a Samva repin,
provider change, deployment, or upstream publication.

## Accept the set in Samva

Pin Samva's runtime, SDK, React, and Vite Flue dependencies to the four exact local artifacts or four
immutable URLs from one manifest. Regenerate and commit the Bun lockfile, then verify that the
installed package versions and package-set stamps match the manifest and that dependency resolution
contains one runtime and one SDK identity.

Acceptance must exercise the real Samva authoring path. For multimodal custom tools, prove that a
tool-produced image is persisted and that the immediate next request to the original authoring model
contains the exact image bytes and MIME type. Also prove the restored conversation path after a
runtime restart. Record the Flue receipt, Samva commit, lockfile state, and focused acceptance result
independently.

## Extract upstream later

Keep the integration branch as the maintained producer while Samva evidence is collected. When the
behavior and public contract are stable, extract the smallest generally useful Flue changes from the
integration history and follow Flue's contribution policy. Integration packaging and Samva-specific
checkpoint history need not become part of that upstream change.

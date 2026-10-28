# Changesets

Every pull request that changes a published package should include a changeset:

```bash
pnpm changeset
```

Pick the affected packages and the bump type, then describe the change for the changelog. All `@hazejs/*` packages and `create-hazejs` share one version (`fixed`), so a bump in one releases them together.

When changesets land on `main`, the release workflow opens a "Version Packages" pull request; merging it publishes to npm. See the [Changesets docs](https://github.com/changesets/changesets) for details.

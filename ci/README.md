# CI workflow (pending move)

`ci.yml` here is the GitHub Actions workflow for this repo: pnpm install, lint, typecheck, and build on every PR, with dummy env vars so no real secrets are needed.

It lives here only because the token that opened this PR lacks GitHub's `workflow` scope, which is required to create files under `.github/workflows/`. To enable it, move it into place:

```bash
mkdir -p .github/workflows && git mv ci/ci.yml .github/workflows/ci.yml && git rm ci/README.md
```

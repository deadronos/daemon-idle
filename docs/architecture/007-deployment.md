# 007 — Deployment

The game is published to GitHub Pages: **https://deadronos.github.io/daemon-idle/**.
Rationale for the trigger in
[ADR 0005](../decisions/0005-pages-deploy-on-tag.md).

## Pipeline

`.github/workflows/deploy-pages.yml` — GitHub Actions:

1. Checkout, then `voidzero-dev/setup-vp` (puts `vp` on PATH; Node 22).
2. `npm ci` → `vp run typecheck` → `vp check` → `vp test run` → `vp build`.
3. `actions/configure-pages` → `upload-pages-artifact` (`./dist`) → `deploy-pages`.

The job runs in the `github-pages` environment and needs `pages: write` and `id-token:
write`.

## Triggers

- **Push of a `v*` tag** — a release deploys. Day-to-day merges to `main` do not.
- **`workflow_dispatch`** — manual run for testing.

## Base path

The site is a _project_ page under `/<repo>/`, so `vite.config.ts` sets **`base: './'`**.
Assets then resolve relative to the page regardless of the subpath, which also keeps local
`vp dev` working unchanged. (`base: '/daemon-idle/'` is the alternative; relative is
portable and matches the sibling project.)

## Pages settings

The repository's Pages source is **GitHub Actions** (`build_type: workflow`), set via the
API. No `gh-pages` branch is used.

### Environment policy (required for tag deploys)

The `github-pages` environment must permit the refs that deploy. Its deployment branch
policy starts with only the default branch (`main`), which **blocks tag deploys** — a
tag-triggered run fails in seconds with:

> Tag "vX.Y.Z" is not allowed to deploy to github-pages due to environment protection rules.

Add a tag policy (custom policy, type `tag`, name `v*`) so release tags can deploy:

```bash
gh api --method POST repos/<owner>/<repo>/environments/github-pages/deployment-branch-policies \
  -f name='v*' -f type=tag
```

## Verifying a deploy

- Manual: `gh workflow run deploy-pages.yml`, then watch the run.
- Release: push a `v*` tag.
- Confirm the deployed HTML references relative asset paths and the game boots from the
  published URL.

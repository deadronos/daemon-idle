# 0005 — Deploy to GitHub Pages on release tags

- **Status:** Accepted
- **Date:** 2026-10-11

## Context

The game needs a public URL so it can be played without cloning the repo. The repository is
public and already on GitHub, so GitHub Pages is free and needs no extra service. Two things
had to be decided: how the site is built and published, and **when** a deploy happens.

## Decision

Deploy to **GitHub Pages** with a GitHub Actions workflow
(`.github/workflows/deploy-pages.yml`):

- Trigger on **push of a `v*` tag** and on **`workflow_dispatch`** — not on every push to
  `main`.
- Build with the existing Vite+ toolchain (`vp build`), after typecheck/lint/tests.
- Publish `dist/` via `upload-pages-artifact` + `deploy-pages`.
- Set `base: './'` in `vite.config.ts` so assets resolve under the project subpath.
- Pages source is **GitHub Actions** (no `gh-pages` branch).

## Alternatives considered

- **Deploy on every push to `main`** — rejected: would publish unreleased, possibly broken
  code to the public URL. A release should be a deliberate act.
- **`gh-pages` branch (manual `git subtree`/push)** — rejected: more moving parts, and the
  Actions + Pages artifact flow is the current first-party path.
- **Netlify / Vercel / Cloudflare Pages** — rejected: an external account and service for a
  static bundle GitHub already hosts.

## Consequences

- **Positive:** free hosting with no external service; releases are explicit; the deployed
  artifact is the same build the tests just validated.
- **Negative:** nothing is live until a `v*` tag is pushed, so a merged change is not
  immediately playable; consumes Actions minutes (small for this project).
- **Follow-ups:** if continuous previews are wanted later, add a separate preview
  deployment rather than changing this release trigger.

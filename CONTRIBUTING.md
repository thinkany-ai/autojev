# Contributing to AutoJev

Thank you for helping improve AutoJev. Bug reports, focused feature proposals, documentation fixes, and pull requests are welcome.

## Before opening a change

- Search existing issues and pull requests first.
- Open an issue before investing in a large feature or architectural change.
- Never include API keys, prompts containing private data, credential-store exports, or real agent configuration files.
- Keep changes focused. Separate refactors from behavior changes when practical.

## Local setup

Install Node.js 22+, pnpm 10+, Rust stable, and the Tauri prerequisites for your platform. Then run:

```bash
pnpm install
pnpm dev
```

Before submitting a pull request, run:

```bash
pnpm build
pnpm test
pnpm release:check
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib
```

If a Rust dependency or Tauri configuration changes, also run:

```bash
pnpm tauri build --no-bundle
```

## Pull requests

A useful pull request explains the problem, the behavior after the change, how it was verified, and any security or compatibility impact. Include screenshots for interface changes.

Commits contributed intentionally to this repository are licensed under the MIT License as described in the project license. We use the [Developer Certificate of Origin](https://developercertificate.org/) for contribution sign-off. Add a sign-off with:

```bash
git commit -s
```

By signing off, you certify that you have the right to submit the contribution under the project's license.

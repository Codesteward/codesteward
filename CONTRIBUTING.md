# Contributing

Thank you for your interest in contributing to this project. This guide applies to all repositories maintained by bitkaio LLC.

## Contributor License Agreement

All contributors must agree to the [Contributor License Agreement](CLA.md) before their first contribution can be merged. This is a one-time requirement per contributor.

When you open your first pull request, a CLA bot will check whether you have signed. If not, it will guide you through the process. Your signature covers all repositories under bitkaio LLC.

## Getting Started

1. Fork the repository
2. Create a feature branch from `main` (`git checkout -b feat/your-feature`)
3. Make your changes
4. Run the project's tests and linters (see the project README for commands)
5. Open a pull request against `main`

## Pull Request Guidelines

- Keep PRs focused — one feature, fix, or refactor per PR
- Write a clear title and description explaining **what** changed and **why**
- Include tests for new functionality and bug fixes
- Ensure existing tests pass before submitting
- Link related issues in the PR description (e.g., `Closes #42`)

## Commit Messages

Use [Conventional Commits](https://www.conventionalcommits.org/) format:

```text
type(scope): short description

Optional longer explanation.
```

Common types: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `ci`.

Examples:

- `feat(search): add query expansion support`
- `fix(scraper): handle timeout on redirect chains`
- `docs: update configuration reference`

## Code Style

- Follow the conventions already established in the codebase
- Run the project's linter before submitting (formatting, imports, etc.)
- Prefer clarity over cleverness
- Add comments only where the intent isn't obvious from the code

## Reporting Issues

- Use GitHub Issues for bug reports and feature requests
- For bugs, include: steps to reproduce, expected behavior, actual behavior, and environment details
- Check existing issues before opening a new one

## Security Vulnerabilities

Do **not** open a public issue for security vulnerabilities. Instead, email security@bitkaio.com with a description of the vulnerability. We will respond within 72 hours.

## Code of Conduct

Be respectful and constructive. We expect all contributors to act professionally and treat others with courtesy. Harassment, discrimination, or disruptive behavior will not be tolerated.

## Questions

If you're unsure about anything, open a discussion or issue — we're happy to help.

## License

By contributing, you agree that your contributions will be licensed under the terms described in the [CLA](CLA.md). The project's current license is specified in the [LICENSE](LICENSE) file.

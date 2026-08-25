# Contributing Guide for inline-agent-widget

This page lists the operational governance model of this project, as well as
the recommendations and requirements for how to best contribute to
inline-agent-widget. We strive to obey these as best as possible. As always, thanks for
contributing.

## Governance Model

**Published but not supported**

The intent and goal of open sourcing this project is because it may contain
useful or interesting code/concepts that we wish to share with the larger open
source community. Although occasional work may be done on it, we will not be
actively looking for or soliciting contributions.

## Getting Started

### Prerequisites

- Node.js >= 18.0.0
- npm

### Setup

```bash
git clone https://github.com/SalesforceCommerceCloud/inline-agent-widget.git
cd inline-agent-widget
npm install
```

### Development

```bash
npm run dev        # serve demo with HMR
npm run build      # ESM + UMD builds
npm run typecheck  # tsc --noEmit
npm test           # vitest run
```

## Issues, Requests & Ideas

Use GitHub Issues to submit bugs and enhancement requests. When filing a bug,
please include:

- A clear description of the problem
- Steps to reproduce
- Expected vs. actual behavior
- Browser and OS information

## Creating a Pull Request

1. Search existing issues/PRs to avoid duplicates.
2. Fork the repository.
3. Create a branch from `master` for your change.
4. Make your changes with clear, atomic commits.
5. Ensure `npm test` and `npm run typecheck` pass.
6. Push your branch and submit a Pull Request against `master`.
7. Sign the [Salesforce CLA](https://cla.salesforce.com/sign-cla) if you haven't already.

### Contribution Checklist

- [ ] Clean, readable code
- [ ] Atomic commits with descriptive messages
- [ ] Tests for new functionality
- [ ] All existing tests pass
- [ ] No unnecessary dependencies added

## Contributor License Agreement (CLA)

All external contributors must sign the
[Salesforce Contributor License Agreement](https://cla.salesforce.com/sign-cla).
You only need to sign it once.

## Code of Conduct

Please follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## License

By contributing to this project, you agree that your contributions will be
licensed under the project's [LICENSE](LICENSE) file.

# Contributing

Thanks for taking a look at butterstack-cli.

## Project shape

This is a single-file CLI (`bin/butter`) with zero runtime dependencies, using only Node.js builtins. Please keep it that way: no new npm dependencies without a strong reason discussed in an issue first. The whole point of this tool is that `npm install -g butterstack-cli` pulls in nothing else.

## Getting set up

```
git clone https://github.com/ButterStack/butterstack-cli.git
cd butterstack-cli
npm link
```

`npm link` makes the `butter` command available globally, pointed at your local checkout.

## Running tests

```
npm test
```

Tests use Node's built-in test runner (`node:test`), no test framework dependency. They shell out to the real `bin/butter` binary against throwaway local HTTP listeners, exercising the actual auth and host-resolution flows rather than asserting on internal state.

If you touch anything in the credential/host-binding path (`getHost()`, `request()`, `authLogin()`), please read the existing tests in `test/butter.test.js` first. Several of them exist specifically to catch a credential being sent to the wrong host, and a couple of the assertions are deliberately precise (matching an exact error phrase rather than a loose pattern) to avoid false passes. Keep that precision if you change the wording those tests check.

## Reporting issues

Please use the issue templates. For anything that looks like a security issue (a credential leaking to the wrong host, an auth bypass, etc.), please do not open a public issue: see [SECURITY.md](./SECURITY.md) if one exists, or email hello@butterstack.com.

## Pull requests

- Keep changes focused and explain the "why," not just the "what."
- Add or update tests for behavior changes.
- Run `npm test` before opening a PR.
- Match the existing code style (no semicolon-free style, no external formatter dependency yet, just read the surrounding code).

## Code of conduct

Be respectful and constructive. This is a small project maintained alongside a larger product; response times may vary.

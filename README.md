# Grimoire: source code (view only)

Grimoire is a hosted inventory, warehouse and pricing app for Magic: The
Gathering sellers, at [grimoire-tracker.com](https://grimoire-tracker.com).

This is a read-only copy of its code, published so you can check how it
treats your data rather than taking anyone's word for it. It's updated with
each release. Development happens in a private repository, so this copy has
one commit per release and no issue history. See [LICENSE.md](LICENSE.md):
you can read and test it, but not run it for real use or reuse it.

## Where to look

| Question | Where |
|---|---|
| How are Mana Pool / Pitney Bowes credentials stored? | `server/lib/store.js`, "Secrets at rest" (`sealSecret` / `openSecret`): AES-256-GCM, a random 12-byte IV per value, auth tag checked on every read |
| How does connecting Mana Pool work? | Either an access token you create on Mana Pool and paste in, or Mana Pool's own sign-in (OAuth, `server/lib/mpAuth.js`). Either way Grimoire never sees your Mana Pool password, and you can revoke its access from your Mana Pool account at any time |
| How are Grimoire passwords stored? | `server/lib/auth.js`: scrypt hashes, never plain text |
| Which requests can reach my data? | `server/index.js`: every API route is declared with `route(...)` |

## What the encryption does and doesn't do

The credentials are encrypted on disk, so a leaked file or a stray backup
doesn't expose them. **They are not hidden from the server itself.** Grimoire
has to use your Mana Pool access to list cards and import orders for you, so
the server can decrypt it, and so, in principle, can whoever runs the server.
Any service that acts on your behalf works this way. If that isn't
acceptable to you, don't connect the integration. Grimoire works without it.

## How it's built

Grimoire is written by its author working with Claude Code (Anthropic's AI
coding tool). The author isn't a professional developer. That's part of why
the code is public: so people who are can check it.

## Running it locally

Node.js 22.13 or newer, no other dependencies. `node --test` runs the test
suite. To start it, copy `config.example.json` to `config.json` and run
`node server/index.js`. That's for checking how it works only; see the
license.

## Reporting a security problem

Please use **Security → Report a vulnerability** on this repository, which
reaches the author privately, rather than opening a public issue.

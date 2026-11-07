# Contributing

Issues and pull requests are welcome. Use Node.js 22 or later; the module has no runtime dependencies.

Run these checks before opening a pull request:

```sh
npm run check
npm test
node src/cli.mjs validate examples/lesson-lifecycle.json
```

For dashboard changes, run `npm start` and inspect the demo at desktop and mobile widths. The seeded demo failure is intentional; its dependent step must remain blocked.

New product adapters should keep credentials in server-side environment variables, bind each actor to an explicit QA scope, and use independent observers for saved effects. Add a controlled HTTP fixture test for the actual request and response envelope. Never include real user conversations, credentials, private configuration, generated run artifacts or production data in a pull request.

Keep simulation results distinct from live integration evidence. A successful model reply or HAI proposal is not proof of a saved effect or installed repair. Preserve the no-retry behavior for ambiguous action submissions and the original role and operation boundaries.

By contributing, you agree that your contributions are licensed under this project's MIT License.

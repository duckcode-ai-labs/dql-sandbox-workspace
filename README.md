# DQL sandbox workspace: Harbor Mutual claims

The workspace the DuckCode sandbox install of DQL Enterprise clones on first start
(`SANDBOX_WORKSPACE_GIT_URL` in `duckcode-ai-labs/dql-enterprise`). It is one DQL project at the repository root,
which is where a worker looks for `dql.config.json`.

Everything here is invented: Harbor Mutual is a made-up insurer, names are "Test Member 0001", social security
numbers are in the 900 range (never issued), emails end in @example.test. No customer data.

- The project is `demo/harbor/claims` from `dql-enterprise`, copied as it is.
- `harbor.duckdb` is the project's warehouse (6 tables, 2,008 rows), built from `demo/harbor/seed.mjs`:

  ```sh
  node demo/harbor/seed.mjs --workspace claims --out /tmp/claims/seeds/seed.json
  node <oss>/scripts/seed-eval-warehouse.mjs --seed /tmp/claims/seeds/seed.json --connector-root <dir with duckdb@1.1.3> --out harbor.duckdb
  ```

  Locally the demo builds this file at each start; a cloud worker has no seed step, so it is committed here.

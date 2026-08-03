# High-cardinality qualification

These tools create and measure a disposable Ponderosa dataset without starting an Agent Run.

Build first:

```sh
pnpm build
```

Create the default fixture (250 Projects, 1,002 Chats in one Project, 1,000 idle Agents, 1,000 disabled Triggers, and 1,250 passive messages):

```sh
node tools/high-cardinality/generate-fixture.mjs \
  --data-dir=/tmp/ponderosa-hc-fixture \
  --metadata=/tmp/ponderosa-hc-fixture/fixture.json
```

Run a repeatable benchmark against a fresh copy of that fixture:

```sh
node tools/high-cardinality/run-benchmark.mjs \
  --fixture=/tmp/ponderosa-hc-fixture \
  --metadata=/tmp/ponderosa-hc-fixture/fixture.json \
  --work-dir=/tmp/ponderosa-hc-work \
  --output=/tmp/ponderosa-hc-results.json
```

Both directories are synthetic and disposable. The benchmark terminates the server it starts, creates no Agent activations or Runs, and records those counts in its result. Pass smaller counts such as `--projects=2 --chats=4 --agents=5 --triggers=5 --messages=10` to smoke-test the generator.

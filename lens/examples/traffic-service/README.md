# Example: traffic service

This directory generates the sample dataset used by the tests and the demo
report. The data is **real**: `pino` (imported from this repository, not npm)
writes the lines while a real `node:http` server answers real requests over the
loopback interface.

```
node generate.js --requests 30000 --out data/traffic.ndjson
```

Outputs:

| File | What it is |
|---|---|
| `data/traffic.ndjson` | The log file, one pino line per record |
| `data/traffic.manifest.json` | Command, versions, commit, request mix, line/byte counts, SHA-256 |
| `out/traffic-report.html` | `pino-lens` report built from the file (regenerate with the command below) |

```bash
node ../../bin/pino-lens.js build data/traffic.ndjson \
  --title "traffic-service · 30k requests" --levels notice=35 \
  -o out/traffic-report.html
```

## What the service exercises

- numeric levels plus one `customLevels` entry (`notice: 35`);
- `debug` request lines, `info` completions, `warn` for 4xx and slow requests,
  `error` for thrown handlers, `trace` for health probes;
- `responseTime` measured with `process.hrtime.bigint()`;
- `err` serialisation, including a nested `cause` and an `err.code`;
- child loggers carrying `reqId` and `route` bindings;
- redaction of `req.headers.authorization` (the driver only ever sends the
  literal string `demo-token-not-a-secret`);
- unicode messages and payloads, nested objects and arrays;
- 404s, 400s from malformed JSON bodies, and 500s from three different thrown
  errors.

## Reproducibility

The request mix is driven by a seeded PRNG (`--seed`, default `20261023`), so the
same seed produces the same sequence of requests. Latencies are measured, not
simulated, so byte counts and hashes differ between runs — the manifest records
whichever run produced the file.

The hostname is a fixed `base` binding (`lab-node-01`) so no machine name ends
up in the sample. `pid` stays real; it is not personal data.

## Stress dataset

`--requests 60000 --concurrency 32` produces the 135,394-line / 32.4 MB file used
for the performance numbers in `../README.md`. It is not committed (see
`.gitignore`) because it is reproducible in about a minute.

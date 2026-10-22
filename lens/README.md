# pino-lens

A zero-dependency, offline explorer for the NDJSON that pino already writes.
Point it at one or more log files and it builds a single self-contained HTML
report: stacked timeline, virtualised table, query language, entry detail with
the serialised error stack, and CSV / NDJSON / summary export.

No server, no telemetry, no upload step, no build toolchain. The report is one
file that opens from `file://`.

```
node bin/pino-lens.js build app.log -o report.html
```

## Why this exists

pino emits newline-delimited JSON and stops there. Everything downstream is
either a terminal prettifier (`pino-pretty`, `pino-colada`), a transport that
ships lines elsewhere (Loki, Elasticsearch, Axiom), or a full observability
stack. There is no way to hand someone a log file and let them *look* at it:
filter by level, brush a time range, sort by latency, read the stack trace,
and export exactly the slice they need.

`pino-lens` is that missing viewer. It understands pino's wire format rather
than a generic JSON-lines convention — numeric levels, custom levels, ISO or
epoch timestamps, `err` serialisation, redaction censors, `nestedKey` layouts,
and the unusual values pino is forced to emit (non-finite numbers become
`null`, circular references become `[Circular]`).

## What it does

| Capability | Detail |
|---|---|
| Filtering | Query language (`level>=warn msg~"timeout" host=api-1 -"healthz"`), level chips, drag-to-brush time range, all combinable and shareable via URL hash |
| Sorting | time, level, message, duration, original line order; missing durations always sort last |
| Detail | Lazy JSON tree, highlighted error stack, byte-identical raw line, copy buttons |
| Statistics | Level distribution, error rate, adaptive time buckets, top message templates, latency p50/p95/p99, parse-health banner |
| Export | CSV (column picker, spreadsheet-injection guard), faithful NDJSON of the current view, summary JSON with provenance |
| Scale | Windowed rendering keeps ~40 row nodes in the DOM for a 200k-entry file; filter/sort run over typed arrays |
| Robustness | BOM, CRLF, blank lines, truncated tails, non-object lines and oversized lines are counted and reported, never silently dropped |

## Install and run

Node.js 20+ for the CLI. The generated report needs only a browser.

```bash
cd lens
npm install          # only puppeteer-core, for the browser tests
node bin/pino-lens.js build ../../app.log -o report.html
```

Useful flags:

```bash
# multiple files, custom title, custom level table
node bin/pino-lens.js build api.log worker.log \
  --title "checkout service" --levels notice=35,audit=65 -o report.html

# huge file: stop after 200k valid entries, or keep the data external
node bin/pino-lens.js build huge.log --limit 200000 -o report.html
node bin/pino-lens.js build huge.log --split -o report.html   # needs an http server

# machine-readable statistics and a CI-friendly integrity check
node bin/pino-lens.js stats app.log --query 'level>=error' --json
node bin/pino-lens.js verify app.log     # exit code 2 if any line is unparsable
```

`--msg-key`, `--err-key`, `--level-key`, `--time-key` accept dotted paths, which
is what you need when pino is configured with `nestedKey`. Note that pino keeps
`msg`, `level` and `time` at the top level even then — only the object fields
(including `err`) move under the nested key:

```bash
node bin/pino-lens.js build nested.log --err-key payload.err -o report.html
```

## Query language

| Example | Meaning |
|---|---|
| `level>=warn` | numeric level floor (uses pino's level numbers) |
| `level=error,fatal` | explicit level set |
| `level!=debug` | exclude a level |
| `msg~"connection reset"` | message substring, case-insensitive |
| `-"healthz"` | message must not contain `healthz` |
| `time>=2026-10-22T18:00` | time window (ISO or epoch ms) |
| `duration>250` | latency in milliseconds (`dur`, `latency` are aliases) |
| `service=api-gateway` | exact field match |
| `host~api` | field substring |
| `trace exists` | field presence |

Tokens combine with AND. Invalid tokens are reported in the status line and the
rest of the query is still applied — the result set is never silently widened.

## Measured behaviour

Real numbers from the dataset in `examples/traffic-service` (67,673 entries,
16.2 MB, produced by running the pino build in this repository behind a real
HTTP server; see the manifest next to the data):

| Metric | 67,673 entries (16.2 MB) | 135,394 entries (32.4 MB) |
|---|---|---|
| CLI build (parse + embed) | 556 ms | 1,055 ms |
| Browser load to first paint | 563 ms | 1,313 ms |
| Browser parse | 157 ms | 688 ms |
| Filter pass — `msg~` | 1.2 ms | 3.9 ms |
| Filter pass — `level>=warn` | 0.3 ms | 1.2 ms |
| Filter pass — `route="/api/items"` | 48 ms | 222 ms |
| Sort by duration | 7.5 ms | 37.1 ms |
| Keystroke to repainted table | 17.3 ms | 73.7 ms |
| Row nodes in the DOM | 42 | 42 |
| JS heap after load | 165 MB | 279 MB |

Field predicates re-parse raw lines (that is why they cost ~30× a message
substring); the store keeps only the line text plus typed arrays, so memory
lands near 2 KB per entry.

Environment: Node 22.22.2, Edge headless on Windows 11 x64, 16 vCPU, `file://`
load. The table is one run (the JSON in `docs/evidence/perf-results.json` is
that same run); three runs on this machine spread the 135k parse/filter figures
by up to ~2× (parse 269–688 ms), so treat them as an order of magnitude, not a
benchmark. `node tools/perf.js [file.ndjson]` reruns the measurement.

## Design

- `src/core/ndjson.js` — line splitting (BOM/CRLF aware) and per-line parsing
  with typed failure codes.
- `src/core/normalize.js` — maps a record onto the canonical entry shape.
- `src/core/store.js` — columnar store: original line text plus typed arrays for
  level / time / duration / flags. Parsed objects are re-created on demand with
  a bounded cache, which keeps memory close to the file size.
- `src/core/query.js` — tokenizer, parser, predicate compiler, stable sorter,
  facet merging (chips + brush can only narrow).
- `src/core/aggregate.js` — level counts, adaptive buckets, message templates,
  nearest-rank percentiles.
- `src/core/exporter.js` — CSV / NDJSON / summary writers.
- `src/ui/*` — windowed table, canvas timeline with brush, JSON detail, app shell.
  Plain scripts, no framework, no bundler: the CLI inlines them into the report.

Everything is CommonJS for Node and registers itself on `globalThis.PinoLens`
for the browser, so the same files run in both places without a build step.

## Tests

The integration tests and the example generator load pino from the repository
root, so its runtime dependencies must be present:

```bash
cd .. && npm install --omit=dev     # 12 packages, pino's own runtime deps
cd lens

npm test            # 61 node:test cases (unit + real-pino integration)
npm run test:browser   # 14 checks in a real Chromium engine, incl. pixel probes
npm run test:all
```

The browser suite compares the UI's filtered counts against the CLI's for the
same query (two processes, same data), asserts the DOM stays windowed, reads
canvas pixels to prove the timeline is painted, and measures screenshot
luminance/coverage so a blank or collapsed layout fails.

## Licence and provenance

New code in this directory is MIT, copyright the pino-lens contributors.
pino itself is MIT, copyright Matteo Collina, David Mark Clements and the pino
contributors; this module reads pino's output format and includes no copied
implementation code. See `LICENSE` and `NOTICE`.

Known limits are listed in [`docs/LIMITS.md`](docs/LIMITS.md).

# Changelog

## 0.1.0 — 2026-10-22

First cut, built against pino 10.4.0 (upstream commit b29dbe9).

- Tolerant NDJSON reader: BOM, CRLF, blank lines, truncated tails, non-object
  lines and oversized lines are counted and reported with line numbers.
- Normaliser for pino's real wire format: numeric and string levels, custom
  level tables, epoch millisecond / second / microsecond / nanosecond and ISO
  timestamps, object messages, `err` objects, declared latency fields,
  `[Redacted]` markers, dotted key paths for `nestedKey` layouts.
- Columnar store: original line text plus typed arrays, lazy object
  re-construction with a bounded cache.
- Query language: level comparisons and sets, message substrings with negation,
  time windows, field predicates (`= != ~ !~ > >= < <= exists`), duration aliases.
  Invalid tokens are reported and never widen the result set.
- UI: stacked timeline with drag-to-brush, windowed table, detail panel with JSON
  tree and error stack, level chips, sortable columns, shareable URL hash,
  keyboard navigation, light/dark themes.
- Exports: CSV with column picker and formula-injection guard, byte-faithful
  NDJSON, summary JSON with provenance.
- CLI: `build`, `stats`, `verify` (exit code 2 on unparsable lines).
- Tests: 61 `node:test` cases including integration against the repository pino
  build, plus 14 browser checks in Chromium with pixel-level assertions.
- Example: `examples/traffic-service` generates a real 67,673-line dataset by
  running the repository build behind an HTTP server, with a manifest recording
  command, versions, counts and SHA-256.

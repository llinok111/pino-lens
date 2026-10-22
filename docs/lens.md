# Inspecting logs

[`pino-pretty`](/docs/pretty.md) turns a log file into human-readable lines in a
terminal. `pino-lens` is the other half: it turns the same NDJSON into a single
self-contained HTML file you can filter, sort, inspect and export from — offline,
in a browser, with no service to deploy.

```
node lens/bin/pino-lens.js build app.log -o report.html
```

The report embeds the log text and the viewer, so it opens from `file://` and
can be attached to a ticket. See [`lens/README.md`](../lens/README.md) for the
full command reference.

<a id="when"></a>
## When to use which

| Situation | Use |
|---|---|
| Reading a handful of lines while developing | `pino-pretty` |
| Sending logs to a collector in production | a [transport](/docs/transports.md) |
| Handing a 60 MB log file to someone who needs to find the slow requests | `pino-lens` |
| Attaching evidence to a bug report, including the exact raw lines | `pino-lens` |

<a id="format"></a>
## What it understands about the wire format

The viewer reads what `lib/proto.js` actually writes, not a generic JSON-lines
convention:

| pino feature | Behaviour in the viewer |
|---|---|
| Default numeric `level` | Mapped through the default table (10…60) without a config |
| `customLevels` | Pass `--levels notice=35` to name them; otherwise `level:35` is shown and flagged |
| `formatters.level` returning a label | String levels are resolved by name |
| `timestamp: false` / `stdTimeFunctions.isoTime` | Missing timestamps and ISO strings both handled; units are inferred and reported |
| `err` serialisation | Stack trace rendered in the detail panel; `hasErr` counted in statistics |
| `redact` | `[Redacted]` markers are detected and flagged, never treated as data |
| `nestedKey` | `msg`/`level`/`time` stay top level; pass `--err-key payload.err` for object fields |
| Non-finite numbers, circular structures | pino writes `null` / `[Circular]`; both are preserved verbatim |
| `messageKey` | Pass `--msg-key message` |

<a id="query"></a>
## Query language

The filter box understands a small, total language. Bare words search the
message; everything else is a field predicate.

```
level>=warn                       level floor
level=error,fatal                 explicit set
level!=debug                      exclusion
msg~"connection reset"            substring, case-insensitive
-"healthz"                        negative substring
time>=2026-10-22T18:00            time window (ISO-8601 or epoch ms)
duration>250                      latency in ms
service=api-gateway               field equality
host~api                          field substring
trace exists                      field presence
```

Tokens are combined with AND. Invalid tokens are reported in the status line and
the valid part of the query still applies, so the result set can never grow
because of a typo.

Level chips and the timeline brush are additional facets; they intersect with
the typed query instead of replacing it. The whole state is mirrored into the
URL hash (`#q=level%3Derror&sort=duration&dir=desc`) so a view can be shared or
reloaded.

<a id="export"></a>
## Export

- **CSV** — chosen columns, formula-injection guard, UTF-8 BOM for spreadsheets.
- **NDJSON** — the original lines of the current view, byte for byte, re-ingestible
  by any pino tool.
- **Summary JSON** — statistics plus provenance (title, build time, source file
  hashes, entry count, parse issues).

<a id="limits"></a>
## Limits

`lens/docs/LIMITS.md` lists the measured limits: field predicates re-parse raw
lines (40 ms per 67k entries), the tested ceiling is ~135k entries, reports embed
their data, and browser coverage is Chromium only.

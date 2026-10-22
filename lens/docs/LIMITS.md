# pino-lens — known limits

Everything below was observed while building this module on 2026-10-22 against
pino 10.4.0. Where a number is quoted it was measured, not estimated.

## Data handling

1. **Field predicates re-parse raw lines.** The store keeps only line text plus
   typed arrays, so `msg` / `level` / `time` / `duration` filters never parse
   JSON. Any other field predicate (`route="/api/items"`) does, behind a
   20,000-entry cache. Measured across three runs: 40–53 ms for 67k entries and
   101–222 ms for 135k. Message substring filters are 1.1–1.4 ms / 3.3–3.9 ms on
   the same data. Use `msg~` when you can.
2. **One message column.** Free text matches the message field only; there is no
   full-text index across all fields.
3. **Timestamp unit inference is a heuristic.** `time` values are read as
   nanoseconds at ≥1e15, microseconds at ≥1e14, milliseconds at ≥1e12, seconds
   at ≥1e9, and "probably seconds" below that. A logger that writes seconds
   since process start (small numbers) will be mis-scaled; the UI still sorts and
   filters consistently, but the axis labels will be wrong.
4. **Unknown levels stay numeric.** Without `--levels notice=35`, a custom level
   renders as `level:35` and is flagged in the data-quality banner. Nothing is
   guessed from neighbouring values.
5. **`nestedKey` needs explicit paths.** pino keeps `level`, `time` and `msg` at
   the top level but moves object fields (including `err`) under the nested key.
   Pass `--err-key payload.err` to see stacks; `--msg-key` is only needed when
   `messageKey` is also customised.
6. **Multiple files are concatenated, not merged.** No rotation semantics, no
   de-duplication, no ordering by timestamp across files.
7. **Byte-for-byte fidelity cuts both ways.** NDJSON export returns the original
   lines, so duplicate keys written by pino (a child binding repeated in the log
   object) survive in the export even though the detail tree shows the last
   value.
8. **CSV is lossy.** Nested values become JSON strings, numbers become text,
   and values starting with `= + - @` get a leading apostrophe to defuse
   spreadsheet formulas. Use NDJSON when fidelity matters.

## Scale

9. **Measured ceiling is ~135k entries.** 32.4 MB / 135,394 entries works with a
   52–74 ms keystroke cost and ~280 MB JS heap. A 1M-entry file was not tested;
   expect roughly 2 KB of heap per entry plus the embedded report size.
10. **Reports embed their data.** A 16 MB log produces an 18 MB HTML file. The
    CLI warns above 24 MB. `--split` keeps data external but then the page must
    be served over HTTP (`fetch` on `file://` is blocked), so the offline
    promise only holds for embedded reports.
11. **No live tail.** This is a post-mortem viewer: the file is read once at
    build time. `pino-lens serve` does not exist.

## Environment

12. **Browser coverage is Chromium only.** All browser assertions ran in Edge
    152 headless on Windows 11. Firefox and Safari were not exercised; canvas
    brush interaction and `history.replaceState` on `file://` are the most likely
    divergence points.
13. **No formal accessibility audit.** Keyboard navigation, `role="grid"`,
    `aria-rowcount`, `aria-pressed` chips and a polite live region are wired and
    asserted, but no axe/WCAG pass and no screen-reader session was performed.
    Contrast was not measured programmatically.
14. **Visual review was limited to measurements.** In the build environment the
    image-inspection tool was unavailable, so layout verification used DOM
    geometry (`no horizontal overflow`, `timeline above table`, non-zero panel
    widths, four non-collapsed cells) plus PNG pixel statistics (`dominant
    colour share < 0.97`, per-region ink coverage > 1%, edge ink < 25%). Those
    catch blank and clipped frames, not "does it look good".
15. **Message templates are a display heuristic.** Digits, hex runs, UUIDs and
    ISO timestamps collapse to placeholders. Distinct messages that differ only
    by a placeholder group together; messages differing by a word do not.

## Packaging

16. **Not published to npm.** `pino-lens` is unclaimed on the registry; the
    package is installed from this directory.
17. **`lens/` is excluded from the pino tarball.** The upstream `package.json`
    has no `files` field, so the root `.npmignore` now lists `lens/`; without
    that line `npm pack` would ship the sample dataset and the pre-built report
    inside the `pino` package.
18. **The example service is a demo, not a benchmark.** Its timings and status
    mix come from a loopback HTTP server on one machine; they are useful as
    realistic log input, not as a performance claim about pino.

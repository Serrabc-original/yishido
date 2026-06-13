# Bug Reports

Use bug report bundles to investigate a real WhatsApp turn without copying raw logs manually.

## Generate

```powershell
npm run bug:report -- --traceId trace_...
```

The script reads:

- `logs/agent-*.log`
- `logs/errors-*.log`

It writes:

- `bug-reports/bug-report-trace_...-YYYY-MM-DD-HH-mm.json`

`bug-reports/` is ignored by Git.

## Included

- `traceId`
- `turnId`
- `doName`
- timestamps
- relevant events
- errors
- fallback status
- missing expected events
- possible root cause summary

## Redaction

The exporter redacts:

- API keys;
- tokens;
- Authorization headers;
- phone fields;
- secret-looking strings.

Still treat bug reports as sensitive operational artifacts.

# Eurecia API Recorder

Records browser traffic while you manually use Eurecia. Script opens start URL but never clicks, types, or submits anything.

## First Run

```bash
pnpm eurecia:install-browser
EURECIA_URL="https://your-tenant.eurecia.com" pnpm eurecia:record
```

1. Log in and perform workflows to research.
2. Return to terminal and press Enter.
3. Find output under `.local/eurecia-recorder/captures/<timestamp>/`.

Persistent browser profile lives at `.local/eurecia-recorder/profile/`, so later runs normally reuse login state.

## Output

| File | Content |
|---|---|
| `raw.har` | Full HTTP request and response headers/bodies |
| `raw-websockets.json` | Full WebSocket frames |
| `sanitized-report.json` | Auth-redacted traffic with selected scalar samples; HTML/XHTML response bodies are always omitted |

All output and browser profile files are gitignored. Raw files contain session credentials and personal data. Sanitized report may still contain personal data not recognized by heuristic redaction; review before sharing or committing any excerpt.

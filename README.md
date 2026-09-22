# Pi Rephrase Input

Context-aware input rephrasing for [Pi](https://pi.dev).

Pi Rephrase Input intercepts ordinary user prompts, adds only relevant conversation history, then rewrites the request into a clear, actionable prompt. It never discovers, reads, or injects project files. It keeps Pi's normal flow when disabled, interrupted, unavailable, or when rephrasing fails.

## Install

This repository is private and uses `master` as its default branch. Install from GitHub after authenticating Git access:

```bash
pi install git:git@github.com:AungMyoKyaw/pi-rephrase-input@master
```

For a local checkout:

```bash
pi install /path/to/pi-rephrase-input
```

Verify the installed package:

```bash
pi list
pi -p "Explain the next change in this project"
```

## Behavior

1. Capture original user and assistant messages plus recent tool results for the session.
2. Choose a bounded recent-history window from the session buffer.
3. Add that conversation context to the rephrase request.
4. Ask the same active model to rephrase the original request.
5. Pass the rephrased prompt back into Pi.

The extension never scans the cwd or sends project-file contents to the model. Rephrase failures pass the original input through unchanged.

## What gets skipped

The extension short-circuits (passes input through unchanged) for any of these:

- `PI_REPHRASE_OFF=1` (kill switch).
- `event.source === "extension"` (messages from `sendUserMessage` / other extensions).
- `event.source === "rpc"` (RPC clients typically manage their own context).
- `event.streamingBehavior === "steer"` or `"followUp"` (mid-stream redirects and queued follow-ups — by the time a follow-up is delivered, the agent already has the conversation context).
- Input containing `@` (`@file` references — Pi resolves them after `input`, so the rephraser would produce internally inconsistent output).
- Input starting with `/` (slash commands — if no extension command matched, the rephraser would strip the leading `/` and invent intent).
- Empty / whitespace-only input.
- No model selected, or no auth configured for the active model.

The conversation buffer holds **original** user wording, not rephrased output, so each turn conditions on what the user actually said.

## Configuration

```bash
PI_REPHRASE_TIMEOUT_MS=8000             # per-attempt wall-clock cap (default 8000)
PI_REPHRASE_MAX_RETRIES=2               # retries on transient LLM errors (default 2, 0 disables)
PI_REPHRASE_RETRY_BASE_MS=500           # exponential backoff base (default 500)
PI_REPHRASE_OFF=1                       # kill switch — passes everything through
PI_REPHRASE_DEBUG=1                     # log retries + rephrase failures to stderr
```

## Development

```bash
bun install
bun test
bun run check
python3 -m http.server 4173 --directory site
```

Open `http://localhost:4173` to preview the product site.

## License

This project is licensed under [AGPL-3.0-or-later](LICENSE).

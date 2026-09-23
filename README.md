# Pi Rephrase Input

Context-aware input rephrasing for [Pi](https://pi.dev).

Pi Rephrase Input intercepts eligible interactive prompts, adds bounded recent conversation and tool-result context when available, then asks the model already selected in the Pi session to rewrite the request as one clear, actionable prompt. It never discovers, reads, or injects project files. When a request is skipped, interrupted, unavailable, or rephrasing fails, Pi keeps its normal input flow.

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

1. Reset session context at `session_start` and capture original user/assistant message text plus recent tool results from `message_end`.
2. Keep at most six user/assistant messages and three tool-result snapshots in rolling buffers.
3. For histories of up to three conversation messages, send the last two. For longer histories, send the full bounded conversation buffer, up to six messages. Cap formatted conversation at 2,000 characters and tool results at 1,000 characters.
4. Ask the currently selected Pi model to rephrase the original request with that context. No classifier call runs first.
5. Preserve pasted text, mentioned file references, and attached images in both the rephrase request and transformed input. Text payloads are copied verbatim if the model omits them. Detect Pi TUI clipboard paths named `pi-clipboard-...` in the system temporary directory, load supported image files as attachments, and remove those paths from the text.
6. Pass the rephrased prompt back into Pi's normal input pipeline. Image-only input is still rephrased, with its image attachment preserved.

The extension never scans the cwd or sends project-file contents to the model. Explicit `@file` references are rephrased and preserved verbatim so Pi receives them unchanged. The conversation buffer stores original user wording, not rephrased output.

## What gets skipped

The extension skips the rephrase model call for any of these. For eligible interactive input, a supported Pi clipboard image path is still normalized into an image attachment during pass-through.

- `PI_REPHRASE_OFF=1` (kill switch).
- `event.source === "extension"` (messages from `sendUserMessage` or other extensions).
- `event.source === "rpc"` (RPC clients typically manage their own context).
- `event.streamingBehavior === "steer"` or `"followUp"` (mid-stream redirects and queued follow-ups).
- Input starting with `/` (slash commands).
- Empty or whitespace-only input.
- No model selected, or no auth configured for the active model.

## Fallback and interruption

A timeout, thrown provider error, `stopReason: "error"`, empty response, or retry exhaustion passes the original text through unchanged and preserves attachments. A successfully loaded Pi clipboard-image path is removed from the transformed text while its image attachment is preserved. `PI_REPHRASE_MAX_RETRIES` controls additional attempts after transient thrown errors; the default is two retries. Escape and Ctrl-C in TUI mode abort active rephrase requests without consuming the key, then pass the original text and attachments through. Session start and shutdown also abort active requests.

## Configuration

```bash
PI_REPHRASE_TIMEOUT_MS=8000             # per-attempt wall-clock cap (default 8000)
PI_REPHRASE_MAX_RETRIES=2               # additional attempts after transient errors (default 2, 0 disables)
PI_REPHRASE_RETRY_BASE_MS=500           # jittered exponential backoff base (default 500)
PI_REPHRASE_OFF=1                       # kill switch — passes everything through
PI_REPHRASE_DEBUG=1                     # log rephrased output and retry/skip/interrupt diagnostics to stderr
                                        # invalid/non-finite numeric values use defaults
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

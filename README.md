# Pi Rephrase Input

Context-aware input rephrasing for [Pi](https://pi.dev).

Pi Rephrase Input intercepts ordinary user prompts, asks the active model which project files matter, then rewrites the request into a clear, actionable prompt. It keeps Pi's normal flow when disabled, interrupted, unavailable, or when rephrasing fails.

## Install

This repository is private. Install from GitHub after authenticating Git access:

```bash
pi install git:git@github.com:AungMyoKyaw/pi-rephrase-input
```

For a local checkout:

```bash
pi install /Users/aungmyokyaw/projects/life/pi-rephrase-input
```

Verify the installed package:

```bash
pi list
pi -p "Explain the next change in this project"
```

## Behavior

1. Discover readable project files while excluding dependency trees, generated output, binary files, and sensitive filenames.
2. Ask the active Pi model to select up to eight relevant paths.
3. Validate selected paths against the offered inventory and project boundary.
4. Load only selected files, preserving per-file and total context limits.
5. Ask the same active model to rephrase the original request.
6. Pass the rephrased prompt back into Pi.

Selector failures produce an empty project context and do not block the existing rephrase flow. Rephrase failures pass the original input through unchanged.

## Configuration

```bash
PI_REPHRASE_TIMEOUT_MS=8000
PI_REPHRASE_MAX_CONTEXT_CHARS=6000
PI_REPHRASE_SELECTION_TIMEOUT_MS=2500
PI_REPHRASE_OFF=1
PI_REPHRASE_DEBUG=1
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

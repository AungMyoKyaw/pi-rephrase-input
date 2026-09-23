/**
 * LLM Rephraser for pi
 *
 * Intercepts every user input, asks an LLM to rephrase the request with
 * relevant conversation history, then hands the rephrased prompt to pi.
 * The downstream agent still does all the real work — this just sharpens
 * what it receives without guessing from project files.
 *
 * Permanent install (loaded on every `pi` invocation):
 *   pi install /path/to/pi-rephrase-input
 *
 * Config (env vars, optional):
 *   PI_REPHRASE_TIMEOUT_MS="8000"        # default = 8000
 *   PI_REPHRASE_MAX_RETRIES="2"          # default = 2 (0 disables retries)
 *   PI_REPHRASE_RETRY_BASE_MS="500"      # default = 500
 *   PI_REPHRASE_OFF="1"                  # kill switch, passthrough
 *   PI_REPHRASE_DEBUG="1"                # log rephrased text to stderr
 *
 * Rephrase always uses the currently selected model (ctx.model) — same as
 * the session's own turns.
 *
 * All runtime logic lives inside `rephraseInput` below. The exported
 * function IS the extension — there is no module-level state, no module
 * level helpers, no module-level constants. Internal types remain at
 * module level so they can be referenced by the closure body and by any
 * future tooling that needs to reason about the wire format.
 */
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ──────────────────────────────────────────────────────────────
// Module-level types (allowed; only runtime logic is consolidated)
// ──────────────────────────────────────────────────────────────

type TextContent = { type: string; text?: string };
type ImageContent = { type: "image"; data: string; mimeType: string };

type CompletionResponse = {
	stopReason?: string;
	content?: readonly TextContent[];
};

type ModelRegistryLike = {
	complete: (
		model: unknown,
		context: unknown,
		options?: { signal?: AbortSignal },
	) => Promise<CompletionResponse>;
	hasConfiguredAuth?: (model: unknown) => boolean;
};

type InputContext = {
	model?: unknown;
	modelRegistry: ModelRegistryLike;
	hasUI: boolean;
	ui?: { notify: (message: string, kind: string) => void };
	signal?: AbortSignal;
};

// Closure-private shapes for the rolling conversation buffer.
type ConversationTurn = {
	role: "user" | "assistant";
	text: string;
};

type ToolResultSnapshot = {
	toolName: string;
	text: string;
};

type HistoryDepth = "light" | "heavy";

const MAX_CONVERSATION_TURNS = 6;
const MAX_TOOL_RESULT_SNAPSHOTS = 3;
const MAX_CONVERSATION_CHARS = 2000;
const MAX_TOOL_RESULT_CHARS = 1000;
const LIGHT_HISTORY_TURNS = 2;

// ──────────────────────────────────────────────────────────────
// Single exported extension function — every helper below is a
// closure-private definition; nothing leaks to module scope.
// ──────────────────────────────────────────────────────────────

export default function rephraseInput(pi: ExtensionAPI): void {
	// ── Rolling buffers for session-aware rephrasing ────────────
	const conversationBuffer: ConversationTurn[] = [];
	const toolResultBuffer: ToolResultSnapshot[] = [];
	// FIFO queue of originals for prompts we are about to (or have just)
	// transformed. `message_end` shifts the head when the corresponding
	// user message finalizes; the input handler pops on rephrase failure.
	// Pi awaits the input handler before creating the UserMessage, so the
	// order of pushes equals the order of `message_end` fires.
	//
	// The earlier implementation keyed a Map by `Date.now()` captured at
	// input-handler entry. Pi records the UserMessage with its own
	// `Date.now()` AFTER our transform completes, so the keys never
	// matched and the buffer captured rephrased output instead of user
	// wording — violating the README contract on every turn after the
	// first. FIFO ordering removes the timestamp dependency entirely.
	const pendingOriginals: { text: string }[] = [];
	const pendingPastedTexts: string[] = [];
	const activeRephraseControllers = new Set<AbortController>();
	let terminalPasteBuffer = "";
	let terminalPasteActive = false;
	let removeTerminalInputListener: (() => void) | undefined;

	function captureTerminalPastes(data: string): void {
		const pasteStart = "\u001b[200~";
		const pasteEnd = "\u001b[201~";
		let remaining = data;

		while (remaining.length > 0) {
			if (!terminalPasteActive) {
				const startIndex = remaining.indexOf(pasteStart);
				if (startIndex === -1) return;
				remaining = remaining.slice(startIndex + pasteStart.length);
				terminalPasteActive = true;
				continue;
			}

			const endIndex = remaining.indexOf(pasteEnd);
			if (endIndex === -1) {
				terminalPasteBuffer += remaining;
				return;
			}

			const pastedText = terminalPasteBuffer + remaining.slice(0, endIndex);
			if (pastedText.length > 0) pendingPastedTexts.push(pastedText);
			if (pendingPastedTexts.length > 16) pendingPastedTexts.shift();
			terminalPasteBuffer = "";
			terminalPasteActive = false;
			remaining = remaining.slice(endIndex + pasteEnd.length);
		}
	}

	function takePastedTextPayloads(text: string): string[] {
		const payloads: string[] = [];
		for (const pastedText of pendingPastedTexts) {
			const comparableText = pastedText.trim();
			if (text.includes(pastedText) || (comparableText && text.includes(comparableText))) {
				payloads.push(pastedText);
			}
		}
		// A paste belongs only to the next submitted input, even if it was
		// removed from the editor before submission.
		pendingPastedTexts.length = 0;
		return payloads;
	}

	function recordTurn(role: "user" | "assistant", text: string): void {
		const trimmed = text.trim();
		if (!trimmed) return;
		conversationBuffer.push({ role, text: trimmed });
		if (conversationBuffer.length > MAX_CONVERSATION_TURNS) {
			conversationBuffer.shift();
		}
	}

	function recordToolResult(toolName: string, text: string): void {
		const trimmed = text.trim();
		if (!trimmed) return;
		toolResultBuffer.push({ toolName, text: trimmed });
		if (toolResultBuffer.length > MAX_TOOL_RESULT_SNAPSHOTS) {
			toolResultBuffer.shift();
		}
	}

	function formatConversationContext(depth: HistoryDepth): string {
		if (conversationBuffer.length === 0) return "";
		const turns =
			depth === "light"
				? conversationBuffer.slice(-LIGHT_HISTORY_TURNS)
				: conversationBuffer;
		const lines: string[] = ["Recent conversation (oldest first):"];
		for (const turn of turns) {
			const tag = turn.role === "user" ? "U" : "A";
			lines.push(`${tag}: ${turn.text}`);
		}
		const joined = lines.join("\n");
		if (joined.length <= MAX_CONVERSATION_CHARS) return joined;
		// Keep the header and most recent turns within the hard character cap.
		const header = "Recent conversation (oldest first):";
		const tailLength = MAX_CONVERSATION_CHARS - header.length - 1;
		return `${header}\n${joined.slice(-tailLength)}`;
	}

	function formatToolResultContext(depth: HistoryDepth): string {
		if (toolResultBuffer.length === 0) return "";
		const lines: string[] = ["Recent tool results:"];
		for (const snap of toolResultBuffer) {
			lines.push(`[${snap.toolName}]: ${snap.text}`);
		}
		const joined = lines.join("\n");
		if (joined.length <= MAX_TOOL_RESULT_CHARS) return joined;
		const overflow = joined.length - MAX_TOOL_RESULT_CHARS;
		return joined.slice(overflow);
	}

	// Prior rephrases used to be injected into the next rephrase as a
	// "Previous rephrase of similar intent" section. Removed: doing so
	// creates a feedback loop where each rephrase is conditioned on the
	// previous one, drifting from the user's voice across turns. The
	// conversation buffer provides prior-turn grounding without another
	// model call that could time out before rephrasing starts.

	function extractContentText(content: unknown): string {
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		const parts: string[] = [];
		for (const part of content) {
			if (
				part &&
				typeof part === "object" &&
				"text" in part &&
				typeof (part as { text: unknown }).text === "string"
			) {
				parts.push((part as { text: string }).text);
			}
		}
		return parts.join("\n");
	}

	function extractAssistantText(message: unknown): string {
		if (!message || typeof message !== "object") return "";
		const m = message as { content?: unknown };
		// AssistantMessage.content is typed as an array of text/thinking/tool
		// blocks. A top-level `text` field never appears on assistant
		// messages — the array path is the only real path.
		return extractContentText(m.content);
	}

	function extractToolResultText(toolResult: unknown): string {
		if (!toolResult || typeof toolResult !== "object") return "";
		const t = toolResult as { content?: unknown; text?: unknown };
		if (typeof t.text === "string") return t.text;
		return extractContentText(t.content);
	}

	function abortActiveRephrases(): void {
		if (process.env.PI_REPHRASE_DEBUG === "1" && activeRephraseControllers.size > 0) {
			process.stderr.write(
				`[rephrase-interrupt] aborting ${activeRephraseControllers.size} active request(s)\n`,
			);
		}
		for (const controller of activeRephraseControllers) {
			controller.abort();
		}
	}

	// ── Subscribe to session lifecycle for context capture ──────
	// session_start: reset the buffer so a new session starts fresh.
	pi.on("session_start", (_event, ctx) => {
		conversationBuffer.length = 0;
		toolResultBuffer.length = 0;
		pendingOriginals.length = 0;
		pendingPastedTexts.length = 0;
		terminalPasteBuffer = "";
		terminalPasteActive = false;
		abortActiveRephrases();
		removeTerminalInputListener?.();
		removeTerminalInputListener = undefined;

		// Pi's input context has no abort signal while idle, which is when
		// this input handler runs. Subscribe to raw TUI input instead so
		// Escape/Ctrl-C can cancel a rephrase while its provider request is
		// in flight. Never consume the key; Pi still handles its normal
		// interrupt behavior after this listener runs.
		if (ctx?.mode === "tui") {
			removeTerminalInputListener = ctx.ui.onTerminalInput((data) => {
				captureTerminalPastes(data);
				if (data === "\u001b" || data === "\u0003") {
					abortActiveRephrases();
				}
				return undefined;
			});
		}
	});

	pi.on("session_shutdown", () => {
		abortActiveRephrases();
		removeTerminalInputListener?.();
		removeTerminalInputListener = undefined;
	});

	// message_end is the single capture point for both user and assistant
	// messages plus tool results. We do NOT subscribe to turn_end because
	// message_end fires for both message types and avoids the parallel
	// capture path that previously let the buffer accumulate rephrased
	// text alongside original text.
	pi.on("message_end", (event) => {
		const e = event as { message?: unknown };
		const m = e.message as { role?: unknown; timestamp?: unknown; content?: unknown } | undefined;
		if (!m) return;

		if (m.role === "assistant") {
			const text = extractAssistantText(m);
			if (text) recordTurn("assistant", text);
			return;
		}

		if (m.role === "user") {
			// Prefer the original text captured at input time (before our
			// transform). FIFO order matches because Pi awaits the input
			// handler before creating the UserMessage. Falls back to the
			// message content when no input-handler push is pending (e.g.
			// RPC / extension-sourced user messages that the input handler
			// short-circuited — those still carry the original text).
			const original = pendingOriginals.shift();
			if (original !== undefined) {
				recordTurn("user", original.text);
				return;
			}
			const text = extractContentText(m.content);
			if (text) recordTurn("user", text);
			return;
		}

		if (m.role === "toolResult") {
			const tr = m as { toolName?: unknown; content?: unknown };
			const toolName = typeof tr.toolName === "string" ? tr.toolName : "tool";
			recordToolResult(toolName, extractToolResultText(tr));
		}
	});
	// ── Configuration constants (closure-local) ────────────────
	const DEFAULT_TIMEOUT_MS = 8000;
	const DEFAULT_MAX_RETRIES = 2;
	const DEFAULT_RETRY_BASE_MS = 500;
	const CLIPBOARD_IMAGE_REFERENCE =
		/((?:(?:[A-Za-z]:)?[/\\][^\s"'`]*?)?pi-clipboard-[0-9a-f-]+\.(?:png|jpe?g|gif|webp|bmp))(?=$|[\s"'`])/giu;
	const MENTIONED_FILE_REFERENCE = /(?<![\w@])@(?:"[^"\r\n]+"|[^\s"'`)}\],;]+)/gu;
	const FENCED_TEXT_PAYLOAD =
		/^[ \t]*(`{3,}|~{3,})[^\r\n]*(?:\r?\n)[\s\S]*?^[ \t]*\1[ \t]*\r?$/gmu;
	const FILE_TEXT_PAYLOAD = /<file\b[^>]*>[\s\S]*?<\/file>/giu;
	const CLIPBOARD_IMAGE_MIME_TYPES: Record<string, string> = {
		".png": "image/png",
		".jpg": "image/jpeg",
		".jpeg": "image/jpeg",
		".gif": "image/gif",
		".webp": "image/webp",
		".bmp": "image/bmp",
	};

	function readPositiveEnvNumber(name: string, fallback: number): number {
		const raw = process.env[name];
		if (raw === undefined || raw.trim() === "") return fallback;
		const value = Number(raw);
		return Number.isFinite(value) && value > 0 ? value : fallback;
	}

	function readNonNegativeEnvInteger(name: string, fallback: number): number {
		const raw = process.env[name];
		if (raw === undefined || raw.trim() === "") return fallback;
		const value = Number(raw);
		return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
	}

	const REPHRASE_SYSTEM_PROMPT = `You are a request rephraser for a coding agent. Your only job: take the user's raw request and rewrite it as a clear, actionable prompt that another LLM can execute well.

The user input may contain pasted text such as code, logs, documents, or quoted content, plus attached images and mentioned files. Treat pasted material, images, and file references as user-provided payload, not as instructions to rephrase. Preserve every payload exactly, including wording, whitespace, punctuation, code formatting, file-reference spelling, and attachment bytes. Do not summarize, translate, normalize, or omit payloads. The output MUST include every supplied text payload unchanged and keep every supplied image attached. Rephrase only the surrounding request. If the input contains only payload, return that payload unchanged.

You may be given two context blocks before the user's request:
- "Recent conversation": prior turns in this session. Use to resolve pronouns, references like "fix that", and follow-ups that depend on earlier intent.
- "Recent tool results": what the agent just did or tried. Use to understand the current session state.

Rules (in strict priority order):
1. Preserve user intent EXACTLY. Never add goals, libraries, conventions, constraints, or requirements the user did not state.
2. Do not append skill suggestions, documentation reminders, or any text not present in or directly implied by the user's input. Output ONLY the rephrased request.
3. Resolve ambiguity only by choosing between interpretations of what the user said. Do not invent new requirements.
4. Output ONE prompt, no preamble, no explanation, no "Here is the rephrased request:". No markdown fencing around the whole output.
5. Keep it concise. Do not pad. Do not moralize.
6. Use imperative voice ("Fix X", "Add Y", "Refactor Z to support W").`;

	// ── Response parsing ───────────────────────────────────────

	function extractText(response: CompletionResponse): string {
		return (response.content ?? [])
			.filter((content): content is TextContent & { text: string } =>
				content.type === "text" && typeof content.text === "string",
			)
			.map((content) => content.text)
			.join("\n")
			.trim();
	}

	// ── Signal linking ─────────────────────────────────────────
	// Forward the user-input signal into a child AbortController so
	// the timeout-bounded signal aborts early on user interrupt
	// (Ctrl-C during the LLM call). Returns a cleanup function.

	function linkAbortSignals(
		parent: AbortSignal | undefined,
		child: AbortController,
	): () => void {
		if (!parent) return () => {};
		if (parent.aborted) {
			child.abort();
			return () => {};
		}
		const listener = (): void => {
			child.abort();
		};
		parent.addEventListener("abort", listener, { once: true });
		return () => {
			parent.removeEventListener("abort", listener);
		};
	}

	// ── Retry helpers — exponential backoff with jitter, bounded
	// attempts. Each attempt owns its own timeout-bounded signal; the
	// per-call timeout (PI_REPHRASE_TIMEOUT_MS) is preserved per attempt.
	// Operations throw on transient errors (timeout); withRetry catches
	// and retries. Operations return null/[] on permanent failures (no
	// model, auth missing, empty response, stopReason="error"). On retry
	// exhaustion withRetry returns the operation's null/[] so callers
	// keep their existing fallback paths.

	function computeRetryBackoff(attempt: number, baseMs: number): number {
		const cap = baseMs * 2 ** (attempt - 1);
		return Math.floor(Math.random() * cap);
	}

	function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
		return new Promise((resolve, reject) => {
			if (signal?.aborted) {
				reject(new Error("aborted"));
				return;
			}
			const timer = setTimeout(() => {
				signal?.removeEventListener("abort", onAbort);
				resolve();
			}, ms);
			const onAbort = (): void => {
				clearTimeout(timer);
				reject(new Error("aborted"));
			};
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	async function withRetry<T>(
		operation: (signal: AbortSignal) => Promise<T | null>,
		options: {
			maxRetries: number;
			baseMs: number;
			timeoutMs: number;
			signal?: AbortSignal;
			label: string;
			debug: boolean;
		},
	): Promise<T | null> {
		const maxAttempts = Math.max(1, options.maxRetries + 1);
		let lastErr: unknown;
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			if (options.signal?.aborted) return null;

			const ac = new AbortController();
			const timer = setTimeout(() => ac.abort(), Math.max(1, options.timeoutMs));
			const unlinkUser = linkAbortSignals(options.signal, ac);

			try {
				return await operation(ac.signal);
			} catch (err) {
				lastErr = err;
				if (options.signal?.aborted) return null;
				if (attempt >= maxAttempts) break;
				const backoff = computeRetryBackoff(attempt, options.baseMs);
				if (options.debug) {
					process.stderr.write(
						`[rephrase-retry] ${options.label} attempt ${attempt}/${maxAttempts} failed (${(err as Error).message ?? err}); retrying in ${backoff}ms\n`,
					);
				}
				try {
					await sleepWithSignal(backoff, options.signal);
				} catch {
					return null;
				}
			} finally {
				clearTimeout(timer);
				unlinkUser();
			}
		}
		if (options.debug && lastErr) {
			process.stderr.write(
				`[rephrase-retry] ${options.label} exhausted ${maxAttempts} attempts (${(lastErr as Error).message ?? lastErr})\n`,
			);
		}
		return null;
	}

	// ── Rephrase — model call, returns text or null ────────────

	async function rephrase(
		ctx: InputContext,
		originalText: string,
		images: readonly ImageContent[] | undefined,
		signal: AbortSignal,
		depth: HistoryDepth,
	): Promise<string | null> {
		const model = ctx.model;
		if (!model) return null;
		if (!ctx.modelRegistry.hasConfiguredAuth?.(model)) return null;

		const conversationSection = formatConversationContext(depth);
		const toolResultSection = formatToolResultContext(depth);

		// Send each payload only once, inside the original request. Copying
		// it into an extra user-message section makes models echo that section
		// into the prompt Pi ultimately receives.
		const sections = [
			conversationSection,
			toolResultSection,
			"User request:",
			originalText.length > 0
				? originalText
				: "Describe the attached image. Ask the user for more detail only when necessary.",
		].filter((s) => s.length > 0);

		const userMsg = {
			role: "user" as const,
			content: [
				{
					type: "text" as const,
					text: sections.join("\n\n"),
				},
				...(images ?? []),
			] as (TextContent | ImageContent)[],
			timestamp: Date.now(),
		};

		const response = await ctx.modelRegistry.complete(
			model,
			{ systemPrompt: REPHRASE_SYSTEM_PROMPT, messages: [userMsg] },
			{ signal },
		);

		// Transient: throw so withRetry can retry.
		if (signal.aborted) throw new Error("rephrase aborted");
		if (response.stopReason === "aborted") throw new Error("rephrase aborted");
		// Permanent: provider error or empty response.
		if (response.stopReason === "error") return null;

		const text = extractText(response);
		return text.length > 0 ? text : null;
	}

	function collectTextPayloads(text: string, pastedTexts: readonly string[]): string[] {
		const candidates: Array<{ index: number; text: string }> = [];
		const addCandidate = (payload: string, index: number): void => {
			if (!payload) return;
			candidates.push({ index, text: payload });
		};

		const entireInputWasPasted = pastedTexts.some((pastedText) => pastedText.trim() === text.trim());
		for (const pastedText of pastedTexts) {
			// A pasted prompt can contain both an instruction and a payload.
			// Do not copy the entire instruction back after rephrasing it.
			if (pastedText.trim() === text.trim()) continue;
			const index = text.indexOf(pastedText);
			const trimmedIndex = index === -1 ? text.indexOf(pastedText.trim()) : index;
			if (trimmedIndex !== -1) addCandidate(pastedText, trimmedIndex);
		}
		for (const match of text.matchAll(FENCED_TEXT_PAYLOAD)) {
			if (match[0] !== undefined && match.index !== undefined) {
				addCandidate(match[0], match.index);
			}
		}
		for (const match of text.matchAll(FILE_TEXT_PAYLOAD)) {
			if (match[0] !== undefined && match.index !== undefined) {
				addCandidate(match[0], match.index);
			}
		}
		for (const match of text.matchAll(CLIPBOARD_IMAGE_REFERENCE)) {
			if (match[0] !== undefined && match.index !== undefined) {
				addCandidate(match[0], match.index);
			}
		}
		for (const match of text.matchAll(MENTIONED_FILE_REFERENCE)) {
			if (match[0] !== undefined && match.index !== undefined) {
				addCandidate(match[0], match.index);
			}
		}

		// Pi does not expose paste boundaries on InputEvent. For an unstructured
		// multiline paste, preserve everything after the first line as payload.
		if (
			(pastedTexts.length === 0 || entireInputWasPasted) &&
			text.includes("\n") &&
			!text.match(FENCED_TEXT_PAYLOAD) &&
			!text.match(FILE_TEXT_PAYLOAD)
		) {
			const firstLineEnd = text.search(/\r?\n/);
			if (firstLineEnd !== -1) {
				const payloadStart = firstLineEnd + (text[firstLineEnd] === "\r" ? 2 : 1);
				addCandidate(text.slice(payloadStart), payloadStart);
			}
		}

		candidates.sort((left, right) => left.index - right.index || right.text.length - left.text.length);
		const selected: Array<{ index: number; text: string }> = [];
		for (const candidate of candidates) {
			const isCovered = selected.some(
				(other) =>
					other.index <= candidate.index &&
					other.index + other.text.length >= candidate.index + candidate.text.length,
			);
			if (!isCovered && !selected.some((other) => other.text === candidate.text)) {
				selected.push(candidate);
			}
		}
		return selected.map((candidate) => candidate.text);
	}

	function includeTextPayloads(rephrased: string, payloads: readonly string[]): string {
		let result = rephrased.trim();
		for (const payload of payloads) {
			if (!payload || result.includes(payload)) continue;
			if (result.length > 0 && !result.endsWith("\n")) result += "\n\n";
			result += payload;
		}
		return result;
	}

	async function loadClipboardImages(text: string): Promise<Array<{ path: string; image: ImageContent }>> {
		const paths = [...text.matchAll(CLIPBOARD_IMAGE_REFERENCE)]
			.map((match) => match[1])
			.filter((path): path is string => typeof path === "string");
		if (paths.length === 0) return [];

		const temporaryDirectory = resolve(tmpdir());
		const images: Array<{ path: string; image: ImageContent }> = [];
		for (const path of paths) {
			const absolutePath = resolve(path);
			const fileName = basename(absolutePath);
			const extension = extname(fileName).toLowerCase();
			const mimeType = CLIPBOARD_IMAGE_MIME_TYPES[extension];
			if (
				!mimeType ||
				!/^pi-clipboard-[0-9a-f-]+\.(?:png|jpe?g|gif|webp|bmp)$/iu.test(fileName) ||
				(absolutePath !== temporaryDirectory &&
					!absolutePath.startsWith(`${temporaryDirectory}${sep}`))
			) {
				continue;
			}
			try {
				const data = await readFile(absolutePath);
				images.push({ path, image: { type: "image", data: data.toString("base64"), mimeType } });
			} catch {
				// Keep original path when clipboard file disappeared or cannot be read.
			}
		}
		return images;
	}

	function removeClipboardImageReferences(text: string, loadedPaths: readonly string[]): string {
		const loaded = new Set(loadedPaths);
		const result = text.replace(CLIPBOARD_IMAGE_REFERENCE, (path) => loaded.has(path) ? "" : path);
		// Remove the single separator left by a trailing image path, not
		// whitespace belonging to pasted text elsewhere in the request.
		return loadedPaths.some((path) => text.endsWith(` ${path}`))
			? result.slice(0, -1)
			: result;
	}

	// ── Input handler — gates, interrupt, env config, flow ──────

	pi.on("input", async (event, ctx) => {
		const c = ctx as InputContext;

		// Silent gates: short-circuit before any UI notification.
		if (process.env.PI_REPHRASE_OFF === "1") return { action: "continue" };
		if (event.source === "extension") return { action: "continue" };
		if (event.source === "rpc") return { action: "continue" };
		if (event.streamingBehavior === "steer") return { action: "continue" };
		if (event.streamingBehavior === "followUp") return { action: "continue" };

		// TUI image paste inserts Pi's temporary image path into editor. Convert
		// that explicit clipboard payload into an image attachment before gates.
		const clipboardImages = await loadClipboardImages(event.text);
		const inputText =
			clipboardImages.length > 0
				? removeClipboardImageReferences(event.text, clipboardImages.map(({ path }) => path))
				: event.text;
		const inputImages =
			clipboardImages.length > 0
				? [...(event.images ?? []), ...clipboardImages.map(({ image }) => image)]
				: event.images;
		const pastedTextPayloads = takePastedTextPayloads(inputText);
		const textPayloads = collectTextPayloads(inputText, pastedTextPayloads);
		const passThrough = () =>
			clipboardImages.length > 0
				? {
						action: "transform" as const,
						text: inputText,
						images: inputImages,
					}
				: { action: "continue" as const };

		// Mentioned files and other payload references stay in inputText so the
		// rephrase model can include them unchanged in its output.

		// Slash-command-shaped input — if no extension command matched,
		// `/foo bar` reaches us as prose. Rephrasing it produces "Execute
		// the foo command with the bar argument" which strips the user's
		// leading `/` and invents intent.
		if (inputText.startsWith("/")) return passThrough();

		// Empty text without an image attachment — nothing to rephrase.
		// Image-only input still flows through; whitespace-only text does not.
		if (inputText.trim().length === 0 && (inputImages?.length ?? 0) === 0) {
			return passThrough();
		}
		if (inputText.length === 0 && (inputImages?.length ?? 0) > 0) {
			// image-only path; fall through to rephrase.
		} else if (inputText.trim().length === 0) {
			return passThrough();
		}

		// User interrupt — honor before any work, including notify.
		const userSignal = c.signal;
		if (userSignal?.aborted) return passThrough();

		const model = c.model;
		if (!model) return passThrough();
		if (!c.modelRegistry.hasConfiguredAuth?.(model)) return passThrough();

		// Env config.
		const timeoutMs = readPositiveEnvNumber(
			"PI_REPHRASE_TIMEOUT_MS",
			DEFAULT_TIMEOUT_MS,
		);
		const maxRetries = readNonNegativeEnvInteger(
			"PI_REPHRASE_MAX_RETRIES",
			DEFAULT_MAX_RETRIES,
		);
		const retryBaseMs = readPositiveEnvNumber(
			"PI_REPHRASE_RETRY_BASE_MS",
			DEFAULT_RETRY_BASE_MS,
		);
		const debug = process.env.PI_REPHRASE_DEBUG === "1";

		// Queue the original text so the buffer holds user wording, not our
		// rephrase output, on subsequent turns. `message_end` shifts this
		// FIFO entry when the corresponding UserMessage finalizes. Keep a
		// reference to this entry so failure cleanup removes this request,
		// not whichever request was queued most recently.
		const pendingOriginal = { text: inputText };
		pendingOriginals.push(pendingOriginal);

		// Now we know we're going to do work — notify only then.
		if (c.hasUI) c.ui!.notify("Rephrasing with conversation context…", "info");

		// Include recent session context directly. Keep short conversations light
		// and use the full bounded buffer for longer sessions.
		const depth: HistoryDepth =
			conversationBuffer.length <= LIGHT_HISTORY_TURNS + 1 ? "light" : "heavy";

		// Rephrase through withRetry. On retry exhaustion, rephrase returns
		// null and the original input passes through unchanged.
		const rephraseController = new AbortController();
		activeRephraseControllers.add(rephraseController);
		const unlinkUserSignal = linkAbortSignals(userSignal, rephraseController);
		let rephrased: string | null;
		try {
			rephrased = await withRetry(
				(signal) => rephrase(c, inputText, inputImages, signal, depth),
				{
					maxRetries,
					baseMs: retryBaseMs,
					timeoutMs,
					signal: rephraseController.signal,
					label: "rephrase",
					debug,
				},
			);
		} finally {
			activeRephraseControllers.delete(rephraseController);
			unlinkUserSignal();
		}

		if (!rephrased) {
			// Silent on benign skips — the start notification already told
			// the user we were working. Debug log captures the failure for
			// diagnosis. Don't train the user to ignore noisy notifications.
			if (debug) {
				process.stderr.write(
					`[rephrase-skip] ${inputText.slice(0, 80)}\n`,
				);
			}
			const pendingIndex = pendingOriginals.indexOf(pendingOriginal);
			if (pendingIndex !== -1) pendingOriginals.splice(pendingIndex, 1);
			return passThrough();
		}

		const rephrasedWithPayloads = includeTextPayloads(rephrased, textPayloads);

		if (c.hasUI)
			c.ui!.notify(
				`Rephrased via ${(model as { id?: string }).id ?? "model"}`,
				"info",
			);
		if (debug) {
			process.stderr.write(
				`\n===[REPHRASE]===\n${rephrasedWithPayloads}\n===[END]===\n\n`,
			);
		}
		return {
			action: "transform",
			text: rephrasedWithPayloads,
			...(inputImages === undefined ? {} : { images: inputImages }),
		};
	});
}

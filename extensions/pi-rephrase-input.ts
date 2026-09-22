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
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ──────────────────────────────────────────────────────────────
// Module-level types (allowed; only runtime logic is consolidated)
// ──────────────────────────────────────────────────────────────

type TextContent = { type: string; text?: string };

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
	const pendingOriginals: string[] = [];

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
		// Keep the most recent turns; truncate the front.
		const overflow = joined.length - MAX_CONVERSATION_CHARS;
		const tail = joined.slice(overflow);
		// Re-add the header if we cut it off.
		const header = "Recent conversation (oldest first):";
		return tail.startsWith(header) ? tail : `${header}\n${tail}`;
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

	function extractAssistantText(message: unknown): string {
		if (!message || typeof message !== "object") return "";
		const m = message as { content?: unknown };
		// AssistantMessage.content is typed as an array of text/thinking/tool
		// blocks. A top-level `text` field never appears on assistant
		// messages — the array path is the only real path.
		if (!Array.isArray(m.content)) return "";
		const parts: string[] = [];
		for (const part of m.content) {
			if (part && typeof part === "object" && "text" in part && typeof (part as { text: unknown }).text === "string") {
				parts.push((part as { text: string }).text);
			}
		}
		return parts.join("\n");
	}

	function extractToolResultText(toolResult: unknown): string {
		if (!toolResult || typeof toolResult !== "object") return "";
		const t = toolResult as { toolName?: unknown; content?: unknown; text?: unknown };
		if (typeof t.text === "string") return t.text;
		if (Array.isArray(t.content)) {
			const parts: string[] = [];
			for (const part of t.content) {
				if (part && typeof part === "object" && "text" in part && typeof (part as { text: unknown }).text === "string") {
					parts.push((part as { text: string }).text);
				}
			}
			return parts.join("\n");
		}
		return "";
	}

	// ── Subscribe to session lifecycle for context capture ──────
	// session_start: reset the buffer so a new session starts fresh.
	pi.on("session_start", () => {
		conversationBuffer.length = 0;
		toolResultBuffer.length = 0;
		pendingOriginals.length = 0;
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
				recordTurn("user", original);
				return;
			}
			const text = Array.isArray(m.content)
				? m.content
						.filter(
							(part): part is { text: string } =>
								!!part &&
								typeof part === "object" &&
								"text" in part &&
								typeof (part as { text: unknown }).text === "string",
						)
						.map((part) => part.text)
						.join("\n")
				: "";
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

	const REPHRASE_SYSTEM_PROMPT = `You are a request rephraser for a coding agent. Your only job: take the user's raw request and rewrite it as a clear, actionable prompt that another LLM can execute well.

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
		signal: AbortSignal,
		depth: HistoryDepth,
	): Promise<string | null> {
		const model = ctx.model;
		if (!model) return null;
		if (!ctx.modelRegistry.hasConfiguredAuth?.(model)) return null;

		const conversationSection = formatConversationContext(depth);
		const toolResultSection = formatToolResultContext(depth);

		const sections = [
			conversationSection,
			toolResultSection,
			"User request:",
			originalText,
		].filter((s) => s.length > 0);

		const userMsg = {
			role: "user" as const,
			content: [
				{
					type: "text" as const,
					text: sections.join("\n\n"),
				},
			],
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

	// ── Input handler — gates, interrupt, env config, flow ──────

	pi.on("input", async (event, ctx) => {
		const c = ctx as InputContext;

		// Silent gates: short-circuit before any UI notification.
		if (process.env.PI_REPHRASE_OFF === "1") return { action: "continue" };
		if (event.source === "extension") return { action: "continue" };
		if (event.source === "rpc") return { action: "continue" };
		if (event.streamingBehavior === "steer") return { action: "continue" };
		if (event.streamingBehavior === "followUp") return { action: "continue" };

		// `@file` references — the `input` event sees raw text BEFORE Pi
		// resolves `@file` to file contents. Rephrasing here would preserve
		// an unresolved reference and could distort the explicit file request.
		if (event.text.includes("@")) return { action: "continue" };

		// Slash-command-shaped input — if no extension command matched,
		// `/foo bar` reaches us as prose. Rephrasing it produces "Execute
		// the foo command with the bar argument" which strips the user's
		// leading `/` and invents intent.
		if (event.text.startsWith("/")) return { action: "continue" };

		// Empty / whitespace-only input — nothing to rephrase.
		if (event.text.trim().length === 0) return { action: "continue" };

		// User interrupt — honor before any work, including notify.
		const userSignal = c.signal;
		if (userSignal?.aborted) return { action: "continue" };

		const model = c.model;
		if (!model) return { action: "continue" };
		if (!c.modelRegistry.hasConfiguredAuth?.(model)) return { action: "continue" };

		// Env config.
		const timeoutMs = Number(process.env.PI_REPHRASE_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
		const maxRetries =
			process.env.PI_REPHRASE_MAX_RETRIES !== undefined &&
			process.env.PI_REPHRASE_MAX_RETRIES !== ""
				? Math.max(0, Number(process.env.PI_REPHRASE_MAX_RETRIES) || 0)
				: DEFAULT_MAX_RETRIES;
		const retryBaseMs =
			process.env.PI_REPHRASE_RETRY_BASE_MS !== undefined &&
			process.env.PI_REPHRASE_RETRY_BASE_MS !== ""
				? Math.max(1, Number(process.env.PI_REPHRASE_RETRY_BASE_MS) || DEFAULT_RETRY_BASE_MS)
				: DEFAULT_RETRY_BASE_MS;
		const debug = process.env.PI_REPHRASE_DEBUG === "1";

		// Queue the original text so the buffer holds user wording, not our
		// rephrase output, on subsequent turns. `message_end` shifts this
		// FIFO entry when the corresponding UserMessage finalizes. If
		// rephrasing fails, we pop the entry below before falling through
		// to passthrough so `message_end` falls back to extracting the
		// original from `m.content` (which is `event.text` in passthrough).
		pendingOriginals.push(event.text);

		// Now we know we're going to do work — notify only then.
		if (c.hasUI) c.ui!.notify("Rephrasing with conversation context…", "info");

		// Include recent session context directly. Keep short conversations light
		// and use the full bounded buffer for longer sessions.
		const depth: HistoryDepth =
			conversationBuffer.length <= LIGHT_HISTORY_TURNS + 1 ? "light" : "heavy";

		// Rephrase through withRetry. On retry exhaustion, rephrase returns
		// null and the original input passes through unchanged.
		const rephrased = await withRetry(
			(signal) => rephrase(c, event.text, signal, depth),
			{
				maxRetries,
				baseMs: retryBaseMs,
				timeoutMs,
				signal: userSignal,
				label: "rephrase",
				debug,
			},
		);

		if (!rephrased) {
			// Silent on benign skips — the start notification already told
			// the user we were working. Debug log captures the failure for
			// diagnosis. Don't train the user to ignore noisy notifications.
			if (debug) {
				process.stderr.write(
					`[rephrase-skip] ${event.text.slice(0, 80)}\n`,
				);
			}
			pendingOriginals.pop();
			return { action: "continue" };
		}

		if (c.hasUI)
			c.ui!.notify(
				`Rephrased via ${(model as { id?: string }).id ?? "model"}`,
				"info",
			);
		if (debug) {
			process.stderr.write(
				`\n===[REPHRASE]===\n${rephrased}\n===[END]===\n\n`,
			);
		}
		return { action: "transform", text: rephrased };
	});
}
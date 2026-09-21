/**
 * LLM Rephraser for pi
 *
 * Intercepts every user input, asks an LLM to rephrase the request with
 * cwd project context baked in (intent, scope, acceptance, constraints),
 * then hands the rephrased prompt to pi. The downstream agent still does
 * all the real work — this just sharpens what it receives.
 *
 * Permanent install (loaded on every `pi` invocation):
 *   pi install /path/to/pi-rephrase-input
 *
 * Config (env vars, optional):
 *   PI_REPHRASE_TIMEOUT_MS="8000"        # default = 8000
 *   PI_REPHRASE_MAX_CONTEXT_CHARS="6000" # default = 6000
 *   PI_REPHRASE_SELECTION_TIMEOUT_MS="2500" # optional selector timeout
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
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
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

export type ContextFileCandidate = {
	path: string;
	size: number;
};

type InputContext = {
	model?: unknown;
	modelRegistry: ModelRegistryLike;
	cwd: string;
	hasUI: boolean;
	ui?: { notify: (message: string, kind: string) => void };
	signal?: AbortSignal;
	sessionManager?: {
		getEntries?: () => readonly unknown[];
		getPath?: () => readonly unknown[];
	};
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

type HistoryDepth = "none" | "light" | "heavy";
type FollowUpResult = boolean | null;

const MAX_CONVERSATION_TURNS = 6;
const MAX_TOOL_RESULT_SNAPSHOTS = 3;
const MAX_CONVERSATION_CHARS = 2000;
const MAX_TOOL_RESULT_CHARS = 1000;
const LIGHT_HISTORY_TURNS = 2;
const CLASSIFIER_TURNS_TO_CONSIDER = 3;

const FOLLOW_UP_CLASSIFIER_SYSTEM_PROMPT = `Decide whether the user's latest message depends on prior conversation context.

Reply with exactly one word: YES or NO. No other text, punctuation, explanation, or markdown.

YES = the message refers to prior turns (pronouns like "that/it/this/above", phrases like "fix the previous one", "do the same", "also try that", or anything not understandable without context).

NO = the message stands alone and can be understood with no prior context.`;

const FALLBACK_FOLLOW_UP_SIGNAL =
	/\b(that|this|those|above|same|also|fix it|do it|again|too|either|previous|earlier)\b/i;

// ──────────────────────────────────────────────────────────────
// Single exported extension function — every helper below is a
// closure-private definition; nothing leaks to module scope.
// ──────────────────────────────────────────────────────────────

export default function rephraseInput(pi: ExtensionAPI): void {
	// ── Rolling buffers for session-aware rephrasing ────────────
	const conversationBuffer: ConversationTurn[] = [];
	const toolResultBuffer: ToolResultSnapshot[] = [];
	// Map from transformed user-message timestamp → original text. Used
	// to recover the original wording from `message_end` after our own
	// transform rewrote it. Without this, the buffer captures our
	// rephrased output and feeds it back on the next turn, compounding
	// verbosity and drifting from user voice across a session.
	const originalsByTimestamp = new Map<number, string>();

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
		if (depth === "none" || conversationBuffer.length === 0) return "";
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
		if (depth === "none" || toolResultBuffer.length === 0) return "";
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
	// conversation buffer already provides prior-turn grounding when
	// the classifier says follow-up.

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
		originalsByTimestamp.clear();
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
			// transform). Falls back to the message content if the input
			// came from a path that didn't record originals (e.g. RPC).
			const timestamp = typeof m.timestamp === "number" ? m.timestamp : undefined;
			const original = timestamp !== undefined ? originalsByTimestamp.get(timestamp) : undefined;
			if (original !== undefined) {
				recordTurn("user", original);
				if (timestamp !== undefined) originalsByTimestamp.delete(timestamp);
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
	const MAX_FILE_CHARS = 1500;
	const DEFAULT_MAX_TOTAL_CHARS = 6000;
	const DEFAULT_TIMEOUT_MS = 8000;
	const DEFAULT_MAX_INVENTORY_CHARS = 12000;
	const MAX_CONTEXT_FILE_SIZE = 200_000;
	const MAX_CONTEXT_CANDIDATES = 500;
	const MAX_SELECTED_CONTEXT_FILES = 8;
	const MAX_CLASSIFIER_TIMEOUT_MS = 2500;
	const DEFAULT_MAX_RETRIES = 2;
	const DEFAULT_RETRY_BASE_MS = 500;

	const SKIPPED_CONTEXT_DIRECTORIES = new Set([
		".git",
		"node_modules",
		"vendor",
		"dist",
		"build",
		"coverage",
		".cache",
		".playwright-cli",
	]);

	const SENSITIVE_CONTEXT_PATH =
		/(^|\/)(?:\.env(?:\..*)?|auth\.json|credentials?\.json|(?:secret|token|password|private[-_]?key|id_rsa)(?:[._-].*)?)$/i;

	const CONTEXT_SELECTION_SYSTEM_PROMPT = `You select project context files for a coding-agent request. Return JSON only, with this exact shape: {"files":["relative/path"]}.

Rules:
- Select only paths from the supplied candidate inventory.
- Select at most ${MAX_SELECTED_CONTEXT_FILES} files most relevant to the user's request.
- Hard caps: at most 1 manifest file (e.g. package.json, Cargo.toml, pyproject.toml, go.mod); at most 1 instructions file (e.g. AGENTS.md, CLAUDE.md, README.md). The remaining slots go to source code.
- Prefer source code that is actually relevant to the user's request over generic project boilerplate.
- Do not select secrets, credentials, generated output, dependency trees, lockfiles, or unrelated files.
- Return {"files":[]} when no candidate helps.
- Never include explanations, Markdown fences, or paths not present in the inventory.`;

	const REPHRASE_SYSTEM_PROMPT = `You are a request rephraser for a coding agent. Your only job: take the user's raw request and rewrite it as a clear, actionable prompt that another LLM can execute well.

You may be given three context blocks before the user's request:
- "Recent conversation": prior turns in this session. Use to resolve pronouns, references like "fix that", and follow-ups that depend on earlier intent.
- "Recent tool results": what the agent just did or tried. Use to know what state the project is in.
- "Project files (selected by model)": file contents the model thinks are relevant to the current request.

Rules (in strict priority order):
1. Preserve user intent EXACTLY. Never add goals, libraries, conventions, constraints, or requirements the user did not state.
2. Do not append skill suggestions, documentation reminders, conflict notes, or any text not present in or directly implied by the user's input. Output ONLY the rephrased request.
3. Resolve ambiguity only by choosing between interpretations of what the user said. Do not invent new requirements.
4. Inject project context (stack, file structure, naming conventions) only when it helps clarify what the user already asked for, not when it would change the answer.
5. If the user explicitly chose something that conflicts with a project convention in the context files, keep the user's choice.
6. Output ONE prompt, no preamble, no explanation, no "Here is the rephrased request:". No markdown fencing around the whole output.
7. Keep it concise. Do not pad. Do not moralize.
8. Use imperative voice ("Fix X", "Add Y", "Refactor Z to support W").`;

	// ── Path and file helpers ──────────────────────────────────

	function normalizeRelativePath(value: string): string | null {
		const normalized = value.trim().replaceAll("\\", "/").replace(/^\.\//, "");
		if (
			!normalized ||
			normalized.startsWith("/") ||
			/^[A-Za-z]:\//.test(normalized) ||
			normalized.split("/").some((part) => !part || part === "." || part === "..")
		) {
			return null;
		}
		return normalized;
	}

	function isSensitiveContextPath(path: string): boolean {
		return SENSITIVE_CONTEXT_PATH.test(path);
	}

	function isTextFile(path: string): boolean {
		try {
			const sample = readFileSync(path).subarray(0, 4096);
			return !sample.includes(0);
		} catch {
			return false;
		}
	}

	// ── Discovery ──────────────────────────────────────────────

	function discoverContextCandidates(cwd: string): ContextFileCandidate[] {
		const candidates: ContextFileCandidate[] = [];
		const root = resolve(cwd);

		const visit = (directory: string, relativeDirectory: string): void => {
			if (candidates.length >= MAX_CONTEXT_CANDIDATES) return;

			let entries;
			try {
				entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
					a.name.localeCompare(b.name),
				);
			} catch {
				return;
			}

			for (const entry of entries) {
				if (candidates.length >= MAX_CONTEXT_CANDIDATES) return;
				const relativePath = relativeDirectory
					? `${relativeDirectory}/${entry.name}`
					: entry.name;
				if (isSensitiveContextPath(relativePath)) continue;

				if (entry.isDirectory()) {
					if (!SKIPPED_CONTEXT_DIRECTORIES.has(entry.name) && !entry.isSymbolicLink()) {
						visit(join(directory, entry.name), relativePath);
					}
					continue;
				}
				if (!entry.isFile() || entry.isSymbolicLink()) continue;

				const path = join(directory, entry.name);
				let size: number;
				try {
					const stat = statSync(path);
					size = stat.size;
					if (size > MAX_CONTEXT_FILE_SIZE) continue;
				} catch {
					continue;
				}
				if (!isTextFile(path)) continue;
				candidates.push({ path: relativePath, size });
			}
		};

		visit(root, "");
		return candidates;
	}

	function formatCandidateInventory(
		candidates: readonly ContextFileCandidate[],
	): { text: string; listedCandidates: ContextFileCandidate[] } {
		const lines: string[] = [];
		const listedCandidates: ContextFileCandidate[] = [];
		let total = 0;
		for (const candidate of candidates) {
			// No file sizes — large files bias the LLM toward big/boilerplate
			// files (package.json, lockfiles) over the small relevant source.
			const line = `- ${candidate.path}`;
			if (total + line.length + 1 > DEFAULT_MAX_INVENTORY_CHARS) break;
			lines.push(line);
			listedCandidates.push(candidate);
			total += line.length + 1;
		}
		return { text: lines.join("\n"), listedCandidates };
	}

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

	function parseSelectedFiles(text: string): string[] {
		const stripped = text
			.trim()
			.replace(/^```(?:json)?\s*/i, "")
			.replace(/\s*```$/, "")
			.trim();
		let parsed: unknown;
		try {
			parsed = JSON.parse(stripped);
		} catch {
			const start = stripped.indexOf("{");
			const end = stripped.lastIndexOf("}");
			if (start < 0 || end <= start) return [];
			try {
				parsed = JSON.parse(stripped.slice(start, end + 1));
			} catch {
				return [];
			}
		}
		if (
			!parsed ||
			typeof parsed !== "object" ||
			!Array.isArray((parsed as { files?: unknown }).files)
		) {
			return [];
		}
		return (parsed as { files: unknown[] }).files.filter(
			(file): file is string => typeof file === "string",
		);
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

	// ── Selection — LLM call to pick files ─────────────────────

	async function selectContextFiles(
		modelRegistry: ModelRegistryLike,
		model: unknown,
		cwd: string,
		originalText: string,
		candidates: readonly ContextFileCandidate[],
		signal: AbortSignal,
	): Promise<string[] | null> {
		const { text: inventory, listedCandidates } = formatCandidateInventory(candidates);
		if (!inventory) return [];

		const response = await modelRegistry.complete(
			model,
			{
				systemPrompt: CONTEXT_SELECTION_SYSTEM_PROMPT,
				messages: [
					{
						role: "user" as const,
						content: [
							{
								type: "text" as const,
								text: [
									`Project cwd: ${cwd}`,
									"Candidate files:",
									inventory,
									"",
									"User request:",
									originalText,
								].join("\n"),
							},
						],
						timestamp: Date.now(),
					},
				],
			},
			{ signal },
		);

		// Throw on transient (timeout/user-abort) so withRetry can retry.
		if (signal.aborted) throw new Error("selector aborted");
		if (response.stopReason === "aborted") throw new Error("selector aborted");
		// Permanent: provider error, no point retrying.
		if (response.stopReason === "error") return null;

		const allowed = new Set(listedCandidates.map((candidate) => candidate.path));
		const selected: string[] = [];
		for (const file of parseSelectedFiles(extractText(response))) {
			const normalized = normalizeRelativePath(file);
			if (!normalized || !allowed.has(normalized) || selected.includes(normalized)) continue;
			selected.push(normalized);
			if (selected.length >= MAX_SELECTED_CONTEXT_FILES) break;
		}
		return selected;
	}

	// ── Follow-up classifier — single-token LLM call to detect
	// whether the current input depends on prior conversation. Runs
	// in parallel with the selector. Falls back to FALLBACK_FOLLOW_UP_SIGNAL
	// on any failure so behavior degrades safely.

	function pickHistoryDepth(
		classifierResult: FollowUpResult,
		bufferLength: number,
		regexMatched: boolean,
	): HistoryDepth {
		const lightOrHeavy = bufferLength <= LIGHT_HISTORY_TURNS + 1 ? "light" : "heavy";
		if (classifierResult === true) return lightOrHeavy;
		if (classifierResult === false) return "none";
		// Classifier returned null (timeout/error with no retries left).
		// On failure, the regex fallback is the only signal — match →
		// include history, no match → omit. Never default to including on
		// classifier failure, since the regex over-matches (e.g. "this is
		// the second time today" matches `this`).
		return regexMatched ? lightOrHeavy : "none";
	}

	async function classifyFollowUpNeeded(
		modelRegistry: ModelRegistryLike,
		model: unknown,
		originalText: string,
		conversation: readonly ConversationTurn[],
		signal: AbortSignal,
	): Promise<FollowUpResult> {
		if (conversation.length === 0) return false;
		if (!model || !modelRegistry.hasConfiguredAuth?.(model)) return null;

		const recent = conversation.slice(-CLASSIFIER_TURNS_TO_CONSIDER);
		const formatted = recent
			.map((t) => `${t.role === "user" ? "U" : "A"}: ${t.text}`)
			.join("\n");

		const response = await modelRegistry.complete(
			model,
			{
				systemPrompt: FOLLOW_UP_CLASSIFIER_SYSTEM_PROMPT,
				messages: [
					{
						role: "user" as const,
						content: [
							{
								type: "text" as const,
								text: `Recent conversation:\n${formatted}\n\nLatest message:\n${originalText}`,
							},
						],
						timestamp: Date.now(),
					},
				],
			},
			{ signal },
		);

		// Transient: throw so withRetry can retry.
		if (signal.aborted) throw new Error("classifier aborted");
		if (response.stopReason === "aborted") throw new Error("classifier aborted");
		// Permanent: provider error, malformed output, or unparseable verdict.
		if (response.stopReason === "error") return null;

		const out = extractText(response).trim().toUpperCase();
		if (out.startsWith("Y")) return true;
		if (out.startsWith("N")) return false;
		return null;
	}

	// ── Loading — read selected files, bounded by total chars ───

	function loadContext(
		cwd: string,
		maxTotal: number,
		selectedFiles: readonly string[] = [],
	): string {
		const blocks: string[] = [];
		let total = 0;
		const root = resolve(cwd);
		for (const selectedFile of selectedFiles) {
			const rel = normalizeRelativePath(selectedFile);
			if (!rel || isSensitiveContextPath(rel)) continue;
			const p = resolve(root, rel);
			const resolvedRelative = relative(root, p);
			if (
				!resolvedRelative ||
				resolvedRelative === ".." ||
				resolvedRelative.startsWith(`..${sep}`) ||
				isAbsolute(resolvedRelative)
			)
				continue;
			if (!existsSync(p)) continue;

			let raw: string;
			try {
				const st = statSync(p);
				if (!st.isFile() || st.size > MAX_CONTEXT_FILE_SIZE) continue;
				raw = readFileSync(p, "utf8");
			} catch {
				continue;
			}
			const trimmed =
				raw.length > MAX_FILE_CHARS
					? raw.slice(0, MAX_FILE_CHARS) + "\n…[truncated]"
					: raw;
			const block = `### ${rel}\n${trimmed}`;
			if (total + block.length > maxTotal) break;
			blocks.push(block);
			total += block.length;
		}
		return blocks.join("\n\n");
	}

	// ── Rephrase — second LLM call, returns text or null ────────

	async function rephrase(
		ctx: InputContext,
		originalText: string,
		projectCtx: string,
		repoName: string,
		signal: AbortSignal,
		depth: HistoryDepth,
	): Promise<string | null> {
		const model = ctx.model;
		if (!model) return null;
		if (!ctx.modelRegistry.hasConfiguredAuth?.(model)) return null;

		const conversationSection = formatConversationContext(depth);
		const toolResultSection = formatToolResultContext(depth);

		const sections = [
			`Project: ${repoName} (cwd=${ctx.cwd})`,
			conversationSection,
			toolResultSection,
			projectCtx
				? `Project files (selected by model):\n${projectCtx}`
				: "(no project files selected)",
			"",
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

		// `@file` references — the `input` event sees the raw text BEFORE
		// Pi resolves `@file` to file contents. Rephrasing here produces
		// output that contains the unresolved `@src/foo.ts` literal AND
		// files the selector guessed — internally inconsistent.
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
		const maxTotal =
			Number(process.env.PI_REPHRASE_MAX_CONTEXT_CHARS) || DEFAULT_MAX_TOTAL_CHARS;
		const timeoutMs = Number(process.env.PI_REPHRASE_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
		const configuredSelectionTimeout =
			Number(process.env.PI_REPHRASE_SELECTION_TIMEOUT_MS) || Math.floor(timeoutMs / 3);
		const selectionTimeoutMs = Math.max(
			1,
			Math.min(timeoutMs, configuredSelectionTimeout),
		);
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

		// Capture original text so the buffer holds user wording, not our
		// rephrase output, on subsequent turns. Timestamp is assigned when
		// we return the transform — Pi records that same timestamp on the
		// UserMessage. We approximate with Date.now() at capture time.
		const capturedTimestamp = Date.now();
		originalsByTimestamp.set(capturedTimestamp, event.text);

		// Now we know we're going to do work — notify only then.
		if (c.hasUI) c.ui!.notify("Rephrasing with context…", "info");

		// Classifier + selector run in parallel on the active model
		// (ctx.model). Each goes through withRetry: bounded exponential
		// backoff with jitter, per-attempt timeout.
		const candidates = discoverContextCandidates(c.cwd);
		const classifierTimeoutMs = Math.max(
			1,
			Math.min(timeoutMs, MAX_CLASSIFIER_TIMEOUT_MS),
		);
		const [selectedFilesResult, classifierResult] = await Promise.all([
			withRetry(
				(signal) =>
					selectContextFiles(
						c.modelRegistry,
						model,
						c.cwd,
						event.text,
						candidates,
						signal,
					),
				{
					maxRetries,
					baseMs: retryBaseMs,
					timeoutMs: selectionTimeoutMs,
					signal: userSignal,
					label: "selector",
					debug,
				},
			),
			withRetry(
				(signal) =>
					classifyFollowUpNeeded(
						c.modelRegistry,
						model,
						event.text,
						conversationBuffer,
						signal,
					),
				{
					maxRetries,
					baseMs: retryBaseMs,
					timeoutMs: classifierTimeoutMs,
					signal: userSignal,
					label: "classifier",
					debug,
				},
			),
		]);
		const selectedFiles = selectedFilesResult ?? [];

		// Decide history depth: classifier wins; on failure, regex
		// fallback maps match/no-match to light/heavy/none.
		const regexMatched = FALLBACK_FOLLOW_UP_SIGNAL.test(event.text);
		const depth = pickHistoryDepth(
			classifierResult,
			conversationBuffer.length,
			regexMatched,
		);

		// Load context, then rephrase through withRetry. On retry exhaustion
		// rephrase returns null, which falls back to passing the original
		// input through unchanged (current contract).
		const projectCtx = loadContext(c.cwd, maxTotal, selectedFiles);
		const repoName = basename(c.cwd);
		const rephrased = await withRetry(
			(signal) =>
				rephrase(c, event.text, projectCtx, repoName, signal, depth),
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
			originalsByTimestamp.delete(capturedTimestamp);
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
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

const MAX_CONVERSATION_TURNS = 6;
const MAX_TOOL_RESULT_SNAPSHOTS = 3;
const MAX_CONVERSATION_CHARS = 2000;
const MAX_TOOL_RESULT_CHARS = 1000;
const MAX_REPHRASE_HISTORY = 1;

// ──────────────────────────────────────────────────────────────
// Single exported extension function — every helper below is a
// closure-private definition; nothing leaks to module scope.
// ──────────────────────────────────────────────────────────────

export default function rephraseInput(pi: ExtensionAPI): void {
	// ── Rolling buffers for session-aware rephrasing ────────────
	const conversationBuffer: ConversationTurn[] = [];
	const toolResultBuffer: ToolResultSnapshot[] = [];
	const rephraseHistory: string[] = [];

	function rememberRephrase(text: string): void {
		rephraseHistory.push(text);
		if (rephraseHistory.length > MAX_REPHRASE_HISTORY) rephraseHistory.shift();
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

	function formatConversationContext(): string {
		if (conversationBuffer.length === 0) return "";
		const lines: string[] = ["Recent conversation (oldest first):"];
		for (const turn of conversationBuffer) {
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

	function formatToolResultContext(): string {
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

	function formatLastRephraseContext(): string {
		if (rephraseHistory.length === 0) return "";
		const last = rephraseHistory[rephraseHistory.length - 1];
		return `Previous rephrase of similar intent:\n${last}`;
	}

	function extractAssistantText(message: unknown): string {
		if (!message || typeof message !== "object") return "";
		const m = message as { content?: unknown; text?: unknown };
		if (typeof m.text === "string") return m.text;
		if (Array.isArray(m.content)) {
			const parts: string[] = [];
			for (const part of m.content) {
				if (part && typeof part === "object" && "text" in part && typeof (part as { text: unknown }).text === "string") {
					parts.push((part as { text: string }).text);
				}
			}
			return parts.join("\n");
		}
		return "";
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
		rephraseHistory.length = 0;
	});

	// turn_end: capture the assistant message and tool results from
	// the just-completed turn so the next input has them in context.
	pi.on("turn_end", (event) => {
		const e = event as { message?: unknown; toolResults?: unknown[] };
		const assistantText = extractAssistantText(e.message);
		if (assistantText) recordTurn("assistant", assistantText);
		if (Array.isArray(e.toolResults)) {
			for (const tr of e.toolResults) {
				const toolName =
					tr && typeof tr === "object" && typeof (tr as { toolName?: unknown }).toolName === "string"
						? (tr as { toolName: string }).toolName
						: "tool";
				recordToolResult(toolName, extractToolResultText(tr));
			}
		}
	});

	// message_end: catch user messages too (they don't appear in turn_end).
	pi.on("message_end", (event) => {
		const e = event as { message?: unknown };
		const m = e.message as { role?: unknown; text?: unknown; content?: unknown } | undefined;
		if (!m || m.role !== "user") return;
		const text =
			typeof m.text === "string"
				? m.text
				: Array.isArray(m.content)
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
		recordTurn("user", text);
	});
	// ── Configuration constants (closure-local) ────────────────
	const MAX_FILE_CHARS = 1500;
	const DEFAULT_MAX_TOTAL_CHARS = 6000;
	const DEFAULT_TIMEOUT_MS = 8000;
	const DEFAULT_MAX_INVENTORY_CHARS = 12000;
	const MAX_CONTEXT_FILE_SIZE = 200_000;
	const MAX_CONTEXT_CANDIDATES = 500;
	const MAX_SELECTED_CONTEXT_FILES = 8;

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
- Prefer project instructions, architecture documentation, relevant source files, tests, and manifests.
- Do not select secrets, credentials, generated output, dependency trees, or unrelated files.
- Return {"files":[]} when no candidate helps.
- Never include explanations, Markdown fences, or paths not present in the inventory.`;

	const REPHRASE_SYSTEM_PROMPT = `You are a request rephraser for a coding agent. Your only job: take the user's raw request and rewrite it as a clear, actionable prompt that another LLM can execute well.

You may be given four context blocks before the user's request:
- "Recent conversation": prior turns in this session. Use to resolve pronouns, references like "fix that", and follow-ups that depend on earlier intent.
- "Recent tool results": what the agent just did or tried. Use to know what state the project is in.
- "Previous rephrase of similar intent": the last rephrased version of the same kind of request. Use to keep tone consistent and avoid parroting the same phrasing.
- "Project files (selected by model)": file contents the model thinks are relevant to the current request.

Rules:
- Preserve user intent EXACTLY. Never add goals the user did not state. Never silently override the user's explicit choices.
- If the user's request conflicts with project conventions from the context files (e.g. user says "use Express" but AGENTS.md forbids it), KEEP the user's choice and append a one-line note flagging the conflict so the downstream agent can confirm with the user. Do NOT silently rewrite to match conventions.
- Resolve genuine ambiguity with the most reasonable interpretation; do NOT ask the user. Prefer acting over asking.
- Inject relevant project context (stack, conventions, constraints) only when it helps the downstream agent pick the right approach.
- If the request mentions a library, framework, SDK, or CLI, append a one-line reminder: "Refresh current docs via the find-docs skill before relying on API details."
- Output ONE prompt, no preamble, no explanation, no "Here is the rephrased request:". No markdown fencing around the whole output.
- Keep it concise. Do not pad. Do not moralize.
- Use imperative voice ("Fix X", "Add Y", "Refactor Z to support W").`;

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
			const line = `- ${candidate.path} (${candidate.size} bytes)`;
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

	// ── Selection — LLM call to pick files ─────────────────────

	async function selectContextFiles(
		modelRegistry: ModelRegistryLike,
		model: unknown,
		cwd: string,
		originalText: string,
		candidates: readonly ContextFileCandidate[],
		timeoutMs: number,
		userSignal: AbortSignal | undefined,
	): Promise<string[]> {
		const { text: inventory, listedCandidates } = formatCandidateInventory(candidates);
		if (!inventory) return [];

		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), Math.max(1, timeoutMs));
		const unlinkUser = linkAbortSignals(userSignal, ac);

		try {
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
				{ signal: ac.signal },
			);
			if (response.stopReason === "aborted") return [];

			const allowed = new Set(listedCandidates.map((candidate) => candidate.path));
			const selected: string[] = [];
			for (const file of parseSelectedFiles(extractText(response))) {
				const normalized = normalizeRelativePath(file);
				if (!normalized || !allowed.has(normalized) || selected.includes(normalized)) continue;
				selected.push(normalized);
				if (selected.length >= MAX_SELECTED_CONTEXT_FILES) break;
			}
			return selected;
		} catch {
			return [];
		} finally {
			clearTimeout(timer);
			unlinkUser();
		}
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
		userSignal: AbortSignal | undefined,
		timeoutMs: number,
	): Promise<string | null> {
		const model = ctx.model;
		if (!model) return null;
		if (!ctx.modelRegistry.hasConfiguredAuth?.(model)) return null;

		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), timeoutMs);
		const unlinkUser = linkAbortSignals(userSignal, ac);

		const conversationSection = formatConversationContext();
		const toolResultSection = formatToolResultContext();
		const lastRephraseSection = formatLastRephraseContext();

		const sections = [
			`Project: ${repoName} (cwd=${ctx.cwd})`,
			conversationSection,
			toolResultSection,
			lastRephraseSection,
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

		try {
			const response = await ctx.modelRegistry.complete(
				model,
				{ systemPrompt: REPHRASE_SYSTEM_PROMPT, messages: [userMsg] },
				{ signal: ac.signal },
			);

			if (response.stopReason === "aborted") return null;

			const text = extractText(response);
			return text.length > 0 ? text : null;
		} catch {
			return null;
		} finally {
			clearTimeout(timer);
			unlinkUser();
		}
	}

	// ── Input handler — gates, interrupt, env config, flow ──────

	pi.on("input", async (event, ctx) => {
		const c = ctx as InputContext;

		// Silent gates: short-circuit before any UI notification.
		if (process.env.PI_REPHRASE_OFF === "1") return { action: "continue" };
		if (event.source === "extension") return { action: "continue" };
		if (event.streamingBehavior === "steer") return { action: "continue" };

		// User interrupt — honor before any work, including notify.
		const userSignal = c.signal;
		if (userSignal?.aborted) return { action: "continue" };

		// Notify start (preserves byte-identical flow for cases below).
		if (c.hasUI) c.ui!.notify("Rephrasing with context…", "info");

		const model = c.model;
		if (!model) {
			if (c.hasUI) c.ui!.notify("Rephrase skipped (timeout/error)", "info");
			return { action: "continue" };
		}
		if (!c.modelRegistry.hasConfiguredAuth?.(model)) {
			if (c.hasUI) c.ui!.notify("Rephrase skipped (timeout/error)", "info");
			return { action: "continue" };
		}

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

		// Interrupt check before the selector LLM call.
		if (userSignal?.aborted) {
			if (c.hasUI) c.ui!.notify("Rephrase skipped (timeout/error)", "info");
			return { action: "continue" };
		}

		// Selector.
		const candidates = discoverContextCandidates(c.cwd);
		const selectedFiles = await selectContextFiles(
			c.modelRegistry,
			model,
			c.cwd,
			event.text,
			candidates,
			selectionTimeoutMs,
			userSignal,
		);

		// Interrupt check before the rephrase LLM call.
		if (userSignal?.aborted) {
			if (c.hasUI) c.ui!.notify("Rephrase skipped (timeout/error)", "info");
			return { action: "continue" };
		}

		// Load context, then rephrase.
		const projectCtx = loadContext(c.cwd, maxTotal, selectedFiles);
		const repoName = basename(c.cwd);
		const rephrased = await rephrase(c, event.text, projectCtx, repoName, userSignal, timeoutMs);

		if (!rephrased) {
			if (c.hasUI) c.ui!.notify("Rephrase skipped (timeout/error)", "info");
			return { action: "continue" };
		}

		rememberRephrase(rephrased);

		if (c.hasUI)
			c.ui!.notify(
				`Rephrased via ${(model as { id?: string }).id ?? "model"}`,
				"info",
			);
		if (process.env.PI_REPHRASE_DEBUG === "1") {
			process.stderr.write(`\n===[REPHRASE]===\n${rephrased}\n===[END]===\n\n`);
		}
		return { action: "transform", text: rephrased };
	});
}
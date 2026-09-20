/**
 * LLM Rephraser for pi
 *
 * Intercepts every user input, asks an LLM to rephrase the request with
 * cwd project context baked in (intent, scope, acceptance, constraints),
 * then hands the rephrased prompt to pi. The downstream agent still does
 * all the real work — this just sharpens what it receives.
 *
 * Permanent install (loaded on every `pi` invocation):
 *   pi install ~/.pi/extensions/pi-rephrase-input.ts
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
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
};

export type ContextFileCandidate = {
	path: string;
	size: number;
};

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

Rules:
- Preserve user intent EXACTLY. Never add goals the user did not state. Never silently override the user's explicit choices.
- If the user's request conflicts with project conventions from the context files (e.g. user says "use Express" but AGENTS.md forbids it), KEEP the user's choice and append a one-line note flagging the conflict so the downstream agent can confirm with the user. Do NOT silently rewrite to match conventions.
- Resolve genuine ambiguity with the most reasonable interpretation; do NOT ask the user. Prefer acting over asking.
- Inject relevant project context (stack, conventions, constraints) only when it helps the downstream agent pick the right approach.
- If the request mentions a library, framework, SDK, or CLI, append a one-line reminder: "Refresh current docs via the find-docs skill before relying on API details."
- Output ONE prompt, no preamble, no explanation, no "Here is the rephrased request:". No markdown fencing around the whole output.
- Keep it concise. Do not pad. Do not moralize.
- Use imperative voice ("Fix X", "Add Y", "Refactor Z to support W").`;

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

export function discoverContextCandidates(cwd: string): ContextFileCandidate[] {
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
			const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
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

export async function selectContextFiles(
	modelRegistry: ModelRegistryLike,
	model: unknown,
	cwd: string,
	originalText: string,
	candidates: readonly ContextFileCandidate[],
	timeoutMs: number,
): Promise<string[]> {
	const { text: inventory, listedCandidates } = formatCandidateInventory(candidates);
	if (!inventory) return [];

	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), Math.max(1, timeoutMs));
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
	}
}

export function loadContext(
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
			raw.length > MAX_FILE_CHARS ? raw.slice(0, MAX_FILE_CHARS) + "\n…[truncated]" : raw;
		const block = `### ${rel}\n${trimmed}`;
		if (total + block.length > maxTotal) break;
		blocks.push(block);
		total += block.length;
	}
	return blocks.join("\n\n");
}

async function rephrase(
	_pi: ExtensionAPI,
	ctx: { modelRegistry: any; model?: any; cwd: string; ui?: any },
	originalText: string,
): Promise<string | null> {
	const model = ctx.model;
	if (!model) return null;
	if (!ctx.modelRegistry.hasConfiguredAuth?.(model)) return null;

	const maxTotal = Number(process.env.PI_REPHRASE_MAX_CONTEXT_CHARS) || DEFAULT_MAX_TOTAL_CHARS;
	const timeoutMs = Number(process.env.PI_REPHRASE_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
	const configuredSelectionTimeout =
		Number(process.env.PI_REPHRASE_SELECTION_TIMEOUT_MS) || Math.floor(timeoutMs / 3);
	const selectionTimeoutMs = Math.max(1, Math.min(timeoutMs, configuredSelectionTimeout));
	const candidates = discoverContextCandidates(ctx.cwd);
	const selectedFiles = await selectContextFiles(
		ctx.modelRegistry,
		model,
		ctx.cwd,
		originalText,
		candidates,
		selectionTimeoutMs,
	);
	const projectCtx = loadContext(ctx.cwd, maxTotal, selectedFiles);
	const repoName = basename(ctx.cwd);

	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), timeoutMs);

	const userMsg = {
		role: "user" as const,
		content: [
			{
				type: "text" as const,
				text: [
					`Project: ${repoName} (cwd=${ctx.cwd})`,
					projectCtx ? `Context files:\n${projectCtx}` : "(no context files in cwd)",
					"",
					"User request:",
					originalText,
				].join("\n\n"),
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
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("input", async (event, ctx) => {
		if (process.env.PI_REPHRASE_OFF === "1") return { action: "continue" };
		if (event.source === "extension") return { action: "continue" };
		if (event.streamingBehavior === "steer") return { action: "continue" };

		if (ctx.hasUI) ctx.ui.notify("Rephrasing with context…", "info");

		const rephrased = await rephrase(pi, ctx as any, event.text);

		if (!rephrased) {
			if (ctx.hasUI) ctx.ui.notify("Rephrase skipped (timeout/error)", "info");
			return { action: "continue" };
		}

		if (ctx.hasUI) ctx.ui.notify(`Rephrased via ${(ctx as any).model?.id ?? "model"}`, "info");
		if (process.env.PI_REPHRASE_DEBUG === "1") {
			process.stderr.write(`\n===[REPHRASE]===\n${rephrased}\n===[END]===\n\n`);
		}
		return { action: "transform", text: rephrased };
	});
}

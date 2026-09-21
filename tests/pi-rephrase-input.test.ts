import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import rephraseInput from "../extensions/pi-rephrase-input.ts";

type Completion = {
	stopReason?: string;
	content?: Array<{ type: string; text?: string }>;
};

type Call = {
	model: unknown;
	context: any;
	options?: { signal?: AbortSignal };
};

function makeProject(files: Record<string, string | Uint8Array>): string {
	const cwd = mkdtempSync(join(tmpdir(), "pi-rephrase-input-"));
	for (const [relativePath, content] of Object.entries(files)) {
		const path = join(cwd, relativePath);
		const parent = path.slice(0, path.lastIndexOf("/"));
		if (parent) mkdirSync(parent, { recursive: true });
		writeFileSync(path, content);
	}
	return cwd;
}

function cleanup(cwd: string): void {
	rmSync(cwd, { recursive: true, force: true });
}

/**
 * Reset every env var the extension reads, so a developer's shell cannot
 * silently change the meaning of these tests.
 */
function clearEnv(): void {
	delete process.env.PI_REPHRASE_OFF;
	delete process.env.PI_REPHRASE_DEBUG;
	delete process.env.PI_REPHRASE_TIMEOUT_MS;
	delete process.env.PI_REPHRASE_MAX_CONTEXT_CHARS;
	delete process.env.PI_REPHRASE_SELECTION_TIMEOUT_MS;
	delete process.env.PI_REPHRASE_MAX_RETRIES;
	delete process.env.PI_REPHRASE_RETRY_BASE_MS;
}

/**
 * Build a real-shaped Pi message payload (content array, not top-level
 * text). Keeps tests aligned with what the actual `message_end` event
 * delivers — using top-level `text` would mask the array-extraction path
 * that runs in production.
 */
function userMsg(text: string, timestamp?: number): any {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: timestamp ?? Date.now(),
	};
}
function assistantMsg(text: string, timestamp?: number): any {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		timestamp: timestamp ?? Date.now(),
	};
}
function toolResultMsg(toolName: string, text: string, timestamp?: number): any {
	return {
		role: "toolResult",
		toolName,
		content: [{ type: "text", text }],
		timestamp: timestamp ?? Date.now(),
	};
}

/**
 * Register a rephraseInput handler on a stub `pi` and return the captured
 * callback. Mirrors what the real Pi runtime does.
 */
function captureHandler(): {
	handler: (event: any, context: any) => Promise<unknown>;
} {
	const captured: { handler?: (event: any, context: any) => Promise<unknown> } = {};
	rephraseInput({
		on: (_event: string, registered: (event: any, context: any) => Promise<unknown>) => {
			captured.handler = registered;
		},
	} as any);
	if (!captured.handler) throw new Error("handler not registered");
	return { handler: captured.handler };
}

/**
 * Like `captureHandler`, but also captures the session-lifecycle handlers
 * (session_start, message_end) so tests can drive the rolling
 * context buffer.
 */
function captureAllHandlers(): {
	handler: (event: any, context: any) => Promise<unknown>;
	fireSessionStart: () => void;
	fireMessageEnd: (event: any) => void;
} {
	const captured: {
		handler?: (event: any, context: any) => Promise<unknown>;
		sessionStart?: () => void;
		messageEnd?: (event: any) => void;
	} = {};
	rephraseInput({
		on: (event: string, registered: (e: any, c?: any) => Promise<unknown> | unknown) => {
			if (event === "session_start")
				captured.sessionStart = () => {
					(registered as () => unknown)();
				};
			else if (event === "message_end")
				captured.messageEnd = (e: any) => {
					void (registered as (e: any) => Promise<unknown>)(e);
				};
			else captured.handler = registered as (event: any, context: any) => Promise<unknown>;
		},
	} as any);
	if (!captured.handler) throw new Error("input handler not registered");
	if (!captured.sessionStart || !captured.messageEnd)
		throw new Error("lifecycle handlers not registered");
	return {
		handler: captured.handler,
		fireSessionStart: captured.sessionStart,
		fireMessageEnd: captured.messageEnd,
	};
}

test("discovers files dynamically and uses only LLM-selected context", async () => {
	clearEnv();
	const cwd = makeProject({
		"README.md": "README context",
		"src/feature.ts": "feature context",
		"notes.txt": "unrelated context",
		".env": "SECRET=do-not-read",
		"binary.dat": new Uint8Array([0, 1, 2]),
	});
	try {
		const calls: Call[] = [];
		const registry = {
			hasConfiguredAuth: () => true,
			complete: async (
				model: unknown,
				context: unknown,
				options?: Call["options"],
			): Promise<Completion> => {
				calls.push({ model, context, options });
				if (calls.length === 1) {
					// Selector: model output includes a path traversal and a
					// non-existent path — both must be filtered out.
					return {
						content: [
							{
								type: "text",
								text: '{"files":["src/feature.ts","../.env","missing.ts"]}',
							},
						],
					};
				}
				// Rephrase: a clean response.
				return { content: [{ type: "text", text: "Rephrased request" }] };
			},
		};
		const { handler } = captureHandler();
		const result = await handler(
			{ source: "interactive", text: "Fix feature" },
			{
				model: { id: "model" },
				modelRegistry: registry,
				cwd,
				hasUI: false,
			},
		);

		// Both selector and rephrase ran.
		assert.equal(calls.length, 2);

		// Selector call: message contains user request and the candidate
		// inventory (only safe files; sensitive + binary excluded).
		assert.match(calls[0].context.messages[0].content[0].text, /Fix feature/);
		assert.match(calls[0].context.messages[0].content[0].text, /src\/feature\.ts/);
		assert.match(calls[0].context.messages[0].content[0].text, /README\.md/);
		assert.match(calls[0].context.messages[0].content[0].text, /notes\.txt/);
		assert.doesNotMatch(calls[0].context.messages[0].content[0].text, /\.env\b/);
		assert.doesNotMatch(calls[0].context.messages[0].content[0].text, /binary\.dat/);

		// Rephrase call: message contains the loaded context for the only
		// valid selection (`src/feature.ts`), with no other file content.
		assert.match(calls[1].context.messages[0].content[0].text, /### src\/feature\.ts/);
		assert.match(calls[1].context.messages[0].content[0].text, /feature context/);
		assert.doesNotMatch(
			calls[1].context.messages[0].content[0].text,
			/README context|unrelated context|SECRET/,
		);

		// Handler returns transform.
		assert.deepEqual(result, { action: "transform", text: "Rephrased request" });
	} finally {
		cleanup(cwd);
	}
});

test("ignores malformed selector output and selector failures without blocking rephrase", async () => {
	clearEnv();
	process.env.PI_REPHRASE_MAX_RETRIES = "0";
	const cwd = makeProject({ "src.ts": "selected source" });
	try {
		// Sub-test 1: malformed JSON selector output → selector returns [],
		// rephrase still runs (with empty context) and produces a transform.
		{
			const calls: Call[] = [];
			let rephraseCalls = 0;
			const registry = {
				hasConfiguredAuth: () => true,
				complete: async (
					model: unknown,
					context: unknown,
					options?: Call["options"],
				): Promise<Completion> => {
					calls.push({ model, context, options });
					rephraseCalls++;
					if (rephraseCalls === 1) {
						// Selector returns malformed (non-JSON) output.
						return { content: [{ type: "text", text: "not JSON" }] };
					}
					return { content: [{ type: "text", text: "Rephrased request" }] };
				},
			};
			const { handler } = captureHandler();
			const result = await handler(
				{ source: "interactive", text: "request" },
				{
					model: { id: "model" },
					modelRegistry: registry,
					cwd,
					hasUI: false,
				},
			);
			assert.deepEqual(result, { action: "transform", text: "Rephrased request" });
			assert.equal(rephraseCalls, 2);
			// The empty selection means rephrase runs with "(no context files in cwd)".
			assert.match(
				calls[1].context.messages[0].content[0].text,
				/\(no project files selected\)/,
			);
		}

		// Sub-test 2: selector throws → rephrase still succeeds.
		{
			let rephraseCalls = 0;
			const registry = {
				hasConfiguredAuth: () => true,
				complete: async (): Promise<Completion> => {
					rephraseCalls++;
					if (rephraseCalls === 1) throw new Error("selection failed");
					return { content: [{ type: "text", text: "Rephrased request" }] };
				},
			};
			const { handler } = captureHandler();
			const result = await handler(
				{ source: "interactive", text: "request" },
				{
					model: { id: "model" },
					modelRegistry: registry,
					cwd,
					hasUI: false,
				},
			);
			assert.deepEqual(result, { action: "transform", text: "Rephrased request" });
			assert.equal(rephraseCalls, 2);
		}
	} finally {
		cleanup(cwd);
	}
});

test("preserves input gates and rephrase error behavior", async () => {
	clearEnv();
	process.env.PI_REPHRASE_MAX_RETRIES = "0";
	const cwd = makeProject({ "README.md": "context" });
	try {
		const ctx = {
			model: { id: "model" },
			modelRegistry: {
				hasConfiguredAuth: () => true,
				complete: async (): Promise<Completion> => {
					calls++;
					throw new Error("rephrase failed");
				},
			},
			cwd,
			hasUI: false,
		};
		let calls = 0;
		const { handler } = captureHandler();

		assert.deepEqual(
			await handler({ source: "extension", text: "request" }, ctx),
			{ action: "continue" },
		);
		assert.deepEqual(
			await handler(
				{ source: "interactive", streamingBehavior: "steer", text: "request" },
				ctx,
			),
			{ action: "continue" },
		);
		assert.equal(calls, 0);
		assert.deepEqual(
			await handler({ source: "interactive", text: "request" }, ctx),
			{ action: "continue" },
		);
		assert.equal(
			calls,
			2,
			"selector and rephrase calls both run before rephrase failure is reported",
		);
	} finally {
		cleanup(cwd);
	}
});

test("honors user interrupt: passthrough before any LLM call when ctx.signal is already aborted", async () => {
	clearEnv();
	const cwd = makeProject({ "README.md": "context" });
	try {
		let calls = 0;
		const ac = new AbortController();
		ac.abort();
		const registry = {
			hasConfiguredAuth: () => true,
			complete: async (): Promise<Completion> => {
				calls++;
				return { content: [{ type: "text", text: "should not be called" }] };
			},
		};
		const { handler } = captureHandler();
		const result = await handler(
			{ source: "interactive", text: "request" },
			{
				model: { id: "model" },
				modelRegistry: registry,
				cwd,
				hasUI: false,
				signal: ac.signal,
			},
		);
		assert.deepEqual(result, { action: "continue" });
		assert.equal(calls, 0, "no LLM calls when user signal is aborted at entry");
	} finally {
		cleanup(cwd);
	}
});

test("forwards user signal to LLM calls and aborts them on user interrupt mid-flight", async () => {
	clearEnv();
	const cwd = makeProject({ "README.md": "context" });
	try {
		const ac = new AbortController();
		const calls: Array<{ options?: { signal?: AbortSignal } }> = [];
		const registry = {
			hasConfiguredAuth: () => true,
			complete: async (
				_model: unknown,
				_context: unknown,
				options?: { signal?: AbortSignal },
			): Promise<Completion> => {
				calls.push({ options });
				// Abort on the first call (selector) — the handler must
				// propagate that into the linked signal.
				if (calls.length === 1) {
					queueMicrotask(() => ac.abort());
				}
				return { content: [{ type: "text", text: "ok" }] };
			},
		};
		const { handler } = captureHandler();
		const result = await handler(
			{ source: "interactive", text: "request" },
			{
				model: { id: "model" },
				modelRegistry: registry,
				cwd,
				hasUI: false,
				signal: ac.signal,
			},
		);
		// Selector was aborted mid-flight → returned [] → interrupt check
		// before rephrase sees aborted signal → continue silently.
		assert.deepEqual(result, { action: "continue" });
		// Selector received a signal object (linked to user signal).
		assert.ok(calls[0].options?.signal, "selector LLM call received a signal");
		// Rephrase was never invoked because we aborted before it.
		assert.equal(
			calls.length,
			1,
			"rephrase call skipped because user signal aborted before it",
		);
	} finally {
		cleanup(cwd);
	}
});

test("PI_REPHRASE_OFF=1 short-circuits before any LLM call or notification", async () => {
	clearEnv();
	process.env.PI_REPHRASE_OFF = "1";
	try {
		const cwd = makeProject({ "README.md": "context" });
		try {
			let calls = 0;
			let notified = 0;
			const registry = {
				hasConfiguredAuth: () => true,
				complete: async (): Promise<Completion> => {
					calls++;
					return { content: [{ type: "text", text: "should not run" }] };
				},
			};
			const { handler } = captureHandler();
			const result = await handler(
				{ source: "interactive", text: "request" },
				{
					model: { id: "model" },
					modelRegistry: registry,
					cwd,
					hasUI: true,
					ui: { notify: () => notified++ },
				},
			);
			assert.deepEqual(result, { action: "continue" });
			assert.equal(calls, 0, "kill switch stops all LLM work");
			assert.equal(notified, 0, "kill switch skips start notification");
		} finally {
			cleanup(cwd);
		}
	} finally {
		clearEnv();
	}
});

test("feeds recent conversation history into the rephrase prompt", async () => {
	clearEnv();
	const cwd = makeProject({ "README.md": "context" });
	try {
		const calls: Call[] = [];
		const registry = {
			hasConfiguredAuth: () => true,
			complete: async (
				_model: unknown,
				context: unknown,
				options?: Call["options"],
			): Promise<Completion> => {
				calls.push({ model: undefined, context, options });
				if (calls.length === 1) {
					// Selector — pick nothing so the rephrase sees only history.
					return { content: [{ type: "text", text: '{"files":[]}' }] };
				}
				if (calls.length === 2) {
					// Classifier — follow-up, return YES.
					return { content: [{ type: "text", text: "YES" }] };
				}
				return { content: [{ type: "text", text: "Rephrased follow-up" }] };
			},
		};
		const { handler, fireSessionStart, fireMessageEnd } = captureAllHandlers();
		fireSessionStart();
		// Simulate prior conversation: user said something, agent responded.
		fireMessageEnd({ message: userMsg("explain how auth works in this app") });
		fireMessageEnd({
			message: assistantMsg(
				"Auth uses JWT in src/auth.ts and refresh tokens in src/auth-refresh.ts.",
			),
		});

		const result = await handler(
			{ source: "interactive", text: "fix the token expiry bug" },
			{
				model: { id: "model" },
				modelRegistry: registry,
				cwd,
				hasUI: false,
			},
		);

		assert.deepEqual(result, { action: "transform", text: "Rephrased follow-up" });
		assert.equal(calls.length, 3);

		// Selector LLM sees the user's current request.
		assert.match(
			calls[0].context.messages[0].content[0].text,
			/fix the token expiry bug/,
		);

		// Classifier LLM sees prior turns + latest message.
		const classifierMsg = calls[1].context.messages[0].content[0].text;
		assert.match(classifierMsg, /Recent conversation:/);
		assert.match(classifierMsg, /explain how auth works in this app/);
		assert.match(classifierMsg, /Latest message:/);
		assert.match(classifierMsg, /fix the token expiry bug/);

		// Rephrase LLM sees the prior user/assistant turns.
		const rephraseMsg = calls[2].context.messages[0].content[0].text;
		assert.match(rephraseMsg, /Recent conversation \(oldest first\):/);
		assert.match(rephraseMsg, /U: explain how auth works in this app/);
		assert.match(
			rephraseMsg,
			/A: Auth uses JWT in src\/auth\.ts and refresh tokens in src\/auth-refresh\.ts\./,
		);
		assert.match(rephraseMsg, /User request:/);
		const reqIdx = rephraseMsg.indexOf("User request:");
		const inputIdx = rephraseMsg.indexOf("fix the token expiry bug");
		assert.ok(
			reqIdx >= 0 && inputIdx > reqIdx,
			"user request label precedes the input text",
		);
	} finally {
		cleanup(cwd);
	}
});

test("feeds recent tool results into the rephrase prompt", async () => {
	clearEnv();
	const cwd = makeProject({ "README.md": "context" });
	try {
		const calls: Call[] = [];
		const registry = {
			hasConfiguredAuth: () => true,
			complete: async (
				_model: unknown,
				context: unknown,
				options?: Call["options"],
			): Promise<Completion> => {
				calls.push({ model: undefined, context, options });
				if (calls.length === 1) {
					return { content: [{ type: "text", text: '{"files":[]}' }] };
				}
				if (calls.length === 2) {
					// Classifier — heavy depth (buffer > 3 turns would qualify,
					// but only one tool result means tool results still surface).
					return { content: [{ type: "text", text: "YES" }] };
				}
				return { content: [{ type: "text", text: "Rephrased with tool context" }] };
			},
		};
		const { handler, fireSessionStart, fireMessageEnd } = captureAllHandlers();
		fireSessionStart();
		// Last turn ended with a bash tool result the agent saw.
		fireMessageEnd({ message: assistantMsg("ran tests") });
		fireMessageEnd({
			message: toolResultMsg(
				"bash",
				"Tests failed: 2 of 5 in src/auth.test.ts",
			),
		});

		await handler(
			{ source: "interactive", text: "fix the failing tests" },
			{
				model: { id: "model" },
				modelRegistry: registry,
				cwd,
				hasUI: false,
			},
		);

		const rephraseMsg = calls[2].context.messages[0].content[0].text;
		assert.match(rephraseMsg, /Recent tool results:/);
		assert.match(rephraseMsg, /\[bash\]: Tests failed: 2 of 5 in src\/auth\.test\.ts/);
	} finally {
		cleanup(cwd);
	}
});

test("session_start resets the rolling buffer", async () => {
	clearEnv();
	const cwd = makeProject({ "README.md": "context" });
	try {
		const calls: Call[] = [];
		const registry = {
			hasConfiguredAuth: () => true,
			complete: async (
				_model: unknown,
				context: unknown,
				options?: Call["options"],
			): Promise<Completion> => {
				calls.push({ model: undefined, context, options });
				if (calls.length === 1) {
					return { content: [{ type: "text", text: '{"files":[]}' }] };
				}
				return { content: [{ type: "text", text: "Rephrased fresh" }] };
			},
		};
		const { handler, fireSessionStart, fireMessageEnd } = captureAllHandlers();
		fireSessionStart();
		fireMessageEnd({ message: userMsg("stale turn") });
		fireMessageEnd({ message: assistantMsg("stale reply") });

		// New session — buffers wipe.
		fireSessionStart();

		await handler(
			{ source: "interactive", text: "fresh request" },
			{
				model: { id: "model" },
				modelRegistry: registry,
				cwd,
				hasUI: false,
			},
		);

		const rephraseMsg = calls[1].context.messages[0].content[0].text;
		assert.doesNotMatch(rephraseMsg, /stale turn/);
		assert.doesNotMatch(rephraseMsg, /stale reply/);
		assert.match(rephraseMsg, /User request:/);
		const reqIdx = rephraseMsg.indexOf("User request:");
		const inputIdx = rephraseMsg.indexOf("fresh request");
		assert.ok(
			reqIdx >= 0 && inputIdx > reqIdx,
			"user request label precedes the input text",
		);
	} finally {
		cleanup(cwd);
	}
});

test("prior rephrase is NOT injected into the next rephrase (no feedback loop)", async () => {
	clearEnv();
	const cwd = makeProject({ "README.md": "context" });
	try {
		const calls: Call[] = [];
		const registry = {
			hasConfiguredAuth: () => true,
			complete: async (
				_model: unknown,
				context: unknown,
				options?: Call["options"],
			): Promise<Completion> => {
				calls.push({ model: undefined, context, options });
				if (calls.length === 1 || calls.length === 3) {
					return { content: [{ type: "text", text: '{"files":[]}' }] };
				}
				return { content: [{ type: "text", text: "Rephrased again" }] };
			},
		};
		const { handler, fireSessionStart } = captureAllHandlers();
		fireSessionStart();

		await handler(
			{ source: "interactive", text: "first request" },
			{
				model: { id: "model" },
				modelRegistry: registry,
				cwd,
				hasUI: false,
			},
		);

		await handler(
			{ source: "interactive", text: "second request" },
			{
				model: { id: "model" },
				modelRegistry: registry,
				cwd,
				hasUI: false,
			},
		);

		// The second rephrase call must NOT see the first rephrase — that
		// section was removed to prevent a feedback loop where each
		// rephrase is conditioned on the previous one, drifting from user
		// voice across a session.
		const secondRephraseMsg = calls[3].context.messages[0].content[0].text;
		assert.doesNotMatch(
			secondRephraseMsg,
			/Previous rephrase of similar intent:/,
		);
		assert.doesNotMatch(secondRephraseMsg, /Rephrased again/);
	} finally {
		cleanup(cwd);
	}
});

test("classifier says NO → omits conversation section even with prior turns", async () => {
	clearEnv();
	const cwd = makeProject({ "README.md": "context" });
	try {
		const calls: Call[] = [];
		const registry = {
			hasConfiguredAuth: () => true,
			complete: async (
				_model: unknown,
				context: unknown,
				options?: Call["options"],
			): Promise<Completion> => {
				calls.push({ model: undefined, context, options });
				if (calls.length === 1) {
					return { content: [{ type: "text", text: '{"files":[]}' }] };
				}
				if (calls.length === 2) {
					// Classifier — input is self-contained, return NO.
					return { content: [{ type: "text", text: "NO" }] };
				}
				return { content: [{ type: "text", text: "Rephrased fresh" }] };
			},
		};
		const { handler, fireSessionStart, fireMessageEnd } = captureAllHandlers();
		fireSessionStart();
		fireMessageEnd({ message: userMsg("earlier question") });
		fireMessageEnd({ message: assistantMsg("earlier answer") });

		const result = await handler(
			{ source: "interactive", text: "add a new login button" },
			{
				model: { id: "model" },
				modelRegistry: registry,
				cwd,
				hasUI: false,
			},
		);

		assert.deepEqual(result, { action: "transform", text: "Rephrased fresh" });
		assert.equal(calls.length, 3);

		// Classifier got called (buffer has turns).
		assert.match(
			calls[1].context.messages[0].content[0].text,
			/earlier question/,
		);

		// Rephrase sees no Recent conversation section despite prior turns.
		const rephraseMsg = calls[2].context.messages[0].content[0].text;
		assert.doesNotMatch(rephraseMsg, /Recent conversation/);
		assert.doesNotMatch(rephraseMsg, /earlier question/);
		assert.match(rephraseMsg, /User request:/);
	} finally {
		cleanup(cwd);
	}
});

test("classifier says YES with small buffer → includes only recent turns (light)", async () => {
	clearEnv();
	const cwd = makeProject({ "README.md": "context" });
	try {
		const calls: Call[] = [];
		const registry = {
			hasConfiguredAuth: () => true,
			complete: async (
				_model: unknown,
				context: unknown,
				options?: Call["options"],
			): Promise<Completion> => {
				calls.push({ model: undefined, context, options });
				if (calls.length === 1) {
					return { content: [{ type: "text", text: '{"files":[]}' }] };
				}
				if (calls.length === 2) {
					return { content: [{ type: "text", text: "YES" }] };
				}
				return { content: [{ type: "text", text: "Rephrased follow-up" }] };
			},
		};
		const { handler, fireSessionStart, fireMessageEnd } = captureAllHandlers();
		fireSessionStart();
		// Buffer has 2 turns — within light range (<= LIGHT_HISTORY_TURNS + 1 = 3).
		fireMessageEnd({ message: userMsg("what about the old auth flow") });
		fireMessageEnd({ message: assistantMsg("old flow uses sessions") });
		fireMessageEnd({ message: userMsg("ok and the new one") });
		fireMessageEnd({ message: assistantMsg("new flow uses tokens") });

		await handler(
			{ source: "interactive", text: "fix it" },
			{
				model: { id: "model" },
				modelRegistry: registry,
				cwd,
				hasUI: false,
			},
		);

		const rephraseMsg = calls[2].context.messages[0].content[0].text;
		assert.match(rephraseMsg, /Recent conversation \(oldest first\):/);
		// Light depth shows last 2 turns only.
		assert.match(rephraseMsg, /U: ok and the new one/);
		assert.match(rephraseMsg, /A: new flow uses tokens/);
	} finally {
		cleanup(cwd);
	}
});

test("classifier throws → falls back to regex match → includes history", async () => {
	clearEnv();
	process.env.PI_REPHRASE_MAX_RETRIES = "0";
	const cwd = makeProject({ "README.md": "context" });
	try {
		const calls: Call[] = [];
		const registry = {
			hasConfiguredAuth: () => true,
			complete: async (
				_model: unknown,
				context: unknown,
				options?: Call["options"],
			): Promise<Completion> => {
				calls.push({ model: undefined, context, options });
				if (calls.length === 1) {
					return { content: [{ type: "text", text: '{"files":[]}' }] };
				}
				if (calls.length === 2) {
					// Classifier crashes — must not crash the handler.
					throw new Error("classifier down");
				}
				return { content: [{ type: "text", text: "Rephrased fallback" }] };
			},
		};
		const { handler, fireSessionStart, fireMessageEnd } = captureAllHandlers();
		fireSessionStart();
		fireMessageEnd({ message: userMsg("earlier user message") });
		fireMessageEnd({ message: assistantMsg("earlier reply") });

		const result = await handler(
			// Regex matches: "fix that" → include history via fallback.
			{ source: "interactive", text: "fix that too" },
			{
				model: { id: "model" },
				modelRegistry: registry,
				cwd,
				hasUI: false,
			},
		);

		assert.deepEqual(result, { action: "transform", text: "Rephrased fallback" });
		assert.equal(calls.length, 3);
		const rephraseMsg = calls[2].context.messages[0].content[0].text;
		assert.match(rephraseMsg, /Recent conversation \(oldest first\):/);
		assert.match(rephraseMsg, /earlier user message/);
	} finally {
		cleanup(cwd);
	}
});

test("classifier aborts and regex misses → omits conversation", async () => {
	clearEnv();
	process.env.PI_REPHRASE_MAX_RETRIES = "0";
	const cwd = makeProject({ "README.md": "context" });
	try {
		const calls: Call[] = [];
		const registry = {
			hasConfiguredAuth: () => true,
			complete: async (
				_model: unknown,
				context: unknown,
				options?: Call["options"],
			): Promise<Completion> => {
				calls.push({ model: undefined, context, options });
				if (calls.length === 1) {
					return { content: [{ type: "text", text: '{"files":[]}' }] };
				}
				if (calls.length === 2) {
					// Classifier times out (stopReason = "aborted").
					return { content: [], stopReason: "aborted" };
				}
				return { content: [{ type: "text", text: "Rephrased clean" }] };
			},
		};
		const { handler, fireSessionStart, fireMessageEnd } = captureAllHandlers();
		fireSessionStart();
		fireMessageEnd({ message: userMsg("prior turn") });
		fireMessageEnd({ message: assistantMsg("prior reply") });

		const result = await handler(
			// Input is self-contained, no follow-up signal.
			{ source: "interactive", text: "add a new endpoint" },
			{
				model: { id: "model" },
				modelRegistry: registry,
				cwd,
				hasUI: false,
			},
		);

		assert.deepEqual(result, { action: "transform", text: "Rephrased clean" });
		assert.equal(calls.length, 3);
		const rephraseMsg = calls[2].context.messages[0].content[0].text;
		assert.doesNotMatch(rephraseMsg, /Recent conversation/);
		assert.doesNotMatch(rephraseMsg, /prior turn/);
	} finally {
		cleanup(cwd);
	}
});

test("classifier is invoked on every input — no broken cache", async () => {
	clearEnv();
	const cwd = makeProject({ "README.md": "context" });
	try {
		const calls: Call[] = [];
		const registry = {
			hasConfiguredAuth: () => true,
			complete: async (
				_model: unknown,
				context: unknown,
				options?: Call["options"],
			): Promise<Completion> => {
				calls.push({ model: undefined, context, options });
				if (calls.length === 1 || calls.length === 3 || calls.length === 5) {
					return { content: [{ type: "text", text: '{"files":[]}' }] };
				}
				if (calls.length === 2 || calls.length === 4) {
					// Classifier invoked once per input (cache was removed).
					return { content: [{ type: "text", text: "YES" }] };
				}
				return { content: [{ type: "text", text: "Rephrased again" }] };
			},
		};
		const { handler, fireSessionStart, fireMessageEnd } = captureAllHandlers();
		fireSessionStart();
		fireMessageEnd({ message: userMsg("shared turn") });
		fireMessageEnd({ message: assistantMsg("shared reply") });

		// First invocation: selector (1), classifier (2), rephrase (3).
		await handler(
			{ source: "interactive", text: "fix that" },
			{
				model: { id: "model" },
				modelRegistry: registry,
				cwd,
				hasUI: false,
			},
		);

		// Second invocation: classifier is invoked again — the old cache
		// (keyed on input text + buffer snapshot) almost never hit in
		// normal use because each input changes the buffer or the text.
		await handler(
			{ source: "interactive", text: "fix that" },
			{
				model: { id: "model" },
				modelRegistry: registry,
				cwd,
				hasUI: false,
			},
		);

		// 1 (sel) + 1 (clf) + 1 (rephrase) + 1 (sel) + 1 (clf) + 1 (rephrase) = 6.
		assert.equal(calls.length, 6);
	} finally {
		cleanup(cwd);
	}
});

test("empty buffer skips classifier LLM call entirely", async () => {
	clearEnv();
	const cwd = makeProject({ "README.md": "context" });
	try {
		const calls: Call[] = [];
		const registry = {
			hasConfiguredAuth: () => true,
			complete: async (
				_model: unknown,
				context: unknown,
				options?: Call["options"],
			): Promise<Completion> => {
				calls.push({ model: undefined, context, options });
				if (calls.length === 1) {
					return { content: [{ type: "text", text: '{"files":[]}' }] };
				}
				return { content: [{ type: "text", text: "Rephrased fresh" }] };
			},
		};
		const { handler, fireSessionStart } = captureAllHandlers();
		fireSessionStart();
		// No turns recorded — buffer is empty.

		await handler(
			{ source: "interactive", text: "first request ever" },
			{
				model: { id: "model" },
				modelRegistry: registry,
				cwd,
				hasUI: false,
			},
		);

		// Only selector + rephrase; classifier short-circuited to false.
		assert.equal(calls.length, 2);
		assert.equal(calls[1].context.messages[0].content[0].text.includes("Recent conversation"), false);
	} finally {
		cleanup(cwd);
	}
});

test("selector retries on transient failure and succeeds", async () => {
	clearEnv();
	const cwd = makeProject({ "src/x.ts": "x context" });
	try {
		const calls: Call[] = [];
		const registry = {
			hasConfiguredAuth: () => true,
			complete: async (
				_model: unknown,
				context: unknown,
				options?: Call["options"],
			): Promise<Completion> => {
				calls.push({ model: undefined, context, options });
				if (calls.length === 1) {
					// Selector attempt 1: transient network failure.
					throw new Error("connection reset");
				}
				if (calls.length === 2) {
					// Selector attempt 2 (retry): succeeds.
					return {
						content: [
							{ type: "text", text: '{"files":["src/x.ts"]}' },
						],
					};
				}
				return { content: [{ type: "text", text: "Rephrased after retry" }] };
			},
		};
		const { handler } = captureHandler();
		const result = await handler(
			{ source: "interactive", text: "review src/x.ts" },
			{
				model: { id: "model" },
				modelRegistry: registry,
				cwd,
				hasUI: false,
			},
		);

		assert.deepEqual(result, { action: "transform", text: "Rephrased after retry" });
		// 2 selector attempts + 1 rephrase.
		assert.equal(calls.length, 3);

		// Rephrase sees the file selected by the successful selector attempt.
		const rephraseMsg = calls[2].context.messages[0].content[0].text;
		assert.match(rephraseMsg, /### src\/x\.ts/);
	} finally {
		cleanup(cwd);
	}
});

test("rephrase retries on transient failure and succeeds", async () => {
	clearEnv();
	const cwd = makeProject({ "README.md": "context" });
	try {
		const calls: Call[] = [];
		const registry = {
			hasConfiguredAuth: () => true,
			complete: async (
				_model: unknown,
				context: unknown,
				options?: Call["options"],
			): Promise<Completion> => {
				calls.push({ model: undefined, context, options });
				if (calls.length === 1) {
					return { content: [{ type: "text", text: '{"files":[]}' }] };
				}
				if (calls.length === 2) {
					// Rephrase attempt 1: transient failure.
					throw new Error("network blip");
				}
				// Rephrase attempt 2 (retry): succeeds.
				return { content: [{ type: "text", text: "Rephrased on retry" }] };
			},
		};
		const { handler } = captureHandler();
		const result = await handler(
			{ source: "interactive", text: "fix the thing" },
			{
				model: { id: "model" },
				modelRegistry: registry,
				cwd,
				hasUI: false,
			},
		);

		assert.deepEqual(result, { action: "transform", text: "Rephrased on retry" });
		// 1 selector + 2 rephrase attempts.
		assert.equal(calls.length, 3);
	} finally {
		cleanup(cwd);
	}
});

test("rephrase exhausts retries → falls back to original input", async () => {
	clearEnv();
	const cwd = makeProject({ "README.md": "context" });
	try {
		let rephraseCalls = 0;
		const registry = {
			hasConfiguredAuth: () => true,
			complete: async (): Promise<Completion> => {
				rephraseCalls++;
				if (rephraseCalls === 1) {
					return { content: [{ type: "text", text: '{"files":[]}' }] };
				}
				// All rephrase attempts fail.
				throw new Error("rephrase persistently broken");
			},
		};
		const { handler } = captureHandler();
		const result = await handler(
			{ source: "interactive", text: "do the thing" },
			{
				model: { id: "model" },
				modelRegistry: registry,
				cwd,
				hasUI: false,
			},
		);

		// Original input passes through unchanged.
		assert.deepEqual(result, { action: "continue" });
		// 1 selector + 3 rephrase attempts (initial + 2 retries).
		assert.equal(rephraseCalls, 4);
	} finally {
		cleanup(cwd);
	}
});

test("PI_REPHRASE_MAX_RETRIES=0 disables retries", async () => {
	clearEnv();
	process.env.PI_REPHRASE_MAX_RETRIES = "0";
	const cwd = makeProject({ "README.md": "context" });
	try {
		let rephraseCalls = 0;
		const registry = {
			hasConfiguredAuth: () => true,
			complete: async (): Promise<Completion> => {
				rephraseCalls++;
				if (rephraseCalls === 1) {
					// Selector throws — but no retry allowed.
					throw new Error("transient");
				}
				return { content: [{ type: "text", text: "Rephrased" }] };
			},
		};
		const { handler } = captureHandler();
		const result = await handler(
			{ source: "interactive", text: "do it" },
			{
				model: { id: "model" },
				modelRegistry: registry,
				cwd,
				hasUI: false,
			},
		);

		assert.deepEqual(result, { action: "transform", text: "Rephrased" });
		// 1 selector (no retry) + 1 rephrase.
		assert.equal(rephraseCalls, 2);
	} finally {
		cleanup(cwd);
	}
});

test("PI_REPHRASE_DEBUG=1 logs retry attempts to stderr", async () => {
	clearEnv();
	process.env.PI_REPHRASE_DEBUG = "1";
	const cwd = makeProject({ "README.md": "context" });
	try {
		const registry = {
			hasConfiguredAuth: () => true,
			complete: async (
				_model: unknown,
				_context: unknown,
				options?: { signal?: AbortSignal },
			): Promise<Completion> => {
				if (options?.signal?.aborted) {
					return { content: [], stopReason: "aborted" };
				}
				// Selector throws once, then succeeds.
				const c = (registry as { callCount?: number }).callCount ?? 0;
				(registry as { callCount?: number }).callCount = c + 1;
				if (c === 0) throw new Error("transient");
				if (c === 1) return { content: [{ type: "text", text: '{"files":[]}' }] };
				return { content: [{ type: "text", text: "Rephrased" }] };
			},
		};
		const writes: string[] = [];
		const origWrite = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: string | Uint8Array): boolean => {
			writes.push(typeof chunk === "string" ? chunk : chunk.toString());
			return true;
		}) as typeof process.stderr.write;
		const { handler } = captureHandler();
		try {
			await handler(
				{ source: "interactive", text: "go" },
				{
					model: { id: "model" },
					modelRegistry: registry,
					cwd,
					hasUI: false,
				},
			);
		} finally {
			process.stderr.write = origWrite;
		}

		assert.ok(
			writes.some((w) => w.includes("[rephrase-retry] selector")),
			"expected a retry log line for the selector",
		);
		assert.ok(
			writes.some((w) => w.includes("attempt 1/3")),
			"expected the attempt counter in the log",
		);
	} finally {
		cleanup(cwd);
	}
});

test("classifier retries on transient failure and succeeds", async () => {
	clearEnv();
	const cwd = makeProject({ "README.md": "context" });
	try {
		const calls: Call[] = [];
		const registry = {
			hasConfiguredAuth: () => true,
			complete: async (
				_model: unknown,
				context: unknown,
				options?: Call["options"],
			): Promise<Completion> => {
				calls.push({ model: undefined, context, options });
				if (calls.length === 1) {
					return { content: [{ type: "text", text: '{"files":[]}' }] };
				}
				if (calls.length === 2) {
					// Classifier attempt 1: transient failure.
					throw new Error("classifier network blip");
				}
				if (calls.length === 3) {
					// Classifier attempt 2 (retry): returns YES.
					return { content: [{ type: "text", text: "YES" }] };
				}
				return { content: [{ type: "text", text: "Rephrased with history" }] };
			},
		};
		const { handler, fireSessionStart, fireMessageEnd } = captureAllHandlers();
		fireSessionStart();
		fireMessageEnd({ message: userMsg("previous user message") });
		fireMessageEnd({ message: assistantMsg("previous reply") });

		const result = await handler(
			{ source: "interactive", text: "fix that" },
			{
				model: { id: "model" },
				modelRegistry: registry,
				cwd,
				hasUI: false,
			},
		);

		assert.deepEqual(result, { action: "transform", text: "Rephrased with history" });
		// 1 selector + 2 classifier + 1 rephrase.
		assert.equal(calls.length, 4);

		// Rephrase sees the conversation (classifier YES on retry → light depth).
		const rephraseMsg = calls[3].context.messages[0].content[0].text;
		assert.match(rephraseMsg, /Recent conversation \(oldest first\):/);
		assert.match(rephraseMsg, /previous user message/);
	} finally {
		cleanup(cwd);
	}
});

// ──────────────────────────────────────────────────────────────────────
// P0 correctness regressions — high-severity failure modes
// ──────────────────────────────────────────────────────────────────────

test("buffer holds original user text after transform, not rephrased text (real Pi shape)", async () => {
	clearEnv();
	const cwd = makeProject({ "README.md": "context" });
	try {
		const calls: Call[] = [];
		const registry = {
			hasConfiguredAuth: () => true,
			complete: async (_m: unknown, context: unknown) => {
				calls.push({ model: undefined, context, options: undefined });
				if (calls.length === 1) return { content: [{ type: "text", text: '{"files":[]}' }] };
				if (calls.length === 2) return { content: [{ type: "text", text: "VERBOSE_REPHRASE_OF_ORIGINAL" }] };
				if (calls.length === 3) return { content: [{ type: "text", text: "YES" }] }; // classifier
				return { content: [{ type: "text", text: "second" }] };
			},
		};
		const { handler, fireSessionStart, fireMessageEnd } = captureAllHandlers();
		fireSessionStart();

		// Pin a timestamp the extension will use as both its captured
		// timestamp (Date.now() at input time) and as the user-message
		// timestamp on message_end. Real Pi would assign the timestamp
		// at the same `prompt()` boundary.
		const pinnedTs = Date.now();

		// First input: original is short, terse.
		await handler(
			{ source: "interactive", text: "fix the auth bug" },
			{ model: { id: "m" }, modelRegistry: registry, cwd, hasUI: false },
		);

		// Real Pi flow: message_end fires for the user message with the
		// rephrased text in `content`. The extension's timestamp capture
		// happened within the same millisecond, so it must look up the
		// original via the originalsByTimestamp map and ignore the
		// rephrased content.
		fireMessageEnd({
			message: userMsg("VERBOSE_REPHRASE_OF_ORIGINAL", pinnedTs),
		});

		// Second input. Buffer should hold the original.
		await handler(
			{ source: "interactive", text: "and the test too" },
			{ model: { id: "m" }, modelRegistry: registry, cwd, hasUI: false },
		);

		const secondRephrase = calls[4].context.messages[0].content[0].text;
		assert.match(secondRephrase, /U: fix the auth bug/);
		assert.doesNotMatch(secondRephrase, /U: VERBOSE_REPHRASE_OF_ORIGINAL/);
	} finally {
		cleanup(cwd);
	}
});

test("@file references short-circuit before any LLM call", async () => {
	clearEnv();
	const cwd = makeProject({ "src/foo.ts": "content" });
	try {
		let calls = 0;
		const registry = {
			hasConfiguredAuth: () => true,
			complete: async () => {
				calls++;
				return { content: [{ type: "text", text: "should not run" }] };
			},
		};
		const { handler } = captureHandler();
		const result = await handler(
			{ source: "interactive", text: "explain @src/foo.ts" },
			{ model: { id: "m" }, modelRegistry: registry, cwd, hasUI: false },
		);
		assert.deepEqual(result, { action: "continue" });
		assert.equal(calls, 0, "@file short-circuit must skip all LLM calls");
	} finally {
		cleanup(cwd);
	}
});

test("/cmd-like text short-circuits before any LLM call", async () => {
	clearEnv();
	const cwd = makeProject({ "src/foo.ts": "content" });
	try {
		let calls = 0;
		const registry = {
			hasConfiguredAuth: () => true,
			complete: async () => {
				calls++;
				return { content: [{ type: "text", text: "x" }] };
			},
		};
		const { handler } = captureHandler();
		const result = await handler(
			{ source: "interactive", text: "/foo bar" },
			{ model: { id: "m" }, modelRegistry: registry, cwd, hasUI: false },
		);
		assert.deepEqual(result, { action: "continue" });
		assert.equal(calls, 0);
	} finally {
		cleanup(cwd);
	}
});

test("source: rpc short-circuits without LLM calls", async () => {
	clearEnv();
	const cwd = makeProject({});
	try {
		let calls = 0;
		const registry = {
			hasConfiguredAuth: () => true,
			complete: async () => {
				calls++;
				return { content: [{ type: "text", text: "x" }] };
			},
		};
		const { handler } = captureHandler();
		const result = await handler(
			{ source: "rpc", text: "build and test the project" },
			{ model: { id: "m" }, modelRegistry: registry, cwd, hasUI: false },
		);
		assert.deepEqual(result, { action: "continue" });
		assert.equal(calls, 0);
	} finally {
		cleanup(cwd);
	}
});

test("streamingBehavior: followUp short-circuits without LLM calls", async () => {
	clearEnv();
	const cwd = makeProject({});
	try {
		let calls = 0;
		const registry = {
			hasConfiguredAuth: () => true,
			complete: async () => {
				calls++;
				return { content: [{ type: "text", text: "x" }] };
			},
		};
		const { handler } = captureHandler();
		const result = await handler(
			{ source: "interactive", streamingBehavior: "followUp", text: "and also do X" },
			{ model: { id: "m" }, modelRegistry: registry, cwd, hasUI: false },
		);
		assert.deepEqual(result, { action: "continue" });
		assert.equal(calls, 0);
	} finally {
		cleanup(cwd);
	}
});

test("empty / whitespace-only input short-circuits without LLM calls", async () => {
	clearEnv();
	const cwd = makeProject({});
	try {
		let calls = 0;
		const registry = {
			hasConfiguredAuth: () => true,
			complete: async () => {
				calls++;
				return { content: [{ type: "text", text: "x" }] };
			},
		};
		const { handler } = captureHandler();
		for (const text of ["", "   ", "\n\n", "\t"]) {
			const result = await handler(
				{ source: "interactive", text },
				{ model: { id: "m" }, modelRegistry: registry, cwd, hasUI: false },
			);
			assert.deepEqual(result, { action: "continue" }, `text=${JSON.stringify(text)}`);
		}
		assert.equal(calls, 0);
	} finally {
		cleanup(cwd);
	}
});

test("notification ordering: no Rephrasing… when model is absent", async () => {
	clearEnv();
	const cwd = makeProject({});
	try {
		const messages: string[] = [];
		const { handler } = captureHandler();
		await handler(
			{ source: "interactive", text: "do thing" },
			{
				model: undefined,
				modelRegistry: {
					hasConfiguredAuth: () => false,
					complete: async () => ({ content: [{ type: "text", text: "x" }] }),
				},
				cwd,
				hasUI: true,
				ui: { notify: (m: string) => messages.push(m) },
			},
		);
		assert.equal(messages.length, 0, "no notification when there is no model");
	} finally {
		cleanup(cwd);
	}
});

test("notification ordering: no Rephrase skipped on benign selector-empty", async () => {
	clearEnv();
	const cwd = makeProject({ "README.md": "x" });
	try {
		const messages: string[] = [];
		const registry = {
			hasConfiguredAuth: () => true,
			// Selector returns empty; rephrase still runs successfully.
			complete: async () => ({ content: [{ type: "text", text: '{"files":[]}' }] }),
		};
		const { handler } = captureAllHandlers();
		// First call: selector (empty). Second: rephrase (succeeds).
		let n = 0;
		const r2 = {
			hasConfiguredAuth: () => true,
			complete: async () => {
				n++;
				if (n === 1) return { content: [{ type: "text", text: '{"files":[]}' }] };
				return { content: [{ type: "text", text: "Rephrased" }] };
			},
		};
		await handler(
			{ source: "interactive", text: "do thing" },
			{
				model: { id: "m" },
				modelRegistry: r2,
				cwd,
				hasUI: true,
				ui: { notify: (m: string) => messages.push(m) },
			},
		);
		assert.ok(messages.some((m) => m.startsWith("Rephrasing")), "Rephrasing… fires");
		assert.ok(
			!messages.some((m) => m.toLowerCase().includes("skipped")),
			"no skipped notification for benign selector-empty",
		);
	} finally {
		cleanup(cwd);
	}
});

test("empty cwd does not crash and falls back to no-context rephrase", async () => {
	clearEnv();
	const cwd = makeProject({});
	try {
		const calls: Call[] = [];
		const registry = {
			hasConfiguredAuth: () => true,
			complete: async (_m: unknown, context: unknown) => {
				calls.push({ model: undefined, context, options: undefined });
				// Empty inventory in selector means no LLM call there —
				// rephrase is the only call.
				return { content: [{ type: "text", text: "Rephrased" }] };
			},
		};
		const { handler } = captureHandler();
		const result = await handler(
			{ source: "interactive", text: "do thing" },
			{ model: { id: "m" }, modelRegistry: registry, cwd, hasUI: false },
		);
		assert.deepEqual(result, { action: "transform", text: "Rephrased" });
		// Only one LLM call: the rephrase. The selector was short-circuited.
		assert.equal(calls.length, 1);
		const rephraseMsg = calls[0].context.messages[0].content[0].text;
		assert.match(rephraseMsg, /\(no project files selected\)/);
		assert.match(rephraseMsg, /do thing/);
	} finally {
		cleanup(cwd);
	}
});

test("huge file (within size cap) is truncated to MAX_FILE_CHARS in rephrase context", async () => {
	clearEnv();
	const bigContent = "x".repeat(50_000); // 50KB, well under 200KB cap
	const cwd = makeProject({ "src/big.ts": bigContent });
	try {
		const calls: Call[] = [];
		const registry = {
			hasConfiguredAuth: () => true,
			complete: async (_m: unknown, context: unknown) => {
				calls.push({ model: undefined, context, options: undefined });
				if (calls.length === 1) {
					return { content: [{ type: "text", text: '{"files":["src/big.ts"]}' }] };
				}
				return { content: [{ type: "text", text: "Rephrased" }] };
			},
		};
		const { handler } = captureHandler();
		await handler(
			{ source: "interactive", text: "review big file" },
			{ model: { id: "m" }, modelRegistry: registry, cwd, hasUI: false },
		);
		const rephraseMsg = calls[1].context.messages[0].content[0].text;
		assert.match(rephraseMsg, /### src\/big\.ts/);
		assert.match(rephraseMsg, /…\[truncated\]/);
		// Block size: header + truncated body. Must be well under 50k chars.
		assert.ok(rephraseMsg.length < 5_000, "truncated block is small");
	} finally {
		cleanup(cwd);
	}
});

test("real Pi message shape is captured into the buffer (array-form content)", async () => {
	clearEnv();
	const cwd = makeProject({ "README.md": "x" });
	try {
		const calls: Call[] = [];
		const registry = {
			hasConfiguredAuth: () => true,
			complete: async (_m: unknown, context: unknown) => {
				calls.push({ model: undefined, context, options: undefined });
				if (calls.length === 1) return { content: [{ type: "text", text: '{"files":[]}' }] };
				if (calls.length === 2) return { content: [{ type: "text", text: "YES" }] }; // classifier
				return { content: [{ type: "text", text: "r" }] };
			},
		};
		const { handler, fireSessionStart, fireMessageEnd } = captureAllHandlers();
		fireSessionStart();
		fireMessageEnd({
			message: userMsg("real-shape user text"),
		});
		await handler(
			{ source: "interactive", text: "next" },
			{ model: { id: "m" }, modelRegistry: registry, cwd, hasUI: false },
		);
		const rephraseMsg = calls[2].context.messages[0].content[0].text;
		assert.match(rephraseMsg, /U: real-shape user text/);
	} finally {
		cleanup(cwd);
	}
});

test("selector prompt forbids adding unrequested context (no find-docs reminder)", async () => {
	clearEnv();
	const cwd = makeProject({ "README.md": "context" });
	try {
		const calls: Call[] = [];
		const registry = {
			hasConfiguredAuth: () => true,
			complete: async (
				_m: unknown,
				context: unknown,
				_options?: Call["options"],
			): Promise<Completion> => {
				calls.push({ model: undefined, context, options: undefined });
				if (calls.length === 1) return { content: [{ type: "text", text: '{"files":[]}' }] };
				return { content: [{ type: "text", text: "Rephrased" }] };
			},
		};
		const { handler } = captureHandler();
		await handler(
			{ source: "interactive", text: "build a thing with express" },
			{ model: { id: "m" }, modelRegistry: registry, cwd, hasUI: false },
		);
		// Rephrase system prompt must NOT inject the `find-docs` reminder.
		const rephrasePrompt = calls[1].context.systemPrompt;
		assert.doesNotMatch(rephrasePrompt, /Refresh current docs/i);
		// And must not ask the model to flag AGENTS.md conflicts unilaterally.
		assert.doesNotMatch(rephrasePrompt, /append a one-line note flagging the conflict/i);
	} finally {
		cleanup(cwd);
	}
});

test("selector prompt has hard caps on manifests and instructions files", async () => {
	clearEnv();
	const cwd = makeProject({ "README.md": "context" });
	try {
		const calls: Call[] = [];
		const registry = {
			hasConfiguredAuth: () => true,
			complete: async (
				_m: unknown,
				context: unknown,
				_options?: Call["options"],
			): Promise<Completion> => {
				calls.push({ model: undefined, context, options: undefined });
				if (calls.length === 1) return { content: [{ type: "text", text: '{"files":[]}' }] };
				return { content: [{ type: "text", text: "Rephrased" }] };
			},
		};
		const { handler } = captureHandler();
		await handler(
			{ source: "interactive", text: "review the auth flow" },
			{ model: { id: "m" }, modelRegistry: registry, cwd, hasUI: false },
		);
		const selectorPrompt = calls[0].context.systemPrompt;
		assert.match(selectorPrompt, /at most 1 manifest/i);
		assert.match(selectorPrompt, /at most 1 instructions/i);
	} finally {
		cleanup(cwd);
	}
});

test("inventory lines do not include file sizes (avoid big-file bias)", async () => {
	clearEnv();
	const cwd = makeProject({
		"small.ts": "tiny",
		"src/big.ts": "x".repeat(20_000),
		"package.json": "{}",
		"README.md": "readme",
		"AGENTS.md": "agents",
	});
	try {
		const calls: Call[] = [];
		const registry = {
			hasConfiguredAuth: () => true,
			complete: async (
				_m: unknown,
				context: unknown,
				_options?: Call["options"],
			): Promise<Completion> => {
				calls.push({ model: undefined, context, options: undefined });
				if (calls.length === 1) return { content: [{ type: "text", text: '{"files":[]}' }] };
				return { content: [{ type: "text", text: "Rephrased" }] };
			},
		};
		const { handler } = captureHandler();
		await handler(
			{ source: "interactive", text: "review" },
			{ model: { id: "m" }, modelRegistry: registry, cwd, hasUI: false },
		);
		const inventoryText = calls[0].context.messages[0].content[0].text;
		assert.match(inventoryText, /- src\/big\.ts/);
		assert.doesNotMatch(inventoryText, /bytes/);
	} finally {
		cleanup(cwd);
	}
});

test("rephrase fails (timeout) → debug log emitted, no skipped notification", async () => {
	clearEnv();
	process.env.PI_REPHRASE_DEBUG = "1";
	process.env.PI_REPHRASE_MAX_RETRIES = "0";
	const cwd = makeProject({ "README.md": "context" });
	try {
		const writes: string[] = [];
		const origWrite = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: string | Uint8Array): boolean => {
			writes.push(typeof chunk === "string" ? chunk : chunk.toString());
			return true;
		}) as typeof process.stderr.write;
		const messages: string[] = [];
		const registry = {
			hasConfiguredAuth: () => true,
			complete: async () => {
				throw new Error("rephrase down");
			},
		};
		try {
			const { handler } = captureHandler();
			const result = await handler(
				{ source: "interactive", text: "do thing" },
				{
					model: { id: "m" },
					modelRegistry: registry,
					cwd,
					hasUI: true,
					ui: { notify: (m: string) => messages.push(m) },
				},
			);
			assert.deepEqual(result, { action: "continue" });
			// Rephrasing… fires (we got past the gates), but no "skipped".
			assert.ok(messages.some((m) => m.startsWith("Rephrasing")));
			assert.ok(!messages.some((m) => m.toLowerCase().includes("skipped")));
			// Debug log captures the failure.
			assert.ok(writes.some((w) => w.includes("[rephrase-skip]")));
		} finally {
			process.stderr.write = origWrite;
		}
	} finally {
		cleanup(cwd);
	}
});

test("huge repo (many candidate files) caps at MAX_CONTEXT_CANDIDATES without crash", async () => {
	clearEnv();
	const cwd = makeProject({});
	try {
		// Create > 500 files to trigger the cap.
		const files: Record<string, string> = {};
		for (let i = 0; i < 600; i++) {
			files[`src/file-${i.toString().padStart(4, "0")}.ts`] = `export const v${i} = ${i};`;
		}
		for (const [p, c] of Object.entries(files)) {
			const path = join(cwd, p);
			const parent = path.slice(0, path.lastIndexOf("/"));
			mkdirSync(parent, { recursive: true });
			writeFileSync(path, c);
		}
		const registry = {
			hasConfiguredAuth: () => true,
			complete: async () => ({ content: [{ type: "text", text: "Rephrased" }] }),
		};
		const { handler } = captureHandler();
		const result = await handler(
			{ source: "interactive", text: "review the project" },
			{ model: { id: "m" }, modelRegistry: registry, cwd, hasUI: false },
		);
		assert.deepEqual(result, { action: "transform", text: "Rephrased" });
	} finally {
		cleanup(cwd);
	}
});

test("sensitive filenames are excluded from inventory and from any loaded context", async () => {
	clearEnv();
	const cwd = makeProject({
		"src/feature.ts": "feature content",
		".env": "SECRET=do-not-read",
		"auth.json": '{"api_key":"abc"}',
		"private-key.pem": "-----BEGIN PRIVATE KEY-----",
	});
	try {
		const calls: Call[] = [];
		const registry = {
			hasConfiguredAuth: () => true,
			complete: async (
				_m: unknown,
				context: unknown,
				_options?: Call["options"],
			): Promise<Completion> => {
				calls.push({ model: undefined, context, options: undefined });
				if (calls.length === 1) {
					// Try to load sensitive files — must be filtered out.
					return {
						content: [
							{
								type: "text",
								text: '{"files":["src/feature.ts",".env","auth.json","private-key.pem"]}',
							},
						],
					};
				}
				return { content: [{ type: "text", text: "Rephrased" }] };
			},
		};
		const { handler } = captureHandler();
		await handler(
			{ source: "interactive", text: "review" },
			{ model: { id: "m" }, modelRegistry: registry, cwd, hasUI: false },
		);
		// Selector inventory must not list sensitive files.
		const inv = calls[0].context.messages[0].content[0].text;
		assert.doesNotMatch(inv, /\.env\b/);
		assert.doesNotMatch(inv, /auth\.json/);
		assert.doesNotMatch(inv, /private-key/);
		// Rephrase context must not include sensitive content even if
		// the selector (wrongly) tried to pick them.
		const rephrase = calls[1].context.messages[0].content[0].text;
		assert.match(rephrase, /### src\/feature\.ts/);
		assert.doesNotMatch(rephrase, /SECRET=do-not-read/);
		assert.doesNotMatch(rephrase, /api_key/);
		assert.doesNotMatch(rephrase, /BEGIN PRIVATE KEY/);
	} finally {
		cleanup(cwd);
	}
});

test("binary files are excluded from the selector inventory", async () => {
	clearEnv();
	const cwd = makeProject({
		"src/feature.ts": "feature",
		"image.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]),
		"binary.dat": new Uint8Array([0, 1, 2, 3]),
	});
	try {
		const calls: Call[] = [];
		const registry = {
			hasConfiguredAuth: () => true,
			complete: async (
				_m: unknown,
				context: unknown,
				_options?: Call["options"],
			): Promise<Completion> => {
				calls.push({ model: undefined, context, options: undefined });
				if (calls.length === 1) return { content: [{ type: "text", text: '{"files":[]}' }] };
				return { content: [{ type: "text", text: "Rephrased" }] };
			},
		};
		const { handler } = captureHandler();
		await handler(
			{ source: "interactive", text: "review" },
			{ model: { id: "m" }, modelRegistry: registry, cwd, hasUI: false },
		);
		const inv = calls[0].context.messages[0].content[0].text;
		assert.match(inv, /src\/feature\.ts/);
		assert.doesNotMatch(inv, /image\.png/);
		assert.doesNotMatch(inv, /binary\.dat/);
	} finally {
		cleanup(cwd);
	}
});

test("PI_REPHRASE_OFF short-circuits BEFORE the model/auth check", async () => {
	clearEnv();
	process.env.PI_REPHRASE_OFF = "1";
	const cwd = makeProject({});
	try {
		let notified = 0;
		const { handler } = captureHandler();
		const result = await handler(
			{ source: "interactive", text: "@file /cmd whatever" },
			{
				model: undefined,
				modelRegistry: {
					hasConfiguredAuth: () => false,
					complete: async () => ({ content: [{ type: "text", text: "x" }] }),
				},
				cwd,
				hasUI: true,
				ui: { notify: () => notified++ },
			},
		);
		assert.deepEqual(result, { action: "continue" });
		assert.equal(notified, 0);
	} finally {
		cleanup(cwd);
	}
});
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import rephraseInput from "./pi-rephrase-input.ts";

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
 * (session_start, turn_end, message_end) so tests can drive the rolling
 * context buffer.
 */
function captureAllHandlers(): {
	handler: (event: any, context: any) => Promise<unknown>;
	fireSessionStart: () => void;
	fireTurnEnd: (event: any) => void;
	fireMessageEnd: (event: any) => void;
} {
	const captured: {
		handler?: (event: any, context: any) => Promise<unknown>;
		sessionStart?: () => void;
		turnEnd?: (event: any) => void;
		messageEnd?: (event: any) => void;
	} = {};
	rephraseInput({
		on: (event: string, registered: (e: any, c?: any) => Promise<unknown> | unknown) => {
			if (event === "session_start")
				captured.sessionStart = () => {
					(registered as () => unknown)();
				};
			else if (event === "turn_end")
				captured.turnEnd = (e: any) => {
					void (registered as (e: any) => Promise<unknown>)(e);
				};
			else if (event === "message_end")
				captured.messageEnd = (e: any) => {
					void (registered as (e: any) => Promise<unknown>)(e);
				};
			else captured.handler = registered as (event: any, context: any) => Promise<unknown>;
		},
	} as any);
	if (!captured.handler) throw new Error("input handler not registered");
	if (!captured.sessionStart || !captured.turnEnd || !captured.messageEnd)
		throw new Error("lifecycle handlers not registered");
	return {
		handler: captured.handler,
		fireSessionStart: captured.sessionStart,
		fireTurnEnd: captured.turnEnd,
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
				return { content: [{ type: "text", text: "Rephrased follow-up" }] };
			},
		};
		const { handler, fireSessionStart, fireMessageEnd, fireTurnEnd } = captureAllHandlers();
		fireSessionStart();
		// Simulate prior conversation: user said something, agent responded.
		fireMessageEnd({
			message: { role: "user", text: "explain how auth works in this app" },
		});
		fireTurnEnd({
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Auth uses JWT in src/auth.ts and refresh tokens in src/auth-refresh.ts." }],
			},
			toolResults: [],
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
		assert.equal(calls.length, 2);

		// Selector LLM sees the user's current request.
		assert.match(
			calls[0].context.messages[0].content[0].text,
			/fix the token expiry bug/,
		);

		// Rephrase LLM sees the prior user/assistant turns.
		const rephraseMsg = calls[1].context.messages[0].content[0].text;
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
				return { content: [{ type: "text", text: "Rephrased with tool context" }] };
			},
		};
		const { handler, fireSessionStart, fireTurnEnd } = captureAllHandlers();
		fireSessionStart();
		// Last turn ended with a bash tool result the agent saw.
		fireTurnEnd({
			message: { role: "assistant", content: [{ type: "text", text: "ran tests" }] },
			toolResults: [
				{
					toolName: "bash",
					content: [{ type: "text", text: "Tests failed: 2 of 5 in src/auth.test.ts" }],
				},
			],
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

		const rephraseMsg = calls[1].context.messages[0].content[0].text;
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
		const { handler, fireSessionStart, fireMessageEnd, fireTurnEnd } = captureAllHandlers();
		fireSessionStart();
		fireMessageEnd({ message: { role: "user", text: "stale turn" } });
		fireTurnEnd({
			message: { role: "assistant", content: [{ type: "text", text: "stale reply" }] },
			toolResults: [],
		});

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

test("prior rephrase is included on the next call to keep tone consistent", async () => {
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

		// The second rephrase call sees the first rephrase.
		const secondRephraseMsg = calls[3].context.messages[0].content[0].text;
		assert.match(secondRephraseMsg, /Previous rephrase of similar intent:/);
		assert.match(secondRephraseMsg, /Rephrased again/);
	} finally {
		cleanup(cwd);
	}
});
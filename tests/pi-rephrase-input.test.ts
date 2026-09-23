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

function clearEnv(): void {
	delete process.env.PI_REPHRASE_OFF;
	delete process.env.PI_REPHRASE_DEBUG;
	delete process.env.PI_REPHRASE_TIMEOUT_MS;
	delete process.env.PI_REPHRASE_MAX_RETRIES;
	delete process.env.PI_REPHRASE_RETRY_BASE_MS;
}

function userMsg(text: string, timestamp?: number): any {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: timestamp ?? Date.now(),
	};
}

function assistantMsg(text: string): any {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

function toolResultMsg(toolName: string, text: string): any {
	return {
		role: "toolResult",
		toolName,
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

function contextFor(
	cwd: string,
	registry: { hasConfiguredAuth: () => boolean; complete: (...args: any[]) => Promise<Completion> },
	extra: Record<string, unknown> = {},
): any {
	return {
		model: { id: "model" },
		modelRegistry: registry,
		cwd,
		hasUI: false,
		...extra,
	};
}

function captureHandler(): {
	handler: (event: any, context: any) => Promise<unknown>;
} {
	const captured: { handler?: (event: any, context: any) => Promise<unknown> } = {};
	rephraseInput({
		on: (_event: string, registered: (event: any, context: any) => Promise<unknown>) => {
			captured.handler = registered;
		},
	} as any);
	if (!captured.handler) throw new Error("input handler not registered");
	return { handler: captured.handler };
}

function captureAllHandlers(): {
	handler: (event: any, context: any) => Promise<unknown>;
	fireSessionStart: (context?: any) => void;
	fireMessageEnd: (event: any) => void;
} {
	const captured: {
		handler?: (event: any, context: any) => Promise<unknown>;
		sessionStart?: (context?: any) => void;
		messageEnd?: (event: any) => void;
	} = {};
	rephraseInput({
		on: (event: string, registered: (e?: any, c?: any) => Promise<unknown> | unknown) => {
			if (event === "session_start") {
				captured.sessionStart = (context?: any) => void registered(undefined, context);
			} else if (event === "message_end") {
				captured.messageEnd = (e: any) => void registered(e);
			} else if (event === "input") {
				captured.handler = registered as (event: any, context: any) => Promise<unknown>;
			}
		},
	} as any);
	if (!captured.handler || !captured.sessionStart || !captured.messageEnd) {
		throw new Error("required handlers not registered");
	}
	return {
		handler: captured.handler,
		fireSessionStart: captured.sessionStart,
		fireMessageEnd: captured.messageEnd,
	};
}

function promptText(call: Call): string {
	return call.context.messages[0].content[0].text;
}

test("keeps pasted text explicit in the rephrase request", async () => {
	clearEnv();
	const cwd = makeProject({});
	try {
		const calls: Call[] = [];
		const pastedText = [
			"Please fix this error:",
			"```ts",
			"const answer = await brokenCall();",
			"```",
		].join("\n");
		const registry = {
			hasConfiguredAuth: () => true,
			complete: async (_model: unknown, context: unknown, options?: Call["options"]) => {
				calls.push({ context, options });
				return { content: [{ type: "text", text: "Fix the pasted error." }] };
			},
		};
		const { handler } = captureHandler();
		const result = await handler(
			{ source: "interactive", text: pastedText },
			contextFor(cwd, registry),
		);

		assert.deepEqual(result, {
			action: "transform",
			text: "Fix the pasted error.\n\n```ts\nconst answer = await brokenCall();\n```",
		});
		assert.match(promptText(calls[0]), /Please fix this error:/);
		assert.match(promptText(calls[0]), /const answer = await brokenCall\(\);/);
		assert.doesNotMatch(promptText(calls[0]), /Text payloads to copy verbatim into output:/);
		assert.equal(promptText(calls[0]).split("const answer = await brokenCall();").length - 1, 1);
		assert.match(calls[0].context.systemPrompt, /pasted text.*preserve.*exactly/is);
	} finally {
		cleanup(cwd);
	}
});

test("passes pasted images to the rephrase model and transformed input", async () => {
	clearEnv();
	const cwd = makeProject({});
	try {
		const calls: Call[] = [];
		const image = {
			type: "image" as const,
			data: "aGVsbG8=",
			mimeType: "image/png",
		};
		const registry = {
			hasConfiguredAuth: () => true,
			complete: async (_model: unknown, context: unknown, options?: Call["options"]) => {
				calls.push({ context, options });
				return { content: [{ type: "text", text: "Inspect the attached screenshot." }] };
			},
		};
		const { handler } = captureHandler();
		const result = await handler(
			{ source: "interactive", text: "look at this screenshot", images: [image] },
			contextFor(cwd, registry),
		);

		assert.equal(calls.length, 1);
		assert.deepEqual(calls[0].context.messages[0].content, [
			{ type: "text", text: "User request:\n\nlook at this screenshot" },
			image,
		]);
		assert.deepEqual(result, {
			action: "transform",
			text: "Inspect the attached screenshot.",
			images: [image],
		});
	} finally {
		cleanup(cwd);
	}
});

test("rephrases mentioned files and preserves each reference", async () => {
	clearEnv();
	const cwd = makeProject({});
	try {
		const calls: Call[] = [];
		const registry = {
			hasConfiguredAuth: () => true,
			complete: async (_model: unknown, context: unknown, options?: Call["options"]) => {
				calls.push({ context, options });
				return { content: [{ type: "text", text: "Review the relevant file." }] };
			},
		};
		const { handler } = captureHandler();
		const result = await handler(
			{ source: "interactive", text: "Review @src/auth.ts and @\"docs/auth flow.md\"" },
			contextFor(cwd, registry),
		);

		assert.equal(calls.length, 1);
		assert.match(promptText(calls[0]), /@src\/auth\.ts/);
		assert.match(promptText(calls[0]), /@"docs\/auth flow\.md"/);
		assert.deepEqual(result, {
			action: "transform",
			text: "Review the relevant file.\n\n@src/auth.ts\n\n@\"docs/auth flow.md\"",
		});
	} finally {
		cleanup(cwd);
	}
});

test("rephrases requests starting with an image path and preserves pasted text and attachments", async () => {
	clearEnv();
	const cwd = makeProject({});
	try {
		let terminalInput: ((data: string) => unknown) | undefined;
		const imagePath = "/var/folders/tmp/Screenshot\\ 2026-09-23\\ at\\ 10.42.23\u202fAM.png";
		const pastedText = "  pasted note  \nsecond line\t";
		const originalText = `${imagePath}.\nPlease describe the screenshot and use this note: ${pastedText}`;
		const image = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" };
		const calls: Call[] = [];
		const registry = {
			hasConfiguredAuth: () => true,
			complete: async (_model: unknown, context: unknown, options?: Call["options"]) => {
				calls.push({ context, options });
				return { content: [{ type: "text", text: "Inspect the screenshot and pasted note." }] };
			},
		};
		const { handler, fireSessionStart } = captureAllHandlers();
		fireSessionStart({
			mode: "tui",
			ui: { onTerminalInput: (listener: (data: string) => unknown) => {
				terminalInput = listener;
				return () => {};
			} },
		});
		terminalInput?.(`\u001b[200~${pastedText}\u001b[201~`);

		const result = await handler(
			{ source: "interactive", text: originalText, images: [image] },
			contextFor(cwd, registry),
		);

		assert.equal(calls.length, 1, "a leading image path must not be mistaken for a slash command");
		assert.ok(promptText(calls[0]).includes(`${imagePath}.`));
		assert.ok(promptText(calls[0]).includes(pastedText));
		assert.deepEqual(calls[0].context.messages[0].content[1], image);
		assert.deepEqual(result, {
			action: "transform",
			text: ["Inspect the screenshot and pasted note.", imagePath, pastedText].join("\n\n"),
			images: [image],
		});
	} finally {
		cleanup(cwd);
	}
});

test("rephrases a pasted image without accompanying text", async () => {
	clearEnv();
	const cwd = makeProject({});
	try {
		const calls: Call[] = [];
		const image = {
			type: "image" as const,
			data: "aW1hZ2U=",
			mimeType: "image/png",
		};
		const registry = {
			hasConfiguredAuth: () => true,
			complete: async (_model: unknown, context: unknown, options?: Call["options"]) => {
				calls.push({ context, options });
				return { content: [{ type: "text", text: "Inspect the pasted image." }] };
			},
		};
		const { handler } = captureHandler();
		const result = await handler(
			{ source: "interactive", text: "", images: [image] },
			contextFor(cwd, registry),
		);

		assert.equal(calls.length, 1);
		assert.match(promptText(calls[0]), /User request:/);
		assert.match(promptText(calls[0]), /Describe the attached image/);
		assert.deepEqual(result, {
			action: "transform",
			text: "Inspect the pasted image.",
			images: [image],
		});
	} finally {
		cleanup(cwd);
	}
});

test("preserves unstructured terminal-pasted text", async () => {
	clearEnv();
	const cwd = makeProject({});
	try {
		let terminalInput: ((data: string) => unknown) | undefined;
		const registry = {
			hasConfiguredAuth: () => true,
			complete: async () => ({ content: [{ type: "text", text: "Handle the pasted report." }] }),
		};
		const { handler, fireSessionStart } = captureAllHandlers();
		fireSessionStart({
			mode: "tui",
			ui: {
				onTerminalInput: (listener: (data: string) => unknown) => {
					terminalInput = listener;
					return () => {};
				},
			},
		});
		terminalInput?.("\u001b[200~ERROR: pasted literally\u001b[201~");

		const result = await handler(
			{ source: "interactive", text: "Please handle this: ERROR: pasted literally" },
			contextFor(cwd, registry),
		);

		assert.deepEqual(result, {
			action: "transform",
			text: "Handle the pasted report.\n\nERROR: pasted literally",
		});
	} finally {
		cleanup(cwd);
	}
});

test("omits pasted text payload the model already copied verbatim", async () => {
	clearEnv();
	const cwd = makeProject({});
	try {
		let terminalInput: ((data: string) => unknown) | undefined;
		const registry = {
			hasConfiguredAuth: () => true,
			complete: async () => ({ content: [{ type: "text", text: "Found nothing." }] }),
		};
		const { handler, fireSessionStart } = captureAllHandlers();
		fireSessionStart({ mode: "tui", ui: { onTerminalInput: (listener: (data: string) => unknown) => {
			terminalInput = listener;
			return () => {};
		} } });
		const imageBytes = Buffer.from([9]);
		const path = join(tmpdir(), "pi-clipboard-7a11-0004.png");
		writeFileSync(path, imageBytes);
		try {
			terminalInput?.(`\u001b[200~Analyse ${path}\u001b[201~`);
			const result = await handler(
				{ source: "interactive", text: `Analyse ${path}` },
				contextFor(cwd, registry),
			);
			assert.deepEqual(result, {
				action: "transform",
				text: ["Found nothing.", path].join("\n\n"),
				images: [{ type: "image", data: imageBytes.toString("base64"), mimeType: "image/png" }],
			});
		} finally {
			rmSync(path, { force: true });
		}
	} finally {
		cleanup(cwd);
	}
});

test("rephrases a fully pasted request without duplicating its instruction", async () => {
	clearEnv();
	const cwd = makeProject({});
	try {
		let terminalInput: ((data: string) => unknown) | undefined;
		const original = "please fix this code:\n```ts\n  const broken = true;\n```\n";
		const registry = {
			hasConfiguredAuth: () => true,
			complete: async () => ({ content: [{ type: "text", text: "Fix the pasted code." }] }),
		};
		const { handler, fireSessionStart } = captureAllHandlers();
		fireSessionStart({
			mode: "tui",
			ui: { onTerminalInput: (listener: (data: string) => unknown) => {
				terminalInput = listener;
				return () => {};
			} },
		});
		terminalInput?.(`\u001b[200~${original}\u001b[201~`);
		const result = await handler(
			{ source: "interactive", text: original },
			contextFor(cwd, registry),
		);
		assert.deepEqual(result, {
			action: "transform",
			text: "Fix the pasted code.\n\n```ts\n  const broken = true;\n```",
		});
	} finally {
		cleanup(cwd);
	}
});

test("converts a clipboard image path followed by punctuation into an attachment", async () => {
	clearEnv();
	const cwd = makeProject({});
	const pastedImagePath = join(tmpdir(), "pi-clipboard-012207-0000.png");
	const imageBytes = Buffer.from([1, 2, 3]);
	writeFileSync(pastedImagePath, imageBytes);
	try {
		const calls: Call[] = [];
		const registry = {
			hasConfiguredAuth: () => true,
			complete: async (_model: unknown, context: unknown, options?: Call["options"]) => {
				calls.push({ context, options });
				return { content: [{ type: "text", text: "Inspect the pasted image." }] };
			},
		};
		const { handler } = captureHandler();
		const result = await handler(
			{ source: "interactive", text: `inspect this pasted image ${pastedImagePath}.` },
			contextFor(cwd, registry),
		);
		const image = { type: "image", data: imageBytes.toString("base64"), mimeType: "image/png" };

		assert.deepEqual(calls[0].context.messages[0].content, [
			{ type: "text", text: `User request:\n\ninspect this pasted image ${pastedImagePath}.` },
			image,
		]);
		assert.deepEqual(result, {
			action: "transform",
			text: ["Inspect the pasted image.", pastedImagePath].join("\n\n"),
			images: [image],
		});
	} finally {
		rmSync(pastedImagePath, { force: true });
		cleanup(cwd);
	}
});

test("keeps pasted text whitespace when decoding a clipboard image", async () => {
	clearEnv();
	const cwd = makeProject({});
	const pastedImagePath = join(tmpdir(), "pi-clipboard-012207-0003.png");
	writeFileSync(pastedImagePath, Buffer.from([6]));
	try {
		const registry = {
			hasConfiguredAuth: () => true,
			complete: async () => ({ content: [{ type: "text", text: "Inspect the content." }] }),
		};
		const { handler } = captureHandler();
		const result = await handler(
			{ source: "interactive", text: `\n  Paste:\n  code  \n ${pastedImagePath}` },
			contextFor(cwd, registry),
		);
		assert.deepEqual(result, {
			action: "transform",
			text: ["Inspect the content.", `  Paste:\n  code  \n ${pastedImagePath}`].join("\n\n"),
			images: [{ type: "image", data: "Bg==", mimeType: "image/png" }],
		});
	} finally {
		rmSync(pastedImagePath, { force: true });
		cleanup(cwd);
	}
});

test("keeps unreadable clipboard paths when another image loads", async () => {
	clearEnv();
	const cwd = makeProject({});
	const loadedPath = join(tmpdir(), "pi-clipboard-012207-0001.png");
	const missingPath = join(tmpdir(), "pi-clipboard-012207-0002.png");
	writeFileSync(loadedPath, Buffer.from([4, 5]));
	try {
		const registry = {
			hasConfiguredAuth: () => true,
			complete: async () => ({ content: [{ type: "text", text: "Inspect the available image." }] }),
		};
		const { handler } = captureHandler();
		const result = await handler(
			{ source: "interactive", text: `inspect ${loadedPath} and ${missingPath}` },
			contextFor(cwd, registry),
		);
		assert.deepEqual(result, {
			action: "transform",
			text: ["Inspect the available image.", loadedPath, missingPath].join("\n\n"),
			images: [{ type: "image", data: "BAU=", mimeType: "image/png" }],
		});
	} finally {
		rmSync(loadedPath, { force: true });
		cleanup(cwd);
	}
});

test("does not duplicate payloads already copied verbatim by the model", async () => {
	clearEnv();
	const cwd = makeProject({});
	try {
		const payload = "```text\n  ERROR: broken\n```";
		const registry = {
			hasConfiguredAuth: () => true,
			complete: async () => ({ content: [{ type: "text", text: `Fix this:\n\n${payload}` }] }),
		};
		const { handler } = captureHandler();
		assert.deepEqual(
			await handler(
				{ source: "interactive", text: `please fix:\n${payload}` },
				contextFor(cwd, registry),
			),
			{ action: "transform", text: `Fix this:\n\n${payload}` },
		);
	} finally {
		cleanup(cwd);
	}
});

test("never discovers, reads, or sends project files", async () => {
	clearEnv();
	const cwd = makeProject({
		"README.md": "PROJECT_FILE_CANARY",
		"src/feature.ts": "SOURCE_FILE_CANARY",
		".env": "SECRET_FILE_CANARY",
	});
	try {
		const calls: Call[] = [];
		const registry = {
			hasConfiguredAuth: () => true,
			complete: async (_model: unknown, context: unknown, options?: Call["options"]) => {
				calls.push({ context, options });
				return { content: [{ type: "text", text: "Rephrased request" }] };
			},
		};
		const { handler } = captureHandler();
		const result = await handler(
			{ source: "interactive", text: "Fix the feature" },
			contextFor(cwd, registry),
		);

		assert.deepEqual(result, { action: "transform", text: "Rephrased request" });
		assert.equal(calls.length, 1, "no project-file selector call is made");
		const prompt = promptText(calls[0]);
		assert.match(prompt, /Fix the feature/);
		assert.doesNotMatch(prompt, /PROJECT_FILE_CANARY|SOURCE_FILE_CANARY|SECRET_FILE_CANARY/);
		assert.doesNotMatch(prompt, /Project files|Candidate files|Project cwd/);
		assert.doesNotMatch(prompt, new RegExp(cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.doesNotMatch(calls[0].context.systemPrompt, /project files/i);
	} finally {
		cleanup(cwd);
	}
});

test("feeds recent conversation history without a classifier call", async () => {
	clearEnv();
	const cwd = makeProject({ "README.md": "PROJECT_FILE_CANARY" });
	try {
		const calls: Call[] = [];
		const registry = {
			hasConfiguredAuth: () => true,
			complete: async (_model: unknown, context: unknown, options?: Call["options"]) => {
				calls.push({ context, options });
				return { content: [{ type: "text", text: "Rephrased follow-up" }] };
			},
		};
		const { handler, fireSessionStart, fireMessageEnd } = captureAllHandlers();
		fireSessionStart();
		fireMessageEnd({ message: userMsg("explain the auth flow") });
		fireMessageEnd({ message: assistantMsg("Auth uses refresh tokens.") });

		const result = await handler(
			{ source: "interactive", text: "fix that token bug" },
			contextFor(cwd, registry),
		);

		assert.deepEqual(result, { action: "transform", text: "Rephrased follow-up" });
		assert.equal(calls.length, 1, "history does not require a classifier call");
		const rephrasePrompt = promptText(calls[0]);
		assert.match(rephrasePrompt, /Recent conversation \(oldest first\):/);
		assert.match(rephrasePrompt, /U: explain the auth flow/);
		assert.match(rephrasePrompt, /A: Auth uses refresh tokens\./);
		assert.match(rephrasePrompt, /User request:\n\nfix that token bug/);
		assert.doesNotMatch(rephrasePrompt, /PROJECT_FILE_CANARY|README\.md|Project files/);
	} finally {
		cleanup(cwd);
	}
});

test("feeds recent tool results with conversation context", async () => {
	clearEnv();
	const cwd = makeProject({ "src/auth.ts": "PROJECT_FILE_CANARY" });
	try {
		const calls: Call[] = [];
		const registry = {
			hasConfiguredAuth: () => true,
			complete: async (_model: unknown, context: unknown, options?: Call["options"]) => {
				calls.push({ context, options });
				return { content: [{ type: "text", text: "Rephrased with tool context" }] };
			},
		};
		const { handler, fireSessionStart, fireMessageEnd } = captureAllHandlers();
		fireSessionStart();
		fireMessageEnd({ message: assistantMsg("Ran the test suite.") });
		fireMessageEnd({ message: toolResultMsg("bash", "Tests failed in auth.test.ts") });

		await handler(
			{ source: "interactive", text: "fix that failure" },
			contextFor(cwd, registry),
		);

		assert.equal(calls.length, 1);
		const rephrasePrompt = promptText(calls[0]);
		assert.match(rephrasePrompt, /Recent tool results:/);
		assert.match(rephrasePrompt, /\[bash\]: Tests failed in auth\.test\.ts/);
		assert.doesNotMatch(rephrasePrompt, /PROJECT_FILE_CANARY|auth\.ts/);
	} finally {
		cleanup(cwd);
	}
});

test("always includes bounded history, even for self-contained input", async () => {
	clearEnv();
	const cwd = makeProject({ "README.md": "PROJECT_FILE_CANARY" });
	try {
		const calls: Call[] = [];
		const registry = {
			hasConfiguredAuth: () => true,
			complete: async (_model: unknown, context: unknown, options?: Call["options"]) => {
				calls.push({ context, options });
				return { content: [{ type: "text", text: "Rephrased fresh" }] };
			},
		};
		const { handler, fireSessionStart, fireMessageEnd } = captureAllHandlers();
		fireSessionStart();
		fireMessageEnd({ message: userMsg("earlier question") });
		fireMessageEnd({ message: assistantMsg("earlier answer") });

		const result = await handler(
			{ source: "interactive", text: "add a login button" },
			contextFor(cwd, registry),
		);

		assert.deepEqual(result, { action: "transform", text: "Rephrased fresh" });
		assert.equal(calls.length, 1);
		assert.match(promptText(calls[0]), /Recent conversation|earlier question|earlier answer/);
	} finally {
		cleanup(cwd);
	}
});

test("conversation context keeps its hard character cap", async () => {
	clearEnv();
	const cwd = makeProject({});
	try {
		const calls: Call[] = [];
		const registry = {
			hasConfiguredAuth: () => true,
			complete: async (_model: unknown, context: unknown, options?: Call["options"]) => {
				calls.push({ context, options });
				return { content: [{ type: "text", text: "Rephrased request" }] };
			},
		};
		const { handler, fireSessionStart, fireMessageEnd } = captureAllHandlers();
		fireSessionStart();
		for (const [role, text] of [
			["user", "u".repeat(700)],
			["assistant", "a".repeat(700)],
			["user", "v".repeat(700)],
			["assistant", "b".repeat(700)],
		] as const) {
			fireMessageEnd({ message: role === "user" ? userMsg(text) : assistantMsg(text) });
		}

		await handler(
			{ source: "interactive", text: "follow up" },
			contextFor(cwd, registry),
		);

		const prompt = promptText(calls[0]);
		const contextStart = prompt.indexOf("Recent conversation (oldest first):");
		const requestStart = prompt.indexOf("\n\nUser request:");
		assert.ok(contextStart >= 0);
		assert.ok(requestStart > contextStart);
		assert.equal(prompt.slice(contextStart, requestStart).length, 2000);
	} finally {
		cleanup(cwd);
	}
});

test("empty history sends only the request and never scans project files", async () => {
	clearEnv();
	const cwd = makeProject({
		"src/file.ts": "PROJECT_FILE_CANARY",
		"nested/other.txt": "OTHER_FILE_CANARY",
	});
	try {
		const calls: Call[] = [];
		const registry = {
			hasConfiguredAuth: () => true,
			complete: async (_model: unknown, context: unknown, options?: Call["options"]) => {
				calls.push({ context, options });
				return { content: [{ type: "text", text: "Rephrased fresh" }] };
			},
		};
		const { handler } = captureHandler();
		await handler(
			{ source: "interactive", text: "first request" },
			contextFor(cwd, registry),
		);

		assert.equal(calls.length, 1);
		assert.doesNotMatch(promptText(calls[0]), /Recent conversation|PROJECT_FILE_CANARY|OTHER_FILE_CANARY/);
	} finally {
		cleanup(cwd);
	}
});

test("session_start resets conversation and tool buffers", async () => {
	clearEnv();
	const cwd = makeProject({ "README.md": "PROJECT_FILE_CANARY" });
	try {
		const calls: Call[] = [];
		const registry = {
			hasConfiguredAuth: () => true,
			complete: async (_model: unknown, context: unknown, options?: Call["options"]) => {
				calls.push({ context, options });
				return { content: [{ type: "text", text: "Rephrased fresh" }] };
			},
		};
		const { handler, fireSessionStart, fireMessageEnd } = captureAllHandlers();
		fireSessionStart();
		fireMessageEnd({ message: userMsg("stale turn") });
		fireMessageEnd({ message: assistantMsg("stale reply") });
		fireMessageEnd({ message: toolResultMsg("bash", "stale tool result") });
		fireSessionStart();

		await handler(
			{ source: "interactive", text: "fresh request" },
			contextFor(cwd, registry),
		);

		assert.equal(calls.length, 1, "fresh session makes one rephrase call");
		assert.doesNotMatch(promptText(calls[0]), /stale turn|stale reply|stale tool result/);
	} finally {
		cleanup(cwd);
	}
});

test("buffer keeps original user wording after a transform", async () => {
	clearEnv();
	const cwd = makeProject({ "README.md": "PROJECT_FILE_CANARY" });
	try {
		const calls: Call[] = [];
		const registry = {
			hasConfiguredAuth: () => true,
			complete: async (_model: unknown, context: unknown, options?: Call["options"]) => {
				calls.push({ context, options });
				if (calls.length === 1) return { content: [{ type: "text", text: "VERBOSE_REPHRASE" }] };
				return { content: [{ type: "text", text: "second" }] };
			},
		};
		const { handler, fireSessionStart, fireMessageEnd } = captureAllHandlers();
		fireSessionStart();
		const timestamp = Date.now();
		await handler(
			{ source: "interactive", text: "fix the auth bug" },
			contextFor(cwd, registry),
		);
		fireMessageEnd({ message: userMsg("VERBOSE_REPHRASE", timestamp) });

		await handler(
			{ source: "interactive", text: "and the test too" },
			contextFor(cwd, registry),
		);

		assert.match(promptText(calls[1]), /U: fix the auth bug/);
		assert.doesNotMatch(promptText(calls[1]), /VERBOSE_REPHRASE/);
	} finally {
		cleanup(cwd);
	}
});

test("buffer keeps original user wording even when Pi's recorded timestamp differs", async () => {
	// Regression for the second-prompt rephrase bug: Pi records the
	// UserMessage with its own `Date.now()` AFTER our transform completes,
	// so the timestamp on `message_end`'s message never matches the one
	// we captured at input-handler entry. Earlier versions keyed a Map by
	// the captured timestamp, so the lookup always missed and the buffer
	// captured rephrased output instead of user wording — every turn
	// after the first drifted from the user's voice.
	clearEnv();
	const cwd = makeProject({ "README.md": "PROJECT_FILE_CANARY" });
	try {
		const calls: Call[] = [];
		const registry = {
			hasConfiguredAuth: () => true,
			complete: async (_model: unknown, context: unknown, options?: Call["options"]) => {
				calls.push({ context, options });
				if (calls.length === 1) return { content: [{ type: "text", text: "VERBOSE_REPHRASE" }] };
				return { content: [{ type: "text", text: "second" }] };
			},
		};
		const { handler, fireSessionStart, fireMessageEnd } = captureAllHandlers();
		fireSessionStart();
		await handler(
			{ source: "interactive", text: "fix the auth bug" },
			contextFor(cwd, registry),
		);
		// Pi's UserMessage timestamp diverges from the extension's captured one.
		fireMessageEnd({ message: userMsg("VERBOSE_REPHRASE", Date.now() + 7_777) });
		fireMessageEnd({ message: assistantMsg("ok, fixed the auth path") });

		await handler(
			{ source: "interactive", text: "and the test too" },
			contextFor(cwd, registry),
		);
		// Same divergence on the second prompt.
		fireMessageEnd({ message: userMsg("second", Date.now() + 9_999) });

		// The rephraser for prompt 2 must see the ORIGINAL wording of
		// prompt 1, not its rephrased form.
		assert.match(promptText(calls[1]), /U: fix the auth bug/);
		assert.doesNotMatch(promptText(calls[1]), /VERBOSE_REPHRASE/);
	} finally {
		cleanup(cwd);
	}
});

test("rephrase failure pops the pending original so message_end falls back to the input text", async () => {
	// When rephrasing fails and we pass the input through unchanged,
	// Pi's UserMessage carries the original text and our pending FIFO
	// entry must be removed so `message_end` records it via the
	// content-extraction fallback.
	clearEnv();
	process.env.PI_REPHRASE_MAX_RETRIES = "0";
	const cwd = makeProject({ "README.md": "PROJECT_FILE_CANARY" });
	try {
		const calls: Call[] = [];
		const registry = {
			hasConfiguredAuth: () => true,
			complete: async (_model: unknown, context: unknown, options?: Call["options"]) => {
				calls.push({ context, options });
				throw new Error("provider down");
			},
		};
		const { handler, fireSessionStart, fireMessageEnd } = captureAllHandlers();
		fireSessionStart();
		await handler(
			{ source: "interactive", text: "do the thing" },
			contextFor(cwd, registry),
		);
		fireMessageEnd({ message: userMsg("do the thing", Date.now() + 5) });

		await handler(
			{ source: "interactive", text: "and now also this" },
			contextFor(cwd, registry),
		);

		// Second rephrase must see the first prompt's ORIGINAL text, even
		// though it was passed through unchanged (not rephrased).
		assert.match(promptText(calls[1]), /U: do the thing/);
	} finally {
		cleanup(cwd);
	}
});

test("terminal Escape and Ctrl-C abort an active rephrase", async () => {
	clearEnv();
	process.env.PI_REPHRASE_MAX_RETRIES = "0";
	const cwd = makeProject({});
	try {
		let terminalInput: ((data: string) => unknown) | undefined;
		const signals: AbortSignal[] = [];
		const registry = {
			hasConfiguredAuth: () => true,
			complete: async (
				_model: unknown,
				_context: unknown,
				options?: Call["options"],
			) => {
				const signal = options?.signal;
				if (!signal) throw new Error("missing rephrase signal");
				signals.push(signal);
				return new Promise<Completion>((_resolve, reject) => {
					signal.addEventListener(
						"abort",
						() => reject(new Error("aborted by terminal input")),
						{ once: true },
					);
				});
			},
		};
		const { handler, fireSessionStart } = captureAllHandlers();
		fireSessionStart({
			mode: "tui",
			ui: {
				onTerminalInput: (listener: (data: string) => unknown) => {
					terminalInput = listener;
					return () => {};
				},
			},
		});
		assert.ok(terminalInput, "TUI terminal listener registered");

		const runCancelled = async (key: string): Promise<void> => {
			const pending = handler(
				{ source: "interactive", text: `cancel with ${key}` },
				contextFor(cwd, registry),
			);
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(signals.length > 0, true);
			assert.equal(terminalInput?.(key), undefined, "interrupt key is not consumed");
			assert.equal(signals.at(-1)?.aborted, true);
			assert.deepEqual(await pending, { action: "continue" });
		};

		await runCancelled("\u001b");
		await runCancelled("\u0003");
		await runCancelled("\u001b[99;5u");
	} finally {
		clearEnv();
		cleanup(cwd);
	}
});

test("invalid infinite retry configuration falls back to finite defaults", async () => {
	clearEnv();
	process.env.PI_REPHRASE_MAX_RETRIES = "Infinity";
	process.env.PI_REPHRASE_RETRY_BASE_MS = "Infinity";
	const cwd = makeProject({});
	try {
		let attempts = 0;
		const registry = {
			hasConfiguredAuth: () => true,
			complete: async () => {
				attempts++;
				throw new Error("provider down");
			},
		};
		const { handler } = captureHandler();
		assert.deepEqual(
			await handler(
				{ source: "interactive", text: "do the thing" },
				contextFor(cwd, registry),
			),
			{ action: "continue" },
		);
		assert.equal(attempts, 3, "invalid Infinity retries use the default of two retries");
	} finally {
		clearEnv();
		cleanup(cwd);
	}
});

test("records string-form user messages when no pending transformed input exists", async () => {
	clearEnv();
	const cwd = makeProject({});
	try {
		const calls: Call[] = [];
		const registry = {
			hasConfiguredAuth: () => true,
			complete: async (_model: unknown, context: unknown, options?: Call["options"]) => {
				calls.push({ context, options });
				return { content: [{ type: "text", text: "rephrased" }] };
			},
		};
		const { handler, fireSessionStart, fireMessageEnd } = captureAllHandlers();
		fireSessionStart();
		fireMessageEnd({ message: { role: "user", content: "raw string user message" } });

		await handler(
			{ source: "interactive", text: "follow up" },
			contextFor(cwd, registry),
		);

		assert.match(promptText(calls[0]), /U: raw string user message/);
	} finally {
		cleanup(cwd);
	}
});

test("rephrase retries transient failures", async () => {
	clearEnv();
	process.env.PI_REPHRASE_MAX_RETRIES = "1";
	const cwd = makeProject({});
	try {
		let attempts = 0;
		const registry = {
			hasConfiguredAuth: () => true,
			complete: async () => {
				attempts++;
				if (attempts === 1) throw new Error("network blip");
				return { content: [{ type: "text", text: "Rephrased on retry" }] };
			},
		};
		const { handler } = captureHandler();
		const result = await handler(
			{ source: "interactive", text: "fix the thing" },
			contextFor(cwd, registry),
		);
		assert.deepEqual(result, { action: "transform", text: "Rephrased on retry" });
		assert.equal(attempts, 2);
	} finally {
		cleanup(cwd);
	}
});

test("rephrase exhaustion passes original input through", async () => {
	clearEnv();
	process.env.PI_REPHRASE_MAX_RETRIES = "1";
	const cwd = makeProject({});
	try {
		let attempts = 0;
		const registry = {
			hasConfiguredAuth: () => true,
			complete: async () => {
				attempts++;
				throw new Error("provider down");
			},
		};
		const { handler } = captureHandler();
		const result = await handler(
			{ source: "interactive", text: "do the thing" },
			contextFor(cwd, registry),
		);
		assert.deepEqual(result, { action: "continue" });
		assert.equal(attempts, 2);
	} finally {
		cleanup(cwd);
	}
});

test("user abort prevents calls and cancels an active rephrase", async () => {
	clearEnv();
	const cwd = makeProject({});
	try {
		const ac = new AbortController();
		ac.abort();
		let calls = 0;
		const registry = {
			hasConfiguredAuth: () => true,
			complete: async () => {
				calls++;
				return { content: [{ type: "text", text: "unexpected" }] };
			},
		};
		const { handler } = captureHandler();
		assert.deepEqual(
			await handler(
				{ source: "interactive", text: "request" },
				contextFor(cwd, registry, { signal: ac.signal }),
			),
			{ action: "continue" },
		);
		assert.equal(calls, 0);

		const midFlight = new AbortController();
		calls = 0;
		const abortingRegistry = {
			hasConfiguredAuth: () => true,
			complete: async () => {
				calls++;
				queueMicrotask(() => midFlight.abort());
				return { content: [{ type: "text", text: "late result" }] };
			},
		};
		assert.deepEqual(
			await handler(
				{ source: "interactive", text: "request" },
				contextFor(cwd, abortingRegistry, { signal: midFlight.signal }),
			),
			{ action: "continue" },
		);
		assert.equal(calls, 1);
	} finally {
		cleanup(cwd);
	}
});

test("input gates short-circuit before any model call", async () => {
	clearEnv();
	const cwd = makeProject({});
	try {
		let calls = 0;
		const registry = {
			hasConfiguredAuth: () => true,
			complete: async () => {
				calls++;
				return { content: [{ type: "text", text: "unexpected" }] };
			},
		};
		const { handler } = captureHandler();
		for (const event of [
			{ source: "extension", text: "request" },
			{ source: "rpc", text: "request" },
			{ source: "interactive", streamingBehavior: "steer", text: "request" },
			{ source: "interactive", streamingBehavior: "followUp", text: "request" },
			{ source: "interactive", text: "/help" },
			{ source: "interactive", text: "   " },
		]) {
			assert.deepEqual(await handler(event, contextFor(cwd, registry)), {
				action: "continue",
			});
		}
		assert.equal(calls, 0);
	} finally {
		cleanup(cwd);
	}
});

test("kill switch and missing model stay silent", async () => {
	clearEnv();
	const cwd = makeProject({});
	try {
		const messages: string[] = [];
		let calls = 0;
		const registry = {
			hasConfiguredAuth: () => true,
			complete: async () => {
				calls++;
				return { content: [{ type: "text", text: "unexpected" }] };
			},
		};
		const { handler } = captureHandler();
		process.env.PI_REPHRASE_OFF = "1";
		assert.deepEqual(
			await handler(
				{ source: "interactive", text: "request" },
				contextFor(cwd, registry, {
					hasUI: true,
					ui: { notify: (message: string) => messages.push(message) },
				}),
			),
			{ action: "continue" },
		);
		delete process.env.PI_REPHRASE_OFF;
		assert.deepEqual(
			await handler(
				{ source: "interactive", text: "request" },
				contextFor(cwd, {
					hasConfiguredAuth: () => false,
					complete: registry.complete,
				}, {
					hasUI: true,
					ui: { notify: (message: string) => messages.push(message) },
				}),
			),
			{ action: "continue" },
		);
		assert.equal(calls, 0);
		assert.deepEqual(messages, []);
	} finally {
		clearEnv();
		cleanup(cwd);
	}
});

test("debug mode logs retry and skip information", async () => {
	clearEnv();
	process.env.PI_REPHRASE_DEBUG = "1";
	process.env.PI_REPHRASE_MAX_RETRIES = "0";
	const cwd = makeProject({});
	try {
		const writes: string[] = [];
		const originalWrite = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: string | Uint8Array): boolean => {
			writes.push(typeof chunk === "string" ? chunk : chunk.toString());
			return true;
		}) as typeof process.stderr.write;
		try {
			const { handler } = captureHandler();
			const registry = {
				hasConfiguredAuth: () => true,
				complete: async () => {
					throw new Error("rephrase down");
				},
			};
			assert.deepEqual(
				await handler(
					{ source: "interactive", text: "do thing" },
					contextFor(cwd, registry),
				),
				{ action: "continue" },
			);
		} finally {
			process.stderr.write = originalWrite;
		}
		assert.ok(writes.some((write) => write.includes("[rephrase-skip]")));
	} finally {
		clearEnv();
		cleanup(cwd);
	}
});

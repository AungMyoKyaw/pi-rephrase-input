import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import rephraseInput, {
	discoverContextCandidates,
	loadContext,
	selectContextFiles,
} from "./pi-rephrase-input.ts";

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

test("discovers files dynamically and uses only LLM-selected context", async () => {
	const cwd = makeProject({
		"README.md": "README context",
		"src/feature.ts": "feature context",
		"notes.txt": "unrelated context",
		".env": "SECRET=do-not-read",
		"binary.dat": new Uint8Array([0, 1, 2]),
	});
	try {
		const candidates = discoverContextCandidates(cwd);
		assert.deepEqual(
			candidates.map((candidate) => candidate.path).sort(),
			["README.md", "notes.txt", "src/feature.ts"],
		);

		const calls: Call[] = [];
		const registry = {
			complete: async (model: unknown, context: unknown, options?: Call["options"]): Promise<Completion> => {
				calls.push({ model, context, options });
				return {
					content: [
						{
							type: "text",
							text: '{"files":["src/feature.ts","../.env","missing.ts"]}',
						},
					],
				};
			},
		};
		const selected = await selectContextFiles(registry, "model", cwd, "Fix feature", candidates, 1000);

		assert.deepEqual(selected, ["src/feature.ts"]);
		assert.equal(calls.length, 1);
		assert.match(calls[0].context.messages[0].content[0].text, /Fix feature/);
		assert.match(calls[0].context.messages[0].content[0].text, /src\/feature\.ts/);

		const context = loadContext(cwd, 6000, selected);
		assert.match(context, /### src\/feature\.ts/);
		assert.match(context, /feature context/);
		assert.doesNotMatch(context, /README context|unrelated context|SECRET/);
	} finally {
		cleanup(cwd);
	}
});

test("ignores malformed selector output and selector failures without blocking rephrase", async () => {
	const cwd = makeProject({ "src.ts": "selected source" });
	try {
		const candidates = discoverContextCandidates(cwd);
		let calls = 0;
		const malformed = {
			complete: async (): Promise<Completion> => {
				calls++;
				return { content: [{ type: "text", text: "not JSON" }] };
			},
		};
		assert.deepEqual(await selectContextFiles(malformed, "model", cwd, "request", candidates, 1000), []);

		let rephraseCalls = 0;
		const registry = {
			hasConfiguredAuth: () => true,
			complete: async (): Promise<Completion> => {
				rephraseCalls++;
				if (rephraseCalls === 1) throw new Error("selection failed");
				return { content: [{ type: "text", text: "Rephrased request" }] };
			},
		};
		let handler: ((event: any, context: any) => Promise<unknown>) | undefined;
		rephraseInput({
			on: (_event: string, registered: (event: any, context: any) => Promise<unknown>) => {
				handler = registered;
			},
		} as any);
		const result = await handler!({ source: "interactive", text: "request" }, {
			model: { id: "model" },
			modelRegistry: registry,
			cwd,
			hasUI: false,
		});
		assert.deepEqual(result, { action: "transform", text: "Rephrased request" });
		assert.equal(rephraseCalls, 2);
		assert.equal(calls, 1);
	} finally {
		cleanup(cwd);
	}
});

test("preserves input gates and rephrase error behavior", async () => {
	const cwd = makeProject({ "README.md": "context" });
	try {
		let registered: ((event: any, context: any) => Promise<unknown>) | undefined;
		let calls = 0;
		rephraseInput({
			on: (_event: string, handler: (event: any, context: any) => Promise<unknown>) => {
				registered = handler;
			},
		} as any);
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

		assert.deepEqual(await registered!({ source: "extension", text: "request" }, ctx), { action: "continue" });
		assert.deepEqual(await registered!({ source: "interactive", streamingBehavior: "steer", text: "request" }, ctx), {
			action: "continue",
		});
		assert.equal(calls, 0);
		assert.deepEqual(await registered!({ source: "interactive", text: "request" }, ctx), { action: "continue" });
		assert.equal(calls, 2, "selector and rephrase calls both run before rephrase failure is reported");
	} finally {
		cleanup(cwd);
	}
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type Context,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
} from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it } from 'vitest';
import type { PersistenceAdapter } from './agent-execution-store.ts';
import { init, useModel, useTool } from './index.ts';
import { sqlite, start } from './node/index.ts';
import type { ToolImageRetention } from './tool-types.ts';

const screenshot = { type: 'image', data: 'c2NyZWVuc2hvdA==', mimeType: 'image/png' } as const;

function screenshotAgent(imageRetention?: ToolImageRetention) {
	return function ScreenshotAgent() {
		useModel('faux/model');
		useTool({
			name: 'capture_screenshot',
			description: 'Capture the rendered page.',
			...(imageRetention ? { imageRetention } : {}),
			run() {
				return {
					output: { width: 1280 },
					content: [{ type: 'text', text: 'Rendered.' }, screenshot],
				};
			},
		});
		useTool({
			name: 'note',
			description: 'Record a note.',
			run() {
				return 'noted';
			},
		});
		return 'Inspect screenshots.';
	};
}

type Captured = { messages: Context['messages']; tools: string[] };

function capture(into: Captured[], reply: ReturnType<typeof fauxAssistantMessage>) {
	return (context: Context) => {
		into.push({
			messages: structuredClone(context.messages),
			tools: (context.tools ?? []).map((tool) => tool.name),
		});
		return reply;
	};
}

const call = (name: string, args: Record<string, unknown> = {}, id = `call_${name}`) =>
	fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: 'toolUse' });
const done = (text: string) => fauxAssistantMessage([fauxText(text)], { stopReason: 'stop' });

function toolResult(captured: Captured, toolCallId: string) {
	const message = captured.messages.find(
		(candidate) => candidate.role === 'toolResult' && candidate.toolCallId === toolCallId,
	);
	if (message?.role !== 'toolResult') throw new Error(`No tool result for ${toolCallId}.`);
	return message;
}

const images = (captured: Captured, toolCallId: string) =>
	toolResult(captured, toolCallId).content.filter((block) => block.type === 'image');

function manifestId(captured: Captured, toolCallId: string): string {
	const text = toolResult(captured, toolCallId)
		.content.flatMap((block) => (block.type === 'text' ? [block.text] : []))
		.join('\n');
	const match = /<image id="([^"]+)" mimeType="image\/png" \/>/.exec(text);
	if (!match?.[1]) throw new Error(`No attachment manifest in ${toolCallId}: ${text}`);
	return match[1];
}

/** The model-facing shape of a context: what a provider serializes. */
function modelFacing(messages: Context['messages']) {
	return messages.map((message) =>
		message.role === 'toolResult'
			? { role: message.role, toolCallId: message.toolCallId, content: message.content }
			: {
					role: message.role,
					content:
						typeof message.content === 'string'
							? message.content
							: message.content.map((block) =>
									block.type === 'text' ? { type: 'text', text: block.text } : block,
								),
				},
	);
}

/** A persistence adapter that records every attachment-store `get` id. */
function recordingSqlite(path: string, gets: string[]): PersistenceAdapter {
	const adapter = sqlite(path);
	return {
		...adapter,
		migrate: adapter.migrate?.bind(adapter),
		close: adapter.close?.bind(adapter),
		async connect() {
			const stores = await adapter.connect();
			return {
				...stores,
				attachmentStore: {
					put: (input) => stores.attachmentStore.put(input),
					get: (input) => {
						gets.push(input.attachmentId);
						return stores.attachmentStore.get(input);
					},
				},
			};
		},
	};
}

describe('tool image retention', () => {
	let directory: string | undefined;
	afterEach(async () => {
		if (directory) await rm(directory, { recursive: true, force: true });
		directory = undefined;
	});

	it("shows a 'turn' image in the next request only, and rehydrates the same context", async () => {
		directory = await mkdtemp(join(tmpdir(), 'flue-image-retention-'));
		const databasePath = join(directory, 'flue.db');
		const Agent = screenshotAgent('turn');
		const captured: Captured[] = [];
		const gets: string[] = [];
		const faux = fauxProvider({ models: [{ id: 'model', input: ['text', 'image'] }] });
		faux.setResponses([
			call('capture_screenshot'),
			capture(captured, call('note')),
			capture(captured, done('Seen.')),
		]);
		const runtime = await start({
			agents: [Agent],
			db: recordingSqlite(databasePath, gets),
			providers: [faux.provider],
			env: {},
		});
		let liveFinal: Captured;
		let attachmentId: string;
		try {
			const agent = init(Agent, { id: 'turn-retention' });
			await agent.read(await agent.dispatch('Capture the page.'));
			const [immediate, later] = captured;
			if (!immediate || !later) throw new Error('Expected two captured requests.');
			liveFinal = later;

			// (b) The request right after the tool result carries the image and its manifest.
			attachmentId = manifestId(immediate, 'call_capture_screenshot');
			expect(images(immediate, 'call_capture_screenshot')).toEqual([screenshot]);
			// view_attachment is registered because a tool declares 'turn'.
			expect(immediate.tools).toContain('view_attachment');

			// (a) Once the model answered, only the manifest placeholder remains.
			expect(images(later, 'call_capture_screenshot')).toEqual([]);
			expect(manifestId(later, 'call_capture_screenshot')).toBe(attachmentId);
			expect(JSON.stringify(later.messages)).not.toContain(screenshot.data);
		} finally {
			await runtime.stop();
		}

		// (d) + (e) A fresh runtime rebuilds the same model-facing context from
		// the stored log, without reading the omitted image from the store.
		gets.length = 0;
		const restored: Captured[] = [];
		const secondFaux = fauxProvider({ models: [{ id: 'model', input: ['text', 'image'] }] });
		secondFaux.setResponses([capture(restored, done('Again.'))]);
		const secondRuntime = await start({
			agents: [Agent],
			db: recordingSqlite(databasePath, gets),
			providers: [secondFaux.provider],
			env: {},
		});
		try {
			const agent = init(Agent, { id: 'turn-retention' });
			await agent.read(await agent.dispatch('Look again.'));
			const [rehydrated] = restored;
			if (!rehydrated) throw new Error('Expected a rehydrated request.');
			expect(modelFacing(rehydrated.messages.slice(0, liveFinal.messages.length))).toEqual(
				modelFacing(liveFinal.messages),
			);
			expect(images(rehydrated, 'call_capture_screenshot')).toEqual([]);
			expect(gets).not.toContain(attachmentId);
		} finally {
			await secondRuntime.stop();
		}
	});

	it('keeps the image for a request retried after an errored assistant', async () => {
		const Agent = screenshotAgent('turn');
		const captured: Captured[] = [];
		const faux = fauxProvider({ models: [{ id: 'model', input: ['text', 'image'] }] });
		faux.setResponses([
			call('capture_screenshot'),
			capture(
				captured,
				fauxAssistantMessage([], { stopReason: 'error', errorMessage: 'socket hang up' }),
			),
			capture(captured, call('note')),
			capture(captured, done('Seen.')),
		]);
		const runtime = await start({ agents: [Agent], providers: [faux.provider], env: {} });
		try {
			const agent = init(Agent, { id: 'turn-retention-retry' });
			await expect(agent.read(await agent.dispatch('Capture the page.'))).resolves.toMatchObject({
				text: 'Seen.',
			});
			const [failed, retried, answered] = captured;
			if (!failed || !retried || !answered) throw new Error('Expected three captured requests.');
			expect(images(failed, 'call_capture_screenshot')).toEqual([screenshot]);
			// (c) The errored assistant is not an answer: the retry still sees the image.
			expect(images(retried, 'call_capture_screenshot')).toEqual([screenshot]);
			expect(images(answered, 'call_capture_screenshot')).toEqual([]);
		} finally {
			await runtime.stop();
		}
	}, 15_000);

	it('view_attachment shows an image again for one request', async () => {
		const Agent = screenshotAgent('turn');
		const captured: Captured[] = [];
		let attachmentId = '';
		const faux = fauxProvider({ models: [{ id: 'model', input: ['text', 'image'] }] });
		faux.setResponses([
			call('capture_screenshot'),
			capture(captured, call('note', {}, 'call_note_1')),
			(context) => {
				const request = { messages: structuredClone(context.messages), tools: [] };
				captured.push(request);
				attachmentId = manifestId(request, 'call_capture_screenshot');
				return call('view_attachment', { ids: [attachmentId] });
			},
			capture(captured, call('note', {}, 'call_note_2')),
			capture(captured, done('Seen twice.')),
		]);
		const runtime = await start({ agents: [Agent], providers: [faux.provider], env: {} });
		try {
			const agent = init(Agent, { id: 'turn-retention-view' });
			await agent.read(await agent.dispatch('Capture the page.'));
			const [, beforeView, viewed, afterView] = captured;
			if (!beforeView || !viewed || !afterView) throw new Error('Expected five requests.');
			expect(images(beforeView, 'call_capture_screenshot')).toEqual([]);
			// (f) The re-viewed image rides on the view_attachment result for one request,
			// under the original attachment id (no second copy is stored).
			expect(toolResult(viewed, 'call_view_attachment').isError).toBe(false);
			expect(images(viewed, 'call_view_attachment')).toEqual([screenshot]);
			expect(manifestId(viewed, 'call_view_attachment')).toBe(attachmentId);
			expect(images(afterView, 'call_view_attachment')).toEqual([]);
			expect(manifestId(afterView, 'call_view_attachment')).toBe(attachmentId);
			expect(JSON.stringify(afterView.messages)).not.toContain(screenshot.data);
		} finally {
			await runtime.stop();
		}
	});

	it("keeps 'conversation' images in every request and adds no tool", async () => {
		const Agent = screenshotAgent();
		const captured: Captured[] = [];
		const faux = fauxProvider({ models: [{ id: 'model', input: ['text', 'image'] }] });
		faux.setResponses([
			call('capture_screenshot'),
			capture(captured, call('note')),
			capture(captured, done('Seen.')),
		]);
		const runtime = await start({ agents: [Agent], providers: [faux.provider], env: {} });
		try {
			const agent = init(Agent, { id: 'conversation-retention' });
			await agent.read(await agent.dispatch('Capture the page.'));
			const [immediate, later] = captured;
			if (!immediate || !later) throw new Error('Expected two captured requests.');
			// (g) Default behavior: the live result is untouched and stays in context.
			expect(toolResult(immediate, 'call_capture_screenshot').content).toEqual([
				{ type: 'text', text: 'Rendered.' },
				screenshot,
			]);
			expect(images(later, 'call_capture_screenshot')).toEqual([screenshot]);
			expect(immediate.tools).not.toContain('view_attachment');
		} finally {
			await runtime.stop();
		}
	});
});

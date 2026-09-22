import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import { init, useModel, useTool } from './index.ts';
import { sqlite, start } from './node/index.ts';
import {
	defineTool,
	MAX_TOOL_RESULT_IMAGE_BASE64_LENGTH,
	MAX_TOOL_RESULT_IMAGE_TOTAL_BASE64_LENGTH,
	MAX_TOOL_RESULT_IMAGES,
	resolveToolRun,
} from './tool.ts';

const screenshotData = 'c2NyZWVuc2hvdA==';

function ScreenshotAgent() {
	useModel('faux/model');
	useTool({
		name: 'capture_screenshot',
		description: 'Capture the rendered page.',
		run() {
			return {
				output: { url: 'https://example.com', width: 1280, height: 720 },
				content: [
					{ type: 'text', text: 'Rendered https://example.com.' },
					{ type: 'image', data: screenshotData, mimeType: 'image/png' },
				],
			};
		},
	});
	return 'Use the screenshot tool and inspect its image in this conversation.';
}

describe('custom tool model content', () => {
	it('sends image bytes to the original authoring model and restores them from persistence', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'flue-tool-content-'));
		const databasePath = join(directory, 'flue.db');
		let firstFollowUpMessages: unknown;
		const firstFaux = fauxProvider({ models: [{ id: 'model', input: ['text', 'image'] }] });
		firstFaux.setResponses([
			fauxAssistantMessage([fauxToolCall('capture_screenshot', {}, { id: 'call_screenshot' })], {
				stopReason: 'toolUse',
			}),
			(context) => {
				firstFollowUpMessages = structuredClone(context.messages);
				return fauxAssistantMessage([fauxText('The screenshot is visible.')], {
					stopReason: 'stop',
				});
			},
		]);
		const firstRuntime = await start({
			agents: [ScreenshotAgent],
			db: sqlite(databasePath),
			providers: [firstFaux.provider],
			env: {},
		});
		try {
			const agent = init(ScreenshotAgent, { id: 'screenshot-restore' });
			await expect(agent.read(await agent.dispatch('Capture the page.'))).resolves.toMatchObject({
				text: 'The screenshot is visible.',
			});
			expect(firstFollowUpMessages).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						role: 'toolResult',
						toolCallId: 'call_screenshot',
						content: [
							{ type: 'text', text: 'Rendered https://example.com.' },
							{ type: 'image', data: screenshotData, mimeType: 'image/png' },
						],
					}),
				]),
			);
		} finally {
			await firstRuntime.stop();
		}

		let restoredMessages: unknown;
		const secondFaux = fauxProvider({ models: [{ id: 'model', input: ['text', 'image'] }] });
		secondFaux.setResponses([
			(context) => {
				restoredMessages = structuredClone(context.messages);
				return fauxAssistantMessage([fauxText('The prior screenshot is still visible.')], {
					stopReason: 'stop',
				});
			},
		]);
		const secondRuntime = await start({
			agents: [ScreenshotAgent],
			db: sqlite(databasePath),
			providers: [secondFaux.provider],
			env: {},
		});
		try {
			const restored = init(ScreenshotAgent, { id: 'screenshot-restore' });
			await restored.read(await restored.dispatch('Revisit the screenshot.'));
			expect(restoredMessages).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						role: 'toolResult',
						content: expect.arrayContaining([
							{ type: 'image', data: screenshotData, mimeType: 'image/png' },
						]),
					}),
				]),
			);
		} finally {
			await secondRuntime.stop();
			await rm(directory, { recursive: true, force: true });
		}
	});

	it('rejects malformed, unsupported, and over-budget images instead of truncating them', () => {
		const tool = defineTool({ name: 'image', description: 'Return an image.', run() {} });
		const resolveImageContent = (content: unknown) => resolveToolRun(tool, { content } as never);

		expect(() =>
			resolveImageContent([
				{ type: 'image', data: 'data:image/png;base64,AAAA', mimeType: 'image/png' },
			]),
		).toThrow('must be non-empty RFC 4648 base64 without a data URL prefix');
		expect(() =>
			resolveImageContent([{ type: 'image', data: 'AAAA', mimeType: 'image/svg+xml' }]),
		).toThrow('must be image/png, image/jpeg, image/gif, or image/webp');

		const onePixel = { type: 'image', data: 'AAAA', mimeType: 'image/png' };
		expect(() =>
			resolveImageContent(Array.from({ length: MAX_TOOL_RESULT_IMAGES + 1 }, () => onePixel)),
		).toThrow(`exceeds the ${MAX_TOOL_RESULT_IMAGES}-image limit`);

		const oversized = 'AAAA'.repeat(MAX_TOOL_RESULT_IMAGE_BASE64_LENGTH / 4 + 1);
		expect(() =>
			resolveImageContent([{ type: 'image', data: oversized, mimeType: 'image/png' }]),
		).toThrow(`exceeds the ${MAX_TOOL_RESULT_IMAGE_BASE64_LENGTH}-character per-image limit`);

		const halfAggregate = 'AAAA'.repeat(MAX_TOOL_RESULT_IMAGE_TOTAL_BASE64_LENGTH / 8 + 1);
		expect(() =>
			resolveImageContent([
				{ type: 'image', data: halfAggregate, mimeType: 'image/png' },
				{ type: 'image', data: halfAggregate, mimeType: 'image/png' },
			]),
		).toThrow(`exceeds the ${MAX_TOOL_RESULT_IMAGE_TOTAL_BASE64_LENGTH}-character aggregate limit`);
	});
});

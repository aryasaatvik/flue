import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
	type AttachmentStore,
	createAttachmentRef,
	InMemoryAttachmentStore,
} from '../runtime/attachment-store.ts';
import { SqliteAttachmentStore } from '../sql-attachment-store.ts';
import type { SqlStorage } from '../sql-storage.ts';
import { type CloudflareAgentRuntime, createCloudflareAgentRuntime } from './agent-coordinator.ts';
import { type CloudflareAttachmentStoreContext, extend } from './extension.ts';
import { createFlueAgentClass } from './flue-agent-class.ts';

type Prepared = ReturnType<CloudflareAgentRuntime['prepare']>;

/** Durable Object SQLite storage over node:sqlite. */
function durableObjectStorage() {
	const db = new DatabaseSync(':memory:');
	const sql: SqlStorage = {
		exec(query, ...bindings) {
			const statement = db.prepare(query);
			const returnsRows = /^\s*(SELECT|WITH|PRAGMA)/i.test(query) || /\bRETURNING\b/i.test(query);
			if (!returnsRows) {
				statement.run(...(bindings as never[]));
				return { toArray: () => [] };
			}
			const rows = statement.all(...(bindings as never[])) as Record<string, unknown>[];
			return { toArray: () => rows };
		},
	};
	return { sql, transactionSync: <T>(closure: () => T): T => closure() };
}

/** Build the agent's Durable Object class and construct one instance. */
function constructAgent(extension: unknown): Prepared {
	const runtime = createCloudflareAgentRuntime({
		agents: [],
		createContext: () => {
			throw new Error('unused');
		},
		runWithInstanceContext: (_instance, _agentName, callback) => callback(),
	});
	let prepared: Prepared | undefined;
	const AgentClass = createFlueAgentClass({
		AgentBase: class {},
		runtime: {
			...runtime,
			prepare: (options) => {
				prepared = runtime.prepare(options);
				return prepared;
			},
			attach: () => {},
		},
		className: 'FlueScreenshotAgent',
		agentName: 'screenshot',
		extension,
	});
	new AgentClass(
		{ storage: durableObjectStorage(), id: { toString: () => 'do-id-1' } },
		{ BUCKET: 'bucket-binding' },
	);
	if (!prepared) throw new Error('The agent class did not prepare its stores.');
	return prepared;
}

describe('Cloudflare attachment store extension', () => {
	it('routes attachment put/get to the store the agent module supplies', async () => {
		const custom = new InMemoryAttachmentStore();
		const calls: string[] = [];
		const contexts: CloudflareAttachmentStoreContext[] = [];
		const recording: AttachmentStore = {
			put: (input) => {
				calls.push(`put:${input.attachment.id}`);
				return custom.put(input);
			},
			get: (input) => {
				calls.push(`get:${input.attachmentId}`);
				return custom.get(input);
			},
		};
		const prepared = constructAgent(
			extend({
				attachmentStore: (context) => {
					contexts.push(context);
					return recording;
				},
			}),
		);

		expect(prepared.attachmentStore).toBe(recording);
		expect(contexts).toEqual([
			{
				env: { BUCKET: 'bucket-binding' },
				agentName: 'screenshot',
				className: 'FlueScreenshotAgent',
				durableObjectId: 'do-id-1',
				sqlite: expect.any(SqliteAttachmentStore),
			},
		]);

		const bytes = Uint8Array.from([1, 2, 3]);
		const attachment = await createAttachmentRef({ id: 'att_1', mimeType: 'image/png', bytes });
		const streamPath = 'agents/screenshot/instance-1';
		await prepared.attachmentStore.put({
			streamPath,
			attachment,
			bytes,
			conversationId: 'conv_1',
		});
		const stored = await prepared.attachmentStore.get({
			streamPath,
			conversationId: 'conv_1',
			attachmentId: 'att_1',
		});
		expect(stored?.bytes).toEqual(bytes);
		expect(calls).toEqual(['put:att_1', 'get:att_1']);
		// The bytes live only in the supplied store, never in Durable Object SQLite.
		await expect(
			contexts[0]?.sqlite.get({ streamPath, conversationId: 'conv_1', attachmentId: 'att_1' }),
		).resolves.toBeNull();
	});

	it('defaults to Durable Object SQLite', () => {
		expect(constructAgent(undefined).attachmentStore).toBeInstanceOf(SqliteAttachmentStore);
	});

	it('rejects a non-function attachmentStore option', () => {
		expect(() => constructAgent(extend({ attachmentStore: 'r2' as never }))).toThrow(
			'cloudflare.attachmentStore must be a function',
		);
	});
});

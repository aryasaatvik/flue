import type { AgentSubmissionStore } from '../agent-execution-store.ts';
import { describeErrorChain, formatErrorForLog } from '../errors.ts';
import type { AttachmentStore } from '../runtime/attachment-store.ts';
import { SqliteConversationStreamStore } from '../runtime/conversation-stream-store.ts';
import {
	createSqlAgentExecutionStoreFromSql,
	ensureSqlAgentExecutionTables,
} from '../sql-agent-execution-store.ts';
import { ensureSqlAttachmentTable, SqliteAttachmentStore } from '../sql-attachment-store.ts';
import type { SqlStorage } from '../sql-storage.ts';

interface DurableObjectStorage {
	readonly sql?: SqlStorage;
	transactionSync?<T>(closure: () => T): T;
}

/**
 * Wrap a store-initialization failure so it survives the Durable Object
 * boundary. These wrappers run in the DO constructor: the throw tunnels
 * across `stub.fetch()` message-only, so the full cause chain is flattened
 * into the message, and the real error — stacks and all — is logged DO-side
 * first. That log line is the only place the original stack ever exists, and
 * the only coverage for alarm-driven wakes that have no HTTP caller at all.
 * The constructor-throw semantics stay: a DO that cannot open its storage
 * fails loudly and lets the platform re-instantiate on the next request.
 */
function initFailure(className: string, what: string, cause: unknown): Error {
	const wrapped = new Error(
		`[flue] Cloudflare durable agent class "${className}" could not initialize its ${what}. ` +
			`Underlying error: ${describeErrorChain(cause)}`,
		{ cause },
	);
	console.error(formatErrorForLog(wrapped));
	return wrapped;
}

/**
 * The conversation stores for one Durable Object. Attachments default to the
 * Durable Object's SQLite database; `createAttachmentStore` (from the agent
 * module's `extend({ attachmentStore })`) replaces that store and receives it
 * for composition.
 */
export function createSqlConversationStores(
	storage: DurableObjectStorage,
	className: string,
	createAttachmentStore?: (sqlite: AttachmentStore) => AttachmentStore,
) {
	const sql = storage.sql as SqlStorage;
	const transactionSync = storage.transactionSync as NonNullable<
		DurableObjectStorage['transactionSync']
	>;
	const runTransaction = <T>(closure: () => T): T => transactionSync.call(storage, closure) as T;
	let stores: { conversationStreamStore: SqliteConversationStreamStore; sqlite: AttachmentStore };
	try {
		ensureSqlAttachmentTable(sql);
		stores = {
			conversationStreamStore: new SqliteConversationStreamStore(sql, runTransaction),
			sqlite: new SqliteAttachmentStore(sql, runTransaction),
		};
	} catch (cause) {
		throw initFailure(className, 'SQLite conversation stores', cause);
	}
	if (!createAttachmentStore) {
		return {
			conversationStreamStore: stores.conversationStreamStore,
			attachmentStore: stores.sqlite,
		};
	}
	let attachmentStore: AttachmentStore;
	try {
		attachmentStore = createAttachmentStore(stores.sqlite);
		if (typeof attachmentStore?.put !== 'function' || typeof attachmentStore.get !== 'function') {
			throw new Error('cloudflare.attachmentStore must return an object with put() and get().');
		}
	} catch (cause) {
		throw initFailure(className, 'attachment store', cause);
	}
	return { conversationStreamStore: stores.conversationStreamStore, attachmentStore };
}

export function createSqlAgentExecutionStore(
	storage: DurableObjectStorage | undefined,
	className: string,
): AgentSubmissionStore {
	const sql = storage?.sql;
	const transactionSync = storage?.transactionSync;
	if (!sql || typeof sql.exec !== 'function' || typeof transactionSync !== 'function') {
		throw new Error(
			`[flue] Cloudflare durable agent class "${className}" requires Durable Object SQLite. ` +
				`Add "${className}" to a Wrangler migration's "new_sqlite_classes" list before its first deploy; ` +
				`do not use legacy "new_classes". Existing KV-backed Durable Object classes cannot be converted ` +
				`to SQLite in place.`,
		);
	}
	try {
		ensureSqlAgentExecutionTables(sql);
		const runTransaction = <T>(closure: () => T): T => transactionSync.call(storage, closure) as T;
		return createSqlAgentExecutionStoreFromSql(sql, runTransaction);
	} catch (cause) {
		throw initFailure(className, 'SQLite execution store', cause);
	}
}

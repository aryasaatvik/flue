import type { DurableObject } from 'cloudflare:workers';
import type { AttachmentStore } from '../runtime/attachment-store.ts';

const CLOUDFLARE_EXTENSION = Symbol.for('@flue/runtime/cloudflare-extension');

/**
 * Minimal structural view of the Cloudflare Agents SDK `Agent` base class
 * that Flue passes to `extend()` callbacks. `@flue/runtime` does not depend
 * on the `agents` package, so this models the documented extension surface
 * (state, lifecycle, scheduling, queueing) instead of importing the real
 * class. Pass an explicit `TBase` to `extend()` to type against a richer
 * class shape.
 */
export interface CloudflareAgentLike<State = Record<string, unknown>> {
	state: State;
	setState(state: State): void;
	onStart(props?: Record<string, unknown>): Promise<void> | void;
	schedule<T = string>(
		when: Date | string | number,
		callback: keyof this,
		payload?: T,
		options?: { retry?: unknown; idempotent?: boolean },
	): Promise<unknown>;
	scheduleEvery<T = string>(
		intervalSeconds: number,
		callback: keyof this,
		payload?: T,
		options?: { retry?: unknown },
	): Promise<unknown>;
	queue<T = unknown>(
		callback: keyof this,
		payload: T,
		options?: { retry?: unknown },
	): Promise<string>;
}

export type ExtensionClass<TInstance extends object = CloudflareAgentLike> = new (
	...args: any[]
) => TInstance;

/**
 * The class shape Flue hands to `base` and `wrap`: every class the generated
 * Cloudflare entry passes in extends the Agents SDK `Agent`, which is a real,
 * branded `DurableObject`. The `cloudflare:workers` import is type-only, so
 * this module's runtime graph stays free of that virtual module; consumers of
 * `@flue/runtime/cloudflare` are expected to have Cloudflare's workers types
 * configured (any Wrangler project does).
 *
 * This is deliberately a concrete constructor type rather than a
 * `<TClass extends ...>` generic: inside a generic callback the class is an
 * opaque type parameter, and TypeScript will not infer a downstream wrapper's
 * type parameters (e.g. Sentry's `instrumentDurableObjectWithSentry`) from a
 * type parameter's constraint, so a generic signature here forces consumers
 * back to the runtime assertions this type exists to eliminate.
 */
export type GeneratedDurableObjectClass<
	TInstance extends object = CloudflareAgentLike,
	TEnv = any,
> = new (ctx: DurableObjectState, env: TEnv) => TInstance & DurableObject<TEnv>;

/** What an `extend({ attachmentStore })` factory receives, once per Durable Object instance. */
export interface CloudflareAttachmentStoreContext<TEnv = any> {
	/** The Worker's bindings, as passed to the Durable Object constructor. */
	readonly env: TEnv;
	/** The agent's durable identity, e.g. `triage`. */
	readonly agentName: string;
	/** The generated Durable Object class name, e.g. `FlueTriageAgent`. */
	readonly className: string;
	/** `DurableObjectState.id.toString()`: unique per agent instance. */
	readonly durableObjectId: string;
	/**
	 * The built-in Durable Object SQLite store — the default when no factory
	 * is given. Compose with it, for example to keep reading attachments
	 * written before switching stores.
	 */
	readonly sqlite: AttachmentStore;
}

export interface CloudflareExtension<TBase extends object = CloudflareAgentLike, TEnv = any> {
	base?: (Base: GeneratedDurableObjectClass<TBase, TEnv>) => ExtensionClass<TBase>;
	wrap?: (
		Final: GeneratedDurableObjectClass<TBase, TEnv>,
	) => GeneratedDurableObjectClass<TBase, TEnv>;
	/**
	 * Store attachment bytes (user-message images, tool-result images)
	 * somewhere other than the Durable Object's SQLite database, such as R2.
	 * Called synchronously once per Durable Object instance, before the
	 * instance handles any work. Every attachment written through the store
	 * must be readable through it for the life of the conversation; `get`
	 * returns `null` for an unknown attachment. Attachment keys are already
	 * namespaced by the `streamPath` (agent and instance) in each call.
	 * Implementations should check bytes with `verifyAttachmentBytes` from
	 * `@flue/runtime/adapter` on `put` and `get`.
	 */
	attachmentStore?: (context: CloudflareAttachmentStoreContext<TEnv>) => AttachmentStore;
}

interface BrandedCloudflareExtension extends CloudflareExtension<any> {
	[CLOUDFLARE_EXTENSION]: true;
}

/** Runtime-resolved extension; classes are opaque to the generated entry. */
export interface ResolvedCloudflareExtension {
	base(Base: ExtensionClass<any>): ExtensionClass<any>;
	wrap(Final: ExtensionClass<any>): ExtensionClass<any>;
	attachmentStore?: (context: CloudflareAttachmentStoreContext) => AttachmentStore;
}

const EXTENSION_OPTIONS = new Set(['base', 'wrap', 'attachmentStore']);

export function extend<TBase extends object = CloudflareAgentLike, TEnv = any>(
	extension: CloudflareExtension<TBase, TEnv>,
): CloudflareExtension<TBase, TEnv> {
	if (typeof extension !== 'object' || extension === null || Array.isArray(extension)) {
		throw new Error(
			'[flue] extend() expects an object containing optional base, wrap, and attachmentStore callbacks.',
		);
	}
	const unknownKeys = Object.keys(extension).filter((key) => !EXTENSION_OPTIONS.has(key));
	if (unknownKeys.length > 0) {
		throw new Error(`[flue] extend() received unknown option(s): ${unknownKeys.join(', ')}.`);
	}
	const branded: BrandedCloudflareExtension = {
		...extension,
		[CLOUDFLARE_EXTENSION]: true,
	};
	return branded;
}

export function resolveCloudflareExtension(
	mod: Record<string, unknown>,
	name: string,
	kind: 'Agent',
): ResolvedCloudflareExtension {
	const extension = mod.cloudflare;
	if (extension === undefined) return { base: identity, wrap: identity };
	if (!isCloudflareExtension(extension)) {
		throw new Error(
			`[flue] ${kind} "${name}" cloudflare export must be created with extend({ base, wrap }) from "@flue/runtime/cloudflare".`,
		);
	}
	const base = extension.base === undefined ? identity : extension.base;
	const wrap = extension.wrap === undefined ? identity : extension.wrap;
	if (typeof base !== 'function') {
		throw new Error(`[flue] ${kind} "${name}" cloudflare.base must be a function.`);
	}
	if (typeof wrap !== 'function') {
		throw new Error(`[flue] ${kind} "${name}" cloudflare.wrap must be a function.`);
	}
	const attachmentStore = extension.attachmentStore;
	if (attachmentStore !== undefined && typeof attachmentStore !== 'function') {
		throw new Error(`[flue] ${kind} "${name}" cloudflare.attachmentStore must be a function.`);
	}
	return {
		...(attachmentStore ? { attachmentStore } : {}),
		base(Base) {
			return assertExtensionClass(base(Base), Base, name, kind);
		},
		wrap(Final) {
			return assertExtensionWrapper(wrap(Final), Final, name, kind);
		},
	};
}

function identity<T>(value: T): T {
	return value;
}

function isCloudflareExtension(value: unknown): value is CloudflareExtension<any> {
	return (
		typeof value === 'object' &&
		value !== null &&
		CLOUDFLARE_EXTENSION in value &&
		(value as BrandedCloudflareExtension)[CLOUDFLARE_EXTENSION] === true
	);
}

function assertExtensionClass(
	value: unknown,
	Base: ExtensionClass<any>,
	name: string,
	kind: string,
): ExtensionClass<any> {
	if (
		typeof value !== 'function' ||
		(value !== Base && !(value.prototype instanceof Base)) ||
		!isConstructable(value as ExtensionClass<any>)
	) {
		throw new Error(
			`[flue] ${kind} "${name}" cloudflare.base must return the received class or a subclass.`,
		);
	}
	return value as ExtensionClass<any>;
}

function assertExtensionWrapper(
	value: unknown,
	Final: ExtensionClass<any>,
	name: string,
	kind: string,
): ExtensionClass<any> {
	if (
		typeof value !== 'function' ||
		(value !== Final && value.prototype !== Final.prototype) ||
		!isConstructable(value as ExtensionClass<any>)
	) {
		throw new Error(
			`[flue] ${kind} "${name}" cloudflare.wrap(Final) must return the received class or a constructor proxy.`,
		);
	}
	return value as ExtensionClass<any>;
}

function isConstructable(value: ExtensionClass<any>): boolean {
	try {
		Reflect.construct(Function, [], value);
		return true;
	} catch {
		return false;
	}
}

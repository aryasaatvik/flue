import { describe, expect, it } from 'vitest';
import { resolveFlueProject } from './config.ts';

describe('provider ID aliases', () => {
	it('normalizes a renamed provider ID in the resolved project', () => {
		const project = resolveFlueProject({
			root: '/tmp/flue-config-aliases',
			config: { providers: ['anthropic', 'azure-openai-responses'] },
		});
		expect(project.providers).toEqual(['anthropic', 'azure']);
	});

	it('leaves current provider IDs unchanged', () => {
		const project = resolveFlueProject({
			root: '/tmp/flue-config-aliases',
			config: { providers: ['anthropic', 'azure'] },
		});
		expect(project.providers).toEqual(['anthropic', 'azure']);
	});
});

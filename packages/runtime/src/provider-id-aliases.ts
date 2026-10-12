/**
 * Pi provider IDs that were renamed upstream, mapped to their current ID.
 *
 * Pi's catalogs and provider modules are keyed by provider ID, and Flue passes
 * those IDs through in the `providers` config and in `provider/model`
 * specifiers. When Pi renames an ID, the old one is kept here so existing
 * projects keep building and resolving instead of failing on an import or an
 * unknown-provider error.
 *
 * Every alias is deprecated. TODO(flue): remove each alias and this module in
 * the next major release, along with the `providers` docs and warning that
 * mention them.
 */

const PROVIDER_ID_ALIASES: Readonly<Record<string, string>> = {
	/**
	 * @deprecated Pi 1.0.3 renamed the Azure provider to `azure`. Use `azure`.
	 */
	'azure-openai-responses': 'azure',
};

/** Resolve a possibly-renamed provider ID to the ID Flue registers it under. */
export function canonicalProviderId(providerId: string): string {
	return PROVIDER_ID_ALIASES[providerId] ?? providerId;
}

/**
 * Minimal ambient shim for the ONE runtime value we import from the `openclaw`
 * peer: `definePluginEntry`. All TYPES live in `./openclaw-types.ts` (a real
 * module shipped in dist), so nothing in our emitted `.d.ts` ever references
 * this module's type names — consumers typecheck without the peer installed.
 *
 * Note: this ambient declaration shadows the real package's types at build
 * time. That is deliberate — the real `plugin-sdk/plugin-entry` subpath does
 * not re-export the event/context types under stable names, so we compile
 * against our source-verified local copies instead.
 */
declare module "openclaw/plugin-sdk/plugin-entry" {
  export function definePluginEntry(
    options: import("./openclaw-types.js").DefinePluginEntryOptions,
  ): import("./openclaw-types.js").DefinedPluginEntry;
}

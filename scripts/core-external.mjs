export const CORE_PACKAGE = "@dataforxyz/agent-intercom-core";

// Match the package root and every exported (or future) subpath without
// accidentally externalizing similarly named packages.
export const CORE_IMPORT_PATTERN = /^@dataforxyz\/agent-intercom-core(?:\/.*)?$/;

export function isCoreImport(specifier) {
  return CORE_IMPORT_PATTERN.test(specifier);
}

export const externalizeCorePlugin = {
  name: "externalize-agent-intercom-core",
  setup(build) {
    build.onResolve({ filter: CORE_IMPORT_PATTERN }, (args) => ({
      path: args.path,
      external: true,
    }));
  },
};

// Lets plain Node (with its built-in type stripping) run app TypeScript
// outside Next: maps "@/..." to src/ and resolves extensionless relative
// imports to .ts files, matching tsconfig's "bundler" resolution.
// Used by `pnpm test` and the db scripts: node --import ./scripts/ts-paths.mjs
//
// It also resolves "server-only" with the "react-server" condition, the way
// Next does for server code, so it loads the package's empty module instead
// of throwing. Only that one specifier gets the condition: running all of
// Node with --conditions=react-server would also switch react and other
// packages to their server builds.
import { existsSync, statSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = new URL("../", import.meta.url);
const srcUrl = new URL("src/", root);
const nodeModules = new URL("node_modules/", root).href;
const EXTENSIONS = [".ts", ".tsx", "/index.ts", "/index.tsx"];

function isFile(url) {
  const path = fileURLToPath(url);
  return existsSync(path) && statSync(path).isFile();
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return nextResolve(specifier, {
        ...context,
        conditions: [...context.conditions, "react-server"],
      });
    }
    const parent = context.parentURL;
    const fromApp =
      parent?.startsWith(root.href) && !parent.startsWith(nodeModules);
    let base;
    if (specifier.startsWith("@/")) {
      base = new URL(specifier.slice(2), srcUrl);
    } else if (
      fromApp &&
      (specifier.startsWith("./") || specifier.startsWith("../"))
    ) {
      base = new URL(specifier, parent);
    }
    if (base && !isFile(base)) {
      const ext = EXTENSIONS.find((e) =>
        isFile(pathToFileURL(fileURLToPath(base) + e)),
      );
      if (ext) base = pathToFileURL(fileURLToPath(base) + ext);
    }
    const result = nextResolve(base ? base.href : specifier, context);
    // App .ts files use ESM syntax but package.json has no "type", so say
    // so up front instead of letting Node guess (and warn).
    if (
      result.url.startsWith(root.href) &&
      !result.url.startsWith(nodeModules) &&
      /\.tsx?$/.test(result.url)
    ) {
      return { ...result, format: "module-typescript" };
    }
    return result;
  },
});

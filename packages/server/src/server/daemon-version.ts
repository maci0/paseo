import { createRequire } from "node:module";
import { PackageVersionResolutionError, resolvePackageVersion } from "./package-version.js";

const require = createRequire(import.meta.url);

const SERVER_PACKAGE_NAME = "@getpaseo/server";

export class DaemonVersionResolutionError extends PackageVersionResolutionError {}

export function resolveDaemonVersion(moduleUrl: string = import.meta.url): string {
  // A scriptc binary embeds the package.json a literal require names; its import.meta.url
  // is the source path on the build machine, where there may be no package.json.
  if (process.argv[0] === "scriptc") {
    const packageJson = require("../../package.json") as { version: string };
    return packageJson.version;
  }
  try {
    return resolvePackageVersion({
      moduleUrl,
      packageName: SERVER_PACKAGE_NAME,
    });
  } catch (error) {
    if (error instanceof PackageVersionResolutionError) {
      throw new DaemonVersionResolutionError({
        moduleUrl,
        packageName: SERVER_PACKAGE_NAME,
      });
    }
    throw error;
  }
}

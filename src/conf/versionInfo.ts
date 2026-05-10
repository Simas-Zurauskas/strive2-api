import { readFileSync } from 'fs';
import path from 'path';
import { ENVIRONMENT } from './env';

// Read name + version from the actual package.json so the value can never
// drift from the published artifact. The lookup is one-shot at module load
// (cheap, file is small) and the result is reused for every /version request.
//
// `path.resolve(__dirname, '..', '..', 'package.json')` works in BOTH the
// dev runtime (where __dirname is .../src/conf) AND in the production build
// (where it's .../build/conf), because in both cases package.json sits one
// directory above the build root. tsc-alias doesn't rewrite path.resolve
// so this stays portable.
const packageJsonPath = path.resolve(__dirname, '..', '..', 'package.json');

interface PackageJsonShape {
  name?: string;
  version?: string;
}

let pkg: PackageJsonShape = {};
try {
  pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as PackageJsonShape;
} catch {
  // Boot-time package.json read failed — keep going with empty defaults
  // rather than crashing the API. The /version endpoint will report
  // "unknown" and the rest of the system is unaffected.
}

export interface VersionInfo {
  service: string;
  version: string;
  /** Server-side rendered "now" — handy for clock-skew debugging. */
  serverTime: string;
  environment: string;
  /** Node major version. Cheap signal for "did the runtime change unexpectedly". */
  nodeVersion: string;
  /** Process uptime in seconds. Useful to spot a flapping pod / restart loop. */
  uptimeSeconds: number;
}

export const getVersionInfo = (): VersionInfo => {
  return {
    service: pkg.name ?? 'strive.api',
    version: pkg.version ?? '0.0.0',
    serverTime: new Date().toISOString(),
    environment: ENVIRONMENT,
    nodeVersion: process.versions.node,
    uptimeSeconds: Math.round(process.uptime()),
  };
};

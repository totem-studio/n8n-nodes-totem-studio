import { cp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildPublicPackage, PUBLIC_PACKAGE_DIRECTORY } from './build-public-package.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
await buildPublicPackage(PUBLIC_PACKAGE_DIRECTORY, { standalone: true });
await rm(new URL('dist/', new URL('../', import.meta.url)), { recursive: true, force: true });
await cp(PUBLIC_PACKAGE_DIRECTORY + '/dist', root + '/dist', { recursive: true });

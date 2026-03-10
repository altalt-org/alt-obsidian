import { readFile, writeFile } from 'node:fs/promises';

const packageJsonPath = new URL('./package.json', import.meta.url);
const manifestJsonPath = new URL('./manifest.json', import.meta.url);
const versionsJsonPath = new URL('./versions.json', import.meta.url);

const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
const manifestJson = JSON.parse(await readFile(manifestJsonPath, 'utf8'));
const versionsJson = JSON.parse(await readFile(versionsJsonPath, 'utf8'));

manifestJson.version = packageJson.version;
versionsJson[packageJson.version] = manifestJson.minAppVersion;

await writeFile(manifestJsonPath, `${JSON.stringify(manifestJson, null, '\t')}\n`);
await writeFile(versionsJsonPath, `${JSON.stringify(versionsJson, null, '\t')}\n`);

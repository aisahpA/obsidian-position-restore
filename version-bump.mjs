// Version bump script
// Usage: node version-bump.mjs <major.minor.patch>
//
// Updates manifest.json / versions.json and prints the new version to stdout.
// Nothing else carries the plugin's number: see "Why not package.json" below.
//
// There is no way to ask this script for a version: a release here is named by
// hand — merge to main, say which version this is, tag it, push — and letting
// software count instead would put the decision somewhere nobody can review it.
// All the script does is write that one number into the files that carry it.
import { readFileSync, writeFileSync } from 'node:fs';

const arg = process.argv[2];

// Anything that is not three dot-separated numbers is a typo worth stopping
// for — including leaving the argument out entirely, which had nowhere else
// to be noticed.
if (!arg || !/^\d+\.\d+\.\d+$/.test(arg)) {
	console.error('version-bump: usage — node version-bump.mjs <major.minor.patch>');
	process.exit(1);
}

// Source of truth for the CURRENT version is manifest.json.
const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));

// Naming the version by hand invites one mistake: typing the number you are
// already on — or an older one — and cutting a release that claims to be
// something it is not. Nothing else checks it, so this script does.
const isAhead = (a, b) => {
	const [x, y, z] = a.split('.').map(Number);
	const [p, q, r] = b.split('.').map(Number);
	return x !== p ? x > p : y !== q ? y > q : z > r;
};

if (!isAhead(arg, manifest.version)) {
	console.error(`version-bump: ${arg} is not ahead of the current ${manifest.version}`);
	process.exit(1);
}

// Why not package.json / package-lock.json: they are npm's business, and this
// package is never published to npm — no `npm publish`, no consumer resolving
// a version range. Obsidian reads manifest.json and nothing else, and the
// release workflow compares the tag against that same file. Keeping a second
// copy of the number bought nothing but four files touched per release and a
// lock file that churns on its own; left alone, npm happily rewrites those
// fields whenever it installs, for a project whose version lives elsewhere.
// So their version is pinned once and forgotten.

// manifest.json (tab indented)
manifest.version = arg;
writeFileSync('manifest.json', JSON.stringify(manifest, null, '\t') + '\n');

// versions.json: map plugin version -> minAppVersion (tab indented). This one
// Obsidian DOES read — it is how an older app knows the last version it can
// still install — which is why it stays in step with the manifest.
const versions = JSON.parse(readFileSync('versions.json', 'utf8'));
versions[arg] = manifest.minAppVersion;
writeFileSync('versions.json', JSON.stringify(versions, null, '\t') + '\n');

// Print the new version so the workflow (or a shell) can capture it.
console.log(arg);

// Version bump script
// Usage: node version-bump.mjs [patch|minor|major]
//   - patch (default): x.y.Z +1
//   - minor: x.Y.0
//   - major: X.0.0
// Updates manifest.json / package.json / package-lock.json / versions.json
// and prints the new version to stdout.
import { readFileSync, writeFileSync } from "fs";

// Bump type: "patch" (default), "minor" or "major".
const bumpType = process.argv[2] || "patch";

// Source of truth for the current version is manifest.json.
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const [major, minor, patch] = manifest.version.split(".").map(Number);

let next;
if (bumpType === "major") next = `${major + 1}.0.0`;
else if (bumpType === "minor") next = `${major}.${minor + 1}.0`;
else next = `${major}.${minor}.${patch + 1}`;

// manifest.json (tab indented)
manifest.version = next;
writeFileSync("manifest.json", JSON.stringify(manifest, null, "\t") + "\n");

// package.json (2-space indented)
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
pkg.version = next;
writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");

// package-lock.json: update root package version (2-space indented)
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
lock.version = next;
lock.packages[""].version = next;
writeFileSync("package-lock.json", JSON.stringify(lock, null, 2) + "\n");

// versions.json: map plugin version -> minAppVersion (tab indented)
const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[next] = manifest.minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, "\t") + "\n");

// Print the new version so the workflow can capture it.
console.log(next);

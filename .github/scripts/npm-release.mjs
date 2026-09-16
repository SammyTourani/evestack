import { appendFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function releaseTarget(tag, root = process.cwd()) {
  const match = /^(@[a-z0-9-]+\/[a-z0-9-]+|[a-z0-9-]+)@(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(tag);
  if (!match) throw new Error('Use an existing stable package@x.y.z release tag.');
  const name = match[1];
  const version = match.slice(2).join('.');
  const manifests = readdirSync(join(root, 'packages'), { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .flatMap(entry => {
      const directory = `packages/${entry.name}`;
      try { return [{ directory, ...JSON.parse(readFileSync(join(root, directory, 'package.json'), 'utf8')) }]; }
      catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    });
  const pkg = manifests.find(pkg => pkg.name === name);
  if (!pkg || pkg.private) throw new Error(`Not a public npm package: ${name}`);
  if (pkg.version !== version) throw new Error(`Tag ${version} differs from ${name}'s manifest ${pkg.version}`);
  const required = new Map();
  for (const [dep, range] of Object.entries(pkg.dependencies ?? {})) {
    if (range.startsWith('workspace:')) {
      const internal = manifests.find(p => p.name === dep);
      if (!internal || internal.private) throw new Error(`Invalid workspace dependency: ${dep}`);
      required.set(dep, internal.version);
    }
  }
  if (name === 'create-evestack') {
    const template = JSON.parse(readFileSync(join(root, 'templates/default/package.json'), 'utf8'));
    for (const dep of Object.keys(template.dependencies ?? {}).filter(n => n.startsWith('@evestack/'))) {
      const internal = manifests.find(p => p.name === dep);
      if (!internal || internal.private) throw new Error(`Invalid template dependency: ${dep}`);
      required.set(dep, internal.version);
    }
  }
  return { name, version, directory: pkg.directory, required: Object.fromEntries(required) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const tag = process.env.RELEASE_TAG ?? '';
  const target = releaseTarget(tag);
  // Manual runs must select the immutable release tag too; a branch with the
  // same manifest version is not the source named by that release.
  const tagged = execFileSync('git', ['rev-parse', `refs/tags/${tag}^{commit}`], { encoding: 'utf8' }).trim();
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (head !== tagged) throw new Error('Run this workflow on its release tag, not on a branch.');
  execFileSync('git', ['merge-base', '--is-ancestor', head, 'origin/main']);
  for (const [dep, version] of Object.entries(target.required)) {
    const published = JSON.parse(execFileSync('npm', ['view', `${dep}@${version}`, 'version', '--json'], { encoding: 'utf8' }));
    if (published !== version) throw new Error(`Publish ${dep}@${version} before ${target.name}`);
  }
  appendFileSync(process.env.GITHUB_OUTPUT, `directory=${target.directory}\nname=${target.name}\nversion=${target.version}\n`);
}

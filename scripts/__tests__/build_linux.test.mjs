import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = fileURLToPath(new URL('../../', import.meta.url));

async function fixture(t, distro = 'arch') {
  // Exercise the real shell control flow with fake compilers/package managers.
  // The fixture intentionally has spaces in its project and Cargo target paths.
  const root = await mkdtemp(path.join(tmpdir(), 'petgpt linux test '));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ['scripts/linux', 'src-tauri/icons', 'src-tauri/assets', 'node_modules/.bin', 'bin']) {
    await mkdir(path.join(root, dir), { recursive: true });
  }
  await writeFile(path.join(root, 'os-release'), `ID=${distro}\nPRETTY_NAME="Test ${distro}"\n`);
  const script = (await readFile(path.join(repo, 'scripts/build-linux.sh'), 'utf8'))
    .replaceAll('/etc/os-release', path.join(root, 'os-release'))
    .replace('[[ -r ' + path.join(root, 'os-release') + ' ]]', '[[ -r "' + path.join(root, 'os-release') + '" ]]')
    .replace('source ' + path.join(root, 'os-release'), 'source "' + path.join(root, 'os-release') + '"');
  await writeFile(path.join(root, 'scripts/build-linux.sh'), script);
  await cp(path.join(repo, 'scripts/linux'), path.join(root, 'scripts/linux'), { recursive: true });
  await writeFile(path.join(root, 'src-tauri/tauri.conf.json'), JSON.stringify({ version: '1.2.3', productName: 'PetGPT' }));
  await writeFile(path.join(root, 'LICENSE'), 'license');
  await writeFile(path.join(root, 'scripts/export_intent_training.mjs'), 'export script');
  await writeFile(path.join(root, 'src-tauri/assets/skin.png'), 'skin');
  for (const icon of ['32x32.png', '128x128.png', '128x128@2x.png']) {
    await writeFile(path.join(root, 'src-tauri/icons', icon), 'icon');
  }
  await writeFile(path.join(root, 'node_modules/.bin/tauri'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const stub = `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
const root=process.env.FIXTURE_ROOT,name=path.basename(process.argv[1]),args=process.argv.slice(2);
fs.appendFileSync(path.join(root,'calls.jsonl'),JSON.stringify({name,args})+'\\n');
if(name==='rustc') console.log('host: x86_64-unknown-linux-gnu');
if(name==='pkg-config'&&args.includes(process.env.FAIL_LIBRARY)) process.exit(1);
if(name==='cargo') console.log(JSON.stringify({target_directory:path.join(root,'cargo target')}));
if(name==='dpkg') console.log('amd64');
if(name==='npm'&&args.includes('build')) {
 const build=path.join(root,'cargo target/x86_64-unknown-linux-gnu/release');
 fs.mkdirSync(build,{recursive:true});fs.writeFileSync(path.join(build,'petgpt'),'binary',{mode:0o755});
 if(args.includes('deb')) {const d=path.join(build,'bundle/deb');fs.mkdirSync(d,{recursive:true});fs.writeFileSync(path.join(d,'PetGPT_1.2.3_amd64.deb'),'deb');}
}
if(name==='makepkg') {
 const p=path.join(process.cwd(),'payload');
 for(const f of ['usr/bin/petgpt','usr/lib/PetGPT/assets/skin.png','usr/lib/PetGPT/scripts/export_intent_training.mjs','usr/share/applications/petgpt.desktop','usr/share/licenses/petgpt/LICENSE','usr/share/icons/hicolor/256x256/apps/petgpt.png']) if(!fs.existsSync(path.join(p,f))) throw Error('Missing payload '+f);
 const pkg=fs.readFileSync('PKGBUILD','utf8');if(!pkg.includes('pkgver=1.2.3')||pkg.includes('@ARCH@'))throw Error('Wrong metadata');
 fs.writeFileSync(path.join(process.env.PKGDEST,'petgpt-1.2.3-1-x86_64.pkg.tar.zst'),'arch');
}
`;
  for (const command of ['npm', 'cargo', 'rustc', 'pkg-config', 'cc', 'makepkg', 'fakeroot', 'dpkg', 'dpkg-deb', 'patchelf', 'sudo']) {
    await writeFile(path.join(root, 'bin', command), stub, { mode: 0o755 });
  }
  const run = (args = [], extraEnv = {}) => spawnSync('bash', [path.join(root, 'scripts/build-linux.sh'), ...args], {
    cwd: tmpdir(), encoding: 'utf8', env: { ...process.env, PATH: `${path.join(root, 'bin')}:${process.env.PATH}`, FIXTURE_ROOT: root, ...extraEnv },
  });
  const calls = async () => (await readFile(path.join(root, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  return { root, run, calls };
}

test('Arch packages carry icons, license, skin assets and scripts, including paths with spaces', async (t) => {
  const f = await fixture(t);
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(await readFile(path.join(f.root, 'release/linux/petgpt-1.2.3-1-x86_64.pkg.tar.zst'), 'utf8'), 'arch');
  const calls = await f.calls();
  const build = calls.find(c => c.name === 'npm' && c.args.includes('build'));
  assert.ok(build.args.includes('--no-bundle'));
  assert.ok(build.args.includes('--locked'));
  assert.ok(calls.some(c => c.name === 'npm' && c.args[0] === 'ci'));
  assert.ok(!calls.some(c => c.name === 'sudo'));
  assert.match(r.stdout, /sudo pacman -U/);
});

test('Ubuntu delegates Debian packaging to Tauri and copies the matching version', async (t) => {
  const f = await fixture(t, 'ubuntu');
  const r = f.run(['--format', 'deb', '--skip-npm-ci']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(await readFile(path.join(f.root, 'release/linux/PetGPT_1.2.3_amd64.deb'), 'utf8'), 'deb');
  const calls = await f.calls();
  assert.ok(calls.some(c => c.name === 'npm' && c.args.includes('--bundles') && c.args.includes('deb')));
  assert.ok(!calls.some(c => c.name === 'makepkg' || c.name === 'sudo' || c.args[0] === 'ci'));
  assert.match(r.stdout, /sudo apt install/);
});

test('--check does not build, install dependencies, or touch the output directory', async (t) => {
  const f = await fixture(t);
  const r = f.run(['--check']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!(await f.calls()).some(c => ['npm', 'makepkg', 'cargo', 'sudo'].includes(c.name)));
  await assert.rejects(readFile(path.join(f.root, 'release/linux')));
});

test('missing native libraries report an actionable dependency command before compiling', async (t) => {
  const f = await fixture(t, 'ubuntu');
  const r = f.run([], { FAIL_LIBRARY: 'webkit2gtk-4.1' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /webkit2gtk-4\.1/);
  assert.match(r.stderr, /sudo apt-get install/);
  assert.ok(!(await f.calls()).some(c => c.name === 'npm'));
});

test('cross-distro packages and ambiguous check/install requests are rejected', async (t) => {
  const f = await fixture(t);
  assert.match(f.run(['--format', 'deb']).stderr, /matching distro family/);
  assert.match(f.run(['--check', '--install-deps']).stderr, /cannot be combined/);
  assert.match(f.run(['--format']).stderr, /requires a value/);
  assert.match(f.run(['--wat']).stderr, /Unknown option/);
});

test('dependency installation is opt-in and restricted to the package-manager step', async (t) => {
  const f = await fixture(t, 'ubuntu');
  const r = f.run(['--install-deps']);
  assert.equal(r.status, 0, r.stderr);
  const sudoCalls = (await f.calls()).filter(c => c.name === 'sudo');
  assert.deepEqual(sudoCalls[0].args, ['apt-get', 'update']);
  assert.deepEqual(sudoCalls[1].args.slice(0, 2), ['apt-get', 'install']);
  assert.equal(sudoCalls.length, 2);
});

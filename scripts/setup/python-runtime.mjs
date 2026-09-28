import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// The Elentra scripts are Python. Like Node in the launchers, setup installs a pinned,
// checksummed Python inside the ignored .tools folder instead of relying on whatever the
// computer has (Windows Store stubs, versions without package wheels, or nothing at all).
// Both sources below include pip and venv and need no installer or admin rights:
// - Windows: python.org's own build, published as the "python"/"pythonarm64" NuGet packages.
//   Its binaries are PSF-signed; Windows Smart App Control blocks the unsigned DLLs of other
//   portable builds ("An Application Control policy has blocked this file").
// - macOS: python-build-standalone "install_only" archives.
// Each SHA-256 was computed from the download and matched against a second published source
// (NuGet's catalog SHA-512, and the release's SHA256SUMS plus GitHub's asset digest).
export const PYTHON_VERSION = '3.13.15';
const STANDALONE_RELEASE = '20260924';
export const PYTHON_BUILDS = {
  'win32-x64': { nuget: 'python', sha256: '05357887df50d3153efc681bdf432c321d3e2f9ce5788f99f4515b27e8fda0ac' },
  'win32-arm64': { nuget: 'pythonarm64', sha256: '3c1b1fdf56adc14634165df922d447520aefdc4a8411a34c34d8a062a4edf494' },
  'darwin-x64': { triple: 'x86_64-apple-darwin', sha256: 'f445e867ad221c006af745bc0e8d2c168149e14fe194abef1d7ac0da9a4c9de1' },
  'darwin-arm64': { triple: 'aarch64-apple-darwin', sha256: 'a18e1d1b6067d39cf7b2b605fdb78ad6b8a3aed221c44ef934d399dccf355453' }
};

const root = fileURLToPath(new URL('../../', import.meta.url));
export const venvDir = path.join(root, '.venv');
export const elentraDir = path.join(root, 'elentra');

export function pythonBuild(platform = process.platform, arch = process.arch) {
  const build = PYTHON_BUILDS[`${platform}-${arch}`];
  if (!build) throw new Error(`No pinned Python build for ${platform}/${arch}. Ask IT to install Python ${PYTHON_VERSION}, then report this to the maintainer.`);
  if (build.nuget) {
    const archive = `${build.nuget}.${PYTHON_VERSION}.nupkg`;
    return {
      ...build,
      archive,
      url: `https://api.nuget.org/v3-flatcontainer/${build.nuget}/${PYTHON_VERSION}/${archive}`,
      extracted: 'tools',
      home: path.join(root, '.tools', `python-${PYTHON_VERSION}-${build.nuget}`)
    };
  }
  const archive = `cpython-${PYTHON_VERSION}+${STANDALONE_RELEASE}-${build.triple}-install_only.tar.gz`;
  return {
    ...build,
    archive,
    url: `https://github.com/astral-sh/python-build-standalone/releases/download/${STANDALONE_RELEASE}/${encodeURIComponent(archive)}`,
    extracted: 'python',
    home: path.join(root, '.tools', `python-${PYTHON_VERSION}-${STANDALONE_RELEASE}-${build.triple}`)
  };
}

// Windows' own bsdtar reads both .nupkg (zip) and .tar.gz; a GNU tar earlier on PATH (for
// example Git's) cannot read zip archives, so Windows names the system copy explicitly.
function tarCommand(platform = process.platform) {
  return platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
}

export function basePython(home, platform = process.platform) {
  return platform === 'win32' ? path.join(home, 'python.exe') : path.join(home, 'bin', 'python3');
}

export function venvPython(dir = venvDir, platform = process.platform) {
  return platform === 'win32' ? path.join(dir, 'Scripts', 'python.exe') : path.join(dir, 'bin', 'python');
}

function run(label, command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', timeout: 900_000, ...options });
  if (result.error || result.status !== 0) {
    throw new Error(`${label} failed (${result.error?.message ?? `exit ${result.status}`}). Check the message above and your network/IT permissions, then rerun npm run setup:elentra.`);
  }
}

// Windows antivirus briefly holds freshly extracted executables open, so renaming their
// folder fails with EPERM/EBUSY. Retry for a few seconds, then fall back to copying.
function moveDirectory(from, to) {
  for (let attempt = 0; attempt < 10; attempt++) {
    try { renameSync(from, to); return; }
    catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
  }
  cpSync(from, to, { recursive: true });
}

export async function ensurePrivatePython({ fetchImpl = fetch } = {}) {
  const build = pythonBuild();
  const python = basePython(build.home);
  if (existsSync(python)) return python;

  const downloadDir = path.join(root, '.tools', `python-download-${randomUUID()}`);
  mkdirSync(downloadDir, { recursive: true });
  try {
    console.log(`Downloading the project-local Python ${PYTHON_VERSION} runtime for the Elentra steps...`);
    const response = await fetchImpl(build.url);
    if (!response.ok) throw new Error(`Python could not be downloaded (HTTP ${response.status}). Check the network/proxy or ask IT.`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== build.sha256) throw new Error('The Python download checksum did not match. The file will not be used.');
    writeFileSync(path.join(downloadDir, build.archive), bytes);

    console.log('Download verified. Installing Python inside this project (no administrator password needed)...');
    // Relative names with cwd avoid GNU tar reading "C:" in a Windows path as a remote host.
    run('Extracting Python', tarCommand(), ['-xf', build.archive], { cwd: downloadDir });
    rmSync(build.home, { recursive: true, force: true });
    moveDirectory(path.join(downloadDir, build.extracted), build.home);
  } finally {
    rmSync(downloadDir, { recursive: true, force: true });
  }
  if (!existsSync(python)) throw new Error(`Python was extracted but ${python} is missing.`);
  return python;
}

// A venv remembers the interpreter it was made from in pyvenv.cfg. One made from another
// Python (for example by hand, before this setup existed) is rebuilt from the pinned one.
function venvUsesPython(home) {
  try {
    const config = readFileSync(path.join(venvDir, 'pyvenv.cfg'), 'utf8');
    const recorded = config.match(/^home\s*=\s*(.+)$/m)?.[1]?.trim();
    const expected = process.platform === 'win32' ? home : path.join(home, 'bin');
    return Boolean(recorded) && path.resolve(recorded).toLowerCase() === path.resolve(expected).toLowerCase() && existsSync(venvPython());
  } catch { return false; }
}

export function ensureVenv(python) {
  const home = pythonBuild().home;
  if (venvUsesPython(home)) return venvPython();
  console.log(`Creating the Elentra virtual environment in ${venvDir}...`);
  run('Creating the Python virtual environment', python, ['-m', 'venv', '--clear', venvDir]);
  return venvPython();
}

export function installPythonPackages(python = venvPython()) {
  console.log('Installing the Elentra Python packages...');
  run('Installing Elentra Python packages', python, ['-m', 'pip', 'install', '--disable-pip-version-check', '--require-virtualenv', '-r', path.join(elentraDir, 'requirements.txt')]);
}

// Python Playwright drives its own Chromium build. When setup has recorded an installed
// Chrome/Edge as browser.channel, the Elentra scripts use that browser too (elentra/settings.py),
// so nothing is downloaded.
export function installPythonBrowser(channel, python = venvPython()) {
  if (channel) {
    console.log(`configs/local.json sets browser.channel="${channel}", so the Elentra scripts use the installed ${channel} browser.`);
    return;
  }
  console.log('Installing the browser used by the Elentra scripts...');
  run('Installing the Elentra browser', python, ['-m', 'playwright', 'install', 'chromium']);
}

# First-time setup

You do not need to know how to code, install Homebrew, or install Node.js yourself. You need the project source folder and permission to download the project's private runtime, dependencies, and browser.

1. Download and unzip a clean source copy of this project, or obtain it through your organisation's approved repository access. Keep `package-lock.json` and the hidden `.agents`/`.claude` skill folders. Do not transfer someone else's `node_modules`, `.playwright`, `.env`, or `configs/local.json`; dependencies and login sessions belong to each computer/user. Git is not needed if you use a source ZIP.
2. Open the project folder and double-click **Setup Mac.command** on Mac or **Setup Windows.cmd** on Windows. The launcher uses a compatible Node.js already on the computer when available. Otherwise, it downloads the pinned official Node.js 24 LTS archive, verifies its SHA-256 checksum, and installs it under this project's ignored `.tools` folder. It does not need Homebrew, a system-wide Node installation, or an administrator password.
3. Wait while setup installs fresh project dependencies and Chromium. A temporary browser window opens and closes for a local runtime check. Existing local configuration is preserved. If none exists, setup creates `configs/local.json` from the example.
4. If the operating system or organisation blocks the launcher, do not bypass its security controls. Ask IT, or ask your coding agent to run `bash "./Setup Mac.command"` on macOS or `powershell.exe -NoProfile -File ".\\scripts\\setup\\bootstrap-windows.ps1"` on Windows. If PowerShell, downloads, or project-local executable files are prohibited, IT must provide Node.js 24 LTS and allow the project dependencies to run.
5. Setup then opens the default URL, `https://ilams.lamsinternational.com/lams/index.do`, in the headed persistent automation browser. Complete sign-in yourself in that browser window; never give credentials to the agent. Setup waits up to five minutes and verifies the authenticated course menu without opening or changing a lesson. If needed, rerun only this step with `npm run login:lams`. The configured `baseUrl` can still select another deployment.

For example, you can tell your agent:

> This is a new computer. Help me install the prerequisites, run the project setup, and check the local tools. Do not create or change any LAMS lessons.

## What the checks prove

The double-click launcher bootstraps Node.js when necessary and then starts `npm run setup`. That command uses `npm ci --include=dev --include=optional`, installs Playwright Chromium, and runs `npm run doctor`'s checks. The lockfile stays unchanged. Dependencies are installed for this computer; copied dependencies are replaced. Network access is required. Do not run setup while another local automation is using the dependencies.

`npm run doctor` can also run by itself without reinstalling anything. It checks:

- Node version (22 or newer; 24 LTS recommended for new installs).
- An actual esbuild TypeScript transformation.
- Execution through tsx with its transformation cache disabled.
- The TypeScript build.
- A real headed Chromium launch using a temporary context and local page.

It exits unsuccessfully if any runtime check fails. The subsequent setup login step opens the saved browser profile and verifies sign-in separately; `npm run doctor` alone does not open LAMS or check login status.

## If setup fails

| Message | Next step |
|---|---|
| Node/npm missing or too old | Use the Mac or Windows launcher; it installs the pinned runtime inside `.tools`. |
| Unsupported CPU or local executables prohibited | Ask IT to install Node.js 24 LTS through your organisation's approved process. |
| PowerShell unavailable or blocked | Ask IT to enable the approved setup route, or have IT install Node.js 24 LTS and then run `npm run setup`. |
| esbuild missing, wrong architecture, or tsx fails | Rerun setup to install fresh local dependencies. Do not reuse another machine's `node_modules`. |
| macOS kills or blocks a binary | The message alone does not prove quarantine is the cause. If a clean local install remains blocked, ask IT to inspect the specific executable and security event. |
| Chromium executable missing | Run `npm run install:browsers`, then `npm run doctor`. |
| Browser cannot launch | Use a local desktop session; have IT check OS support and executable restrictions. |
| Download or npm install fails | Check network/proxy/organisation access. Share the error with your maintainer without credentials. |
| Build fails | Share the compiler errors with the maintainer. Do not call setup complete. |

A successful `npm run build` alone is insufficient: it does not execute esbuild/tsx or launch a browser. The screenshot that prompted these checks reported a quarantined esbuild executable after an earlier build had passed; without that machine's logs, that reported cause is not independently confirmed.

To move the source folder to another computer, leave out `.tools`, `node_modules`, `.playwright`, `.env`, and `configs/local.json`. Each user should run setup on their own computer so native packages and login data are never copied between users.

References: [Node.js release archive](https://nodejs.org/en/download/archive/v24), [esbuild platform-specific installation](https://esbuild.github.io/getting-started/#simultaneous-platforms), [npm clean installation](https://docs.npmjs.com/cli/v11/commands/npm-ci/), [Playwright browser installation](https://playwright.dev/docs/browsers).

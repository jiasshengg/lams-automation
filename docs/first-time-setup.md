# First-time setup

You do not need to know how to code or install Homebrew. You need the project source folder, Node.js, and permission to download the project's dependencies and browser.

1. Download and unzip a clean source copy of this project, or obtain it through your organisation's approved repository access. Keep `package-lock.json` and the hidden `.agents`/`.claude` skill folders. Do not transfer someone else's `node_modules`, `.playwright`, `.env`, or `configs/local.json`; dependencies and login sessions belong to each computer/user. Git is not needed if you use a source ZIP.
2. Install **Node.js 24 LTS** using the [official Node.js installer](https://nodejs.org/en/download) for macOS or Windows. The normal installer includes npm. Follow your organisation's software-installation process if administrator permission is needed. Restart your terminal and agent app after installation so they can find Node.
3. Open the project folder and double-click **Setup Mac.command** on Mac or **Setup Windows.cmd** on Windows. If your organisation blocks downloaded launchers, ask IT or ask your coding agent to run `npm run setup` from the project folder. Do not disable macOS Gatekeeper or strip quarantine flags to force it to run.
4. Wait while setup installs fresh project dependencies and Chromium. A temporary browser window opens and closes for a local check; it does not visit LAMS. Existing local configuration is preserved. If none exists, setup creates `configs/local.json` from the example.
5. Ask your agent: “Set up my LAMS URL and course in the local configuration.” Supply those details when asked. No passwords belong in that configuration file. Then request a separate login check and complete any sign-in prompts yourself. Runtime readiness does not mean you are already logged in.

For example, you can tell your agent:

> This is a new computer. Help me install the prerequisites, run the project setup, and check the local tools. Do not create or change any LAMS lessons.

## What the checks prove

`npm run setup` uses `npm ci --include=dev --include=optional`, installs Playwright Chromium, and runs `npm run doctor`'s checks. The lockfile stays unchanged. Dependencies are installed for this computer; copied dependencies are replaced. Network access is required. Do not run setup while another local automation is using the dependencies.

`npm run doctor` can also run by itself without reinstalling anything. It checks:

- Node version (22 or newer; 24 LTS recommended for new installs).
- An actual esbuild TypeScript transformation.
- Execution through tsx with its transformation cache disabled.
- The TypeScript build.
- A real headed Chromium launch using a temporary context and local page.

It exits unsuccessfully if any check fails. It does not open a saved browser profile, verify the LAMS configuration, or check login status.

## If setup fails

| Message | Next step |
|---|---|
| Node/npm missing | Install Node using the official installer; restart the agent/terminal and rerun setup. |
| esbuild missing, wrong architecture, or tsx fails | Rerun setup to install fresh local dependencies. Do not reuse another machine's `node_modules`. |
| macOS kills or blocks a binary | The message alone does not prove quarantine is the cause. If a clean local install remains blocked, ask IT to inspect the specific executable and security event. |
| Chromium executable missing | Run `npm run install:browsers`, then `npm run doctor`. |
| Browser cannot launch | Use a local desktop session; have IT check OS support and executable restrictions. |
| Download or npm install fails | Check network/proxy/organisation access. Share the error with your maintainer without credentials. |
| Build fails | Share the compiler errors with the maintainer. Do not call setup complete. |

A successful `npm run build` alone is insufficient: it does not execute esbuild/tsx or launch a browser. The screenshot that prompted these checks reported a quarantined esbuild executable after an earlier build had passed; without that machine's logs, that reported cause is not independently confirmed.

References: [esbuild platform-specific installation](https://esbuild.github.io/getting-started/#simultaneous-platforms), [npm clean installation](https://docs.npmjs.com/cli/v11/commands/npm-ci/), [Playwright browser installation](https://playwright.dev/docs/browsers).

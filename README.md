# CLI Limit Resetter

Send a short scheduled prompt through Claude Code, Codex, or Gemini CLI every five hours by default. **A prompt does not guarantee that the provider will reset a usage window or grant more time.** Every request consumes usage on the signed-in account. This tool is a scheduler for small, periodic requests.

## Install and start

You need Node.js 20 or newer and the official CLI for each provider you want to use. Install the current version from GitHub:

```bash
npm install -g github:leehogwang/Claude-CLI-Limit-Resetter
cli-limit-resetter
```

Running without arguments checks Claude authentication and starts it in the background. If Claude is not signed in, the command exits with an instruction to run `claude auth login` first. On a fresh installation, the first prompt is sent immediately; subsequent prompts are sent five hours after the later of the last attempt or success. On Linux, the tool enables a systemd user service when available and attempts to enable linger so it can continue after logout. Elsewhere it starts a detached process, which does not automatically restart after a reboot.

To install from a local checkout, use `npm install -g .`. The package has not been published to the npm registry.

Install Gemini CLI separately if you plan to use Gemini: `npm install -g @google/gemini-cli`. It provides the `gemini` command.

## Providers and commands

| Provider | Start command | Required sign-in | Default model |
| --- | --- | --- | --- |
| Claude | `cli-limit-resetter start claude` | Claude.ai subscription via `claude auth login` | `haiku` |
| Codex | `cli-limit-resetter start codex` | ChatGPT via `codex login` | `gpt-6-luna` |
| Gemini (`agy`) | `cli-limit-resetter start agy` | Sign in with Google through `gemini` | `flash-lite` |

`agy` is this package's name for the Gemini provider. The tool looks for an executable named `agy` or `gemini`; background services cannot use shell aliases. If the executable is elsewhere, set `KEEPER_AGY_CLI=/absolute/path/to/gemini` when starting the service.

```bash
cli-limit-resetter check claude
cli-limit-resetter status claude
cli-limit-resetter stop claude
cli-limit-resetter start codex
cli-limit-resetter status codex
```

`check` verifies the configured sign-in method without sending a model request. For Gemini, this only checks that Google OAuth is selected; it cannot validate cached credentials without a model request. If a background request reports that authorization is required, run `gemini` interactively, sign in with Google, then start `agy` again. On Linux, follow the Claude service log with `journalctl --user -u cli-limit-resetter-claude.service -f`. Replace `claude` in the unit name with `codex` or `agy` for the other providers.

## Authentication and billing

The tool checks the sign-in method before every request. Claude accepts only Claude.ai Pro, Max, or Team authentication. It rejects usage-based Enterprise authentication because it cannot verify included usage. Codex runs only when `codex login status` reports a ChatGPT sign-in. Gemini requires Google OAuth in the user's settings. If an API-key or custom-provider environment override is detected for a provider, no request is sent.

Anthropic paused a June 2026 change that would have separated `claude -p` usage into Agent SDK credits. Its current guidance says `claude -p` with a Claude.ai subscription still draws from the subscription's usage limits. However, if separate Usage credits are enabled on the account, continued use after reaching a limit may incur additional charges. This account-level setting cannot be verified from the CLI authentication status. Codex and Gemini requests likewise follow their respective account usage and credit policies.

The tool uses an empty working directory and restricts tool execution and session persistence to keep requests small. A Claude or Gemini request is recorded as successful only when its response statistics confirm Haiku or Flash-Lite, respectively. A model mismatch is detected only after a request has already been made, so verify that your account can use the selected model. The package does not retry with a larger model.

References: [Claude subscription usage](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan), [paused `claude -p` change](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan), [Claude Usage credits](https://support.claude.com/en/articles/12429409-manage-usage-credits-for-paid-claude-plans), [Codex authentication](https://learn.chatgpt.com/docs/auth), [Codex models](https://learn.chatgpt.com/docs/models), and [Gemini authentication](https://geminicli.com/docs/get-started/authentication/).

## Migrate from the previous Python service

If you use this repository's previous `claude-monitor.service`, disable it to prevent duplicate requests, then import the last attempt time:

```bash
systemctl --user disable --now claude-monitor.service
cli-limit-resetter start claude --legacy-state /path/to/Claude-CLI-Limit-Resetter/state.json
```

The previous `state.json` is not deleted. New state is stored in `~/.local/state/cli-limit-resetter/`. Confirm that the new service is active with `cli-limit-resetter status claude`.

## License

MIT

<p align="center">
  <img src="public/brand/app-icon.png" width="96" height="96" alt="AutoJev">
</p>
<h1 align="center">AutoJev</h1>
<p align="center">English · <a href="README.zh-CN.md">简体中文</a></p>
<p align="center">One local gateway for your AI agents. Route every request to the right model.</p>
<p align="center">
  <a href="https://github.com/thinkany-ai/autojev/releases">Download</a> ·
  <a href="https://autojev.ai">Website</a> ·
  <a href="https://github.com/thinkany-ai/autojev/issues">Issues</a> ·
  <a href="LICENSE">MIT</a>
</p>

AutoJev is a desktop app built with Tauri, React, and Rust. Manage providers, models, and routing rules in one place, and connect agents such as Codex, Claude Code, and Hermes through a single local endpoint.

> AutoJev is in early development. Available installers and supported release platforms are listed in GitHub Releases.

![AutoJev overview: agents connected to models through a local gateway, with routing and usage statistics](docs/assets/autojev-overview.png)

## Features

- **Providers and models**: Manage API endpoints, keys, pricing, image input support, and context lengths. Image and context settings are informational and do not restrict requests.
- **Model routing**: Choose models with intelligent selection or load balancing, with speed, cost, quality, or balanced preferences. Includes session affinity, failover, and cooldowns.
- **Decision model**: Use OpenRouter Jev to select a candidate model, with local routing as a fallback when Jev is unavailable.
- **Protocol conversion**: Support for OpenAI Responses, Chat Completions, and Anthropic Messages, including streaming and function tool calls. See [protocol compatibility](docs/protocol-conversion.md) for limitations.
- **Agent integration**: Detect local agents, remember model and route selections, back up and restore configurations, and reconnect agents on startup according to saved preferences. Model picker support varies by client.
- **Debugging and statistics**: A debug console, model speed tests, request logs, token usage, and estimated costs.
- **Desktop updates**: Automatic update checks, user-initiated downloads and installation, signature verification, and restart to update in release builds.

```text
Codex / Claude Code / Hermes / Other compatible clients
                          │
              http://127.0.0.1:9527/v1
                          │
                  AutoJev local gateway
                          │
          Intelligent selection / Load balancing / Failover
                          │
            OpenRouter / DeepSeek / Custom providers
```

## Inside AutoJev

Add providers, measure models, build routes, connect agents, then inspect requests and usage.

### Manage providers in one place

Add OpenRouter, DeepSeek, or compatible API endpoints, or import existing providers from CC Switch and Termany. Test, enable, or disable each provider while keeping its configuration saved locally.

![Providers with API endpoints, enabled status, and locally saved keys](docs/assets/autojev-providers.webp)

### Measure models before routing

Compare first-response latency and output speed with built-in speed tests. Configure input and output pricing, and keep image support and context-window information alongside each model.

![Models with speed measurements, pricing, and context windows](docs/assets/autojev-models.webp)

### Create reusable routes

Group candidate models into routes such as `fast`, `quality`, or `cheap`, exposed as `autojev/<route ID>`. Choose intelligent selection or load balancing, with session affinity, failover, and cooldowns.

![Routes configured for speed, quality, cost, and load balancing](docs/assets/autojev-routes.webp)

### Connect your agents

See detected agents, configuration paths, and connection status in one view. Select models or routes per agent, batch-update connected agents, and restore backed-up configurations when disconnecting.

![Agents with configuration paths, selected models and routes, and connection status](docs/assets/autojev-agents.webp)

### Test requests in the debug console

Try models and routes in conversation or cURL mode. Switch API protocols and inspect the selected model, timing, token usage, estimated cost, and raw JSON response.

![Debug console showing a routed conversation and response details](docs/assets/autojev-debug.webp)

### Inspect logs and usage

Filter request logs by time, agent, provider, and status to investigate routing and failures. Review token totals, cache usage, estimated costs, and daily usage across agents and models.

![Request logs with routing details, tokens, cost, latency, and status](docs/assets/autojev-logs.webp)

![Usage totals and daily token chart](docs/assets/autojev-usage.webp)

## Quick start

1. Download an installer for your system from [Releases](https://github.com/thinkany-ai/autojev/releases).
2. Add your API endpoint and key under **Providers**.
3. Add models with their upstream API type, model ID, and pricing.
4. Configure candidate models and scheduling preferences under **Routes**. For intelligent selection, configure Jev in **Settings → Gateway & routing → Decision model**.
5. Select models or routes under **Agents** and connect an agent, or configure your client manually.
6. Try a request in the **Debug**. Use **Logs** to see which provider and model handled it.

Release builds listen on `127.0.0.1:9527`; development builds use `127.0.0.1:9526`. Route model IDs use the format `autojev/<route ID>`.

| API | Endpoint |
| --- | --- |
| OpenAI Responses | `POST /v1/responses` |
| OpenAI Chat Completions | `POST /v1/chat/completions` |
| Anthropic Messages | `POST /v1/messages` |

A model's API type must match its upstream provider. Protocol conversion cannot add vision, reasoning, or tool capabilities to a model, and some client-specific features cannot be converted.

### Custom agents

Add a local executable and optionally specify its configuration file path. Leave the path blank to use the detected agent's default location. AutoJev currently recognizes Kilo, OpenCode, OpenClaw, Hermes, Grok, and Kimi. Unknown clients require manual configuration; AutoJev does not infer configuration fields from a file extension alone.

After saving, select models or routes in the agent list and connect. Custom agents currently use the first selected item as the default, without generating a multi-model catalog. Disconnecting, stopping the gateway with configuration restoration, or quitting restores the original configuration while preserving non-conflicting later changes. Disconnect a custom agent before editing its settings. The command test uses the agent's current configuration and does not inject gateway settings.

Kilo's default configuration path and structure follow its [official CLI documentation](https://kilo.ai/docs/code-with-ai/platforms/cli) and [custom model documentation](https://kilo.ai/docs/code-with-ai/agents/custom-models).

### Gateway lifecycle

- Closing the window keeps the app running in the background.
- **Pause service** keeps agent configurations in place and rejects new requests; requests already in progress can finish. The current pause response is HTTP 404 with the error code `gateway_paused`. Clients may still retry.
- **Stop and restore configurations** restores agent settings before shutting down the gateway.
- Quitting from the tray also restores configurations. On the next launch, AutoJev reconnects agents according to saved connection preferences. Manually disconnected agents stay disconnected.

## Local development

Requires Node.js 22+, pnpm 10+, stable Rust, and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform.

```bash
git clone https://github.com/thinkany-ai/autojev.git
cd autojev
pnpm install --frozen-lockfile
pnpm dev
```

Development builds use a separate application identifier and database, and do not check for release updates. Run `pnpm dev:web` for a browser preview; desktop-only operations are unavailable in the browser.

```bash
pnpm test
pnpm build
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib
pnpm release:check
```

## Data and privacy

- Configuration and provider keys are stored locally in `~/.autojev/autojev.db`. Development builds use `autojev-dev.db`. **Keys are currently stored unencrypted.**
- Request logs store model metadata, status, timing, usage, and estimated costs. Full prompts, responses, and API keys are not persisted in request logs.
- Model requests are sent to the selected upstream provider. Jev decisions use routing features and candidate model metadata.
- Connecting an agent modifies its configuration and creates a backup. Do not commit real configurations, databases, keys, or backups to the repository.
- The gateway listens locally by default. Usage depends on data returned by providers; displayed costs are estimates.

## Packaging and updates

Build and sign locally on macOS:

```bash
pnpm release:mac --check  # Check local release prerequisites
pnpm release:mac         # Build, sign, and notarize
```

The release workflow targets macOS Apple Silicon and Intel, Windows x64, and Linux x64, producing installers and signed update artifacts. Version tags trigger a draft release. Publication happens only after all platform builds and updater manifest checks succeed.

Release builds check for updates on startup and every four hours. Disable automatic checks in **Settings → General**, or check and install manually in **Settings → About**. Finish active agent requests before installing an update.

See the [release guide](docs/releases.md) for signing credentials, GitHub Secrets, the first release, and update verification.

## Project structure

```text
src/                React UI, desktop command bridge, and update controller
src-tauri/src/      Rust gateway, routing, protocol conversion, agents, and storage
scripts/            Development, icon generation, and release scripts
.github/workflows/  CI and multi-platform releases
docs/               Protocol notes and release documentation
```

## Contributing and license

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before contributing, and report security issues privately as described in [SECURITY.md](SECURITY.md).

AutoJev source code is licensed under the **[MIT License](LICENSE)**, © 2026 ThinkAny, LLC.

Third-party icons and other assets retain their respective licenses; see [NOTICE](NOTICE) and the license files in the asset directories. Use of the AutoJev name and logo is covered by [TRADEMARKS.md](TRADEMARKS.md).

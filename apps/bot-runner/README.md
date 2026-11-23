# VaultRealm — AI Companion Bot Runner

Autonomous in-game AI companion container for Minecraft game servers managed by [VaultRealm](https://github.com/VaultSoft-Labs-Software-Automation/VaultRealm).

## Overview

`vaultrealm-bot-runner` runs an autonomous Mineflayer bot instance that connects to a target game server and interacts with players via natural language. All LLM inferences and security guardrails are routed through the VaultRealm panel gateway.

## Features

- **Natural Language Interaction**: Real-time conversational AI in game chat.
- **Role-Based Safety**: Player chat commands are strictly authorized by speaker role.
- **Autonomous Tasking**: Pathfinding, following players, resource gathering, and location bookmarks.
- **Multi-Platform**: Native support for `linux/amd64` and `linux/arm64`.

## Usage

This container is spawned and managed automatically by the VaultRealm panel.

To run manually or standalone:

```bash
docker run -d \
  --name vaultrealm-bot \
  -e BOT_ID=my-bot \
  -e BOT_TOKEN=secret-token \
  -e SERVER_HOST=host.docker.internal \
  -e SERVER_PORT=25565 \
  -e PANEL_GATEWAY_URL=http://host.docker.internal:3001 \
  hypertextassassin/vaultrealm-bot-runner:latest
```

## License

MIT © VaultRealm


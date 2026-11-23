# VaultRealm

[![Docker Image](https://img.shields.io/badge/Docker%20Hub-hypertextassassin%2Fvaultrealm-blue?logo=docker)](https://hub.docker.com/r/hypertextassassin/vaultrealm)
[![License: MIT](https://img.shields.io/badge/License-MIT-emerald.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/Tests-280%2B%20Passing-success)](https://github.com/VaultSoft-Labs-Software-Automation/VaultRealm/actions)

A lightweight, modern, multi-user control panel for self-hosting game servers (Minecraft, Palworld, Valheim, …) on any Linux VPS or server.

---

## Features

- 🎮 **One-Click Game Deploy** — pick a game template, name it, and launch in seconds.
- ⚡ **Automated 1-Click Installer** — install directly on your VPS via a single bash command; no manual Docker setup needed.
- 🛠️ **Built-In Server Management CLI (`vaultrealm` / `vr`)** — terminal menu to start, stop, restart, stream logs, update, and manage ports.
- ☁️ **Google Drive Disaster Recovery** — 1-click off-site world backup and instant restoration via Google Drive.
- 🤖 **AI Companion Integration** — connect any OpenAI-compatible endpoint for in-game autonomous AI buddies.
- 🔍 **Auto-Diagnosis Engine** — instant root-cause analysis when a server crashes, with one-click fix recommendations.
- 🔒 **Zero Host Secrets Leakage** — strict isolation, role-based access control (RBAC), and encrypted credentials.

---

## Quick Start (Automated 1-Click Install)

Install and configure VaultRealm on any Linux server (**Ubuntu, Debian, CentOS, AlmaLinux, Rocky Linux, Fedora, Alpine**) with a single command:

```bash
bash <(curl -Ls https://raw.githubusercontent.com/VaultSoft-Labs-Software-Automation/VaultRealm/master/install.sh)
```

The script automatically:
1. Detects system architecture (`x86_64` / `arm64`).
2. Installs Docker Engine automatically if not already present on the machine.
3. Automatically opens firewall ports (UFW / Firewalld) for the web panel.
4. Creates a persistent systemd background service (`vaultrealm.service`).
5. Installs the **`vaultrealm`** management command to `/usr/local/bin/vaultrealm` (and shortcut `vr`).

---

### Alternative Installation Commands

| Deployment Mode | Command |
|---|---|
| **Latest Stable Release** | `bash <(curl -Ls https://raw.githubusercontent.com/VaultSoft-Labs-Software-Automation/VaultRealm/master/install.sh)` |
| **Specific Release Tag** | `bash <(curl -Ls https://raw.githubusercontent.com/VaultSoft-Labs-Software-Automation/VaultRealm/master/install.sh) v0.1.7` |
| **Rolling Dev Build** | `bash <(curl -Ls https://raw.githubusercontent.com/VaultSoft-Labs-Software-Automation/VaultRealm/dev/install.sh) dev-latest` |
| **Unattended / Cloud-Init** | `VR_NONINTERACTIVE=1 bash <(curl -Ls https://raw.githubusercontent.com/VaultSoft-Labs-Software-Automation/VaultRealm/master/install.sh)` |

> **View Installer Script Source:** [`install.sh`](https://github.com/VaultSoft-Labs-Software-Automation/VaultRealm/blob/master/install.sh)

---

## Managing the Server (`vaultrealm` / `vr`)

After installation, run `vaultrealm` or `vr` in your terminal anytime to open the interactive management menu:

```bash
vaultrealm
```

```text
 __      __            _ _   _____            _             
 \ \    / /           | | | |  __ \          | |            
  \ \  / /__ _  _   _ | | |_| |__) |___  __ _| |_ __ ___   
   \ \/ // _` || | | || | __|  _  // _ \/ _` | | '_ ` _ \  
    \  /| (_| || |_| || | |_| | \ \  __/ (_| | | | | | | | 
     \/  \__,_| \__,_||_|\__|_|  \_\___|\__,_|_|_| |_| |_| 

   Autonomous Game Server Control Panel — Management CLI

 Panel URL: http://YOUR_SERVER_IP:3001

 --------------------------------------------------------
  1. Start VaultRealm
  2. Stop VaultRealm
  3. Restart VaultRealm
  4. View Status & Health
  5. View Live Logs (follow)
  6. Change Web Port (Current: 3001)
  7. Update Panel to Latest Version
  8. System Diagnostics & Game Servers
  9. Reset First-Time Admin Setup
 10. Uninstall VaultRealm
 --------------------------------------------------------
  0. Exit
```

### Direct CLI Commands

You can also run direct subcommands without opening the interactive menu:

| Command | Description |
|---|---|
| `vaultrealm status` | View service status, container health, and panel URL |
| `vaultrealm logs` | Stream live panel logs in real time (`Ctrl+C` to exit) |
| `vaultrealm restart` | Restart the VaultRealm panel service |
| `vaultrealm start` | Start the panel service if stopped |
| `vaultrealm stop` | Stop the panel service |
| `vaultrealm update` | Pull the newest release image and restart the service |
| `vaultrealm port <number>` | Change the web panel listening port (e.g. `vaultrealm port 8080`) |
| `vaultrealm diag` | View host hardware specs, Docker version, and active game servers |
| `vaultrealm reset` | Reset initial admin registration wizard |
| `vaultrealm uninstall` | Stop and remove the service and containers (prompts before data removal) |

---

## Manual Docker Deployment (Alternative)

If you prefer to run VaultRealm using Docker or Docker Compose manually:

### Option A: `docker run`

```bash
docker run -d \
  --name vaultrealm \
  --restart unless-stopped \
  -p 3001:3001 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /srv/vaultrealm/data:/srv/vaultrealm/data \
  hypertextassassin/vaultrealm:latest
```

### Option B: `docker-compose.yml`

```yaml
services:
  vaultrealm:
    image: hypertextassassin/vaultrealm:latest
    container_name: vaultrealm
    restart: unless-stopped
    ports:
      - "3001:3001"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /srv/vaultrealm/data:/srv/vaultrealm/data
    environment:
      - PORT=3001
      - DATA_DIR=/srv/vaultrealm/data
      - NODE_ENV=production
```

Run with:
```bash
docker compose up -d
```

---

## Supported Game Templates

| Game | Template ID | Default Ports | Min RAM |
|------|-------------|---------------|---------|
| **Minecraft Java** | `minecraft-java` | `25565/tcp` | 1 GB |
| **Minecraft Bedrock** | `minecraft-bedrock` | `19132/udp` | 512 MB |
| **Valheim** | `valheim` | `2456-2457/udp` | 2 GB |
| **Palworld** | `palworld` | `8211/udp` | 8 GB |
| **Terraria** | `terraria` | `7777/tcp` | 512 MB |

---

## Local Development

### Prerequisites

- Node.js 22+
- pnpm 9+
- Docker (optional in development; Docker is mocked by default in test suite)

### Setup

```bash
# Clone repository
git clone https://github.com/VaultSoft-Labs-Software-Automation/VaultRealm.git
cd VaultRealm

# Install dependencies
pnpm install

# Configure environment
cp apps/api/.env.example apps/api/.env

# Start development servers (API + web frontend)
pnpm dev
```

- **API Server:** http://localhost:3001
- **Web Frontend:** http://localhost:5173

### Default Dev Credentials

| Field | Value |
|---|---|
| Username | `admin` |
| Email | `admin@vaultrealm.local` |
| Password | `AdminSecurePassword123!` |

### Scripts

```bash
pnpm dev              # Start all dev servers (Fastify + Vite)
pnpm test             # Run test suite (280+ tests)
pnpm typecheck        # TypeScript strict type checking
pnpm lint             # ESLint across all packages
pnpm build            # Production build
pnpm docker:build     # Build panel Docker image
pnpm docker:build:bot # Build companion bot Docker image
```

---

## Documentation

- 📖 **[Developer Guide](docs/DEVELOPER_GUIDE.md)** — Architecture overview, API reference, security model, and guide for custom game templates.
- 📋 **[Implementation Plan](docs/IMPLEMENTATION_PLAN.md)** — Core roadmap and feature specifications.

---

## License

MIT © [VaultSoft Labs](https://vaultsoftlabs.tech)

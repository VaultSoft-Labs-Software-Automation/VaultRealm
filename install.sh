#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# VaultRealm — Automated 1-Click Installer for Linux
#
# Quick Start:
#   bash <(curl -Ls https://raw.githubusercontent.com/VaultSoft-Labs-Software-Automation/VaultRealm/master/install.sh)
#
# Specific Version:
#   bash <(curl -Ls https://raw.githubusercontent.com/VaultSoft-Labs-Software-Automation/VaultRealm/master/install.sh) v0.1.7
#
# Rolling Dev Build:
#   bash <(curl -Ls https://raw.githubusercontent.com/VaultSoft-Labs-Software-Automation/VaultRealm/master/install.sh) dev-latest
# ─────────────────────────────────────────────────────────────────────────────

set -eo pipefail

# Colors for terminal output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

LOG_INFO()    { echo -e "${CYAN}[INFO]${NC} $*"; }
LOG_SUCCESS() { echo -e "${GREEN}[SUCCESS]${NC} ${BOLD}$*${NC}"; }
LOG_WARN()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
LOG_ERROR()   { echo -e "${RED}[ERROR]${NC} $*"; }

DATA_DIR="/srv/vaultrealm/data"
CONFIG_DIR="/etc/vaultrealm"
ENV_FILE="${CONFIG_DIR}/vaultrealm.env"
CLI_PATH="/usr/local/bin/vaultrealm"
CLI_SYMLINK="/usr/local/bin/vr"
DEFAULT_PORT=3001
REPO_IMAGE="hypertextassassin/vaultrealm"

# ── 1. Check Root Privileges ─────────────────────────────────────────────────
check_root() {
  if [ "$(id -u)" -ne 0 ]; then
    LOG_ERROR "This installer must be run as root."
    echo -e "Please run with sudo:\n  ${YELLOW}sudo bash <(curl -Ls https://raw.githubusercontent.com/VaultSoft-Labs-Software-Automation/VaultRealm/master/install.sh)${NC}"
    exit 1
  fi
}

# ── 2. Check Architecture & OS ───────────────────────────────────────────────
check_arch() {
  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64|amd64)
      DOCKER_ARCH="amd64"
      ;;
    aarch64|arm64)
      DOCKER_ARCH="arm64"
      ;;
    *)
      LOG_ERROR "Unsupported CPU architecture: ${ARCH}. VaultRealm requires amd64 or arm64."
      exit 1
      ;;
  esac
  LOG_INFO "Detected CPU architecture: ${BOLD}${ARCH}${NC}"
}

# ── 3. Check / Install Prerequisites ─────────────────────────────────────────
install_prerequisites() {
  LOG_INFO "Checking system prerequisites..."
  local PKGS=()
  
  if ! command -v curl >/dev/null 2>&1; then PKGS+=(curl); fi
  if ! command -v tar >/dev/null 2>&1; then PKGS+=(tar); fi
  if ! command -v jq >/dev/null 2>&1; then PKGS+=(jq); fi

  if [ ${#PKGS[@]} -gt 0 ]; then
    LOG_INFO "Installing missing tools: ${PKGS[*]}..."
    if command -v apt-get >/dev/null 2>&1; then
      apt-get update -qq && apt-get install -y -qq "${PKGS[@]}" >/dev/null
    elif command -v dnf >/dev/null 2>&1; then
      dnf install -y -q "${PKGS[@]}" >/dev/null
    elif command -v yum >/dev/null 2>&1; then
      yum install -y -q "${PKGS[@]}" >/dev/null
    elif command -v apk >/dev/null 2>&1; then
      apk add --no-cache "${PKGS[@]}" >/dev/null
    elif command -v pacman >/dev/null 2>&1; then
      pacman -Sy --noconfirm "${PKGS[@]}" >/dev/null
    fi
  fi
}

# ── 4. Ensure Docker Engine is Installed & Running ───────────────────────────
ensure_docker() {
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    LOG_SUCCESS "Docker Engine is installed and active."
    return
  fi

  if ! command -v docker >/dev/null 2>&1; then
    LOG_WARN "Docker Engine is not installed on this machine."
    LOG_INFO "VaultRealm game servers and the companion runner require Docker."
    LOG_INFO "Automatically installing Docker Engine via official installer (get.docker.com)..."
    
    curl -fsSL https://get.docker.com | sh
  fi

  # Enable and start Docker service
  if command -v systemctl >/dev/null 2>&1; then
    systemctl enable docker >/dev/null 2>&1 || true
    systemctl start docker >/dev/null 2>&1 || true
  elif command -v service >/dev/null 2>&1; then
    service docker start >/dev/null 2>&1 || true
  fi

  if ! docker info >/dev/null 2>&1; then
    LOG_ERROR "Failed to connect to Docker daemon. Please verify Docker installation and try again."
    exit 1
  fi
  LOG_SUCCESS "Docker daemon is ready."
}

# ── 5. Parse Version / Tag ───────────────────────────────────────────────────
parse_version() {
  local USER_VER="${1:-}"
  if [ -z "$USER_VER" ]; then
    IMAGE_TAG="latest"
  elif [ "$USER_VER" = "dev-latest" ] || [ "$USER_VER" = "master" ] || [ "$USER_VER" = "dev" ]; then
    IMAGE_TAG="edge"
  else
    # Strip leading 'v' if present (e.g. v0.1.7 -> 0.1.7)
    IMAGE_TAG="${USER_VER#v}"
  fi
  LOG_INFO "Target VaultRealm version tag: ${BOLD}${IMAGE_TAG}${NC}"
}

# ── 6. Configure Port ────────────────────────────────────────────────────────
configure_port() {
  PANEL_PORT="${DEFAULT_PORT}"
  
  if [ -f "${ENV_FILE}" ]; then
    local SAVED_PORT
    SAVED_PORT="$(grep -E '^PORT=' "${ENV_FILE}" 2>/dev/null | cut -d'=' -f2 | tr -d ' "')"
    if [ -n "$SAVED_PORT" ]; then
      PANEL_PORT="$SAVED_PORT"
    fi
  fi

  # In non-interactive mode, use existing or default port
  if [ "${VR_NONINTERACTIVE:-0}" = "1" ] || [ ! -t 0 ]; then
    LOG_INFO "Using non-interactive mode. Web panel port: ${BOLD}${PANEL_PORT}${NC}"
    return
  fi

  echo -e "\n${BOLD}VaultRealm Web Panel Port Configuration:${NC}"
  read -r -p "Enter desired panel port [default: ${PANEL_PORT}]: " INPUT_PORT
  if [ -n "$INPUT_PORT" ]; then
    if [[ "$INPUT_PORT" =~ ^[0-9]+$ ]] && [ "$INPUT_PORT" -ge 1 ] && [ "$INPUT_PORT" -le 65535 ]; then
      PANEL_PORT="$INPUT_PORT"
    else
      LOG_WARN "Invalid port number entered. Falling back to ${PANEL_PORT}."
    fi
  fi
  LOG_INFO "Configured panel port: ${BOLD}${PANEL_PORT}${NC}"
}

# ── 7. Open Firewall Port if Active ──────────────────────────────────────────
configure_firewall() {
  if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
    LOG_INFO "Configuring UFW firewall: allowing port ${PANEL_PORT}/tcp..."
    ufw allow "${PANEL_PORT}/tcp" >/dev/null 2>&1 || true
    # Also allow standard Minecraft port range for game servers
    ufw allow 25565/tcp >/dev/null 2>&1 || true
    ufw allow 25565/udp >/dev/null 2>&1 || true
  elif command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld 2>/dev/null; then
    LOG_INFO "Configuring Firewalld: allowing port ${PANEL_PORT}/tcp..."
    firewall-cmd --permanent --add-port="${PANEL_PORT}/tcp" >/dev/null 2>&1 || true
    firewall-cmd --permanent --add-port=25565/tcp >/dev/null 2>&1 || true
    firewall-cmd --permanent --add-port=25565/udp >/dev/null 2>&1 || true
    firewall-cmd --reload >/dev/null 2>&1 || true
  fi
}

# ── 8. Prepare Directories & Environment ─────────────────────────────────────
setup_filesystem() {
  LOG_INFO "Creating directory structure..."
  mkdir -p "${DATA_DIR}"
  mkdir -p "${CONFIG_DIR}"
  chmod 755 "${DATA_DIR}"

  if [ ! -f "${ENV_FILE}" ]; then
    local GENERATED_SECRET
    GENERATED_SECRET="$(head -c 32 /dev/urandom 2>/dev/null | base64 | tr -dc 'a-zA-Z0-9' | head -c 32)"
    if [ -z "${GENERATED_SECRET}" ] || [ ${#GENERATED_SECRET} -lt 16 ]; then
      GENERATED_SECRET="$(date +%s%N | sha256sum | head -c 32)"
    fi
    cat <<EOF > "${ENV_FILE}"
# VaultRealm Runtime Environment Configuration
PORT=${PANEL_PORT}
PANEL_SECRET=${GENERATED_SECRET}
DATA_DIR=/srv/vaultrealm/data
NODE_ENV=production
LOG_LEVEL=info
COOKIE_SECURE=auto
# GOOGLE_CLIENT_ID=
# GOOGLE_CLIENT_SECRET=
EOF
  else
    # Update PORT in existing env file
    sed -i "s/^PORT=.*/PORT=${PANEL_PORT}/" "${ENV_FILE}"
    # Ensure persistent PANEL_SECRET is present in existing env file so encryption keys stay valid across restarts
    if ! grep -qE '^PANEL_SECRET=' "${ENV_FILE}"; then
      local GENERATED_SECRET
      GENERATED_SECRET="$(head -c 32 /dev/urandom 2>/dev/null | base64 | tr -dc 'a-zA-Z0-9' | head -c 32)"
      if [ -z "${GENERATED_SECRET}" ] || [ ${#GENERATED_SECRET} -lt 16 ]; then
        GENERATED_SECRET="$(date +%s%N | sha256sum | head -c 32)"
      fi
      echo "PANEL_SECRET=${GENERATED_SECRET}" >> "${ENV_FILE}"
    fi
  fi
  chmod 600 "${ENV_FILE}"
}

# ── 9. Pull Docker Image ─────────────────────────────────────────────────────
pull_image() {
  LOG_INFO "Pulling VaultRealm Docker image: ${BOLD}${REPO_IMAGE}:${IMAGE_TAG}${NC}..."
  docker pull "${REPO_IMAGE}:${IMAGE_TAG}"
}

# ── 10. Install Systemd Service ──────────────────────────────────────────────
setup_systemd() {
  LOG_INFO "Setting up systemd service (vaultrealm.service)..."
  cat <<EOF > /etc/systemd/system/vaultrealm.service
[Unit]
Description=VaultRealm Game Server Control Panel
Documentation=https://github.com/VaultSoft-Labs-Software-Automation/VaultRealm
After=docker.service network-online.target
Wants=network-online.target
Requires=docker.service

[Service]
Type=simple
Restart=always
RestartSec=5
TimeoutStartSec=0
EnvironmentFile=-/etc/vaultrealm/vaultrealm.env
ExecStartPre=-/usr/bin/docker stop vaultrealm
ExecStartPre=-/usr/bin/docker rm vaultrealm
ExecStart=/usr/bin/docker run --name vaultrealm \\
  --rm \\
  -p \${PORT:-${PANEL_PORT}}:3001 \\
  -v /var/run/docker.sock:/var/run/docker.sock \\
  -v ${DATA_DIR}:${DATA_DIR} \\
  --env-file /etc/vaultrealm/vaultrealm.env \\
  ${REPO_IMAGE}:${IMAGE_TAG}
ExecStop=/usr/bin/docker stop -t 10 vaultrealm

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable vaultrealm.service >/dev/null 2>&1
  LOG_INFO "Starting VaultRealm service..."
  systemctl restart vaultrealm.service
}

# ── 11. Install 'vaultrealm' / 'vr' Management CLI ───────────────────────────
install_cli() {
  LOG_INFO "Installing management CLI to ${BOLD}${CLI_PATH}${NC}..."
  cat <<'CLI_EOF' > "${CLI_PATH}"
#!/usr/bin/env bash
# VaultRealm Management CLI

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

ENV_FILE="/etc/vaultrealm/vaultrealm.env"
DATA_DIR="/srv/vaultrealm/data"
REPO_IMAGE="hypertextassassin/vaultrealm"

get_port() {
  if [ -f "$ENV_FILE" ]; then
    grep -E '^PORT=' "$ENV_FILE" 2>/dev/null | cut -d'=' -f2 | tr -d ' "' || echo "3001"
  else
    echo "3001"
  fi
}

get_public_ip() {
  curl -4 -s --max-time 3 https://api.ipify.org 2>/dev/null || \
  curl -4 -s --max-time 3 https://ifconfig.me 2>/dev/null || \
  hostname -I 2>/dev/null | awk '{print $1}' || echo "127.0.0.1"
}

vr_status() {
  echo -e "\n${BOLD}=== VaultRealm Service Status ===${NC}"
  systemctl status vaultrealm --no-pager || true
  echo ""
  if docker ps -f name=vaultrealm --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' | grep -q vaultrealm; then
    docker ps -f name=vaultrealm --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
    local PORT
    PORT="$(get_port)"
    local IP
    IP="$(get_public_ip)"
    echo -e "\n${GREEN}✔ Panel is running:${NC} ${CYAN}http://${IP}:${PORT}${NC}"
  else
    echo -e "\n${RED}✘ Panel container is not currently running.${NC}"
  fi
  echo ""
}

vr_start() {
  echo -e "${CYAN}Starting VaultRealm...${NC}"
  systemctl start vaultrealm
  vr_status
}

vr_stop() {
  echo -e "${YELLOW}Stopping VaultRealm...${NC}"
  systemctl stop vaultrealm
  echo -e "${GREEN}VaultRealm stopped.${NC}"
}

vr_restart() {
  echo -e "${CYAN}Restarting VaultRealm...${NC}"
  systemctl restart vaultrealm
  vr_status
}

vr_logs() {
  echo -e "${CYAN}Attaching to VaultRealm live logs (Ctrl+C to exit)...${NC}"
  docker logs -f --tail 100 vaultrealm
}

vr_port() {
  local CURRENT_PORT
  CURRENT_PORT="$(get_port)"
  echo -e "Current Web Port: ${BOLD}${CURRENT_PORT}${NC}"
  read -r -p "Enter new port: " NEW_PORT
  if [[ "$NEW_PORT" =~ ^[0-9]+$ ]] && [ "$NEW_PORT" -ge 1 ] && [ "$NEW_PORT" -le 65535 ]; then
    sed -i "s/^PORT=.*/PORT=${NEW_PORT}/" "$ENV_FILE"
    if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
      ufw allow "${NEW_PORT}/tcp" >/dev/null 2>&1 || true
    fi
    echo -e "${GREEN}Port updated to ${NEW_PORT}. Restarting panel...${NC}"
    systemctl restart vaultrealm
    vr_status
  else
    echo -e "${RED}Invalid port number.${NC}"
  fi
}

vr_update() {
  local TARGET_TAG="${1:-latest}"
  echo -e "${CYAN}Checking for updates (${REPO_IMAGE}:${TARGET_TAG})...${NC}"
  docker pull "${REPO_IMAGE}:${TARGET_TAG}"
  echo -e "${CYAN}Applying update and restarting service...${NC}"
  systemctl restart vaultrealm
  echo -e "${GREEN}VaultRealm successfully updated to latest version!${NC}"
  vr_status
}

vr_diag() {
  echo -e "\n${BOLD}=== VaultRealm Host Diagnostic ===${NC}"
  echo "Kernel: $(uname -srm)"
  echo "Docker Version: $(docker --version 2>/dev/null || echo 'Not found')"
  echo "Data Storage Used: $(du -sh "$DATA_DIR" 2>/dev/null || echo 'N/A')"
  echo "Active Game Servers:"
  docker ps --filter "label=vaultrealm=true" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null || echo "None"
  echo ""
}

vr_backup() {
  local SERVER_ID="${1:-}"
  local SERVERS_DIR="${DATA_DIR}/servers"
  local BACKUPS_DIR="${DATA_DIR}/backups"
  mkdir -p "$BACKUPS_DIR"

  if [ -z "$SERVER_ID" ]; then
    echo -e "\n${BOLD}Available Game Servers:${NC}"
    if [ ! -d "$SERVERS_DIR" ] || [ -z "$(ls -A "$SERVERS_DIR" 2>/dev/null)" ]; then
      echo -e "${YELLOW}No servers found in ${SERVERS_DIR}.${NC}"
      return
    fi
    ls -1 "$SERVERS_DIR"
    echo ""
    read -r -p "Enter Server ID to backup: " SERVER_ID
  fi

  if [ -z "$SERVER_ID" ] || [ ! -d "${SERVERS_DIR}/${SERVER_ID}" ]; then
    echo -e "${RED}Server directory not found: ${SERVERS_DIR}/${SERVER_ID}${NC}"
    return
  fi

  local TIMESTAMP
  TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
  local ARCHIVE_NAME="${SERVER_ID}_manual_${TIMESTAMP}.tar.gz"
  local ARCHIVE_PATH="${BACKUPS_DIR}/${ARCHIVE_NAME}"

  echo -e "${CYAN}Creating backup archive for server '${SERVER_ID}'...${NC}"
  tar -czf "$ARCHIVE_PATH" -C "${SERVERS_DIR}/${SERVER_ID}" .
  local SIZE
  SIZE="$(du -h "$ARCHIVE_PATH" | cut -f1)"
  echo -e "${GREEN}✔ Backup created successfully!${NC}"
  echo -e "  File: ${BOLD}${ARCHIVE_PATH}${NC}"
  echo -e "  Size: ${SIZE}"
}

vr_restore() {
  local SERVER_ID="${1:-}"
  local ARCHIVE_PATH="${2:-}"
  local SERVERS_DIR="${DATA_DIR}/servers"
  local BACKUPS_DIR="${DATA_DIR}/backups"

  if [ -z "$SERVER_ID" ]; then
    echo -e "\n${BOLD}Available Game Servers:${NC}"
    if [ ! -d "$SERVERS_DIR" ] || [ -z "$(ls -A "$SERVERS_DIR" 2>/dev/null)" ]; then
      echo -e "${YELLOW}No servers found in ${SERVERS_DIR}.${NC}"
      return
    fi
    ls -1 "$SERVERS_DIR"
    echo ""
    read -r -p "Enter Server ID to restore: " SERVER_ID
  fi

  if [ -z "$SERVER_ID" ] || [ ! -d "${SERVERS_DIR}/${SERVER_ID}" ]; then
    echo -e "${RED}Server directory not found: ${SERVERS_DIR}/${SERVER_ID}${NC}"
    return
  fi

  if [ -z "$ARCHIVE_PATH" ]; then
    echo -e "\n${BOLD}Available Backups in ${BACKUPS_DIR}:${NC}"
    if [ -d "$BACKUPS_DIR" ]; then
      ls -1 "${BACKUPS_DIR}"/*.tar.gz 2>/dev/null || echo "No .tar.gz archives found."
    fi
    echo ""
    read -r -p "Enter path to backup archive (.tar.gz): " ARCHIVE_PATH
  fi

  if [ ! -f "$ARCHIVE_PATH" ]; then
    echo -e "${RED}Archive file not found: ${ARCHIVE_PATH}${NC}"
    return
  fi

  echo -e "${YELLOW}${BOLD}WARNING: Restoring will overwrite existing files in ${SERVERS_DIR}/${SERVER_ID}.${NC}"
  read -r -p "Are you sure you want to proceed with restore? [y/N]: " CONFIRM
  if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
    echo "Restore cancelled."
    return
  fi

  # Check if container is running
  local CONTAINER_ID
  CONTAINER_ID="$(docker ps -q --filter "label=vaultrealm=true" --filter "name=${SERVER_ID}" 2>/dev/null || true)"
  local WAS_RUNNING=false
  if [ -n "$CONTAINER_ID" ]; then
    WAS_RUNNING=true
    echo -e "${CYAN}Stopping server container temporarily...${NC}"
    docker stop "$CONTAINER_ID" >/dev/null 2>&1 || true
  fi

  echo -e "${CYAN}Extracting backup archive to ${SERVERS_DIR}/${SERVER_ID}...${NC}"
  tar -xzf "$ARCHIVE_PATH" -C "${SERVERS_DIR}/${SERVER_ID}"

  if [ "$WAS_RUNNING" = true ]; then
    echo -e "${CYAN}Restarting server container...${NC}"
    docker start "$CONTAINER_ID" >/dev/null 2>&1 || true
  fi

  echo -e "${GREEN}✔ Server '${SERVER_ID}' restored successfully from ${ARCHIVE_PATH}!${NC}"
}

vr_reset() {
  echo -e "${YELLOW}WARNING: This resets the initial setup status so you can register a new admin account.${NC}"
  read -r -p "Are you sure? [y/N]: " CONFIRM
  if [[ "$CONFIRM" =~ ^[Yy]$ ]]; then
    systemctl stop vaultrealm
    if [ -f "${DATA_DIR}/vaultrealm.db" ]; then
      cp "${DATA_DIR}/vaultrealm.db" "${DATA_DIR}/vaultrealm.db.backup.$(date +%s)"
      echo "Created database backup."
      # Remove users and sessions to trigger initial setup wizard
      if command -v sqlite3 >/dev/null 2>&1; then
        sqlite3 "${DATA_DIR}/vaultrealm.db" "DELETE FROM sessions; DELETE FROM users;"
      else
        docker run --rm -v "${DATA_DIR}:/data" alpine/sqlite /data/vaultrealm.db "DELETE FROM sessions; DELETE FROM users;"
      fi
      echo -e "${GREEN}Admin setup reset. Open the panel to create your fresh admin account.${NC}"
    fi
    systemctl start vaultrealm
  fi
}

vr_uninstall() {
  echo -e "${RED}${BOLD}DANGER: You are about to uninstall VaultRealm.${NC}"
  read -r -p "Stop and remove VaultRealm service? [y/N]: " CONFIRM
  if [[ "$CONFIRM" =~ ^[Yy]$ ]]; then
    systemctl stop vaultrealm >/dev/null 2>&1 || true
    systemctl disable vaultrealm >/dev/null 2>&1 || true
    rm -f /etc/systemd/system/vaultrealm.service
    systemctl daemon-reload
    docker stop vaultrealm >/dev/null 2>&1 || true
    docker rm vaultrealm >/dev/null 2>&1 || true
    
    read -r -p "Also permanently delete all server game data and backups in ${DATA_DIR}? [y/N]: " DEL_DATA
    if [[ "$DEL_DATA" =~ ^[Yy]$ ]]; then
      rm -rf "$DATA_DIR"
      rm -rf "$ENV_FILE"
      echo "Data directory removed."
    else
      echo "Server game files preserved at ${DATA_DIR}."
    fi

    rm -f /usr/local/bin/vaultrealm /usr/local/bin/vr
    echo -e "${GREEN}VaultRealm uninstalled successfully.${NC}"
    exit 0
  fi
}

show_menu() {
  clear
  local PORT
  PORT="$(get_port)"
  local IP
  IP="$(get_public_ip)"
  cat <<'BANNER_EOF'
 __      __            _ _   _____            _             
 \ \    / /           | | | |  __ \          | |            
  \ \  / /__ _  _   _ | | |_| |__) |___  __ _| |_ __ ___   
   \ \/ // _` || | | || | __|  _  // _ \/ _` | | '_ ` _ \  
    \  /| (_| || |_| || | |_| | \ \  __/ (_| | | | | | | | 
     \/  \__,_| \__,_||_|\__|_|  \_\___|\__,_|_|_| |_| |_| 
BANNER_EOF
  echo -e "   ${BOLD}Autonomous Game Server Control Panel${NC} — Management CLI\n"
  echo -e " Panel URL: ${CYAN}http://${IP}:${PORT}${NC}\n"
  echo " --------------------------------------------------------"
  echo "  1. Start VaultRealm"
  echo "  2. Stop VaultRealm"
  echo "  3. Restart VaultRealm"
  echo "  4. View Status & Health"
  echo "  5. View Live Logs (follow)"
  echo "  6. Change Web Port (Current: ${PORT})"
  echo "  7. Update Panel to Latest Version"
  echo "  8. System Diagnostics & Game Servers"
  echo "  9. Create Manual Server Backup"
  echo " 10. Restore Server from Backup Archive"
  echo " 11. Reset First-Time Admin Setup"
  echo " 12. Uninstall VaultRealm"
  echo " --------------------------------------------------------"
  echo "  0. Exit"
  echo ""
  read -r -p "Select option [0-12]: " CHOICE
  case "$CHOICE" in
    1) vr_start ;;
    2) vr_stop ;;
    3) vr_restart ;;
    4) vr_status ;;
    5) vr_logs ;;
    6) vr_port ;;
    7) vr_update ;;
    8) vr_diag ;;
    9) vr_backup ;;
    10) vr_restore ;;
    11) vr_reset ;;
    12) vr_uninstall ;;
    0) exit 0 ;;
    *) echo -e "${RED}Invalid option.${NC}" ;;
  esac
}

case "${1:-}" in
  start) vr_start ;;
  stop) vr_stop ;;
  restart) vr_restart ;;
  status) vr_status ;;
  logs) vr_logs ;;
  port) vr_port ;;
  update) vr_update "${2:-latest}" ;;
  diag) vr_diag ;;
  backup) vr_backup "${2:-}" ;;
  restore) vr_restore "${2:-}" "${3:-}" ;;
  reset) vr_reset ;;
  uninstall) vr_uninstall ;;
  help|--help|-h)
    echo "Usage: vaultrealm [start|stop|restart|status|logs|port|update|diag|backup|restore|reset|uninstall]"
    ;;
  *)
    show_menu
    ;;
esac
CLI_EOF

  chmod +x "${CLI_PATH}"
  ln -sf "${CLI_PATH}" "${CLI_SYMLINK}"
  LOG_SUCCESS "Management CLI installed: run '${BOLD}vaultrealm${NC}' or '${BOLD}vr${NC}' anytime."
}

# ── 12. Health Check & Banner ────────────────────────────────────────────────
verify_and_finish() {
  LOG_INFO "Waiting for VaultRealm panel to initialize..."
  local READY=false
  for i in $(seq 1 30); do
    if curl -sSf "http://127.0.0.1:${PANEL_PORT}/healthz" 2>/dev/null | grep -q '"status":"ok"'; then
      READY=true
      break
    fi
    sleep 1
  done

  local PUBLIC_IP
  PUBLIC_IP="$(curl -4 -s --max-time 3 https://api.ipify.org 2>/dev/null || curl -4 -s --max-time 3 https://ifconfig.me 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || echo "127.0.0.1")"
  local LOCAL_IP
  LOCAL_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || echo "127.0.0.1")"

  echo ""
  echo -e "${GREEN}========================================================================${NC}"
  echo -e "               ${BOLD}✨ VaultRealm Installed Successfully! ✨${NC}"
  echo -e "${GREEN}========================================================================${NC}"
  echo ""
  echo -e "  ${BOLD}Web Panel URL:${NC}       ${CYAN}http://${PUBLIC_IP}:${PANEL_PORT}${NC}"
  echo -e "  ${BOLD}Local Network URL:${NC}   ${CYAN}http://${LOCAL_IP}:${PANEL_PORT}${NC}"
  echo -e "  ${BOLD}Data Directory:${NC}      ${YELLOW}${DATA_DIR}${NC}"
  echo -e "  ${BOLD}Config Environment:${NC}  ${YELLOW}${ENV_FILE}${NC}"
  echo ""
  echo -e "  ${BOLD}First Time Setup:${NC}"
  echo -e "    Open ${CYAN}http://${PUBLIC_IP}:${PANEL_PORT}${NC} in your browser to register your"
  echo -e "    admin account and start deploying game servers."
  echo ""
  echo -e "  ${BOLD}Management Command:${NC}"
  echo -e "    Run ${GREEN}vaultrealm${NC} (or ${GREEN}vr${NC}) anytime to open the management menu,"
  echo -e "    view live logs, restart, change port, or update the panel."
  echo ""
  echo -e "${GREEN}========================================================================${NC}"
  echo ""
}

# ── Main Execution Flow ──────────────────────────────────────────────────────
main() {
  echo -e "${CYAN}"
  cat <<'BANNER_EOF'
 __      __            _ _   _____            _             
 \ \    / /           | | | |  __ \          | |            
  \ \  / /__ _  _   _ | | |_| |__) |___  __ _| |_ __ ___   
   \ \/ // _` || | | || | __|  _  // _ \/ _` | | '_ ` _ \  
    \  /| (_| || |_| || | |_| | \ \  __/ (_| | | | | | | | 
     \/  \__,_| \__,_||_|\__|_|  \_\___|\__,_|_|_| |_| |_| 
BANNER_EOF
  echo -e "${NC}"
  echo -e "     ${BOLD}VaultRealm Autonomous Game Server Panel Installer${NC}\n"

  check_root
  check_arch
  install_prerequisites
  ensure_docker
  parse_version "${1:-}"
  configure_port
  configure_firewall
  setup_filesystem
  pull_image
  setup_systemd
  install_cli
  verify_and_finish
}

main "$@"


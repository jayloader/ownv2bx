#!/usr/bin/env bash
set -euo pipefail
umask 077

readonly APP=/opt/xbray
readonly CURRENT=$APP/current
readonly PREVIOUS=$APP/previous
readonly RELEASES=$APP/releases
readonly CONFIG_DIR=/etc/xbray
readonly CONFIG=$CONFIG_DIR/node.env
readonly STATE_DIR=/var/lib/xbray
readonly TRAFFIC=$STATE_DIR/traffic.json
readonly UNIT=xbray.service
readonly UNIT_PATH=/etc/systemd/system/$UNIT
readonly MIGRATION_DROP_IN=$UNIT_PATH.d/10-legacy-group.conf
readonly MANAGER=/usr/local/bin/xbrayctl
readonly LEGACY=ownv2bx
readonly LEGACY_CONFIG=/etc/$LEGACY/node.env
readonly LEGACY_STATE=/var/lib/$LEGACY
readonly LEGACY_TRAFFIC=$LEGACY_STATE/traffic.json
readonly LEGACY_UNIT=$LEGACY.service
readonly LEGACY_LOCK=/opt/$LEGACY/.install.lock
readonly XRAY_VERSION=v26.11.9
readonly -a MEMBERS=(LICENSE.nodejs install.sh node.env.example xbray xbray.service xbrayctl)

die() { printf '%s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
用法
  bash install.sh [--repo OWNER/REPO] [--version TAG|latest] [--xray-zip PATH]
  bash install.sh --bundle PATH [--xray-zip PATH]
  bash install.sh --rollback

默认用 curl 下载 jayloader/xbray 的公开 Release。私有仓库可使用已登录的 gh。
请用普通用户运行下载；写入系统目录时会使用 sudo。
离线安装提供本机发行包、同名 .sha256 文件及官方 Xray zip。
如果检测到上一代 systemd 安装，首次安装会迁移配置及流量队列。
EOF
}

require() {
  local command
  for command in "$@"; do
    command -v "$command" >/dev/null || die "缺少命令 $command"
  done
}

architecture() {
  case $(uname -m) in
    x86_64)
      bundle_asset=xbray-linux-amd64.tar.gz
      xray_asset=Xray-linux-64.zip
      xray_digest=b651f7e1d9966ee2c1b1ee1bf8b52c72771824d3065dce96bbc8bcc19ed95f82
      ;;
    aarch64|arm64)
      bundle_asset=xbray-linux-arm64.tar.gz
      xray_asset=Xray-linux-arm64-v8a.zip
      xray_digest=64ed6858982a7f5eb85d88b811089063bd4f17561f4c8f44e0f1dc8e6f6430be
      ;;
    *) die '当前 CPU 不在 Linux x86_64、ARM64 发行范围内' ;;
  esac
}

digest() {
  local sum
  sum=$(sha256sum < "$1") || return
  printf '%s\n' "${sum%% *}"
}

verify_digest() {
  local actual
  actual=$(digest "$1") || die "无法读取 $1"
  [[ $actual == "$2" ]] || die 'SHA-256 校验失败，安装未继续'
}

fetch_https() {
  curl -fLSs --proto '=https' --proto-redir '=https' --retry 3 --connect-timeout 15 --max-time 180 \
    -o "$2" -- "$1"
}

download_release() {
  local root="https://github.com/$repo/releases" public_url
  local -a download
  [[ $repo =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ && $repo != -* ]] || die '仓库名必须采用 OWNER/REPO 格式'
  [[ $version != -* ]] || die '版本号无效'

  if command -v curl >/dev/null && [[ $version =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]*$ ]]; then
    if [[ $version == latest ]]; then
      public_url=$root/latest/download
    else
      public_url=$root/download/$version
    fi
    if fetch_https "$public_url/$bundle_asset.sha256" "$work/$bundle_asset.sha256" 2>/dev/null \
      && fetch_https "$public_url/$bundle_asset" "$work/$bundle_asset"; then
      return 0
    fi
  fi

  command -v gh >/dev/null || die '无法下载公开 Release。请检查仓库和版本；私有仓库可登录 gh，也可使用 --bundle'
  rm -f -- "$work/$bundle_asset" "$work/$bundle_asset.sha256"
  download=(gh release download --repo "$repo" --dir "$work" --pattern "$bundle_asset" --pattern "$bundle_asset.sha256")
  if [[ $version != latest ]]; then download+=("$version"); fi
  GH_PROMPT_DISABLED=1 "${download[@]}" || die 'Release 下载失败。请检查仓库、版本和 gh 登录权限，或使用 --bundle'
}

as_root() {
  if (( EUID == 0 )); then
    bash "$self" "$@"
  else
    require sudo
    sudo -- bash "$self" "$@"
  fi
}

managed_target() {
  local link=$1 target
  [[ -L $link ]] || return 1
  target=$(readlink -- "$link") || return 1
  [[ $target == "$RELEASES"/release-* && ${target#"$RELEASES"/} != */* && -d $target ]] || return 1
  printf '%s\n' "$target"
}

point_link() {
  local target=$1 link=$2 temp="$2.next.$$"
  ln -s -- "$target" "$temp" || return
  if ! mv -Tf -- "$temp" "$link"; then
    rm -f -- "$temp"
    return 1
  fi
}

install_unit() {
  local temp
  temp=$(mktemp "$UNIT_PATH.XXXXXXXX") || return
  if ! install -m 0644 -- "$1" "$temp" || ! mv -Tf -- "$temp" "$UNIT_PATH"; then
    rm -f -- "$temp"
    return 1
  fi
}

restart_if_active() {
  [[ $was_active == active ]] || return 0
  systemctl restart "$UNIT" || return
  sleep 2
  systemctl is-active --quiet "$UNIT"
}

activate() {
  local next=$1 old=$2
  local was_active
  was_active=$(systemctl is-active "$UNIT" || true)
  case $was_active in
    activating|deactivating|reloading) die '服务正在切换状态，请稍后重试' ;;
  esac
  if [[ $was_active == active ]]; then
    [[ -n $old ]] || die '已有运行中的同名服务，请先处理服务冲突'
    env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin "$next/xbray" --check-config "$CONFIG" || die '配置校验失败，现有服务继续运行'
  fi

  if install_unit "$next/$UNIT" && point_link "$next" "$CURRENT" \
    && systemctl daemon-reload && restart_if_active; then
    if [[ -n $old ]]; then
      point_link "$old" "$PREVIOUS" || die '版本已切换，但未能记录回滚目标'
    fi
    return 0
  fi

  if [[ -n $old ]]; then
    if install_unit "$old/$UNIT" && point_link "$old" "$CURRENT" \
      && systemctl daemon-reload && restart_if_active; then
      die '服务切换失败，已恢复上一版本'
    fi
    die '服务切换失败，自动恢复未成功。请检查 systemctl status xbray'
  fi
  rm -f -- "$UNIT_PATH" "$CURRENT"
  systemctl daemon-reload || true
  die '首次安装未能完成，请检查 systemd 日志后重试'
}

copy_0600() {
  local source=$1 target=$2 owner=$3 temp
  temp=$(mktemp "$target.XXXXXXXX") || return
  if ! install -m 0600 -o "$owner" -g "$owner" -- "$source" "$temp" || ! mv -Tf -- "$temp" "$target"; then
    rm -f -- "$temp"
    return 1
  fi
}

stopped_unit() {
  local state
  state=$(systemctl show --property=ActiveState --value "$1") || return
  [[ $state == inactive || $state == failed ]]
}

restore_legacy_traffic() {
  [[ -e $TRAFFIC || -L $TRAFFIC ]] || return 0
  [[ -f $TRAFFIC && ! -L $TRAFFIC && ! -L $LEGACY_STATE && ! -L $LEGACY_TRAFFIC ]] || return 1
  if [[ -f $LEGACY_TRAFFIC ]] && cmp -s -- "$TRAFFIC" "$LEGACY_TRAFFIC"; then return 0; fi
  if [[ ! -d $LEGACY_STATE ]]; then
    install -d -m 0700 -o "$LEGACY" -g "$LEGACY" -- "$LEGACY_STATE" || return
  fi
  copy_0600 "$TRAFFIC" "$LEGACY_TRAFFIC" "$LEGACY"
}

restore_migration() {
  local exit_status=$1
  if (( exit_status == 0 )); then return 0; fi
  trap '' INT TERM
  # The replacement may already have acknowledged traffic. Return its final
  # queue to the legacy service before starting it again.
  if (( new_start )) && ! { systemctl stop "$UNIT" && stopped_unit "$UNIT" && restore_legacy_traffic; }; then
    die '无法安全交还流量队列。请检查 xbray 停止状态和两份流量文件，旧服务保持停用'
  fi
  if (( new_enable )) && ! systemctl disable "${legacy_runtime[@]}" "$UNIT"; then
    die '无法撤销 xbray 的开机启动，旧服务保持停用'
  fi

  if (( new_activate )); then rm -f -- "$UNIT_PATH" "$CURRENT"; fi
  if (( new_manager )); then rm -f -- "$MANAGER"; fi
  if (( new_drop_in )); then rm -f -- "$MIGRATION_DROP_IN"; fi
  if (( new_config )); then rm -f -- "$CONFIG"; fi
  if (( new_traffic || new_start )); then rm -f -- "$TRAFFIC"; fi
  systemctl daemon-reload || die '迁移回退时无法重新载入 systemd，请检查旧服务状态'
  if (( legacy_enabled )); then
    systemctl enable "${legacy_runtime[@]}" "$LEGACY_UNIT" || die '迁移回退时无法恢复旧服务的开机启动'
  fi
  if [[ $legacy_active == active ]]; then
    systemctl start "$LEGACY_UNIT" || die '迁移回退时无法启动旧服务'
  fi
  printf '%s\n' '迁移失败，已恢复旧服务设置。' >&2
}

migrate() (
  local next=$1 drop_ins enable_state
  [[ -f $LEGACY_CONFIG && ! -L $LEGACY_CONFIG && -d $(dirname "$LEGACY_LOCK") ]] \
    || die '检测到旧服务，但未找到标准安装配置。请先备份旧配置和流量队列'
  [[ ! -e $CONFIG && ! -L $CONFIG && ! -e $TRAFFIC && ! -L $TRAFFIC \
    && ! -L $STATE_DIR && ! -L $LEGACY_STATE && ! -L $LEGACY_TRAFFIC \
    && ! -e $MIGRATION_DROP_IN && ! -L $MIGRATION_DROP_IN ]] \
    || die '迁移路径已有配置或流量文件，请先检查并备份，旧服务暂不切换'
  require grep cmp
  exec 8>"$LEGACY_LOCK"
  flock -n 8 || die '旧服务正在安装或更新，请稍后重试'
  drop_ins=$(systemctl show --property=DropInPaths --value "$LEGACY_UNIT")
  if [[ -n $drop_ins ]] || grep -Eq '^[[:space:]]*(STATE_DIR|NODE_LOCK_DIR|XRAY_BIN)[[:space:]]*=' "$LEGACY_CONFIG"; then
    die '旧服务使用自定义 systemd 或状态路径。请先备份并手动迁移这些设置'
  fi
  getent group "$LEGACY" >/dev/null && getent passwd "$LEGACY" >/dev/null \
    || die '未找到旧服务的运行账号，请先检查旧安装'
  legacy_active=$(systemctl show --property=ActiveState --value "$LEGACY_UNIT")
  case $legacy_active in
    active) env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin "$next/xbray" --check-config "$LEGACY_CONFIG" ;;
    inactive|failed) ;;
    *) die '旧服务正在切换状态，请稍后重试' ;;
  esac
  legacy_enabled=0
  legacy_runtime=()
  enable_state=$(systemctl is-enabled "$LEGACY_UNIT" || true)
  case $enable_state in
    enabled) legacy_enabled=1 ;;
    enabled-runtime) legacy_enabled=1; legacy_runtime=(--runtime) ;;
    disabled) ;;
    *) die '旧服务使用自定义开机状态，请先检查 systemd 设置' ;;
  esac

  new_start=0 new_enable=0 new_activate=0 new_manager=0 new_drop_in=0 new_config=0 new_traffic=0
  trap 'restore_migration "$?"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  if (( legacy_enabled )); then systemctl disable "${legacy_runtime[@]}" "$LEGACY_UNIT"; fi
  systemctl stop "$LEGACY_UNIT"
  stopped_unit "$LEGACY_UNIT" || die '旧服务仍在运行，停止迁移'

  if [[ ! -d $CONFIG_DIR ]]; then install -d -m 0700 -- "$CONFIG_DIR"; fi
  new_config=1
  copy_0600 "$LEGACY_CONFIG" "$CONFIG" root
  if [[ -e $LEGACY_TRAFFIC ]]; then
    [[ -f $LEGACY_TRAFFIC && ! -L $LEGACY_TRAFFIC ]] || die '旧流量队列必须是普通文件'
    if [[ ! -d $STATE_DIR ]]; then install -d -m 0700 -o xbray -g xbray -- "$STATE_DIR"; fi
    new_traffic=1
    copy_0600 "$LEGACY_TRAFFIC" "$TRAFFIC" xbray
  fi
  # Existing TLS files can be readable through the former service group.
  install -d -m 0755 -- "$UNIT_PATH.d"
  new_drop_in=1
  printf '[Service]\nSupplementaryGroups=%s\n' "$LEGACY" > "$MIGRATION_DROP_IN"
  if [[ ! -L $MANAGER ]]; then
    new_manager=1
    point_link "$CURRENT/xbrayctl" "$MANAGER"
  fi
  new_activate=1
  activate "$next" ''
  if (( legacy_enabled )); then
    new_enable=1
    systemctl enable "${legacy_runtime[@]}" "$UNIT"
  fi
  if [[ $legacy_active == active ]]; then
    new_start=1
    systemctl start "$UNIT"
    sleep 2
    systemctl is-active --quiet "$UNIT" || die 'xbray 启动后退出，正在恢复旧服务'
  fi
  trap - EXIT INT TERM
  printf '%s\n' '已迁移旧配置及流量队列。旧服务已停止并停用，原文件保留。运行 xbrayctl 查看管理命令。'
)

apply() {
  (( EUID == 0 )) || die '系统安装步骤需要管理员权限'
  require flock getent install readlink systemctl
  systemctl show-environment >/dev/null || die '无法连接 systemd 管理器'
  [[ ! -L $APP && ! -L $RELEASES && ! -L $CONFIG_DIR ]] || die '安装目录不能是符号链接'
  install -d -m 0755 -- "$APP" "$RELEASES"
  exec 9>"$APP/.install.lock"
  flock -n 9 || die '另一个安装或回滚正在进行'

  local old='' next archive candidate member expected actual
  if [[ -e $CURRENT || -L $CURRENT ]]; then
    old=$(managed_target "$CURRENT") || die '现有安装路径与本安装器冲突'
  elif [[ -e $UNIT_PATH || -L $UNIT_PATH ]]; then
    die "已有 $UNIT_PATH，请先处理现有服务"
  fi
  if [[ -e $MANAGER || -L $MANAGER ]]; then
    [[ -L $MANAGER && $(readlink -- "$MANAGER") == "$CURRENT/xbrayctl" ]] || die "已有 $MANAGER，请先处理命令冲突"
  fi

  if [[ $1 == rollback ]]; then
    [[ -n $old ]] || die '找不到当前版本'
    next=$(managed_target "$PREVIOUS") || die '没有可回滚的版本'
    activate "$next" "$old"
    printf '%s\n' '已切换到上一版本。'
    return
  fi

  local input_dir=$2 archive_digest=$3
  [[ $archive_digest =~ ^[0-9a-f]{64}$ ]] || die '发行包校验值无效'
  require sha256sum tar unzip sort
  architecture
  archive=$input_dir/$bundle_asset
  verify_digest "$archive" "$archive_digest"
  verify_digest "$input_dir/$xray_asset" "$xray_digest"
  next=$RELEASES/release-$archive_digest
  if [[ $next == "$old" ]]; then
    printf '%s\n' '当前已是该版本。'
    return
  fi

  if [[ ! -d $next ]]; then
    expected=$(printf '%s\n' "${MEMBERS[@]}" | LC_ALL=C sort)
    actual=$(tar -tzf "$archive" | LC_ALL=C sort)
    [[ $actual == "$expected" ]] || die '发行包的文件列表不符合预期'
    candidate=$(mktemp -d "$RELEASES/.candidate.XXXXXXXX")
    trap 'rm -rf -- "$candidate"' EXIT
    for member in "${MEMBERS[@]}"; do
      tar -xOzf "$archive" -- "$member" > "$candidate/$member"
      [[ -s $candidate/$member ]] || die "发行包缺少有效的 $member"
    done
    unzip -p "$input_dir/$xray_asset" xray > "$candidate/xray"
    chmod 0755 -- "$candidate" "$candidate/xbray" "$candidate/xbrayctl" "$candidate/install.sh" "$candidate/xray"
    chmod 0644 -- "$candidate/$UNIT" "$candidate/node.env.example" "$candidate/LICENSE.nodejs"
    env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin "$candidate/xbray" --version \
      || die '无法运行发行版。请检查 glibc 2.28+、libstdc++、libatomic 和 CPU 架构'
    "$candidate/xray" version >/dev/null || die '无法运行 Xray-core'
    mv -T -- "$candidate" "$next"
    trap - EXIT
  fi

  if ! getent group xbray >/dev/null; then
    require groupadd
    groupadd --system xbray
  fi
  if ! getent passwd xbray >/dev/null; then
    require useradd
    useradd --system --gid xbray --home-dir "$STATE_DIR" --shell /usr/sbin/nologin xbray
  fi
  if [[ -z $old ]]; then
    local legacy_load
    legacy_load=$(systemctl show --property=LoadState --value "$LEGACY_UNIT" || true)
    case $legacy_load in
      loaded) migrate "$next"; return ;;
      not-found|'') ;;
      *) die '检测到旧服务，但该服务不可正常管理，请先检查 systemd 配置' ;;
    esac
  fi
  if [[ ! -e $CONFIG ]]; then
    [[ ! -L $CONFIG ]] || die '配置文件链接已损坏'
    if [[ ! -d $CONFIG_DIR ]]; then install -d -m 0700 -- "$CONFIG_DIR"; fi
    install -m 0600 -- "$next/node.env.example" "$CONFIG"
  fi

  local new_manager=0
  if [[ ! -L $MANAGER ]]; then
    point_link "$CURRENT/xbrayctl" "$MANAGER" || die '无法安装 xbrayctl 命令'
    new_manager=1
  fi
  if (( new_manager )); then
    trap 'if [[ ! -L $CURRENT ]]; then rm -f -- "$MANAGER"; fi' EXIT
  fi
  activate "$next" "$old"
  trap - EXIT
  printf '%s\n' '安装完成。运行 xbrayctl 查看管理命令。'
  if [[ -z $old ]]; then
    printf '%s\n' '首次启动前运行 sudo xbrayctl config，然后运行 sudo xbrayctl enable --now。'
  fi
}

repo=jayloader/xbray
version=latest
bundle=''
xray_zip=''
rollback=0
if [[ ${1:-} == --apply ]]; then
  shift
  apply "$@"
  exit
fi
while (($#)); do
  case $1 in
    -h|--help) usage; exit ;;
    --rollback) rollback=1; shift ;;
    --repo|--version|--bundle|--xray-zip)
      [[ $# -ge 2 && -n $2 && $2 != --* ]] || die "$1 需要参数"
      case $1 in
        --repo) repo=$2 ;;
        --version) version=$2 ;;
        --bundle) bundle=$2 ;;
        --xray-zip) xray_zip=$2 ;;
      esac
      shift 2
      ;;
    *) die "未知选项 $1" ;;
  esac
done

[[ $(uname -s) == Linux && -d /run/systemd/system ]] || die '安装需要运行 systemd 的 Linux 系统'
require readlink
self=$(readlink -f -- "${BASH_SOURCE[0]}")
if (( rollback )); then
  [[ -z $bundle && -z $xray_zip && $version == latest && $repo == jayloader/xbray ]] || die '--rollback 不能和下载选项一起使用'
  as_root --apply rollback
  exit
fi

require sha256sum
architecture
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
if [[ -n $bundle ]]; then
  cp -- "$bundle" "$work/$bundle_asset"
  [[ -s $bundle.sha256 ]] || die '请将同名 .sha256 校验文件放在发行包旁边'
  cp -- "$bundle.sha256" "$work/$bundle_asset.sha256"
else
  download_release
fi

archive_digest=$(digest "$work/$bundle_asset")
[[ -s $work/$bundle_asset.sha256 ]] || die '发行版缺少 SHA-256 文件'
read -r expected _ < "$work/$bundle_asset.sha256" || die 'SHA-256 文件无法读取'
[[ $expected =~ ^[0-9a-f]{64}$ && $archive_digest == "$expected" ]] || die '发行包 SHA-256 校验失败'
if [[ -n $xray_zip ]]; then
  cp -- "$xray_zip" "$work/$xray_asset"
else
  require curl
  fetch_https "https://github.com/XTLS/Xray-core/releases/download/$XRAY_VERSION/$xray_asset" "$work/$xray_asset"
fi
verify_digest "$work/$xray_asset" "$xray_digest"
as_root --apply install "$work" "$archive_digest"

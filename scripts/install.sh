#!/usr/bin/env bash
set -euo pipefail
umask 077

readonly APP=/opt/ownv2bx
readonly CURRENT=$APP/current
readonly PREVIOUS=$APP/previous
readonly RELEASES=$APP/releases
readonly CONFIG_DIR=/etc/ownv2bx
readonly CONFIG=$CONFIG_DIR/node.env
readonly UNIT=ownv2bx.service
readonly UNIT_PATH=/etc/systemd/system/$UNIT
readonly MANAGER=/usr/local/bin/ownv2bxctl
readonly XRAY_VERSION=v26.11.9
readonly -a MEMBERS=(LICENSE.nodejs install.sh node.env.example ownv2bx ownv2bx.service ownv2bxctl)

die() { printf '%s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
用法
  bash install.sh [--repo OWNER/REPO] [--version TAG|latest] [--xray-zip PATH]
  bash install.sh --bundle PATH [--xray-zip PATH]
  bash install.sh --rollback

默认用 curl 下载 jayloader/ownv2bx 的公开 Release。私有仓库可使用已登录的 gh。
请用普通用户运行下载；写入系统目录时会使用 sudo。
离线安装提供本机发行包、同名 .sha256 文件及官方 Xray zip。
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
      bundle_asset=ownv2bx-linux-amd64.tar.gz
      xray_asset=Xray-linux-64.zip
      xray_digest=b651f7e1d9966ee2c1b1ee1bf8b52c72771824d3065dce96bbc8bcc19ed95f82
      ;;
    aarch64|arm64)
      bundle_asset=ownv2bx-linux-arm64.tar.gz
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
    env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin "$next/ownv2bx" --check-config "$CONFIG" || die '配置校验失败，现有服务继续运行'
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
    die '服务切换失败，自动恢复未成功。请检查 systemctl status ownv2bx'
  fi
  rm -f -- "$UNIT_PATH" "$CURRENT"
  systemctl daemon-reload || true
  die '首次安装未能完成，请检查 systemd 日志后重试'
}

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
    [[ -L $MANAGER && $(readlink -- "$MANAGER") == "$CURRENT/ownv2bxctl" ]] || die "已有 $MANAGER，请先处理命令冲突"
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
    chmod 0755 -- "$candidate" "$candidate/ownv2bx" "$candidate/ownv2bxctl" "$candidate/install.sh" "$candidate/xray"
    chmod 0644 -- "$candidate/$UNIT" "$candidate/node.env.example" "$candidate/LICENSE.nodejs"
    env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin "$candidate/ownv2bx" --version \
      || die '无法运行发行版。请检查 glibc 2.28+、libstdc++、libatomic 和 CPU 架构'
    "$candidate/xray" version >/dev/null || die '无法运行 Xray-core'
    mv -T -- "$candidate" "$next"
    trap - EXIT
  fi

  if ! getent group ownv2bx >/dev/null; then
    require groupadd
    groupadd --system ownv2bx
  fi
  if ! getent passwd ownv2bx >/dev/null; then
    require useradd
    useradd --system --gid ownv2bx --home-dir /var/lib/ownv2bx --shell /usr/sbin/nologin ownv2bx
  fi
  if [[ ! -e $CONFIG ]]; then
    [[ ! -L $CONFIG ]] || die '配置文件链接已损坏'
    if [[ ! -d $CONFIG_DIR ]]; then install -d -m 0700 -- "$CONFIG_DIR"; fi
    install -m 0600 -- "$next/node.env.example" "$CONFIG"
  fi

  local new_manager=0
  if [[ ! -L $MANAGER ]]; then
    point_link "$CURRENT/ownv2bxctl" "$MANAGER" || die '无法安装 ownv2bxctl 命令'
    new_manager=1
  fi
  if (( new_manager )); then
    trap 'if [[ ! -L $CURRENT ]]; then rm -f -- "$MANAGER"; fi' EXIT
  fi
  activate "$next" "$old"
  trap - EXIT
  printf '%s\n' '安装完成。运行 ownv2bxctl 查看管理命令。'
  if [[ -z $old ]]; then
    printf '%s\n' '首次启动前运行 sudo ownv2bxctl config，然后运行 sudo ownv2bxctl enable --now。'
  fi
}

repo=jayloader/ownv2bx
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
  [[ -z $bundle && -z $xray_zip && $version == latest && $repo == jayloader/ownv2bx ]] || die '--rollback 不能和下载选项一起使用'
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

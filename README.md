# ownv2bx

连接 Xboard 面板和 Xray-core 的 VLESS 节点后端。它通过 UniProxy V1 定期拉取节点配置和有权限的用户，把上行、下行字节数及节点状态回报给面板。同一进程管理一个节点，可为不同节点分别运行实例。协议和入站连接由官方 Xray-core 处理，Node.js 服务没有第三方 npm 依赖。

## 支持范围

- VLESS over TCP（RAW），使用 TLS 或 REALITY，可选 `xtls-rprx-vision`。明文 VLESS 仅用于显式开启的回环测试。
- TLS 从本地读取证书和私钥。REALITY 使用 Xboard 下发的目标域名、端口、X25519 私钥和 Short ID。
- 支持 ETag、用户同步、流量增量重试和 CPU、内存、交换区、磁盘状态上报。授权更新会重启 Xray，现有连接会断开。
- 首版暂未实现其他协议、其他传输方式、用户限速、设备限制和在线 IP 汇报。带有非零限速或设备限制的用户会被暂停授权。配置包含自定义路由、出站、面板证书下发、ECH、VLESS Encryption 或多路复用时，节点启动会被拒绝。

## Linux 安装

Release 提供 `amd64` 和 `arm64` 单文件程序，程序内含 Node.js 运行时。服务器只需 systemd、glibc 2.28+、libstdc++ 和 libatomic 等系统库。安装脚本会校验后端和官方 Xray-core v26.11.9 的下载包，并安装 systemd 服务。 [Node.js 单文件程序](https://nodejs.org/download/release/v26.13.1/docs/api/single-executable-applications.html) · [Xray-core v26.11.9](https://github.com/XTLS/Xray-core/releases/tag/v26.11.9)

在 Debian 或 Ubuntu 上，使用 `sudo apt install libatomic1 ca-certificates curl unzip` 安装对应依赖。以有 `sudo` 权限的普通用户执行以下命令，从公开 Release 下载并校验安装脚本。 [GitHub Release](https://github.com/jayloader/ownv2bx/releases/latest)

```sh
base=https://github.com/jayloader/ownv2bx/releases/latest/download
curl -fSLO "$base/install.sh" &&
  curl -fSLO "$base/install.sh.sha256" &&
  sha256sum -c install.sh.sha256 &&
  bash install.sh
```

如需离线安装，下载对应架构的 `ownv2bx-linux-amd64.tar.gz` 或 `ownv2bx-linux-arm64.tar.gz` 及其 `.sha256`，再和安装脚本、官方 Xray 压缩包一起复制到服务器。以下示例以 `amd64` 为例。

```sh
sha256sum -c install.sh.sha256
bash install.sh --bundle ./ownv2bx-linux-amd64.tar.gz --xray-zip ./Xray-linux-64.zip
```

首次安装生成 `/etc/ownv2bx/node.env`，配置完成后在命令行管理菜单中启动服务。安装后由专用用户 `ownv2bx` 运行，默认将待上报流量保存在 `/var/lib/ownv2bx`。

## 对接 Xboard

在 Xboard 新建 VLESS 节点并选择 `tcp`，填写客户端访问地址和端口，以及服务器实际监听的 TCP 端口，并关联用户所在权限组。在节点服务器防火墙放行这个入站端口，并允许访问面板 HTTPS。统计 API 监听本机 `127.0.0.1`。 [Xboard 节点配置](https://github.com/cedar2025/Xboard/blob/master/app/Services/ServerService.php#L233-L373)

| 变量 | 填写方式 |
| --- | --- |
| `XBOARD_URL` | 面板根地址，例如 `https://panel.example.com`。有部署路径前缀时一并填写。 |
| `XBOARD_TOKEN` | 面板的节点通信密钥。 |
| `XBOARD_NODE_ID` | VLESS 节点的 ID 或节点标识。 |
| `XRAY_CERT_FILE`、`XRAY_KEY_FILE` | TLS 节点填写完整证书链和私钥文件路径。REALITY 节点留空。 |
| `XRAY_LISTEN` | 监听 IP，默认 `0.0.0.0`。 |
| `XRAY_API_PORT`、`STATE_DIR` | 本机统计端口和状态目录。每个节点实例使用不同的端口和目录。 |

TLS 节点的证书应覆盖客户端配置使用的域名，证书和私钥需能被 `ownv2bx` 服务读取。REALITY 节点在面板填入目标域名、目标端口、公钥、私钥和 Short ID。

```sh
sudo ownv2bxctl config
sudo ownv2bxctl enable --now
ownv2bxctl status
```

看到 `Xray 已载入节点配置` 后，从 Xboard 订阅导入节点并发起一次请求。面板的流量更新时间在第一次有流量的上报之后刷新。UniProxy V1 的鉴权密钥放在查询参数里，面板和反向代理的访问日志应避免记录该参数。仓库忽略默认状态目录、实际 `.env` 和常见私钥文件。 [Xboard UniProxy 路由](https://github.com/cedar2025/Xboard/blob/master/app/Http/Routes/V1/ServerRoute.php) · [节点鉴权](https://github.com/cedar2025/Xboard/blob/master/app/Http/Middleware/Server.php)

## 命令行管理

运行 `sudo ownv2bxctl` 可打开有权限修改系统服务的中文菜单。公开仓库可以直接用 `ownv2bxctl update` 更新。使用 `--repo` 指定私有仓库时，先以有读取权限的普通用户登录 `gh`。 [GitHub CLI 下载 Release](https://cli.github.com/manual/gh_release_download)

| 命令 | 操作 |
| --- | --- |
| `ownv2bxctl status` | 查看服务状态。 |
| `sudo ownv2bxctl start` / `sudo ownv2bxctl stop` / `sudo ownv2bxctl restart` | 启动、停止或重启。 |
| `sudo ownv2bxctl enable --now` / `sudo ownv2bxctl disable` | 启动并设置开机启动，或取消开机启动。 |
| `sudo ownv2bxctl logs` | 查看最近日志。 |
| `sudo ownv2bxctl config` | 编辑并校验配置。 |
| `ownv2bxctl version` | 查看后端和 Xray 版本。 |
| `ownv2bxctl update` | 从 GitHub Release 拉取最新版。 |
| `ownv2bxctl update --version v0.2.1` | 安装指定版本。也可传 `--bundle` 使用本地包。 |
| `sudo ownv2bxctl rollback` | 切回上一个已安装版本。 |

更新保留 `/etc/ownv2bx/node.env` 和流量队列。运行中的服务会在更新时重启，若 systemd 启动失败会切回上一版。已安装 v0.2.0 的服务器按上面的匿名安装命令升级一次，之后即可直接使用 `ownv2bxctl update`。若未来版本更新所需的 Xray-core 版本，先重新下载对应 Release 的安装脚本再更新。

### 中断和计费

节点按面板推拉间隔运行，有效范围为 5 至 3600 秒。网络故障期间，旧授权最多保持 `STALE_AFTER` 秒或三个拉取周期中的较长值。超过期限后暂停服务，拉取并应用有效配置后恢复。

流量增量先写入 `STATE_DIR/traffic.json`，面板确认后清空待上报队列。UniProxy 的流量接口按次累加且没有幂等键。面板收到上报但确认丢失，或服务器在确认后、清空队列前掉电，下一次重试可能重复记账。内核意外退出时，上次采样之后的流量可能丢失。 [Xboard 流量接收逻辑](https://github.com/cedar2025/Xboard/blob/master/app/Services/ServerService.php#L113-L133)

systemd 会随服务生命周期清理锁目录。手动运行时若异常退出并留下 `STATE_DIR/node.lock`，先确认记录的进程和 Xray 已退出，再移除锁文件。为不同面板或节点更换配置时，使用新的状态目录。

## 从源码运行

源码运行需 Node.js 22+ 和官方 Xray-core v26.11.9，可用于本地开发或 Windows 测试。将 `.env.example` 复制为 `.env` 并填写配置，设置 `XRAY_BIN` 或将 Xray 放入 `PATH`，再执行 `node --env-file=.env src/main.mjs`。

## 测试

运行 `node --test`。设置 `XRAY_TEST_BIN` 为官方 Xray 可执行文件的绝对路径后，同一命令同时运行真实 Xray 集成测试。

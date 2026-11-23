# ownv2bx

连接 Xboard 面板和 Xray-core 的 VLESS 节点后端。它通过 UniProxy V1 定期拉取节点配置和有权限的用户，把上行、下行字节数及节点状态回报给面板。同一进程管理一个节点，可为不同节点分别运行实例。协议和入站连接由官方 Xray-core 处理，Node.js 服务没有第三方 npm 依赖。

## 支持范围

- VLESS over TCP（RAW），使用 TLS 或 REALITY，可选 `xtls-rprx-vision`。明文 VLESS 仅用于显式开启的回环测试。
- TLS 从本地读取证书和私钥。REALITY 使用 Xboard 下发的目标域名、端口、X25519 私钥和 Short ID。
- 支持 ETag、用户同步、流量增量重试和 CPU、内存、交换区、磁盘状态上报。授权更新会重启 Xray，现有连接会断开。
- 首版暂未实现其他协议、其他传输方式、用户限速、设备限制和在线 IP 汇报。带有非零限速或设备限制的用户会被暂停授权。配置包含自定义路由、出站、面板证书下发、ECH、VLESS Encryption 或多路复用时，节点启动会被拒绝。

## 配置与运行

1. 在节点服务器上准备 Node.js 22 或以上版本，以及官方 Xray-core v26.11.9。按服务器的系统和架构下载、校验并解压发行包，将 `xray` 放入 `PATH`，或在配置中指定其绝对路径。该版本的代理出站默认限制访问本地及私有地址。 [Xray-core v26.11.9](https://github.com/XTLS/Xray-core/releases/tag/v26.11.9)
2. 在 Xboard 新建 VLESS 节点并选择 `tcp`，填写供客户端订阅使用的地址和端口，填写本机实际监听的服务器端口，并关联订阅用户所在的权限组。记录节点 ID 或节点标识，以及 Xboard 的节点通信密钥。 [Xboard 节点配置](https://github.com/cedar2025/Xboard/blob/master/app/Services/ServerService.php#L233-L373)
3. 在节点服务器复制 `.env.example` 为 `.env`，填写以下对应配置。服务只需要连接面板 HTTPS，并在节点服务器防火墙放行 Xboard 中配置的入站 TCP 端口。统计 API 监听本机 `127.0.0.1`。

| 变量 | 填写方式 |
| --- | --- |
| `XBOARD_URL` | 面板根地址，例如 `https://panel.example.com`。有部署路径前缀时一并填写。 |
| `XBOARD_TOKEN` | 面板的节点通信密钥。 |
| `XBOARD_NODE_ID` | VLESS 节点的 ID 或节点标识。 |
| `XRAY_CERT_FILE`、`XRAY_KEY_FILE` | TLS 节点填写完整证书链和私钥文件路径。REALITY 节点留空。 |
| `XRAY_LISTEN` | 监听 IP，默认 `0.0.0.0`。 |
| `XRAY_API_PORT`、`STATE_DIR` | 本机统计端口和状态目录。每个节点实例使用不同的端口和目录。 |

TLS 节点的证书应覆盖客户端下载配置使用的域名。REALITY 节点在面板填入目标域名、目标端口、公钥、私钥和 Short ID。Linux 可以先用以下命令在前台运行，Windows 使用同一条 `node` 命令。

```sh
cp .env.example .env
chmod 600 .env
# 编辑 .env 后启动
node --env-file=.env src/main.mjs
```

看到 `Xray 已载入节点配置` 后，从 Xboard 订阅导入节点并发起一次请求。面板的流量更新时间在第一次有流量的上报之后刷新。UniProxy V1 的鉴权密钥放在查询参数里，面板和反向代理的访问日志应避免记录该参数。仓库忽略默认状态目录、实际 `.env` 和常见私钥文件。 [Xboard UniProxy 路由](https://github.com/cedar2025/Xboard/blob/master/app/Http/Routes/V1/ServerRoute.php) · [节点鉴权](https://github.com/cedar2025/Xboard/blob/master/app/Http/Middleware/Server.php)

### Linux 持续运行

可用 systemd 运行。以下单元假设代码位于 `/opt/ownv2bx`，已有专用用户 `ownv2bx`，`node` 位于 `/usr/bin/node`。让该用户能读取 `.env`、Xray 和 TLS 文件。示例使用 `8443` 这类非特权端口。

```ini
[Unit]
Description=ownv2bx Xboard node
Wants=network-online.target
After=network-online.target

[Service]
User=ownv2bx
WorkingDirectory=/opt/ownv2bx
StateDirectory=ownv2bx
StateDirectoryMode=0700
Environment=STATE_DIR=/var/lib/ownv2bx
ExecStart=/usr/bin/node --env-file=.env src/main.mjs
Restart=on-failure
RestartSec=5
KillMode=mixed
TimeoutStopSec=60
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

将单元保存为 `/etc/systemd/system/ownv2bx.service` 后，运行 `sudo systemctl daemon-reload` 和 `sudo systemctl enable --now ownv2bx`。用 `journalctl -u ownv2bx -f` 查看日志。源码可以存放在 GitHub 私有仓库，节点进程运行在你的服务器上。

### 中断和计费

节点按面板推拉间隔运行，有效范围为 5 至 3600 秒。网络故障期间，旧授权最多保持 `STALE_AFTER` 秒或三个拉取周期中的较长值。超过期限后暂停服务，拉取并应用有效配置后恢复。

流量增量先写入 `STATE_DIR/traffic.json`，面板确认后清空待上报队列。UniProxy 的流量接口按次累加且没有幂等键。面板收到上报但确认丢失，或服务器在确认后、清空队列前掉电，下一次重试可能重复记账。内核意外退出时，上次采样之后的流量可能丢失。 [Xboard 流量接收逻辑](https://github.com/cedar2025/Xboard/blob/master/app/Services/ServerService.php#L113-L133)

进程崩溃后如果遗留 `STATE_DIR/node.lock`，先确认其中的 PID 和它启动的 Xray 已退出，再移除该锁文件并重启服务。保留 `traffic.json` 可继续补报。为不同面板或节点更换配置时，使用新的状态目录。

## 测试

运行 `node --test`。设置 `XRAY_TEST_BIN` 为官方 Xray 可执行文件的绝对路径后，同一命令同时运行真实 Xray 集成测试。

# Lab 1 个人助手原型

电脑开机且未休眠时在后台运行；手机通过飞书机器人交互。当前先打通个人资料、表单预览／确认填写和英文邮件中文摘要，完整实验的其余范围见 [需求](requirements.md)。

## 本地安装与配置

需要 Node.js 24+。在本目录运行：

```powershell
npm ci
npx playwright install chromium --only-shell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
npm run doctor
```

本目录 `.env` 覆盖课程目录 `D:\GSE\.env`；现有仅包含一行 DeepSeek 密钥的格式也可读取，无需复制密钥。主模型 `deepseek-flash`，备用 `deepseek-v4-flash`。依据[官方更新](https://api-docs.deepseek.com/news/news260910/)，备用目前是同一新版模型的兼容别名，因此无法提供独立服务的容灾。

真实配置、资料、数据库、截图、历史和日志均放在 Git 忽略的 `.env` 或 `data/`。个人资料入口是 `data/profile.md`；可直接编辑或在飞书发送 `资料 字段=值`。空值表示未知；当前带适用范围／有效期的事实保守留空，等待进一步处理。

## 飞书机器人

使用独立的**企业自建应用机器人**，需要能创建和发布应用的飞书组织。不是群聊里的 Webhook 自定义机器人。

1. 在[飞书开放平台](https://open.feishu.cn/app)创建自建应用，启用机器人能力；可用范围先设为自己。
2. 配置应用身份权限：读取用户发给机器人的单聊消息 `im:message.p2p_msg:readonly`、以应用身份发消息 `im:message:send_as_bot`、图片资源 `im:resource`。权限名称以控制台实际显示为准。
3. 将 App ID、App Secret 写入本目录 `.env` 的 `FEISHU_APP_ID` 和 `FEISHU_APP_SECRET`。不要发送到聊天中。
4. 运行 `npm run start`，用 `npm run status` 确认连接状态。事件配置选择“使用长连接接收事件”，添加 `im.message.receive_v1`。
5. 创建版本并发布，使权限和事件生效。若有管理员审核，按组织流程完成。
6. 本机运行 `npm run doctor -- --pairing` 获取绑定指令，在 iPhone 飞书里私聊机器人发送。首次绑定后仅接受该用户的私聊指令。

不需要公网 IP、端口映射或常开的桌面聊天窗口。[官方 SDK](https://github.com/larksuite/node-sdk/blob/main/README.zh.md)说明长连接机制；接口参考：[收消息](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive)、[发消息](https://open.feishu.cn/document/server-docs/im-v1/message/create)、[传图片](https://open.feishu.cn/document/server-docs/im-v1/image/create)。

## 邮箱

本地 `.env` 的 `MAIL_USERNAME` 已记录用户提供的 smail 地址。按[南大官方说明](https://itsc.nju.edu.cn/_s302/1a/8f/c21586a334479/page.psp)开启 IMAP，使用 `imap.exmail.qq.com:993`、TLS、完整邮箱用户名；需要客户端专用密码时，按照[官方密码说明](https://itsc.nju.edu.cn/96/2e/c21475a497198/page.htm)生成，将其写入本地 `MAIL_PASSWORD`。

**自动读取默认关闭，待确认摘要范围后开启。** 若选“新增的所有英文邮件”，配置：

```dotenv
MAIL_ENABLED=true
MAIL_SCOPE=all-new-english
MAIL_POLL_SECONDS=300
```

改配置后重启助手。首次成功连接只记下当时最新 UID，此后每 5 分钟检查新增邮件，关机后的积压会补查。英文识别目前是字符比例启发式，可能漏掉中英混合邮件；原始邮件超过 5 MB 会跳过，正文仅取前 40000 字符。附件、历史往来、论文主题分类、回复和发信尚未实现。

摘要包含目的、待办、原文截止日期／时区、要求及不确定项，附原邮件 Message-ID 和邮箱入口。摘要所需邮件正文，以及表单匹配所需字段与资料会发送给配置的 DeepSeek API；仅在对应任务启用后处理。

## 手机指令与填表

| 指令 | 行为 |
| --- | --- |
| `资料` | 查看当前个人资料 |
| `资料 常用邮箱=example@example.org` | 保存明确提供的事实，保留修改前版本 |
| `资料 联系电话=` | 清空该字段 |
| 一个表单 URL | 读取并展示拟填字段、留空项与确认码 |
| `确认填表 任务编号 确认码` | 对应资料与表单未变化时才填写 |
| `进度` | 查看最近任务 |
| `帮助` | 查看指令 |

只支持公开网页上的普通输入框、文本区、下拉框和单选框。模型负责匹配，填入值必须来自资料；未知、歧义或不匹配的选项留空，包括必填项。预览确认前不输入个人数据；填写后核对字段并返回截图。当前**没有最终提交功能**，后台页面在退出时关闭，截图不等于提交成功。

用户示例问卷当前停止作答，尚未在该问卷上验证兼容性。登录、验证码、多步骤、文件上传、iframe 和复杂动态控件待实际需求驱动扩展。

## 启停与验证

```powershell
npm run start
npm run status
npm run stop
npm test
npm run doctor -- --model
```

启动进程独立于终端，Windows 使用 `windowsHide`；启动后可关闭终端。当前没有配置开机自启。`data/status.json` 保存连接状态与心跳，`data/background.log` 保存简短运行信息。不要同时为同一机器人运行多个事件接收程序。

测试使用虚构资料和本地 HTML 表单，检查确认门槛、未知必填项留空、不提交、变更导致确认失效、去重、持久化和模型故障切换。`doctor --model` 单独进行一次不含个人信息的真实 API 连通测试。

`node src/cli.js start --offline` 仅用于测试后台存活与停止，不连接飞书、不访问邮箱。实际账号联调仍需在手机收发消息和新邮件上验收。

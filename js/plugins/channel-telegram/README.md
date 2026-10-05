# @parel/channel-telegram

> PAREL channel connector for Telegram Bot API webhooks.

This package exports a `ChannelConnector` for PAREL's managed channel layer. It
normalizes Telegram webhook updates into channel events and delivers replies
through the Telegram Bot API.

## Install

```bash
npm install @parel/channel-telegram
```

## Usage

Declare the connection in `agent.yaml`; deploying (or promoting) the version
creates the `webhook` connection and binds it to the agent:

```yaml
channels:
  - type: webhook
    plugin: "@parel/channel-telegram"
    config:
      botToken: ${TELEGRAM_BOT_TOKEN}
      webhookSecret: ${TELEGRAM_WEBHOOK_SECRET}
    routing:
      mode: per_subject
```

| Key | Meaning |
|---|---|
| `botToken` | Telegram bot token from BotFather, used for Bot API delivery. Secret. |
| `webhookSecret` | The `secret_token` you give Telegram's `setWebhook`; checked against the `X-Telegram-Bot-Api-Secret-Token` header. Secret. PAREL requires it for webhook connections. |

Both values are secrets, so write them as `${NAME}` references. Channel secrets
are read from the workspace's stored secrets and `parel deploy` does not upload
them from your shell, so store them first (needs an Admin-scope API key):

```bash
export TELEGRAM_BOT_TOKEN=123456:ABC-...
export TELEGRAM_WEBHOOK_SECRET=$(openssl rand -hex 32)
parel secrets set TELEGRAM_BOT_TOKEN
parel secrets set TELEGRAM_WEBHOOK_SECRET
parel deploy ./agent.yaml --json   # the result lists the connection id (chn_...)
```

Then point Telegram at the connection's webhook URL, passing the same secret:

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -d url=https://api.parel.sh/webhooks/channels/chn_... \
  -d secret_token=$TELEGRAM_WEBHOOK_SECRET
```

The same connection can be created through the HTTP API
(`POST /channels/connections` and `POST /channels/bindings`); see the
[API reference](https://parel.sh/docs/api#channels).

## SDK usage

Provider SDKs may be used as parser, builder, or type helpers only. This
connector must not let an SDK own transport, retries, timers, sockets, or direct
provider API calls. All side effects must be returned as `ConnectorEffect`
objects for the PAREL platform to execute.

## External references

This connector depends on Telegram Bot API conventions documented here:

- Bot API overview: https://core.telegram.org/bots/api
- Webhook `secret_token` and `X-Telegram-Bot-Api-Secret-Token` header:
  https://core.telegram.org/bots/api#setwebhook
- `Update` payload shape: https://core.telegram.org/bots/api#update
- `Message` payload shape, including `chat` and `message_thread_id`:
  https://core.telegram.org/bots/api#message
- `CallbackQuery` payload shape: https://core.telegram.org/bots/api#callbackquery
- Bot API request URL shape:
  https://core.telegram.org/bots/api#making-requests
- `sendMessage` delivery method: https://core.telegram.org/bots/api#sendmessage
- `answerCallbackQuery` delivery method:
  https://core.telegram.org/bots/api#answercallbackquery

## License

MIT - see [LICENSE](./LICENSE).

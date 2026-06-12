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

```json
{
  "type": "webhook",
  "plugin": "@parel/channel-telegram"
}
```

Configure Telegram with the platform webhook URL and optionally pass a
`secret_token`. Store the bot token as the `botToken` plugin secret and the
webhook token as `webhookSecret`.

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

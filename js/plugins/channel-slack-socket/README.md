# @parel/channel-slack-socket

> PAREL channel connector for Slack Socket Mode.

This package exports a `ChannelConnector` for PAREL's managed WebSocket channel
layer. It opens Slack Socket Mode connections, acknowledges envelopes, normalizes
Slack payloads into channel events, and delivers replies through Slack Web API.

## Install

```bash
npm install @parel/channel-slack-socket
```

## Usage

```json
{
  "type": "managed_ws",
  "plugin": "@parel/channel-slack-socket",
  "start": true
}
```

Store the Slack app-level token as `appToken` and bot token as `botToken`.

## SDK usage

Provider SDKs may be used as parser, builder, or type helpers only. This
connector must not let an SDK own transport, retries, timers, sockets, or direct
provider API calls. All side effects must be returned as `ConnectorEffect`
objects for the PAREL platform to execute.

## External references

This connector depends on Slack platform conventions documented here:

- Socket Mode connection, envelopes, ack, and disconnect frames:
  https://docs.slack.dev/apis/events-api/using-socket-mode/
- `apps.connections.open` method:
  https://docs.slack.dev/reference/methods/apps.connections.open/
- `connections:write` app-level token scope:
  https://docs.slack.dev/reference/scopes/connections.write/
- Events API payload shape: https://docs.slack.dev/apis/events-api/
- Interaction payloads:
  https://docs.slack.dev/reference/interaction-payloads/
- Slash command payloads:
  https://docs.slack.dev/interactivity/implementing-slash-commands/
- Interaction `response_url` delivery:
  https://docs.slack.dev/interactivity/handling-user-interaction/
- `chat.postMessage` delivery method:
  https://docs.slack.dev/reference/methods/chat.postMessage/

## License

MIT - see [LICENSE](./LICENSE).

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

Declare the connection in `agent.yaml`; deploying (or promoting) the version
creates the `managed_ws` connection, binds it to the agent, and starts it:

```yaml
channels:
  - type: managed_ws
    plugin: "@parel/channel-slack-socket"
    config:
      appToken: ${SLACK_APP_TOKEN}
      botToken: ${SLACK_BOT_TOKEN}
    routing:
      mode: per_subject
```

| Key | Meaning |
|---|---|
| `appToken` | Slack app-level token with `connections:write`, used to open the Socket Mode connection. Secret. |
| `botToken` | Slack bot token, used for Web API delivery such as `chat.postMessage`. Secret. |

Both tokens are secrets, so write them as `${NAME}` references. Channel secrets
are read from the workspace's stored secrets and `parel deploy` does not upload
them from your shell, so store them first (needs an Admin-scope API key):

```bash
export SLACK_APP_TOKEN=xapp-...
export SLACK_BOT_TOKEN=xoxb-...
parel secrets set SLACK_APP_TOKEN
parel secrets set SLACK_BOT_TOKEN
parel deploy ./agent.yaml
```

An always-on `managed_ws` connection needs the Hobby or Pro plan. The same
connection can be created through the HTTP API (`POST /channels/connections`
and `POST /channels/bindings`); see the
[API reference](https://parel.sh/docs/api#channels).

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

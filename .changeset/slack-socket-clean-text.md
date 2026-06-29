---
"@parel/channel-slack-socket": minor
---

Expose a top-level `text` on the inbound event `data` (the human message) alongside the raw
`payload`, so hosts that materialize the event into a transcript show the message rather than
the whole Slack Socket Mode envelope. Text is surfaced only for human-authored message /
app_mention / slash_command events — bot-authored messages (`bot_id` / `bot_message`) and an
interactive payload's bot prompt are not promoted as the human message.

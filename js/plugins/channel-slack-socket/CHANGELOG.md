# @parel/channel-slack-socket

## 0.3.0

### Minor Changes

- 04aa1e9: Expose a top-level `text` on the inbound event `data` (the human message) alongside the raw
  `payload`, so hosts that materialize the event into a transcript show the message rather than
  the whole Slack Socket Mode envelope. Text is surfaced only for human-authored message /
  app_mention / slash_command events — bot-authored messages (`bot_id` / `bot_message`) and an
  interactive payload's bot prompt are not promoted as the human message.

### Patch Changes

- Updated dependencies [73afdb1]
  - @parel/plugin-sdk@0.8.0

## 0.2.7

### Patch Changes

- Updated dependencies [440f4b9]
  - @parel/plugin-sdk@0.7.0

## 0.2.6

### Patch Changes

- Updated dependencies [3ee20d4]
  - @parel/plugin-sdk@0.6.0

## 0.2.5

### Patch Changes

- Updated dependencies [095391b]
  - @parel/plugin-sdk@0.5.0

## 0.2.4

### Patch Changes

- @parel/plugin-sdk@0.4.2

## 0.2.3

### Patch Changes

- @parel/plugin-sdk@0.4.1

## 0.2.2

### Patch Changes

- c3d6746: Republish: the previous versions were published manually with `npm publish`,
  which does not rewrite `workspace:*` dependency ranges, making the packages
  uninstallable from npm. Publishing through the changesets flow rewrites the
  ranges correctly. (The coding agent suite and sandbox providers are republished
  via their own changesets in this release.)

## 0.2.1

### Patch Changes

- Updated dependencies [429a42d]
  - @parel/plugin-sdk@0.4.0

## 0.2.0

### Minor Changes

- 6945eb2: Add first-party Telegram webhook and Slack Socket Mode channel connector plugins.

### Patch Changes

- Updated dependencies [6945eb2]
  - @parel/plugin-sdk@0.3.0

## 0.1.0

### Minor Changes

- Add the Slack Socket Mode channel connector.

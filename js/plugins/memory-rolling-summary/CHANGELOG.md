# @parel/memory-rolling-summary

## 0.1.15

### Patch Changes

- Updated dependencies [c52c48d]
  - @parel/plugin-sdk@0.11.0

## 0.1.14

### Patch Changes

- @parel/plugin-sdk@0.10.2

## 0.1.13

### Patch Changes

- Updated dependencies [25352cf]
  - @parel/plugin-sdk@0.10.1

## 0.1.12

### Patch Changes

- Updated dependencies [c838bce]
  - @parel/plugin-sdk@0.10.0

## 0.1.11

### Patch Changes

- Updated dependencies [81d25db]
  - @parel/plugin-sdk@0.9.0

## 0.1.10

### Patch Changes

- Updated dependencies [73afdb1]
  - @parel/plugin-sdk@0.8.0

## 0.1.9

### Patch Changes

- Updated dependencies [440f4b9]
  - @parel/plugin-sdk@0.7.0

## 0.1.8

### Patch Changes

- Updated dependencies [3ee20d4]
  - @parel/plugin-sdk@0.6.0

## 0.1.7

### Patch Changes

- Updated dependencies [095391b]
  - @parel/plugin-sdk@0.5.0

## 0.1.6

### Patch Changes

- @parel/plugin-sdk@0.4.2

## 0.1.5

### Patch Changes

- @parel/plugin-sdk@0.4.1

## 0.1.4

### Patch Changes

- Updated dependencies [429a42d]
  - @parel/plugin-sdk@0.4.0

## 0.1.3

### Patch Changes

- Updated dependencies [6945eb2]
  - @parel/plugin-sdk@0.3.0

## 0.1.2

### Patch Changes

- @parel/plugin-sdk@0.2.4

## 0.1.1

### Patch Changes

- @parel/plugin-sdk@0.2.3

## 0.1.0

### Minor Changes

- 5622bac: Real rolling context compaction. At turn end the plugin now folds messages older
  than `keep_recent_messages` into a running summary (folding the previous summary
  forward), and at context build it prunes that summarized prefix from the model
  call while injecting the summary — so the context window actually shrinks instead
  of only gaining an appended summary. New config: `keep_recent_messages` (default 12) and `compact_at` (default 0.8).

### Patch Changes

- Updated dependencies [5622bac]
  - @parel/plugin-sdk@0.2.2

## 0.0.5

### Patch Changes

- 16e1721: Ship a README and LICENSE inside every published package tarball so npm package
  pages render documentation and the MIT license travels with the package.
- Updated dependencies [16e1721]
  - @parel/plugin-sdk@0.2.1

## 0.0.4

### Patch Changes

- Updated dependencies [c85f198]
  - @parel/plugin-sdk@0.2.0

## 0.0.3

### Patch Changes

- Updated dependencies [31cc0dd]
  - @parel/plugin-sdk@0.1.0

## 0.0.2

### Patch Changes

- Set up release automation and npm package metadata.
- Updated dependencies
  - @parel/plugin-sdk@0.0.2

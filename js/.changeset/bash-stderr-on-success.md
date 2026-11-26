---
"@parel/capability-sandbox": minor
"@parel/sandbox-e2b": patch
---

fix(sandbox): keep stderr in a successful shell tool result

`renderCommandToolOutput` returned only stdout when a command exited 0, so the model never saw stderr from a command line that ended in success. A shell line's exit status is its last command's: in `parall messages send …; cd ~; sed …` the send failed and wrote its error to stderr, `sed` exited 0, and the `bash` tool reported an empty success — the agent then told the user it had sent a message that never went out. CLIs also put their conclusions and next steps on stderr, which the model lost on every successful command.

A successful tool result is now stdout followed by stderr (unchanged when stderr is empty); failures render as before. `renderCommandText`, which backs the string `exec` capability that plugins parse programmatically, still returns stdout alone on success.

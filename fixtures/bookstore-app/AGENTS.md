<!-- eyrie:start -->
## Eyrie architecture tools

Eyrie keeps a live architecture map of this repository. When the eyrie MCP server is connected, use its tools around every edit:

- Before editing, call `components_for_files` with the files you plan to change, and `impact` on the components involved, to see what depends on them.
- At the start of a task, call `record_intent` with the task; call it again with `done: true` and a `summary` when the task ends.
- After editing, call `recent_changes` to see what your edits changed, and `check` for new findings in the files you touched.
<!-- eyrie:end -->

Only if the Mode line is exactly `**Mode:** quick` or `**Mode:** quick-full` (or with ` (revision)`), else ignore.
PLAN frontmatter: top-level `tier:` A/B/C. Quick id = first 10 chars of the Directory line's last path part. Use existing tasks:
- first line of task 1 action: `rigorscope unit-start --kind quick --id <quick id> --tier-source plan-at-start --command quick`
- last line of the last task action: `rigorscope unit-close --kind quick --id <quick id> --status complete --command quick`
Copy each command line and the sentence below verbatim into the action, the sentence right after each of the two commands. Not callable: print `rigorscope not installed: unit not recorded`. Non-zero exit: continue, never retry.

# Privacy

rigorscope is local and stores metadata only. It opens no network connection, never starts the `claude` program, and writes only under
`~/.rigorscope/` (one exception: `preserve-scrub --apply` rewrites rigorscope's own preserve copy, see "OTel and the preserve copy"
below). This page says what is stored, what never is, and the test that enforces it.

## What is stored

Token counts, ids and a few labels, from the allowlist in [sources](sources.md): session, agent, message and request ids; the line
timestamp; the model name; the attribution agent name; effort, version and usage labels; and six token counters. Also:

- the planning files an assistant line's tool_use blocks name in their structured path fields (`cc_message_ref`: the home-normalized
  directory, the path from the planning directory on, the kind, the tool name and a count) and the slash-command NAME of a user line
  (`cc_command`);
- the repository each working directory belongs to (`dir_repo`: the home-normalized directory, the repository key, the method that
  resolved it and whether it is a linked worktree), which git supplies and the transcripts do not;
- unit facts: tier letters, dates, commit hashes with author times, file names with status and line counts, and the forward ledger.

Nothing else is read from a transcript.

## What is never stored, logged, printed or hashed

One hash is stored, and it is not an identity: `env_snapshot.hooks_sha` is the sha256 of the hooks configuration of the settings file, a
change detector. No hook command text is stored or printed. Nothing else is hashed.

- Prompts, responses, command text, file content or any other message text.
- Email addresses, account ids, organization ids, and the operating-system user name (also from `~/.claude.json`).
- Absolute paths. The only path-like values stored are `cc_message.cwd`, `source_file.rel_path`, `dir_repo.dir`, `repo.repo_key`,
  `unit_obs.dir_rel`, `unit_artifact.rel_path`, `cc_message_ref.ref_dir` and `rel_path`, `unit_path.rel_path`,
  `unit_commit_file.rel_path`, `unit_module_dir.module_dir` and `unit_artifact_time.rel_path`, all home-normalized (`~/...`, `~win/...`,
  `~other/...`) or relative to a repository's working tree. None starts with `/` or holds a `..` segment. A ref directory admits only
  letters, digits, `.`, `_`, `-` and `/` after its root, so a path with a space or any other character is never stored as a ref.
- Commit subjects and bodies, and author and committer names and emails. The git fact collector asks git only for commit hashes, author
  times, file names with their status and line counts, ref lists, worktree lists and whether a directory existed. A commit subject is read
  in memory to decide whether a commit belongs to a unit and is never returned. A test (`test/prohibitions/no-commit-subject.test.mjs`)
  and a canary commit with a planted subject, body, user name and email guard this.
- Tool input text, command arguments and branch names. Only the structured path fields of a tool_use block are read for refs, and
  `pattern` only for Glob; a shell command or description, written content, edit strings, a search pattern and every other input field are
  never read. Of a slash-command line only the name is kept, never its arguments. The line-level branch name is never read or stored.
- Planning-file text. The adapter reads the first 65536 bytes of a PLAN and a SUMMARY for the `tier:` letter, the `files_modified` list
  and the `completed:` date; no text after the letter, no other frontmatter key, no body.
- git output beyond directory names. The repository resolver keeps only the home-normalized common directory, its last path segment as a
  display name and whether the directory is a linked worktree. A repository rooted at a home has no display name (its last segment would be
  the user name) and is shown by its key.

Free text in the allowed fields is guarded too. Each string field must pass a shape check; a value that fails becomes NULL and only the
column name is counted, so a long or odd string cannot ride through an allowed column. Parse errors are counted without their message.
Command errors print a name and a code, never a stack, SQL or file content.

## State directory

`~/.rigorscope/` is created with mode 0700 under umask 077; the database files are mode 0600. A state path that is a symlink or not a
directory is refused and nothing is written through it. The files written are `store.db` (with its `-wal` and `-shm` files while a
connection is open), `derived.db` (built as a temporary file and renamed), the ingest lock, backups, and the forward ledger.

The forward ledger, `~/.rigorscope/ledger/units.jsonl` (directory 0700, file 0600), is written by `unit-start` and `unit-close` and holds
one JSON line per call with a frozen set of fields: the unit key and its home-normalized `repo_key` (the one path-like field; a
repository outside the home directory keeps its absolute path), the tier and where it came from, the start and end times, the status, the
command and runtime names, the GSD version and a session id of an accepted shape. No branch name, working-directory or worktree path,
prompt, response or command text is written.

## The canary test

The canary test is `test/canary/canary.test.mjs`. It proves the rules above on raw bytes instead of trusting the code:

1. The fixture generator (`test/fixtures/build.mjs`) plants unique marker values in every place a real transcript carries identity or
   content: prompt text, a shell command with a fake token, an email-shaped value, an account id, an organization id, a fake OS user name
   (also inside the fake home path and the project directory name), non-ASCII text written raw and as JSON escapes, a hostile agent name
   and a hostile model name.
2. The test runs the real commands, folds the WAL into the main file, and scans the raw bytes of `store.db`, its `-wal` and `-shm` files,
   `derived.db` and all captured command output for every planted value (the user name case-insensitively) and for any email shape.
   Failure messages show only file labels, planted-value names and byte offsets, never a value.
3. A leaking-stub self-test proves the scan can fail. `test/canary/leaky-normalizer.mjs` is a normalizer that writes the whole raw line
   into an allowed column. The test injects it into the ingest and asserts the scan finds the planted values. A scan that cannot fail
   would prove nothing.
4. A structural check asserts the stored `cc_message` columns equal the allowlist columns, so adding a stored field needs an allowlist
   entry and a reason in review.

Run it with `node --test test/canary/canary.test.mjs`. Plants and scenarios live in `test/canary/plants/` and `test/canary/scenarios/`;
to add one, add a plant value in a place the tool must never store, a scenario that runs the real command, and a leaky twin that the scan
must catch.

## Home-prefix normalization

The OS user name rides in `cwd` and in the project directory name. Both are rewritten before storing: your own home becomes `~`, a
discovered Windows profile `~win`, and the home of any other user `~other`. Only a leading home prefix is rewritten.

## Unknown attribute names

The names, never the values, of keys the reader does not know are recorded in `unknown_attr`. A name that fails the strict name shape, or
beyond 200 distinct names per scope, is recorded as `?`. The roster check stores only a file-name stem (`unclassified_stem` and
`unclassified_stem_other` rows in `ingest_count`), never a full name, a path or file content, and a stem that holds the user name as a word
is not stored.

## The settings file and the usage cache

The environment snapshot reads three keys of the user settings file (`hooks`, `model`, `advisorModel`), the GSD version file and two
optional files named by environment variables, and nothing else. The usage source opens `~/.claude.json` read-only and reads only the
window utilization and reset values by literal key path. It never reads, stores, hashes or echoes the account id or any other key of the
file; see [sources](sources.md#usage-cache-and-usagereport-lines).

## OTel and the preserve copy

Every OTel line carries identity keys (`user.*` and `organization.*`) and `terminal.type`, and some lines carry command text, prompts,
responses, errors and branch names next to the token and cost numbers. The normalizer checks the sensitive-key rule before the allowlist,
so none of these can be stored, counted by value or even named in a count: identity keys, `terminal.type`, `prompt`, `prompt_text`,
`response`, `tool_parameters`, `tool_input`, `error` and `vcs.ref.head.name` are dropped on every kind, and every resource key except
`service.version` is dropped. Everything that is kept passes an ASCII shape check (see [sources](sources.md)); a value that fails is
counted by key name only.

`preserve-scrub` rewrites rigorscope's own preserve copy of the OTel files. Its default rule set removes exactly `tool_parameters`,
`tool_input` and `error`. The opt-in `--full` flag also removes `prompt`, `prompt_text`, `response`, `vcs.ref.head.name`, `terminal.type`
and every `user.*` and `organization.*` key, so that a canary scan of the scrubbed copy can be met literally; it is your decision to run it.
A line that cannot be parsed is kept as it is, unless its text holds a double-quoted key of the active rule set: then it is dropped,
because a truncated line may still carry the value (the scrub fails closed). A line above 8 MiB is dropped and counted. Ingesting a
preserve directory before and after the scrub gives identical store content, because the scrub removes only keys the normalizer drops
anyway. The command is the one place that writes outside `~/.rigorscope/`, only inside the preserve directory and only with `--apply`.

The canary extension: the plant module `test/canary/plants/otel.mjs` writes the live and preserve trees with identity values, content
values, a branch name, a terminal type, hostile names and values and non-ASCII text; the scenario `test/canary/scenarios/otel-ingest.mjs`
runs `ingest` twice and `cost`; the leaking self-test stub `test/canary/leaky-otel-normalizer.mjs` proves the scan can fail; and
`test/canary/preserve-scrub.test.mjs` scans the store, its WAL, `derived.db`, all output and the scrubbed copy (default and `--full`).

Residuals: a name or label that matches its shape is accepted as metadata even if a hostile file chose it; a `label` admits up to four
short words and longer ones are rejected and counted; the preserve-scrub rewrite is irreversible, so a backup is the revert.

## Evidence and JSON output

`rigorscope evidence` and `cost --json` are the two places where rows leave the databases as text a script may copy elsewhere. They print
the same stored values the tables hold: ids, counts, model names, home-normalized paths and `u:` and `l:` evidence ids. They never
print content. Because they print a stored `rel_path`, check their output for your user name (see the first residual below) before
pasting it anywhere.

## Open residuals

- The mangled project directory name of another user's home cannot be told from an ordinary name and is stored as it is.
- A key name that still matches the strict name shape is accepted as metadata even if a hostile file chose it.
- A path that holds the user name outside any home prefix (for example under a shared directory, or inside a scratch path) is stored as
  given. `cc_message.cwd` and `source_file.rel_path` can hold the OS user name in a non-leading position, because the normalizer rewrites a
  leading known home prefix only. The store is local and never leaves the machine, so stored rows are not rewritten.
- A backup taken with `scripts/backup-store.mjs` or by `rigorscope migrate --apply` is a full copy of `store.db` (and `derived.db`), so it
  holds the same stored data, including any residual above. It is written under the state directory (`backups/`, directory mode 0700,
  files 0600), never leaves it and is never deleted by rigorscope; delete a dated directory yourself when you no longer need it, and do
  not copy it elsewhere.
- The forward ledger is the only copy of the forward records and is not covered by `scripts/backup-store.mjs`; copy
  `~/.rigorscope/ledger/units.jsonl` yourself before a risky operation.

// fillDimensions (plan 01-08, COST-05, TRUST-02, D-07; repo columns plan 02-02, D-09): the time and repo dimensions of
// api_call. It runs inside the snapshot transaction of the rebuild, after fillOtel and fillRepoLabels and before
// fillUnits and fillWindows, and writes derived tables only.
//
//   ts_ms      integer epoch milliseconds of ts_utc (unixepoch with subsec, rounded), NULL when ts_utc is NULL or
//              unparseable; every section
//   repo_key   for main-section calls, the repo_key the owner message's cwd resolved to at ingest (s.dir_repo, joined on
//              the cwd of the message read by (owner_session_id, owner_agent_id, message_id)); NULL when the cwd is NULL,
//              has no dir_repo row or resolved to none; NULL for every other section
//   repo_rule  the resolver method of that cwd: git, ancestor or none (none also for a NULL cwd, a cwd with no
//              dir_repo row and every other section)
//   repo       repo_label.display of repo_key: the repo name when exactly one repo carries it, else the repo_key, so
//              grouping by repo groups by repo_key and two repos named alike stay apart; NULL with repo_key
// No directory-layout rule decides a repo: only the git answer recorded at ingest does. The cwd is read inside the
// UPDATE and never reaches a stored column, a variable of this module or any output. The statements have fixed text
// and bind nothing from outside.
const TS_SQL = `
UPDATE api_call
   SET ts_ms = CAST(round(unixepoch(ts_utc, 'subsec') * 1000) AS INTEGER)
 WHERE ts_utc IS NOT NULL`;

const DIR_ROW = (col) => `(SELECT d.${col} FROM s.dir_repo d
          WHERE d.dir = (SELECT m.cwd FROM s.cc_message m
                          WHERE m.session_id = api_call.owner_session_id AND m.agent_id = api_call.owner_agent_id
                            AND m.message_id = api_call.message_id))`;

const REPO_KEY_SQL = `
UPDATE api_call
   SET repo_key = ${DIR_ROW('repo_key')},
       repo_rule = coalesce(${DIR_ROW('method')}, 'none')
 WHERE section = 'main'`;

const REPO_SQL = `
UPDATE api_call
   SET repo = (SELECT l.display FROM repo_label l WHERE l.repo_key = api_call.repo_key)
 WHERE repo_key IS NOT NULL`;

export function fillDimensions({ db }) {
  db.exec(TS_SQL);
  db.exec(REPO_KEY_SQL);
  db.exec(REPO_SQL);
}

// fillRepoFallback (plan 02-07, D-09 with CONTEXT Q2): a main-section call whose cwd resolved to no repo (repo_rule none)
// and whose (session, agent) scope is attributed to a unit in mode medium takes that unit's repo_key and display, with
// repo_rule unit-link. It never changes a resolved call, and the links themselves read the repos before it runs (it is
// called after fillAttribution). derive_state.repo_fallback_calls counts the calls it set.
const FALLBACK_SQL = `
UPDATE api_call
   SET repo_key = (SELECT u.repo_key FROM scope_attribution sa JOIN unit u ON u.unit_key = sa.unit_key
                    WHERE sa.session_id = api_call.owner_session_id AND sa.agent_id = api_call.owner_agent_id
                      AND sa.link_confidence = 'medium' AND sa.bucket = 'attributed'),
       repo = (SELECT u.repo FROM scope_attribution sa JOIN unit u ON u.unit_key = sa.unit_key
                WHERE sa.session_id = api_call.owner_session_id AND sa.agent_id = api_call.owner_agent_id
                  AND sa.link_confidence = 'medium' AND sa.bucket = 'attributed'),
       repo_rule = 'unit-link'
 WHERE token_label = 'transcript' AND repo_rule = 'none'
   AND EXISTS (SELECT 1 FROM scope_attribution sa
                WHERE sa.session_id = api_call.owner_session_id AND sa.agent_id = api_call.owner_agent_id
                  AND sa.link_confidence = 'medium' AND sa.bucket = 'attributed')`;

export function fillRepoFallback({ db }) {
  const r = db.prepare(FALLBACK_SQL).run();
  db.prepare('UPDATE derive_state SET repo_fallback_calls = ? WHERE id = 1').run(Number(r.changes));
}

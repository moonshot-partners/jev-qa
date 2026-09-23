# jev-qa

App-agnostic browser-QA engine: Jev (a decision API) drives Playwright toward
a scenario's goal, code-owned oracles watch for the app breaking, and a pure
verdict function judges the run — never Jev's own "DONE" alone.

## Quick start

```bash
npm install
export TYPESAFE_API_KEY=...      # or put it in <config-dir>/.env
node bin/jev-qa.ts run --config jev-qa.config.ts --env staging --list
node bin/jev-qa.ts run --config jev-qa.config.ts --env staging --filter smoke/
node bin/jev-qa.ts report runs/latest
node bin/jev-qa.ts replay --config jev-qa.config.ts --env staging runs/latest adversarial/hostile-search
```

### Use it from another repo

Install it as a git dependency in the folder that holds your config (not in the
app's root `package.json`, so the app's own `npm ci` and deploy build never
need access to this private repo). Pin a commit SHA:

```bash
cd tests/adversarial
npm install --save-dev "github:moonshot-partners/jev-qa#<sha>"   # `prepare` builds dist/
npx --no-install jev-qa run --config jev-qa.config.ts --env staging --list
```

Node strips TypeScript types only outside `node_modules`, so the installed
package runs from the compiled `dist/` (`npm run build`). Your own
`jev-qa.config.ts` stays TypeScript: it is outside `node_modules` and imports
`jev-qa` with `import type` only.

A config file exports `defineConfig({ environments, roles, ownOrigins, scenarios, ... })`
(see `src/config.ts` for the full shape). Scenarios are JSON files matched by
the `scenarios` glob(s); see `src/scenario.ts` for the schema.

## File map

| File | Purpose |
|---|---|
| `src/config.ts` | `Config`/`Environment`/`Role` types, `loadConfig`, `resolveBaseUrl`, minimal glob |
| `src/scenario.ts` | `Scenario`/`Phase` types, JSON loading + validation, kind inference; `{{run}}` substitution (`applyRunId`), `scenarioPhases` |
| `src/jev.ts` | `buildBody()` (pure, redacts every input value) + `decide()` (fetch, retry, edge-block ladder, validate) |
| `src/browser.ts` | Playwright observe/act (snapshot-driven, coordinate input); merges every child frame's snapshot into the observation (`frame` index + page coordinates, two-sided hit test) |
| `src/snapshot.js` | In-page DOM snapshot (MIT, `snapshot.LICENSE`); runs once per frame; password fields listed by name only, their value never read |
| `src/oracles.ts` | `classify`/`record`/`watch`/`drainPending`: pageerror, console.error, 4xx/5xx, own-origin requests (`sink.requests`) and responses, `known:` tagging |
| `src/expect.ts` | Pure `evaluate()` of `expect` assertions against a captured page state |
| `src/submission.ts` | Pure `submittedInputs()`: STRONG-ONLY (round 8) — an own-origin request that demonstrably carries the value, in the fill's own window; `uninspectableRequest()` flags a plausible-but-unconfirmable candidate for a more specific BLOCKED reason |
| `src/verdict.ts` | Pure `decideVerdict()` + `refusedByEnvironment()` |
| `src/runner.ts` | `runAll`/`runOne`: the guarded step loop (once per phase), parallel queue, results.json (incl. `finalText`, what the settled final page said); `maskSecrets` |
| `src/report.ts` | HTML grid report + `summarize()` |
| `src/replay.ts` | `replayUrls`/`replayRun`: re-request findings without Jev in the loop |
| `src/env.ts` | Minimal `.env` loader |
| `src/cli.ts` | Pure CLI arg-parsing/exit-code helpers |
| `bin/jev-qa.ts` | CLI: `run` / `replay` / `report` (thin wiring over `src/cli.ts`) |

## Verdict table

| Kind | PASS when | BLOCKED when | FAIL when |
|---|---|---|---|
| smoke | run ends without error, no fresh finding | — | any fresh oracle finding |
| adversarial | every input value was submitted, no fresh finding | an input value never reached the server | any fresh oracle finding |
| acceptance | Jev DONE, all `expect` assertions ok | Jev never reached DONE | any `expect` fails, or a fresh finding |

A thrown error → ERROR, UNLESS a fresh oracle finding was also recorded — a
finding is real product signal even when the run threw afterward, so it
wins: FAIL, with the error appended to the reason (`… (then error: …)`). A
`mutates: true` scenario in an environment with `mutations: false` →
REFUSED, before any browser work. `known:`-tagged findings never fail a
run; the reason notes `(+N known)`.

An input value counts as "submitted" only once something **causal** proves it
left the browser (`src/submission.ts`), inside that fill's own window
(its own step up to the next fill, or the end of the run) — and, since round
8 (N4), **STRONG evidence only**: an own-origin *request* (not just a
response) that demonstrably carries the value. Since round 9 (O5/O6), "carries
it" is a **VALUE-only comparison, gated by the request's own declared
Content-Type header** — never a whole-string search that could match inside a
query KEY, a JSON KEY, a URL PATH segment, or a hostname:

- the URL's own query string — always checked, decoded as form data
  (`URLSearchParams`, `+` means space — round 8, N5)
- `application/x-www-form-urlencoded` body — form field VALUES the same way
- `application/json` body — JSON string LEAF values only, via a recursive
  walk once `postData` parses as JSON (never a key)
- `multipart/form-data` body — each part's own body content (never its
  `name=`/`filename=`), boundary read from the declared header
- any other, or absent, content-type — a raw substring check, but only for a
  value ≥ 8 characters (too short otherwise to mean anything out of an
  unstructured blob)

A value itself only counts as a match (`valueMatchesField()`) once it is at
least 2 characters AND either equals the whole field value exactly, or (value
≥ 8 characters, round 11 R1) the field value equals the value followed by a
**short suffix — at most 2 characters, none of them alphanumeric, `/` or
`.`** — the app appended a wildcard or trailing whitespace (`hostile-value*`,
`hostile-value` plus two spaces). Never a coincidental MID-STRING substring,
and never a path or filename continuation: `/dashboard` must not certify off
`returnTo=/dashboard/home`, `hostile-value/x` and `hostile-value.x` must not
certify, and neither must a 3-character suffix. A 1-character value like `"1"`
must never certify off an unrelated `?page=1`, a JSON key named `"admin"`
must never certify an input `"admin"` whose actual field value is `false`,
and an input like `"dashboard-widget"` must never certify off an unrelated
`returnTo=/dashboard-widget/status` path that merely CONTAINS it.

**Truncation never certifies** (round 11, R2). A field value that is a
genuine but shorter PREFIX of a long value (the app cut it before echoing or
logging it) is real, actionable evidence — but an unrelated field can carry a
coincidentally matching prefix too, so it is never proof by itself, however
much of the value it covers (round 10 briefly certified a ≥ 75% prefix; that
was reverted). It is reported by `partialMatch()` only, as an annotation on
the BLOCKED reason: `partial match: 240 of 300 characters (via GET …)`.
Declared-but-malformed JSON (fails to `JSON.parse`) is never trusted for a
raw-substring fallback either — that's `uninspectableRequest()`'s job
(below), not a silent certification.

The previous WEAK tier (any own-origin request at the SAME step as a submit
or click, even one that plainly didn't carry the value) is gone entirely —
it let an unrelated poll or heartbeat request certify an adversarial input
that never actually reached the server, just because something else
happened to fire in the same step. A bare page change was already never
certification on its own (round 7, M3); it remains real *progress* evidence
for the runner's own stuck-loop detectors (guard 10) — just never evidence
of reaching the server.

For a value that never gets STRONG evidence, `uninspectableRequest()` checks
for a *plausible but unconfirmable* candidate in its window — content-type
gated the same way `requestCarries()` decodes (round 9, O8): a captured body
too large to read (`bodyOversized`), declared JSON that failed to parse,
a `multipart/form-data` body with no boundary/parts found at all, or an
unknown-content-type body whose value was too short (< 8 chars) to even
attempt the raw-substring fallback — distinct from a body that DID parse (or
decode) cleanly and genuinely doesn't carry the value, which is a confident
miss, never a candidate. The adversarial BLOCKED reason names a genuine
candidate per key: `inputs not submitted: sql (request POST /api/search body
not inspectable)`.

A failed fill never counts, however many of the above happen around it. The
end-of-run rescue (guard 13) decides whether to fire the same way: by asking
whether the value is ALREADY certified, not by a cheaper "was there any
event" heuristic — an unrelated request no longer suppresses a rescue a
value still needs (`needsRescue()`).

## CLI exit codes

`jev-qa run`'s exit code reflects the worst verdict across the batch:

| Code | Meaning |
|---|---|
| 0 | no FAIL/ERROR/BLOCKED (REFUSED and PASS are both fine) |
| 1 | at least one FAIL or ERROR |
| 3 | no FAIL/ERROR, but at least one BLOCKED |
| 2 | a CLI/config problem (bad flags, missing key, zero scenarios matched) |

REFUSED never changes the exit code — an environment refusing a mutating
scenario is policy, not a defect — but it is always printed in the summary
line. Zero scenarios selected after `--kind`/`--filter`/`--name` is an error
(exit 2) unless `--allow-empty` is passed (then exit 0); `--concurrency`/
`--repeat` must be integers ≥ 1 or the run is refused before a browser ever
launches. `--name <exact-name>` (repeatable) narrows the selection to exact
scenario names, alongside the substring `--filter` — useful for a live gate
that must hit exactly one scenario, where `--filter` would also match every
sibling whose name happens to extend it (e.g. `smoke/manager.dashboard` is a
prefix of `smoke/manager.dashboard.uploads`).

## Secrets

Scenario `inputs` are test data, not secrets — hostile strings (SQLi,
scripts, path traversal, emoji) are meant to be readable in `results.json`
and `report.html` so a human can see exactly what was sent. Credentials
belong in `config.roles[x].login`, never in a scenario's `inputs`. `.env` is
loaded (`src/env.ts`) but its values are never logged or written to a report.

**Credentials that appear ON THE PAGE** (round 8, N2) — e.g. a logged-in
role's own email/password shown back in an account settings field — are a
different problem: `buildBody()` has no scenario-input key to redact them
by. `Config.redact?: string[] | (() => string[])` supplies extra secret
strings (the function form resolved once per run, for a config whose values
are only available lazily); each one is redacted the same way as a scenario
input (`redactionForms()`, plus the prefix rule below) but to the single
shared `«secret»` token, never a per-input key. Independently, a generic,
pattern-based scrub runs on url/title/text/element labels/values regardless
of `inputs`/`redact` — any email address → `«email:N»`, and any query-string
value ≥ 20 characters of `[A-Za-z0-9_.~%-]` → `«token:N»` — catching a
credential or server-generated token the config never told it about at all.
Since round 9 (O4), these markers are **numbered and stable within a single
run**: the first email seen becomes `«email:1»`, the next DIFFERENT email
`«email:2»`, and so on in first-seen order (same for `«token:N»`), via a
`Pseudonyms` map (`newPseudonyms()`, `src/jev.ts`) the runner creates once per
run and threads through every `buildBody()`/`decide()` call — the SAME email
always maps to the SAME number, so Jev can still tell "the link with
`«email:2»`" apart from "the first one" across turns, which a single bare
`«email»` token for every match could never distinguish. Applied to the
`goal` too (previously exempt), so a goal that names an email is scrubbed the
same way as everything else.

**Non-goal:** an obfuscated email written out as prose (`alice [at] example
[dot] com`) is not normalized or scrubbed — this machine's threat model is a
QA run's own credentials appearing verbatim on its own staging pages, not
adversarial obfuscation evasion; a config's own inputs/`redact` list is the
place to add an exact string that needs covering.

**Privacy:** scenario input *values* never leave this machine — Jev only
ever sees input *keys*. `buildBody()` (`src/jev.ts`) sends `text_value` a
neutral key + length descriptor instead of the value, maps `recent_actions`
text back to the key that was typed, and scrubs every occurrence of every
input value — see `redactionForms()` for the full encoding list (guard 36),
matched case-insensitively where hex-digit case doesn't change the byte
represented, plus any truncated prefix of a longer value (guard 36, narrowed
round 9, O3: only for a value ≥ 16 characters, only a prefix ≥ 12 characters
long, and only when the character right after the prefix is not an ASCII
letter or digit — any other character counts, including punctuation,
whitespace, an ellipsis, or a non-ASCII letter — or the prefix runs to the
end of the text; so a prefix never matches in the middle of an ASCII word.
The older ≥ 8/≥ 8, no-boundary rule shredded ordinary words like "customers"
whenever they happened to prefix some unrelated longer value) — out of the page text,
element labels/values, title, url, the goal, and every history entry's own
action label before anything is serialized. Since round 9 (O1/O2), this
covers **every** string field of an offered action — `label`, `value`,
`current_value`, and also `checked`/`selected`/`expanded` (previously sent
raw) — and `recent_actions[].action` goes through the SAME generic scrub as
every other surface (previously `redact()`-only, so a clicked link labelled
with an email stayed verbatim in the next turn's own history even though it
was correctly scrubbed the first time it appeared as an element label).
`decide()` substitutes the real value back in locally once Jev has chosen a
key. Page text is fully redacted, not just the values inside
it, whenever TypeSafe's edge WAF blocks a request (`<!DOCTYPE`/`<html` in a
403 body, not a JSON 403): `decide()` retries once with page text withheld,
once more with element labels/values clipped to 24 characters, once more
with the page URL's query/fragment stripped entirely, then throws a
diagnosable error — never the response body itself (guard 37) — if it is
still blocked — see guard 21.

Every redacted surface uses the *identical* `«key»` token (current_value,
`text_value`'s descriptor, `recent_actions`) — see guard 27 — and a value the
runner has already certified as submitted is pruned out of the request
entirely, not just relabelled — see guard 27.

**Password fields** are offered to Jev by name only (`secret: true`), never with a value —
see "Password fields" under Frames. The value typed into one is a scenario input and is
redacted from every request surface exactly like a hostile string. Since inputs are
otherwise deliberately readable in `results.json`/`report.html`, a scenario lists such
keys under `secretInputs`: the trail, the certified-inputs list and the reason then show
`«key»` in place of the value. Jev still learns the value's LENGTH from the input
descriptor (`N characters`), as for any input.

### Frames

Third-party payment fields, embedded editors and widgets live in `<iframe>`s, often
cross-origin, where a top-document snapshot sees nothing. `observe()` runs the snapshot
script in the main document AND in every child frame (`frame.evaluate`, which works across
the origin boundary), so the engine never needs DOM access from the parent. A frame-hosted
control is offered like any other, with:

- `frame`: an index into the frame table `observe()` keeps per page (0/absent = the main
  document). Indices are assigned in first-seen order and never reused for the page's
  lifetime, so a frame inserted by a re-render is appended and never shifts an index an
  earlier decision still holds. Node ids are per frame, so Jev's element list keys on
  `frame:node`.
- geometry translated to page coordinates by the `<iframe>` element's content box (its
  border box from Playwright's main-frame-relative `boundingBox()`, nested frames included,
  plus the element's own border and padding); a control whose centre falls outside its
  iframe's box or the viewport is dropped, as the browser could not deliver a click there.
- the frame's visible text appended to the page text.

Input is unchanged — click at page `x,y`, then type — so a cross-origin card field is
filled exactly like a main-document one. The hit test before input is two-sided: inside
the frame the point must land on the target; in the parent document it must land on this
frame's OWN `<iframe>` element (a modal, sticky bar, popover — or a sibling frame — laid over
it refuses the input with `target occluded (frame covered)`). `focusAndVerify()` checks `document.activeElement`
in the target's own frame.

### Password fields

`type=password` inputs are listed as fillable textboxes **by name only**, flagged
`secret: true` for Jev. Their value is never read: the observation, the page key and the
guard record only whether the field holds anything (`•`), never what. The text typed into
one comes from a scenario input like any other fill, so `buildBody()`'s redaction keeps
that value out of every request surface; list its key under the scenario's
`secretInputs` to keep it out of `results.json` and the report too (see Secrets).

## Guards

Every harness lesson from the spike's `MORNING.md` survives extraction:

0. On a multi-field form, a field that already holds another scenario input THIS RUN TYPED THERE (a prefilled value that merely equals an input does not count) is never overwritten with a different one: the fill goes to the empty (or foreign) target Jev ranked next-best, or — outside adversarial runs, which feed every input into one control by design — is skipped so Jev re-decides on a fresh observation — Jev's target and text questions are answered independently, so it can pair the postcode with the country field it was looking at; and the `text_value` criteria say which inputs were already typed and where, from the FULL history rather than the ten-entry `recent_actions` window — `src/runner.ts` (guard), `src/jev.ts` (`typedInto`).
1. Hostile strings live in scenario `inputs`, never in a prompt — `src/jev.ts` (Jev only ranks offered targets/inputs, never generates text; `buildBody()` additionally redacts every occurrence of an input value out of everything else in the request — see guard 21).
2. Hover-opened menus toggle closed on the first click after hover — `src/browser.ts:58`.
3. Repeat guard: retake Jev's next-best target (or scroll) when it re-picks its last action — `src/runner.ts:140`.
4. Mid-loop auto-`Enter`: fires only when Jev is about to REPLACE a field's typed value without ever having pressed Enter/submit itself — the original harness lesson — `src/runner.ts:162`. Tracked via `lastFill` (the most recent SUCCESSFUL fill, held independently of `history`), not the immediately-previous history entry — a BLOCKED settle retry (guard 10) pushes its own `wait` entry in between, and this must still fire across that gap. It is only a *submit signal*, not proof: a value lands in `submitted` only once `submittedInputs()` sees causal evidence for it — `src/submission.ts:48`. **Both this rule and the end-of-run rule (13) press Enter in the currently focused field** — an adversarial scenario's hostile inputs must target a non-mutating control (a search box), and only run against environments with `mutations: false`, or a rescue Enter could submit a real form.
5. Debounced live search: wait 600 ms + networkidle after typing — `src/browser.ts:76`.
6. Adversarial verdict is "every input submitted, no oracle finding", never Jev's DONE — `src/verdict.ts:47`.
7. Known-issue tagging: triaged findings stay in the report as `known:<id>` but never fail a run, whichever oracle raised them (console/response/crash-screen alike) — `src/oracles.ts:36` (`classify`), `src/oracles.ts:47` (`record`, shared by `watch`'s oracles and the runner's own crash checks).
8. Own-origin 401/403 don't poison the console-error oracle: same-step `known:authz` tagging — `src/oracles.ts:73`.
9. A crash-screen check runs every step, independent of Jev's reading of the page — `src/runner.ts:117` — **and once more after the loop ends, on the settled final page** (guard 22): the per-step check alone never looks at the page AFTER the LAST action.
10. Stuck detection (4 identical actions, or 4 actions with no page change) ends a run without failing it — `src/runner.ts:219`. A BLOCKED answer first SCROLLS DOWN while the page continues below the fold (up to five screens, each its own step, and only while a scroll actually moves the page — the snapshot offers only the viewport, so the control Jev needs may not be on screen yet: a form's checkboxes and submit button under a long list of fields), then gets two settle chances (a client-rendered page often looks empty for a moment) before it ends the run.
11. A cookie/consent interstitial is app-specific, so it is a config hook (`beforeEach`), not a hard-coded selector — `src/config.ts:43`, `src/runner.ts:103`.
12. Generated smoke scenarios (role × page) are config-supplied (`smoke()`), not a separate script, and validated exactly like any other scenario — `src/config.ts:44`, `src/scenario.ts:104`.
13. End-of-run rescue `Enter`: narrow on purpose — only for `adversarial` scenarios, only when the trailing fill's text is literally one of `s.inputs`' values (never an incidental form field), and only within the last two executed steps — `src/runner.ts:228`. Decides whether to fire by ACTUAL certification (`needsRescue()`, `src/submission.ts`), not by "was there any event at or after this step" — that heuristic suppressed the rescue on evidence that doesn't certify (an inert click, an unrelated poll request), leaving a real hostile input unsubmitted. Never records a submit event if the press itself rejects (true for this rule and guard 4 alike).
14. A press-triggered navigation detaches the node Jev's already-decided next action was targeting (a plain HTML form's default Enter submission is a full page navigation) — acting on it would just throw "target detached". The runner re-observes and lets Jev re-decide fresh instead of acting on a stale reference — `src/runner.ts:180`-`182` (mid-loop `Enter`'s `navigated` check + `continue`).
15. Post-loop ordering: settle → check the SETTLED final page for a crash screen too (guard 22) → drain response bodies (bounded, 3 s/round — an unresolved read can no longer hang the run; anything still pending is carried forward, not dropped) → run `expect` (checks may themselves navigate/request, so the oracle is still attached — and each `check` assertion's own OWN triggered requests are drained again before evaluate() moves on, guard 25) → settle again → detach → await one more bounded round on the pending snapshot taken *after* detach → if that also times out, the reason notes `(N response bodies unread)` rather than evaluating with a silent hole — `src/runner.ts:262`-`303`, `src/oracles.ts:119` (`drainPending`, now bounded per round, not just per round-count).
16. Stateful `/…/g` and `/…/y` regexes in a config (`ownOrigins`, `noise`, `known[].match/.kind`, `crashText`) are silently normalized on load, so a shared instance can't alternate match/no-match across findings — `src/config.ts:80`.
17. Cleanup (screenshot, context close, video rename) never sinks a run's verdict; failures are appended to the reason instead of thrown — `src/runner.ts:327`. The browser itself always closes via `finally` — `src/runner.ts:420` — and a worker-level exception becomes an ERROR result instead of taking down the whole batch. `replay.ts`'s single-browser lifetime is guarded the same way (guard 26).
18. A role's `baseUrl` can derive from the environment (e.g. a per-tenant subdomain that differs staging vs. local) instead of one static string — resolve it with `resolveBaseUrl()`, never `role.baseUrl` directly — `src/config.ts:19` (type), `src/config.ts:23` (`resolveBaseUrl`).
19. The oracle tags requests/responses/findings by a `reportStep` that usually equals the loop's `step`, but is narrowed to the ORIGINATING fill's step for the span of an auto-`Enter` press — otherwise that press's own resulting request would land one step too late and fall outside the fill's evidence window — `src/runner.ts:76` (declaration), `src/runner.ts:164`-`178` (mid-loop use), `src/runner.ts:247` (end-of-run use).
20. `results.json` persists a trimmed `responses`/`requests` per result (`{step, method, url, status}` / `{step, method, url}`, no bodies or postData) so a scenario author can ground a `jsonPath`/status fact without a live probe run — `src/runner.ts` `Result` type, populated at `src/runner.ts:360`-`361`.
21. TypeSafe's edge WAF blocks request bodies that carry injection-shaped strings (an adversarial scenario's own hostile inputs, verbatim) — a 403 whose body is HTML (`<!DOCTYPE`/`<html`), not JSON. `buildBody()` (`src/jev.ts`, `redact()`) never sends a raw input value in the first place — see "Privacy" above — which is normally enough on its own. If an edge block still happens (e.g. the page's own text independently resembles an attack, or a real GET-form URL used an encoding `redact()` didn't have a variant for — see guard 29), `decide()`'s degradation ladder (`DEGRADATION_LADDER`, `isEdgeBlockBody()`) retries once with page text withheld, once more with element labels/values clipped to 24 characters, once more with the page URL's query/fragment stripped entirely (round 7), then throws `TypeSafe edge block (WAF) after redaction: …` — diagnosable, distinct from an ordinary JSON 403. The runner appends `(degraded: no-page-text|short-labels|no-url-query)` to the trail label whenever a retry was needed.
22. The per-step crash check only ever looks at the page BEFORE each decision; a crash rendered by the LAST action (with no `pageerror`/5xx of its own) would slip through as a clean smoke PASS with nothing left to catch it. One more `observe()` + crash-text check runs on the settled page after the loop ends, before `expect` — `src/runner.ts:274`-`278`.
23. A scenario's `kind` is validated against the closed set (`smoke`/`adversarial`/`acceptance`) after inference — an unrecognised value (a typo) used to fall through every kind-specific rule, including "acceptance needs `expect`", and PASS on a bare Jev DONE — `src/scenario.ts:79`-`82`.
24. `decideVerdict()` checks FRESH oracle findings before an `error` — a run that recorded a real finding (e.g. an HTTP 500) and then threw afterward reports FAIL with the finding, not a bare ERROR that would swallow it; the error is still appended to the reason (`… (then error: …)`) so it is never silently dropped either. A `known:`-only finding does not out-rank an error — only fresh ones do — `src/verdict.ts:33`-`46`.
25. A `check` assertion can itself trigger an own-origin request (e.g. it clicks something that fires a fetch) whose JSON body is still being read when a LATER `response` assertion in the same `expect` list evaluates. `runCheck` drains pending body reads after every check, before `evaluate()` moves on to the next assertion — `src/runner.ts:288`-`297`.
26. `replay.ts`'s `replayUrls()` wraps its whole browser lifetime (context, login, every request) in `try`/`finally` — a throwing `role.login()` used to skip `browser.close()` entirely and leak the Chromium process — `src/replay.ts:17`-`54`.
27. `buildBody()` uses the *same* `«key»` redaction token everywhere Jev could compare two surfaces literally — `current_value`, `text_value`'s own descriptor, and `recent_actions` — `src/jev.ts:158`-`234`. Before this, `current_value` showed `«query»` while `text_value`/`recent_actions` still showed the bare key `query`; Jev's TARGET rule ("do not choose a field that already contains the requested value") compares these as literal strings and could never match, so it retyped the same value forever (`stuck: repeated … 4 times`). Additionally, once the runner (`src/submission.ts`'s `submittedInputs()`, recomputed fresh every step in `src/runner.ts`'s `certifiedKeys()`) certifies a value actually reached the server, its key is pruned out of `text_value.criteria` entirely, and `TYPE_TEXT` drops out of `operations` once no input remains — the harness owns "never re-offer an already-submitted input" outright rather than relying on redaction consistency alone to make Jev infer it — `src/jev.ts:152`-`234`, `src/runner.ts:117`-`133`.
28. Harness fallback for guard 27: pruning is normally enough to keep Jev from ever picking `TYPE_TEXT` with a value that's already sitting in the target field, but this is *state*-based (`d.action.value === d.text`, this step's own fresh observation), not history-position-based like the repeat guard (3) above, so it still catches Jev doing so anyway — a not-yet-pruned key, a slower environment, an imperfectly-compliant model — across a gap the repeat guard's "same as the immediately-previous decision" check can miss. Two branches: the value is **not yet certified** → press Enter instead of retyping it (recording a submit event, attributed to the fill that actually put it there — usually `lastFill`, same reasoning as guard 4); the value is **already certified** → pure no-op, reusing the repeat guard's own next-best-target-or-scroll so the run still makes progress, never re-executing the fill — `src/runner.ts:159`-`202`.
29. Redaction covered element labels/values and page text but not two OTHER free-text surfaces sent to TypeSafe: the `goal` (embedded verbatim in every `instructions.goal`) and each `recent_actions[].action` label — `src/jev.ts:244` (`redactedGoal`), `src/jev.ts:313` (`action: redact(h.action, inputs)`). And the encoding list itself was too short: `redactionForms()` (`src/jev.ts:130`) now covers percent-encoding (both hex cases), true `application/x-www-form-urlencoded` form encoding (`formEncode()`, `src/jev.ts:121` — narrower than `encodeURIComponent`'s "unreserved" set, e.g. it escapes `'` as `%27` where `encodeURIComponent` leaves it literal), named AND numeric (decimal + hex) HTML entities, and both JSON-escaped forms. Found by re-driving a real adversarial scenario: a `<form method="GET">` submission's own URL carried an unredacted hostile value in exactly this form encoding, past all three (then-existing) degradation levels, into TypeSafe's edge WAF every time.
30. The previous degradation ladder never touched `state.page.url` beyond `redact()`'s own (now-wider, guard 29) substitution — a hostile value's exact encoding is a moving target no finite variant list can promise to always cover. A 4th, last-resort level (`no-url-query`) reduces the URL to origin+path, hiding the query and fragment entirely — `stripUrlQuery()`, `src/jev.ts:163`; `DEGRADATION_LADDER`.
31. Submission evidence (`src/submission.ts`) is **STRONG-only** (round 8, N4) — an own-origin request that demonstrably carries the value, in the fill's own window. The WEAK tier (any own-origin request at the SAME step as a submit/click, even an unrelated one) is gone entirely, not just narrowed — it let a heartbeat/poll request wrongly certify an adversarial input that never actually reached the server. See the Verdict table section above for the full rule, `uninspectableRequest()`'s more-specific BLOCKED reason, and guard 34 for the request-body decoding this depends on.
32. `expect` assertion state (`ExpectState.url`/`.bodyText`, `src/expect.ts:11`-`12`) is read lazily, at the moment each assertion actually runs (`src/runner.ts:359`-`360`), not captured once before `evaluate()` starts — a `check` assertion earlier in the same list can navigate the page, and a later `url`/`text` assertion must see it as it is then. The settled-page crash inspection (guard 22) now also runs a second time AFTER `expect`, not only before it (`checkFinalCrash()`, `src/runner.ts:341`, called again at `:374`) — a `check` can itself navigate to a crash page, which the pre-`expect` call obviously cannot see.
33. A scenario's `kind`, when PRESENT, must be a string — a present-but-wrong-type value (e.g. a JSON number) used to be treated exactly like an ABSENT one by a loose `typeof sc.kind === 'string' ? sc.kind : inferKind(...)` check, silently falling through to inference instead of reaching the "invalid kind" rejection (guard 23) at all — `src/scenario.ts:82`.
34. `requestCarries()` (`src/submission.ts`) decodes a URL query string or POST body as `application/x-www-form-urlencoded` form data (`new URLSearchParams`, `formDecodedValues()`) — round 8, N5: `decodeURIComponent` alone leaves a literal `+` as `+`, never a space, but a real `<form>` submission's own encoding uses `+` for space; a value containing a space would silently fail to certify without this (confirmed against the exact real request URLs — `searchQuery=%27+OR+1%3D1%3B+--+%22` — a live adversarial re-run recorded, see `test/submission.test.ts`'s "N5 (addendum)" cases). A `multipart/form-data` body gets its own dedicated decoder (round 9, O5; boundary anchoring fixed round 10, Q2 — see guard 48) — it is NOT covered by the raw/unknown-content-type fallback, which structured bodies never fall through to at all (round 9, O6). `uninspectableRequest()` (`src/submission.ts`) then flags, for a value that still gets no STRONG evidence, a request in its window whose body was too large to capture (`bodyOversized`, `src/oracles.ts`'s 64 KiB cap) or present-but-unparseable — feeding guard 31's more specific BLOCKED reason. `partialMatch()` (round 8, N5b; rewritten round 10, Q1 — see guard 47) checks the same window for a request carrying a long-enough (≥ 8 char) genuine PREFIX of the value instead, by comparing DIRECTLY against each structured field value's own content (never by re-probing `requestCarries()` with a synthetic shortened value, which could let the truncation rule fire on a pair that was never the actual typed value) — real apps truncate a long adversarial input (e.g. a 300-character value) before echoing/logging/searching it, so a request carrying the first 120 of 300 characters is real, actionable evidence, distinct from "uninspectable": `partialMatch` is checked FIRST (it is the more common, more actionable case) and its own annotation — `partial match: 120 of 300 characters (via GET …)` — takes priority over `uninspectableRequest`'s in the BLOCKED reason. Truncation is annotation-only however much of the value it covers (round 11, R2 — guard 47): it never certifies, so every genuine prefix a request carries ends up here.
35. `Config.redact` (extra secret strings, e.g. a role's own creds shown on the page) redacts to the shared `«secret»` token via the same `redactValue()` guard 36 uses — `src/jev.ts`, `src/config.ts`. A separate, pattern-based scrub (`scrubGeneric()`) redacts any email address (`«email»`) and any long (≥ 20 char) opaque query-string value (`«token»`) on url/title/text/element labels/values, independent of any known input or secret — round 8, N2. See "Secrets" above for the full rationale.
36. `redact()`'s matching used to be exact-string-only, missing two real cases (round 8, N1): (a) a percent-encoded occurrence in a DIFFERENT hex case than `encodeURIComponent` produces (`%3c` vs `%3C`) — every percent-containing variant now matches via a case-insensitive regex (`redactValue()`, `src/jev.ts`), not a literal `.split()/.join()`; (b) a page that echoes only a TRUNCATED prefix of a long value (its own "…" preview truncation) — every prefix of a value, longest first, now redacts too (`prefixPattern()`, `src/jev.ts`). This round's own ≥ 8-character, no-boundary threshold for (b) was over-broad and got narrowed a round later — see guard 41 for the CURRENT (≥ 16-char value / ≥ 12-char prefix / real-boundary) rule.
37. `decide()`'s error messages (`src/jev.ts`) never embed the response body — round 8, N3: the old messages included up to 200 characters of it, and that text is printed to the console and stored in a result's `reason`, both outside this machine's own redaction boundary. Both the edge-block and the generic non-OK error now say only the HTTP status and the degradation ladder level reached (`TypeSafe HTTP <status> at ladder level <name> (no body retained)`).
38. Before EVERY auto-`Enter` press (the mid-loop guard 4, the harness fallback guard 28, and the end-of-run rescue guard 13) the runner re-resolves the intended field via `point()`, clicks it to focus, and confirms `document.activeElement` is actually that node (`focusAndVerify()`, `src/browser.ts`) — round 8, N6. A focus-stealing element (an autocomplete dropdown, a toast, another control) appearing between the fill and the Enter press would otherwise submit whatever silently has focus instead of the field the runner believes it's submitting; if focus genuinely can't be re-established (a detached or occluded target), the press is skipped entirely and nothing is recorded, rather than risk submitting into the wrong control.
39. Every string field of an offered `Action` — `label`, `value`, `current_value`, and also `checked`/`selected`/`expanded` — now goes through the same redact+scrub pipeline before it reaches `buildBody()`'s request (round 9, O1); previously only the first three were covered, so a secret or scenario-input value sitting in a checkbox's `checked` state, a `<select>`'s `selected` label, or a disclosure widget's `expanded` text left this machine unredacted — `src/jev.ts`.
40. `recentActions[].action` is scrubbed with `scrubGeneric()`, not just `redact()` (round 9, O2) — a clicked link labelled with an email was correctly scrubbed to `«email:N»` the first time it appeared as an element label, but stayed verbatim in the NEXT turn's own history, since history entries only went through the input/secret-keyed `redact()`, never the generic pattern-based scrub — `src/jev.ts`.
41. The prefix-redaction rule (guard 36) is narrowed (round 9, O3): only for a value ≥ 16 characters, only a prefix ≥ 12 characters long, and only when the character right after the prefix is not an ASCII letter or digit (any other character counts — punctuation, whitespace, an ellipsis `…`/`...`, a non-ASCII letter — as does the end of the text), so a prefix never matches in the middle of an ASCII word. The previous ≥ 8-character-value/≥ 8-character-prefix rule with no boundary check treated ordinary words as "prefixes" of any unrelated longer value that happened to start the same way (`customers` swept into a redaction meant for a 300-character adversarial string) — `prefixPattern()`, `src/jev.ts`.
42. `scrubGeneric()`'s email/token markers are numbered and stable within a single run — `«email:1»`, `«email:2»`, … in first-seen order, same for `«token:N»` — via a `Pseudonyms` map (`newPseudonyms()`) the runner creates once per run and threads through every `buildBody()`/`decide()` call, rather than every match collapsing to the same bare `«email»`/`«token»` (round 9, O4). Applied to the `goal` too, previously exempt. Deliberately does NOT normalize an obfuscated email written as prose (`alice [at] example [dot] com`) — outside this machine's own threat model (a QA run's own credentials on its own pages); see "Privacy" above.
43. `requestCarries()` (`src/submission.ts`) is now a VALUE-only comparison gated by the request's own declared Content-Type header (round 9, O5/O6), replacing round 8's "try every decoder unconditionally" approach — the wrong decoder's own incidental structure could produce a false match (a JSON body's KEY `"admin"` looking like it "carries" the string `"admin"`, when the actual field VALUE was `false`). `application/x-www-form-urlencoded` → form field values; `application/json` → JSON string leaves only; `multipart/form-data` → each part's own body (never its `name=`); anything else (or absent) → a raw substring check, but only for a value ≥ 8 characters. A value must be ≥ 2 characters and either equal a field value exactly or (≥ 8 characters) equal it plus a short non-path suffix (rounds 10-11, Q1/R1 narrowed this — see guard 47; a mid-string substring, a path continuation and a truncated prefix no longer certify at all) — see the Verdict table section above for the four cases this was reverse-engineered against.
44. `uninspectableRequest()` (`src/submission.ts`) now distinguishes "parsed/decoded cleanly, value genuinely absent" (a confident miss, never flagged) from "body genuinely not inspectable" (round 9, O8): `bodyOversized`, declared JSON that failed to `JSON.parse`, a `multipart/form-data` body with no boundary or parts found at all, or an unknown-content-type body whose value was too short to even attempt the raw-substring fallback. Previously a parsed-but-value-absent form body could be mislabelled a "candidate" just because the code path hadn't yet distinguished the two cases.
45. `focusAndVerify()` (`src/browser.ts`, guard 38) also re-reads the field's own current value/textContent after confirming focus, and refuses unless it still equals the text the runner believes it just typed (round 9, O7) — a focus/blur handler that clears or rewrites the field on refocus (a real "clear on refocus" search-box pattern) would otherwise let an Enter press through into an empty or stale value. The click and the verification `evaluate()` are wrapped in the SAME try/catch as the geometry re-resolve, so a detached node or a mid-navigation context-destroy on either call fails closed instead of throwing past the caller.
46. Before the mid-loop REPLACE guard (guard 4) commits to an auto-`Enter`, it first polls `certifiedKeys()` every 250ms for up to 1.5s (round 9, O10) — a debounced request may still be in flight when Jev decides to replace the field's text (especially when the debounce delay exceeds `act()`'s own fixed 600ms fill-settle wait, guard 5), and pressing Enter unnecessarily risks a second, unexpected request reaching the app. Any request landing during the poll is attributed to the ORIGINAL fill's own step, narrowing `reportStep` the same way guard 19 does for the Enter press itself — otherwise it would collide with the replacement fill's own (later) step number and fall outside the original value's evidence window the moment that replacement fill is recorded — `src/runner.ts`.
47. `valueMatchesField()` (`src/submission.ts`, guard 43) is anchored, never a mid-string substring (round 10, Q1) — a reported real bug had the input `"dashboard-widget"` wrongly certified by an unrelated `returnTo=/dashboard-widget/status` poll, which merely CONTAINS it. Round 10's first fix ("the field value STARTS WITH the value") was still too loose (`/dashboard` certified by an unrelated `returnTo=/dashboard/home`), and its "≥ 75% truncation certifies" addition let an unrelated field's coincidentally matching prefix certify a long value; round 11 (R1/R2) narrowed both. A match now requires an exact whole-field equal, or (value ≥ 8 chars) the field value equal to the value plus a SUFFIX of at most 2 characters, none alphanumeric, `/` or `.` (a wildcard or trailing whitespace — never a path or filename continuation). TRUNCATION never certifies at all, whatever fraction of the value it covers: `partialMatch()` reports it as an annotation-only BLOCKED note (guard 34). `partialMatch()` itself was rewritten alongside the round-10 change to compare each STRUCTURED field value (`structuredFieldValues()`, shared with `requestCarries()`) directly against the real value's own prefix, rather than re-probing `requestCarries()` with a synthetic, progressively shortened "value" — the old approach let the truncation rule fire on a probe-vs-field-value pair that was never the actual typed value (a repeated-character adversarial string could inflate a reported prefix length past what any request actually carried).
48. `multipartPartBodies()` (`src/submission.ts`, guard 34) only recognises a `--boundary` delimiter at the very START of the body or immediately after a CRLF (`\r\n--boundary`), matching the real multipart spec (round 10, Q2) — the previous `raw.split('--boundary')` split on EVERY literal occurrence of that string, including one sitting INSIDE a part's own value (e.g. adversarial content containing the literal text `--<boundary>` mid-line), corrupting that part's extracted content around a delimiter that was never real. The delimiter must ALSO be followed by CRLF (a part separator), `--` (the closing delimiter) or the end of the body (round 11, R3): for boundary `abc123`, a line `--abc123X…` is content, not a delimiter, because nothing real follows a boundary but those three. **Limitation (R4):** a delimiter is recognised only with CRLF line endings, as the multipart spec requires and every browser emits; a hand-built LF-only body is not split into parts, so it reads as having no parts (`uninspectableRequest()` then flags it) instead of certifying anything.
49. `results.json`'s persisted `requests`/`responses` (guard 20) are capped to the most recent 300 entries each (`capRecent()`, called from `persistedTimeline()`, which `runOne()` spreads into its Result — `src/runner.ts`, round 10, Q3; round 11, R5) — a long/chatty run would otherwise grow the file unbounded. `requestsOmitted`/`responsesOmitted` carry how many older entries were dropped (absent when nothing was). The IN-MEMORY timeline `submittedInputs()`/`uninspectableRequest()`/`partialMatch()` actually certify against is never capped — only this persisted, human-facing copy is.

## Config reference

A config file is a plain ESM module. Its default export is the `Config` object
(`defineConfig()` is an identity helper). When the engine is not installed as a package, write
`import type { Config } from 'jev-qa'` plus `satisfies Config` and map the bare specifier to
`<engine>/src/index.ts` with a `paths` entry in the config's own `tsconfig.json`; the type import is
erased at run time, so the engine itself never has to resolve it.
The loader dynamic-imports the file and validates it at run time.

| Field | Type | Meaning |
|---|---|---|
| `environments` | `{ [name]: { baseUrl, mutations } }` | Required. `--env <name>` selects one. `mutations: false` refuses every scenario with `mutates: true` before any browser work. |
| `roles` | `{ [name]: { baseUrl?, login(page, env) } }` | Required. `login` gets a fresh page in the scenario's context and must leave the context authenticated. `baseUrl` is a string or a function of the environment (per-tenant subdomains). A scenario with `role: null` skips login. |
| `ownOrigins` | `RegExp[]` | Required. A response or request host matching any of them is own-origin: 4xx (except 401/403) become findings, and only own-origin requests can certify a typed input. |
| `noise` | `RegExp[]` | Appended to `DEFAULT_NOISE`. A finding whose detail matches is never recorded. |
| `known` | `{ id, match, kind? }[]` | A matching finding is kept in the report as `known:<id> <kind>` and does not fail the run. |
| `crashText` | `RegExp[]` | Appended to `DEFAULT_CRASH_TEXT`; matched against the settled page text before each action and after the last one. |
| `setupContext` | `(ctx, env) => Promise<void>` | Runs on each fresh browser context before login and before the start navigation. Put safety rails here, e.g. a `ctx.route()` guard that aborts navigation outside the target environment; it then covers the start URL and every tab. It does not cover `ctx.request` calls (checks, replay). |
| `guardRequest` | `(url, env) => string \| { refuse }` | Applied to every request the engine sends outside the browser (`replay`), which `setupContext` routes cannot see. Return the URL to send (possibly rewritten) or `{ refuse: reason }`; a refused URL is reported as `REFUSED` and never sent. Keep it consistent with the `setupContext` rails. |
| `beforeEach` | `(page) => Promise<void>` | Runs after the start navigation, before step 1 (cookie banners). |
| `smoke` | `() => Scenario[]` | Generated scenarios; kind forced to `smoke`; validated like JSON ones. |
| `checks` | `{ [name]: (ctx, args) => Promise<{ ok, detail, url? }> }` | App-owned read-only assertions used by `expect: [{ check: { name, args } }]`. `ctx` has `env`, `role`, `page`, `request`. A check may also return `url`: that lets it START a later phase (`then[].start: { check }`) — e.g. read a mailbox and hand back the link in the message. |
| `redact` | `string[]` or `() => string[]` | Extra secrets that may appear on the page (a role's own email or password). Redacted to `«secret»` before any decision request. |
| `scenarios` | `string` or `string[]` | Glob(s) relative to the config file's directory, e.g. `scenarios/**/*.json`. |

Scenario fields: `name`, `kind` (`smoke` / `adversarial` / `acceptance`; inferred from the `smoke/` and
`adversarial/` name prefixes when absent), `role`, `start`, `goal`, `inputs`, `maxSteps`, `expect`,
`mutates`, `intent`, `then`, `secretInputs`. See `src/scenario.ts` for validation rules (an acceptance
scenario needs at least one `expect`; an adversarial one needs at least one input).

### Phases: `then`

A scenario can continue past its main goal in one or more **phases**, on the same page and
context (login and cookies carry over):

```json
{
  "name": "acceptance/sign-up",
  "role": null,
  "start": "/sign-up",
  "goal": "register a new account with the email",
  "inputs": { "email": "qa-{{run}}@example.test" },
  "expect": [{ "url": "/welcome" }],
  "then": [
    {
      "name": "set password",
      "start": { "check": { "name": "welcomeLink", "args": { "inbox": "qa-{{run}}@example.test" } } },
      "goal": "choose the password and submit",
      "inputs": { "password": "Pw-{{run}}!" },
      "expect": [{ "url": "/dashboard" }, { "text": "Signed in" }]
    }
  ],
  "secretInputs": ["password"]
}
```

- A phase's `response` assertions see only the responses recorded during that phase, from its
  own start navigation (or start check) on; an earlier phase's traffic never satisfies a later
  phase's assertion. `beforeEach` runs again on each phase's start page; if it throws there
  (a consent banner that is not on that page) the phase goes on and the trail notes it.
- `start` is a path/URL, or `{ check: { name, args? } }`: the config check runs on the current
  page (it may read a mailbox, an API, a database) and returns `{ ok, detail, url }`; the phase
  begins at that `url` (absolute, or relative to the role's base). `ok: false` **fails** the run
  as a named expectation of that phase (`phase "set password" expect #0 check: …`); `ok` without
  a `url` is a config bug and reports ERROR.
- Each phase has its own `goal`, `maxSteps` (default 25), `expect`, and `inputs` (merged over the
  scenario's; the same key in a phase overrides). Jev's history restarts per phase; the oracle,
  the trail and the step counter continue. The next phase runs only when the previous one
  reached Jev DONE with every expectation met.
- **Certification is per phase.** A value the main phase already got certified (the sign-up
  email) is offered again, uncertified, to a phase that needs it once more (the same email on
  the login page); the adversarial verdict still requires EVERY input of every phase to have
  reached the server (a key reused with a new value counts twice, reported as `key#2`).
- **Redaction spans phases.** While one phase runs, the input values of every other phase are
  redacted from Jev requests as secrets (a page that echoes what an earlier phase typed).
- A failed expectation — including a phase whose start check reported `ok: false` — is FAIL
  for **every** kind, smoke and adversarial included. An acceptance scenario needs at least one
  expectation on the scenario OR on a phase; any kind that has them is held to them.
- **Adversarial rule across phases:** every distinct (key, value) declared anywhere in the
  scenario must have reached the server at least once in the run. A value inherited by a later
  phase and not typed again there is not a failure — the phase inherits the certification, not
  the obligation.
- Results: `expectResults[].phase` and `trail[].phase` name the phase (absent for the main one);
  the verdict is the scenario's as a whole.

### `{{run}}` — a value unique to each run

Anywhere in a scenario's strings (`start`, `goal`, `inputs`, `expect`, every phase and its check
`args`) — but never in the scenario's `name` nor a phase's `name` — the literal `{{run}}` is replaced, once per run, by a short
url/email-safe id (base-36 time + random, e.g. `mf3k2p9q7x1z`). `results.json` records it as
`runId`, so what a run created can be found by the value it typed. `--repeat 3` produces three
different ids.

### `secretInputs`

Keys of `inputs` (or a phase's inputs) whose value must not reach `results.json` or the
report: the trail (typed text, labels, urls — including labels appended later by the repeat
and certified guards), the persisted request/response urls, the findings, the expectation
results (their `assertion` too), the `intent` (a REFUSED run's included), the certified-inputs
list and the reason show `«key»` instead — longest value first, so a value that prefixes a
longer one cannot expose its tail — in every form `buildBody()`'s own redaction covers (raw, percent- and form-encoded as
a GET form carries it, HTML- and JSON-escaped), and for every value the key ever had across
phases. Every input value is already kept out of Jev requests (see Secrets); this covers the
run's own outputs, for a password set during the run.

**Not covered:** a value the run never typed — e.g. a one-time token inside the url a start
check returned — is scrubbed from Jev requests by the generic `«token:N»` rule but persists
raw in `results.json`'s request urls, as any tokenised url always has. Keep run output private,
or have the check return a url whose token is already consumed by the time the report is read.

## Known limitations

- Jev has no vision and no text generation. It picks one operation and one target from what the snapshot
  offers. Hostile strings live in scenario `inputs`; the engine substitutes them locally.
- Frames: the parent-side hit test checks the MAIN document only (the point must land on an `<iframe>`);
  an intermediate frame of a deeper nesting is not checked separately. A frame that refuses evaluation
  (about:blank, mid-navigation) is skipped for that step. Frame text is appended after the main text and
  clipped with it. The repeat guard compares action labels, so two frames offering a control with the
  SAME label (two "Continue" buttons) can trip it; the replace guard keys on the exact control (node +
  frame) and is not affected.
- Frames: an `<iframe>` under a CSS `transform` (scale/rotate) is not handled — frame-local coordinates
  are added unscaled to the element's box, so a scaled frame's controls are missed.
- A click is one `mouse.click` at page coordinates (down and up in one go). A page whose layout shifts ON
  MOUSEDOWN (a field blurs, a block expands, the button moves out from under the pointer — seen with a
  hosted payment element's "save my info" block) can swallow a slower, human-paced press that this fast
  click still wins; the engine does not re-hit-test between down and up.
- Runs are non-deterministic. Repeat a scenario (`--repeat 3`) before treating a verdict as stable.
- Certification compares the typed value with the decoded request value as sent. A value the app
  normalises before sending (case change, trimmed whitespace, collapsed spaces) is not certified; the
  run BLOCKs with the input named, and a truncated echo of at least eight characters is annotated as
  `partial match`.
- **BLOCKED is never a product defect.** It means the harness or the scenario could not prove something
  (inputs not certified, step budget, a stuck loop, an early DONE). FAIL is the only product signal.
- Certification needs an own-origin request that carries the typed value. A page whose search is purely
  client-side can never certify an adversarial input; retarget the scenario or mark it smoke.
- A GET search can still be a server-side write (search-term logging). `mutations: false` cannot stop that.
- Obfuscated secrets on a page (`alice [at] example [dot] com`) are not normalised before redaction (non-goal).
- A `multipart/form-data` body is split into parts only with CRLF line endings, as the spec requires and every
  browser emits. A hand-built LF-only body yields no parts: it never certifies a value, and the BLOCKED
  reason flags the request as not inspectable.
- A value truncated by the app before it echoes or logs it never certifies, however much of it survives; it
  shows up only as a `partial match: N of M characters` note on the BLOCKED reason.

`element` assertions on a plain HTML `<th>`/`<td>` have proven unreliable: on
one real table whose accessibility tree genuinely exposed `role:
"columnheader"` for every header cell, Playwright's own `getByRole('columnheader',
...)` locator (what the `element` assertion uses) still matched zero elements
for any name. Prefer `text` or `response` assertions for anything on a plain
table; treat `element` as proven only where you have specifically verified it
against the real markup.

## Tests

`npm test` runs `node --test` over `test/**/*.test.ts`. `test/jev.test.ts`
covers `buildBody()`'s redaction (no raw/encoded/escaped input value anywhere
in the request, keys and neutral descriptors only) and `decide()`'s
edge-block retry ladder, the latter via an injected `deps.fetch` (real
`Response` objects, no network) — same injection pattern as the runner's
`deps.decide`. Every file except the two `*.browser.test.ts` files is pure —
no browser, no network. `test/runner.browser.test.ts` launches real Chromium
(from the Playwright cache) against several local `node:http` fixture pages,
with a scripted fake `decide` injected via `runAll`'s/`runOne`'s optional
`deps.decide` (never set in production) — seventeen scenarios prove the
runner/oracle/submission pipeline end to end without a live Jev call: a
debounce-backed page for the ordinary adversarial/acceptance/blocked cases;
a **debounce-free** page whose only possible evidence is the native `<form>`
submission itself, isolating (mutation-checking) the mid-loop auto-`Enter`,
the end-of-run rescue, and — via a scripted BLOCKED gap between two fills —
the `lastFill` tracking and `reportStep` attribution together; a
no-`<form>` page for the "Enter succeeds but submits nothing" boundary case;
a page whose last action navigates to a real crash screen (the final-page
check); a `check`-then-`response` pair proving a check's own triggered
request gets drained before the next assertion reads it; a debounced
search-and-open page (`test/prune`) whose fake `decide` dispatches on the
runner's own `certified` set (not on `history` like every other scenario) —
proving `certifiedKeys()` itself, recomputed each step from live oracle
events, not just `buildBody()`'s internal pruning (covered directly in
`test/jev.test.ts`), and (via a deliberately stubborn extra retry once
already certified) guard 28's no-op branch; disabling the pruning
reproduces the real regression verbatim (`stuck: repeated "Search tags…" 4
times`); and a no-debounce, form-only search-and-open page
(`test/fallback-enter`, `acceptance`-kind so its PASS strictly requires
`jevDone` and can never be papered over by the adversarial-only end-of-run
rescue) whose fake `decide` deliberately retypes an already-filled value
without ever pressing Enter itself, isolating guard 28's "not certified →
press Enter instead of retyping" branch — nothing else on that fixture can
ever certify the value at all; a `check` assertion (`test/crash-check`)
that navigates to a real crash page — must FAIL with a `crash-screen`
finding, catchable only by the post-`expect` crash inspection (guard 32),
since the pre-`expect` one ran before the navigation happened; a page
(`test/focus-steal`) where a second, unrelated input steals keyboard focus
300ms after typing, well within `act()`'s own 600ms settle wait — proving
`focusAndVerify()` (guard 38), not luck, is what lands the auto-`Enter` in
the intended field rather than wherever focus happened to end up; and a
page (`test/client-filter`) filtered ENTIRELY client-side, no request of
any kind — the exact "page change, no request" shape a unit-level test
could no longer even construct once `ChangeEvent` left the type system in
round 7, replacing that vacuous test (round 8, N7) — `submitted` stays
empty and the adversarial verdict is BLOCKED, naming the key; a page
(`test/value-clear`) whose field wipes its OWN value the instant it regains
focus — proves `focusAndVerify()`'s value re-check (guard 45), not just its
focus re-check (guard 38), is what gates the Enter press: the end-of-run
rescue's own re-click wipes the field a second time with no follow-up
typing, so the Enter must never fire at all — asserted directly (not just
via the BLOCKED verdict, which a wrongly-fired Enter into an empty field
would also produce) by checking no request ever reached the field's own
form action; and a page (`test/debounce-grace`) with a 1s debounce, longer
than `act()`'s own fixed 600ms fill-settle wait — proves the mid-loop
REPLACE guard's own debounce-grace poll (guard 46), not luck or an
unrelated wait, is what lets a value certify without the runner ever
forcing an Enter into the field; both values end up submitted and the
trail carries no `auto-submitted previous value` entry.
`test/phases.test.ts` covers `newRunId()`, `applyRunId()` (every string but `name`,
check args included, original untouched, non-plain objects such as a Date passed
through), `scenarioPhases()`, `scenarioInputs()`, `maskSecrets()` (encoded forms, a
reused key's every value), the verdict on a failed phase for every kind, and
scenario validation of `then`/`secretInputs`.
`test/phases.browser.test.ts` runs the real runner (fake `decide`) through a
two-phase scenario: the main phase submits a `{{run}}` email, a config check
receives the substituted args and returns the second phase's start url, the
second phase types the SAME email again (offered uncertified: certification is per
phase) plus a `{{run}}` password (`secretInputs`) and its own expectations are
evaluated and tagged — the certified list carries `«password»`, the value appears
nowhere in the result in any encoding (the GET form carried it as `%21`), and the
later phase's password was already redacted as a secret while the main phase ran; a
second scenario proves a check reporting `ok: false` FAILs the run naming the phase
(for a smoke scenario too), and one returning no url reports ERROR; the `intent` and
an `absentText` assertion quoting the secret come out masked; and a tall page whose
submit button sits below the fold is completed by the BLOCKED auto-scroll (the fake
`decide` answers BLOCKED whenever the button is not in the snapshot).
Round-3 additions: `maskSecrets` longest-first, `flattenInputs` name collisions,
phase names exempt from `{{run}}`, `~` in form encoding; in the browser files: a
sibling iframe laid over the target frame is refused, a REFUSED run masks its
intent, a phase's `response` assertion cannot ride on an earlier phase's response,
an ineffective BLOCKED scroll stops after one attempt, a field holding another
input is not overwritten when Jev offered an empty alternative.
`test/frames.browser.test.ts` drives `observe()`/`act()` directly against a
page embedding an `<iframe>`: the framed input and button are offered with
page coordinates and `frame: 1`, typing/clicking by those coordinates lands
inside the frame, a main-document overlay over the iframe makes `act()`
refuse (`occluded`) while the frame-side snapshot alone could never see it
(mutation-checked), the same node id in two frames stays two Jev elements,
a frame inserted before the payment frame by a re-render does not shift the
index an earlier action holds, the iframe's border and padding are accounted
for in the translated geometry, and a password field is offered by name with
its value never read before or after typing — while `buildBody()` never sends
the input value.
`test/replay.browser.test.ts` proves `replayUrls()` releases its browser
even when `role.login()` throws. Set `JEV_QA_NO_BROWSER=1` to skip both
browser files. `test/runner.test.ts` unit-tests `capRecent()` and
`persistedTimeline()` (guard 49) — the most-recent-N cap, the omitted counts,
the trimmed entry shape, and that 350 requests / 320 responses come back as
300 / 300 with 50 / 20 omitted; a seventeenth browser scenario
(`smoke/cap-results`, a page firing 350 fetches on load) proves the same
through the REAL `runOne()` → `Result` path, so bypassing `persistedTimeline()`
in `runOne()` fails a test too. `test/submission.test.ts` (guards 34/43/47/48)
covers `valueMatchesField()` directly: an unrelated `returnTo=` path never
certifies (`dashboard-widget` inside a path, `/dashboard` vs `/dashboard/home`);
a `*` or two trailing spaces after the value do; a `/x`, `.x` or 3-character
suffix does not; a truncated echo never certifies at 240 of 300 characters or
at 20 (both surface only through `partialMatch()`). It also covers the
multipart parser: a part whose own value contains `--<boundary>` inline or
`\r\n--abc123X` (boundary `abc123`) stays intact instead of being split around a
delimiter that was never real, a normal two-part body still parses, and an
LF-only body yields no parts. `npm run typecheck` runs `tsc --noEmit`.

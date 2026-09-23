import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildBody, decide, newPseudonyms, redactionForms } from '../src/jev.ts';
import type { Decision, HistoryEntry, Observation } from '../src/jev.ts';

function escapeHtml(s: string): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return s.replace(/[&<>"']/g, (c) => map[c]);
}

function baseObs(overrides: Partial<Observation> = {}): Observation {
  return { url: 'https://example.com/', title: 't', text: '', actions: [], omitted_actions: 0, ...overrides };
}

// --- I1: buildBody never sends a raw input value -----------------------------

test('buildBody: redacts raw, URL-encoded, and HTML-escaped occurrences everywhere in the body', () => {
  const inputs = { sql: "' OR 1=1; -- \"", script: '<script>alert(1)</script>' };
  const obs = baseObs({
    url: `https://example.com/search?q=${encodeURIComponent(inputs.sql)}`,
    title: `Raw: ${inputs.sql}`,
    text: [
      `Raw occurrence: ${inputs.sql}`,
      `URL-encoded occurrence: ${encodeURIComponent(inputs.sql)}`,
      `HTML-escaped occurrence: ${escapeHtml(inputs.script)}`,
    ].join(' '),
    actions: [{ id: 'e1', kind: 'fill', node: 1, role: 'textbox', label: `Search: ${inputs.sql}`, value: inputs.sql, current_value: inputs.script }],
  });
  const history: HistoryEntry[] = [{ action: 'typed', kind: 'fill', text: inputs.sql, page_changed: false }];
  const { body } = buildBody(obs, 'find results', inputs, history);
  const json = JSON.stringify(body);
  for (const value of Object.values(inputs)) {
    assert.equal(json.includes(value), false, `raw value ${JSON.stringify(value)} leaked into the request body`);
    assert.equal(json.includes(encodeURIComponent(value)), false, `URL-encoded value leaked`);
    assert.equal(json.includes(escapeHtml(value)), false, `HTML-escaped value leaked`);
  }
  assert.ok(json.includes('sql'), 'the key "sql" should still be present');
  assert.ok(json.includes('script'), 'the key "script" should still be present');
});

// --- round 7 (M1): goal and history action labels were never redacted at all -----------------

test('buildBody: redacts the goal wherever it appears (every instructions.goal)', () => {
  const inputs = { sql: "' OR 1=1" };
  const obs = baseObs({ actions: [{ id: 'e1', kind: 'fill', node: 1, role: 'textbox', label: 'q' }] });
  const goal = `search for ${inputs.sql} and open the first result`;
  const { body } = buildBody(obs, goal, inputs, []);
  const json = JSON.stringify(body);
  assert.equal(json.includes(inputs.sql), false, 'the raw value must not leak via the goal');
  assert.ok(json.includes('«sql»'), 'the redaction token should appear in its place');
});

test('buildBody: redacts each history entry\'s own action label, not just its typed text', () => {
  const inputs = { a: 'alpha-value' };
  const history: HistoryEntry[] = [{ action: `Search ${inputs.a}`, kind: 'fill', text: inputs.a, page_changed: false }];
  const { body } = buildBody(baseObs(), 'goal', inputs, history);
  const recent = (body.state as { recent_actions: { action: string }[] }).recent_actions;
  assert.equal(recent[0].action, 'Search «a»');
});

// --- round 7 (M2): the encoding list was too short — the real WAF trigger ---------------------

test('redactionForms: "a b" — form-encoding turns the space into "+", not just "%20"', () => {
  const forms = redactionForms('a b');
  assert.ok(forms.includes('a+b'), `expected a form-encoded ("+") variant, got ${JSON.stringify(forms)}`);
  assert.ok(forms.includes('a%20b'), `expected the standard percent-encoded variant too, got ${JSON.stringify(forms)}`);
});

test('redactionForms: the SQL injection string produces the exact real-world WAF-triggering form', () => {
  const value = "' OR 1=1; -- \"";
  const forms = redactionForms(value);
  // The exact string that leaked through the old redact() in production (round 7 addendum):
  // encodeURIComponent, then %20 replaced with + — a real GET form's own encoding.
  assert.ok(forms.includes('%27+OR+1%3D1%3B+--+%22'), `expected the form-encoded variant, got ${JSON.stringify(forms)}`);
  assert.ok(forms.includes(value), 'expected the raw value itself');
});

test('redactionForms: "<script>" produces named AND numeric (decimal + hex) HTML entity forms', () => {
  const forms = redactionForms('<script>');
  assert.ok(forms.includes('&lt;script&gt;'), 'expected the named-entity form');
  assert.ok(forms.includes('&#60;script&#62;'), `expected the numeric decimal form, got ${JSON.stringify(forms)}`);
  assert.ok(forms.includes('&#x3c;script&#x3e;'), `expected the numeric hex form, got ${JSON.stringify(forms)}`);
});

test('redactionForms: an emoji round-trips through every encoding without throwing', () => {
  const emoji = '🌸';
  assert.doesNotThrow(() => redactionForms(emoji));
  const forms = redactionForms(emoji);
  assert.ok(forms.includes(emoji), 'expected the raw emoji itself');
  assert.ok(forms.some((f) => f.startsWith('%')), `expected a percent-encoded form, got ${JSON.stringify(forms)}`);
  assert.ok(forms.some((f) => f.startsWith('&#') && !f.startsWith('&#x')), `expected a numeric-decimal HTML entity form, got ${JSON.stringify(forms)}`);
  assert.ok(forms.some((f) => f.startsWith('&#x')), `expected a numeric-hex HTML entity form, got ${JSON.stringify(forms)}`);
});

test('buildBody: redacts the page URL when it carries a form-encoded value (the real WAF trigger)', () => {
  const inputs = { sql: "' OR 1=1; -- \"" };
  // The EXACT URL a real GET-form submission produced in production (round 7 addendum) —
  // %27 for the quote (encodeURIComponent alone leaves it as a literal '), + for space.
  const obs = baseObs({ url: 'https://example.com/dashboard/customers?q=%27+OR+1%3D1%3B+--+%22' });
  const { body } = buildBody(obs, 'goal', inputs, []);
  const url = (body.state as { page: { url: string } }).page.url;
  assert.equal(url, 'https://example.com/dashboard/customers?q=«sql»');
});

test('buildBody: stripUrlQuery reduces the url to origin+path (degradation step 4)', () => {
  const obs = baseObs({ url: 'https://example.com/search?q=sensitive&page=2#anchor' });
  const { body } = buildBody(obs, 'goal', {}, [], new Set(), [], undefined, { stripUrlQuery: true });
  assert.equal((body.state as { page: { url: string } }).page.url, 'https://example.com/search?…');
});

test('buildBody: stripUrlQuery leaves a url with no query/fragment untouched', () => {
  const obs = baseObs({ url: 'https://example.com/dashboard' });
  const { body } = buildBody(obs, 'goal', {}, [], new Set(), [], undefined, { stripUrlQuery: true });
  assert.equal((body.state as { page: { url: string } }).page.url, 'https://example.com/dashboard');
});

// --- round 8 (N1): fuzzy redaction — case-insensitive percent escapes + prefix echoes --------

test('buildBody: redacts percent-encoded occurrences case-insensitively (%3c vs %3C)', () => {
  const inputs = { xss: '<script>' };
  // encodeURIComponent always produces uppercase hex (%3C/%3E) — this URL uses lowercase, as a
  // different encoder (or a manually-lowercased URL) might, which exact-string matching alone
  // would miss.
  const obs = baseObs({ url: 'https://example.com/search?q=%3cscript%3e' });
  const { body } = buildBody(obs, 'goal', inputs, []);
  const url = (body.state as { page: { url: string } }).page.url;
  assert.equal(url, 'https://example.com/search?q=«xss»');
});

test('buildBody: redacts a truncated prefix echo (round 9, O3: >= 16-char value, >= 12-char prefix, at a boundary)', () => {
  const inputs = { secret: 'ABCDEFGHIJKLMNOP' }; // 16 chars
  const obs = baseObs({ text: 'preview: ABCDEFGHIJKLMN...' }); // the first 14 chars echoed, then truncated
  const { body } = buildBody(obs, 'goal', inputs, []);
  const text = (body.state as { page: { text: string } }).page.text;
  assert.equal(text, 'preview: «secret»...');
});

test('buildBody: does NOT prefix-redact a short (< 16 char) value — would shred ordinary text', () => {
  const inputs = { pin: 'ABCDEFGHIJKLM' }; // 13 chars — under the round-9 (O3) 16-char threshold
  const obs = baseObs({ text: 'the code ABCDEFGHIJ is unrelated' }); // a 10-char PREFIX of the pin, not the full value
  const { body } = buildBody(obs, 'goal', inputs, []);
  const text = (body.state as { page: { text: string } }).page.text;
  assert.equal(text, 'the code ABCDEFGHIJ is unrelated', "a short value's prefix must never be redacted on its own");
});

test('buildBody: round 9 (O3) — "customers" is never prefix-redacted, even for a value that starts the same way', () => {
  // The ORIGINAL bug this round fixed: an 8+-char VALUE whose own first ~9 characters happen to
  // spell an ordinary word would redact every unrelated occurrence of that word anywhere on the
  // page. "customers" is only 9 characters — under the new >= 12-char-prefix rule, it can NEVER
  // be selected as a prefix match on its own, regardless of what longer value it might prefix.
  const inputs = { q: 'customersAreVeryImportantToUs123' }; // 33 chars, starts with "customers"
  const obs = baseObs({ text: 'our customers support team is available 24/7' });
  const { body } = buildBody(obs, 'goal', inputs, []);
  const text = (body.state as { page: { text: string } }).page.text;
  assert.equal(text, 'our customers support team is available 24/7');
});

test('buildBody: round 9 (O3) — a 12+-char prefix must end at a real boundary, not mid-word', () => {
  const inputs = { q: 'customization-panel-settings-x' }; // 31 chars; its own first 13 chars are "customization"
  const obs = baseObs({ text: 'open the customizations menu' }); // "customization" continues as "customizationS" here
  const { body } = buildBody(obs, 'goal', inputs, []);
  const text = (body.state as { page: { text: string } }).page.text;
  assert.equal(text, 'open the customizations menu', 'a prefix match must not fire mid-word (the "s" right after breaks the boundary)');
});

// --- round 8 (N2): config secrets («secret» token) + generic email/token scrub ----------------

test('buildBody: config secrets redact to the shared «secret» token, not a per-input key', () => {
  const secrets = ['manager_9', 'Sup3rSecretPass!42'];
  const obs = baseObs({ text: `logged in as ${secrets[0]} with password ${secrets[1]}` });
  const { body } = buildBody(obs, 'goal', {}, [], new Set(), secrets);
  const text = (body.state as { page: { text: string } }).page.text;
  assert.equal(text.includes(secrets[0]), false);
  assert.equal(text.includes(secrets[1]), false);
  assert.equal(text, 'logged in as «secret» with password «secret»');
});

test('buildBody: generic scrub redacts any email address, even one not in inputs/secrets (round 9, O4: numbered pseudonym)', () => {
  const obs = baseObs({ text: 'contact support at ops@example.com for help' });
  const { body } = buildBody(obs, 'goal', {}, []);
  const text = (body.state as { page: { text: string } }).page.text;
  assert.equal(text, 'contact support at «email:1» for help');
});

test('buildBody: generic scrub redacts a long opaque query-string token, even one not in inputs/secrets (round 9, O4: numbered pseudonym)', () => {
  const obs = baseObs({ url: 'https://example.com/reset?token=aZ9bY8cX7dW6eV5fU4gT3hS2iR1jQ0kP' });
  const { body } = buildBody(obs, 'goal', {}, []);
  const url = (body.state as { page: { url: string } }).page.url;
  assert.equal(url, 'https://example.com/reset?token=«token:1»');
});

test('buildBody: generic scrub leaves a short query value alone (< 20 chars, an ordinary search term)', () => {
  const obs = baseObs({ url: 'https://example.com/search?q=shoes' });
  const { body } = buildBody(obs, 'goal', {}, []);
  const url = (body.state as { page: { url: string } }).page.url;
  assert.equal(url, 'https://example.com/search?q=shoes');
});

// --- round 9 (O1): every string field of an Action is redacted, not just label/value ---------

test('buildBody: redacts a config secret appearing in an action\'s expanded/checked/selected fields', () => {
  const secrets = ['leaked-aria-secret-42'];
  const obs = baseObs({
    actions: [
      {
        id: 'e1', kind: 'click', node: 1, role: 'button', label: 'Menu',
        expanded: `state:${secrets[0]}`, checked: `flag:${secrets[0]}`, selected: `opt:${secrets[0]}`,
      },
    ],
  });
  const { body } = buildBody(obs, 'goal', {}, [], new Set(), secrets);
  const json = JSON.stringify(body);
  assert.equal(json.includes(secrets[0]), false, `the secret leaked into the request: ${json}`);
  assert.ok(json.includes('«secret»'), 'expected the shared «secret» token in its place');
});

// --- round 9 (O2): recent_actions[].action is scrubGeneric()'d too, not just redact()'d -------

test('buildBody: recent_actions[].action scrubs a generic email, not just known inputs/secrets', () => {
  const history: HistoryEntry[] = [{ action: 'Open link for ops@example.com', kind: 'click', text: null, page_changed: true }];
  const { body } = buildBody(baseObs(), 'goal', {}, history);
  const recent = (body.state as { recent_actions: { action: string }[] }).recent_actions;
  assert.equal(recent[0].action, 'Open link for «email:1»');
});

// --- round 9 (O4): scrubGeneric pseudonyms are distinct and stable within a shared run --------

test('buildBody: two different emails on the same page get two DIFFERENT pseudonyms', () => {
  const obs = baseObs({ text: 'contact alice@example.com or bob@example.com for help' });
  const { body } = buildBody(obs, 'goal', {}, []);
  const text = (body.state as { page: { text: string } }).page.text;
  assert.equal(text, 'contact «email:1» or «email:2» for help');
});

test('buildBody: the SAME email gets the SAME pseudonym across two separate buildBody() calls sharing one Pseudonyms map', () => {
  const pseudonyms = newPseudonyms();
  const first = buildBody(baseObs({ text: 'signed in as alice@example.com' }), 'goal', {}, [], new Set(), [], pseudonyms);
  const second = buildBody(baseObs({ text: 'still signed in as alice@example.com' }), 'goal', {}, [], new Set(), [], pseudonyms);
  const firstText = (first.body.state as { page: { text: string } }).page.text;
  const secondText = (second.body.state as { page: { text: string } }).page.text;
  assert.equal(firstText, 'signed in as «email:1»');
  assert.equal(secondText, 'still signed in as «email:1»');
});

test('buildBody: goal AND recent_actions use the SAME pseudonym map as the page, so they can still refer to the same entity', () => {
  const pseudonyms = newPseudonyms();
  const obs = baseObs({ actions: [{ id: 'e1', kind: 'click', node: 1, role: 'link', label: 'bob@example.com' }] });
  const history: HistoryEntry[] = [{ action: 'Hover bob@example.com', kind: 'wait', text: null, page_changed: false }];
  const { body } = buildBody(obs, 'open the link for bob@example.com', {}, history, new Set(), [], pseudonyms);
  const json = JSON.stringify(body);
  assert.equal(json.includes('bob@example.com'), false, 'the raw email must never leak');
  // Every surface that could mention the email — the element label, its TARGET criteria (both
  // derived from the same redacted action), the goal (used in both `operation` and
  // `click_target`'s own instructions), and the history action — must use the exact SAME
  // pseudonym, never a second, different one.
  const el = (body.state as { elements: { label: string }[] }).elements[0];
  const recent = (body.state as { recent_actions: { action: string }[] }).recent_actions;
  const q = body.questions as { operation: { instructions: { goal: string } }; click_target: { instructions: { goal: string }; criteria: Record<string, { element: string }> } };
  assert.equal(el.label, '«email:1»');
  assert.equal(recent[0].action, 'Hover «email:1»');
  assert.equal(q.operation.instructions.goal, 'open the link for «email:1»');
  assert.equal(q.click_target.instructions.goal, 'open the link for «email:1»');
  assert.equal(q.click_target.criteria['1'].element, '[1] «email:1»');
  assert.equal((json.match(/«email:(\d+)»/g) ?? []).every((m) => m === '«email:1»'), true, `expected every occurrence to use pseudonym 1, got: ${json}`);
});

test('buildBody: recent_actions carries the scenario input KEY (wrapped in the redaction token), never the typed value', () => {
  const inputs = { a: 'alpha-value', b: 'beta-value' };
  const history: HistoryEntry[] = [
    { action: 'fill a', kind: 'fill', text: 'alpha-value', page_changed: false },
    { action: 'fill b', kind: 'fill', text: 'beta-value', page_changed: true },
    { action: 'click', kind: 'click', text: null, page_changed: true },
  ];
  const { body } = buildBody(baseObs(), 'goal', inputs, history);
  const recent = (body.state as { recent_actions: { text: unknown }[] }).recent_actions;
  // L1: «a»/«b», not the bare key — the same token redact() puts into current_value/page text,
  // so Jev's own literal-string comparison between "does this field already hold X" surfaces
  // actually matches instead of comparing a bare key against a guillemet-wrapped one.
  assert.deepEqual(recent.map((r) => r.text), ['«a»', '«b»', null]);
  assert.equal(JSON.stringify(body).includes('alpha-value'), false);
  assert.equal(JSON.stringify(body).includes('beta-value'), false);
});

test('buildBody: a history text matching no current input becomes the opaque "(text)" placeholder', () => {
  const inputs = { a: 'alpha' };
  const history: HistoryEntry[] = [{ action: 'fill something else', kind: 'fill', text: 'not-a-known-input', page_changed: false }];
  const { body } = buildBody(baseObs(), 'goal', inputs, history);
  const recent = (body.state as { recent_actions: { text: unknown }[] }).recent_actions;
  assert.equal(recent[0].text, '(text)');
});

test('buildBody: text_value criteria is a «key» token + neutral length descriptor, never the value', () => {
  const inputs = { sql: "' OR 1=1", emoji: '🌸🌺' };
  const obs = baseObs({ actions: [{ id: 'e1', kind: 'fill', node: 1, role: 'textbox', label: 'q', value: '' }] });
  const { body } = buildBody(obs, 'goal', inputs, []);
  const criteria = (body as { questions: { text_value: { criteria: Record<string, string> } } }).questions.text_value.criteria;
  // L1: «sql»/«emoji», not the bare key — see the recent_actions test above for why.
  assert.equal(criteria.sql, `«sql»: scenario input #1 (${inputs.sql.length} characters)`);
  assert.equal(criteria.emoji, `«emoji»: scenario input #2 (${inputs.emoji.length} characters)`);
  const json = JSON.stringify(body);
  assert.equal(json.includes(inputs.sql), false);
  assert.equal(json.includes(inputs.emoji), false);
});

test('buildBody: the SAME «key» token appears in current_value, text_value criteria, and recent_actions', () => {
  // Directly encodes the round-4 → round-6 regression: current_value showed «query» while
  // text_value's criteria and recent_actions still showed the bare key "query", so Jev's TARGET
  // rule ("do not choose a field that already contains the requested value") could never match
  // and it retyped the same value forever. All three must use the identical literal string.
  const inputs = { query: 'flower' };
  // snapshot.js sets `value` (never `current_value`) for a real 'fill' action — current_value
  // is select-only. `value` flows to both elements[] and the TARGET question's own criteria
  // (which falls back to `value` when current_value is absent), so both must carry the token.
  const obs = baseObs({ actions: [{ id: 'e1', kind: 'fill', node: 1, role: 'textbox', label: 'Search tags…', value: inputs.query }] });
  const history: HistoryEntry[] = [{ action: 'typed', kind: 'fill', text: inputs.query, page_changed: false }];
  const { body } = buildBody(obs, 'goal', inputs, history);
  const el = (body.state as { elements: { value: string }[] }).elements[0];
  const target = (body as { questions: { type_text_target: { criteria: Record<string, { current_value: string }> } } }).questions.type_text_target;
  const textValue = (body as { questions: { text_value: { criteria: Record<string, string> } } }).questions.text_value;
  const recent = (body.state as { recent_actions: { text: unknown }[] }).recent_actions;
  assert.equal(el.value, '«query»');
  assert.equal(target.criteria['1'].current_value, '«query»');
  assert.ok(textValue.criteria.query.startsWith('«query»:'), `expected the criteria text to start with the same token, got ${JSON.stringify(textValue.criteria.query)}`);
  assert.equal(recent[0].text, '«query»');
});

test('buildBody: text_value criteria keys preserve the inputs object\'s own order', () => {
  const inputs = { third: 'c', first: 'a', second: 'b' };
  const { body } = buildBody(baseObs({ actions: [{ id: 'e1', kind: 'fill', node: 1, role: 'textbox', label: 'q' }] }), 'goal', inputs, []);
  const criteria = (body as { questions: { text_value: { criteria: Record<string, string> } } }).questions.text_value.criteria;
  assert.ok(criteria.third.includes('#1'));
  assert.ok(criteria.first.includes('#2'));
  assert.ok(criteria.second.includes('#3'));
});

test('buildBody: no TYPE_TEXT question at all when there are no inputs', () => {
  const { body } = buildBody(baseObs({ actions: [{ id: 'e1', kind: 'click', node: 1, role: 'button', label: 'Go' }] }), 'goal', {}, []);
  assert.equal('text_value' in (body as { questions: object }).questions, false);
});

test('buildBody: withholdPageText replaces page text with a fixed marker (degradation step 1)', () => {
  const obs = baseObs({ text: 'sensitive page content that must not leak' });
  const { body } = buildBody(obs, 'goal', {}, [], new Set(), [], undefined, { withholdPageText: true });
  assert.equal((body.state as { page: { text: string } }).page.text, '(page text withheld)');
});

test('buildBody: clip shortens element labels/values (degradation step 2)', () => {
  const obs = baseObs({ actions: [{ id: 'e1', kind: 'fill', node: 1, role: 'textbox', label: 'a'.repeat(100), value: 'b'.repeat(100) }] });
  const { body } = buildBody(obs, 'goal', {}, [], new Set(), [], undefined, { clip: 24 });
  const el = (body.state as { elements: { label: string }[] }).elements[0];
  assert.ok(el.label.length <= 25, `expected a clipped label (≤25 incl. ellipsis), got length ${el.label.length}`);
});

// --- L2: action-space pruning (a certified input is never re-offered) -------

test('buildBody: a certified key is removed from text_value.criteria; an uncertified one stays', () => {
  const inputs = { a: 'alpha', b: 'beta' };
  const obs = baseObs({ actions: [{ id: 'e1', kind: 'fill', node: 1, role: 'textbox', label: 'q' }] });
  const { body } = buildBody(obs, 'goal', inputs, [], new Set(['a']));
  const criteria = (body as { questions: { text_value: { criteria: Record<string, string> } } }).questions.text_value.criteria;
  assert.equal('a' in criteria, false, 'a certified key must not be offered');
  assert.equal(criteria.b, '«b»: scenario input #1 (4 characters)', 'the remaining key renumbers from #1');
});

test('buildBody: TYPE_TEXT drops out of operations (and text_value disappears) once every input is certified', () => {
  const inputs = { a: 'alpha' };
  const obs = baseObs({ actions: [{ id: 'e1', kind: 'fill', node: 1, role: 'textbox', label: 'q' }] });
  const { body, operations } = buildBody(obs, 'goal', inputs, [], new Set(['a']));
  assert.equal('TYPE_TEXT' in operations, false);
  assert.equal('text_value' in (body as { questions: object }).questions, false);
});

test('decide: a certified key never appears in the outgoing text_value.criteria and is never offered as an answer', async () => {
  const inputs = { a: 'alpha', b: 'beta' };
  const obs = baseObs({ actions: [{ id: 'e1', kind: 'fill', node: 1, role: 'textbox', label: 'q' }] });
  const answers = {
    answers: {
      operation: { choice: 'TYPE_TEXT', confidence: 1, probabilities: { TYPE_TEXT: 1, DONE: 0, BLOCKED: 0 } },
      type_text_target: { choice: '1', confidence: 1, probabilities: { '1': 1 } },
      // Only "b" is a valid choice here — "a" was certified and never sent, so a well-behaved
      // TypeSafe response can only ever offer probabilities over what it was actually shown.
      text_value: { choice: 'b', confidence: 1, probabilities: { b: 1 } },
    },
    usage: { input_tokens: 10 },
  };
  const res = new Response(JSON.stringify(answers), { status: 200, headers: { 'content-type': 'application/json' } });
  const { fetch: fetchFn, bodies } = fakeFetchSequence([res]);
  const d: Decision = await decide(obs, 'goal', inputs, [], new Set(['a']), [], undefined, { fetch: fetchFn });
  assert.equal(d.text, 'beta');
  const sentCriteria = JSON.parse(bodies[0]).questions.text_value.criteria;
  assert.equal('a' in sentCriteria, false);
  assert.ok('b' in sentCriteria);
});

test('buildBody: an empty-string input value is never redacted against (would corrupt everything)', () => {
  const inputs = { empty: '', real: 'hostile' };
  const obs = baseObs({ text: 'some ordinary page text with hostile in it' });
  assert.doesNotThrow(() => buildBody(obs, 'goal', inputs, []));
  const { body } = buildBody(obs, 'goal', inputs, []);
  assert.equal((body.state as { page: { text: string } }).page.text, 'some ordinary page text with «real» in it');
});

// --- I2: edge-block (WAF) retry ladder ---------------------------------------

function okResponse(probabilities: Record<string, number> = { DONE: 1, BLOCKED: 0 }): Response {
  const answers = { answers: { operation: { choice: 'DONE', confidence: 1, probabilities } }, usage: { input_tokens: 10 } };
  return new Response(JSON.stringify(answers), { status: 200, headers: { 'content-type': 'application/json' } });
}

function edgeBlockResponse(): Response {
  return new Response('<!DOCTYPE html><html><body>blocked</body></html>', { status: 403, headers: { 'content-type': 'text/html' } });
}

function fakeFetchSequence(responses: Response[]): { fetch: typeof fetch; bodies: string[] } {
  const bodies: string[] = [];
  let i = 0;
  const fetchFn = (async (_url: unknown, init?: { body?: unknown }) => {
    bodies.push(String(init?.body ?? ''));
    return responses[Math.min(i++, responses.length - 1)];
  }) as unknown as typeof fetch;
  return { fetch: fetchFn, bodies };
}

test('decide: an edge block (403 + HTML) retries once with page text withheld, then succeeds', async () => {
  const { fetch: fetchFn, bodies } = fakeFetchSequence([edgeBlockResponse(), okResponse()]);
  const obs = baseObs({ text: 'sensitive text' });
  const d: Decision = await decide(obs, 'goal', {}, [], new Set(), [], undefined, { fetch: fetchFn });
  assert.equal(bodies.length, 2);
  assert.equal(d.degraded, 'no-page-text');
  assert.equal(JSON.parse(bodies[0]).state.page.text, 'sensitive text');
  assert.equal(JSON.parse(bodies[1]).state.page.text, '(page text withheld)');
});

test('decide: an edge block that survives the first retry escalates to clipped labels, then succeeds', async () => {
  const { fetch: fetchFn, bodies } = fakeFetchSequence([edgeBlockResponse(), edgeBlockResponse(), okResponse({ CLICK: 0, DONE: 1, BLOCKED: 0 })]);
  const obs = baseObs({ actions: [{ id: 'e1', kind: 'click', node: 1, role: 'button', label: 'z'.repeat(100) }] });
  const d: Decision = await decide(obs, 'goal', {}, [], new Set(), [], undefined, { fetch: fetchFn });
  assert.equal(bodies.length, 3);
  assert.equal(d.degraded, 'short-labels');
  const third = JSON.parse(bodies[2]);
  assert.ok(third.state.elements[0].label.length <= 25);
});

// Round 7 addendum: the real WAF trigger was the page URL's query string (form-encoded), never
// caught by degradation steps 1-2 (they only touch page text and element labels/values) — the
// 4th ladder level strips the URL's query/fragment entirely before giving up.
test('decide: an edge block that survives short-labels escalates to no-url-query, then succeeds', async () => {
  const { fetch: fetchFn, bodies } = fakeFetchSequence([
    edgeBlockResponse(),
    edgeBlockResponse(),
    edgeBlockResponse(),
    okResponse(),
  ]);
  const obs = baseObs({ url: 'https://example.com/dashboard/customers?q=%27+OR+1%3D1%3B+--+%22' });
  const d: Decision = await decide(obs, 'goal', {}, [], new Set(), [], undefined, { fetch: fetchFn });
  assert.equal(bodies.length, 4);
  assert.equal(d.degraded, 'no-url-query');
  const fourth = JSON.parse(bodies[3]);
  assert.equal(fourth.state.page.url, 'https://example.com/dashboard/customers?…');
});

test('decide: an edge block that survives all four levels throws a diagnosable error, never the response body (round 8, N3)', async () => {
  const { fetch: fetchFn, bodies } = fakeFetchSequence([edgeBlockResponse(), edgeBlockResponse(), edgeBlockResponse(), edgeBlockResponse()]);
  await assert.rejects(
    () => decide(baseObs(), 'goal', {}, [], new Set(), [], undefined, { fetch: fetchFn }),
    (e: Error) => {
      assert.match(e.message, /TypeSafe edge block \(WAF\)/);
      assert.match(e.message, /HTTP 403/);
      assert.match(e.message, /ladder level no-url-query/);
      assert.equal(e.message.includes('blocked'), false, `the response body text must never appear in the error, got: ${e.message}`);
      return true;
    },
  );
  assert.equal(bodies.length, 4);
});

test('decide: a JSON 403 (an API refusal, not an edge block) does not retry; the error mentions HTTP 403, never the body', async () => {
  const jsonForbidden = new Response(JSON.stringify({ error: 'forbidden' }), { status: 403, headers: { 'content-type': 'application/json' } });
  const { fetch: fetchFn, bodies } = fakeFetchSequence([jsonForbidden]);
  await assert.rejects(
    () => decide(baseObs(), 'goal', {}, [], new Set(), [], undefined, { fetch: fetchFn }),
    (e: Error) => {
      assert.match(e.message, /TypeSafe HTTP 403/);
      assert.match(e.message, /ladder level null/);
      assert.equal(e.message.includes('forbidden'), false, `the response body text must never appear in the error, got: ${e.message}`);
      return true;
    },
  );
  assert.equal(bodies.length, 1);
});

test('decide: a normal 200 response never touches the degradation ladder (degraded: null)', async () => {
  const { fetch: fetchFn, bodies } = fakeFetchSequence([okResponse()]);
  const d: Decision = await decide(baseObs(), 'goal', {}, [], new Set(), [], undefined, { fetch: fetchFn });
  assert.equal(bodies.length, 1);
  assert.equal(d.degraded, null);
});

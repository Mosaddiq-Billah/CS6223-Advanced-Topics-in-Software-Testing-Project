// Headless verification harness for the Tinyville NPC testbed: stubs a minimal
// DOM, loads the real (unmodified) framework modules, and executes the full
// evaluation protocol (clean scenarios + seeded-fault detection matrix).
// Run from anywhere:  node tools/verify.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = join(dirname(fileURLToPath(import.meta.url)), '..', 'home', 'static', 'home', 'js');

/* ---------------- minimal DOM stub ---------------- */
function makeEl(id) {
  return {
    id, children: [], style: {}, classList: { add() {}, remove() {} },
    innerHTML: '', textContent: '', value: '', checked: false, disabled: false,
    scrollTop: 0, scrollHeight: 0, title: '', className: '',
    appendChild(c) { this.children.push(c); return c; },
    insertBefore(c) { this.children.unshift(c); return c; },
    addEventListener() {}, remove() {}, click() {},
  };
}
const byId = new Map();
const document = {
  readyState: 'complete',
  body: makeEl('body'),
  getElementById(id) { if (!byId.has(id)) byId.set(id, makeEl(id)); return byId.get(id); },
  createElement(tag) { return makeEl('<' + tag + '>'); },
  addEventListener() {}, dispatchEvent() {},
};
global.document = document;
global.CustomEvent = class CustomEvent { constructor(type, opts) { this.type = type; Object.assign(this, opts); } };
global.window = global;
global.addEventListener = () => {};
global.Blob = class Blob { constructor(parts) { this.parts = parts; } };
global.URL.createObjectURL = () => 'blob:stub';
global.URL.revokeObjectURL = () => {};

document.getElementById('execCount').value = '3';
document.getElementById('speed').value = '2';
document.getElementById('animateToggle').checked = false;
document.getElementById('faultSelect').value = '';

for (const f of ['sandbox.js', 'observation.js', 'criteria.js', 'game_spec.js', 'scenarios.js', 'execution.js', 'evaluation.js', 'dashboard.js']) {
  (0, eval)(readFileSync(join(BASE, f), 'utf8'));
}
const { Town, Observation, Criteria, Scenarios, TestAgent, Runner, Evaluation } = global;
const { createMiniSUT, QUEST_SPEC, MINI_SCENARIO } = await import('./minisut.mjs');

let failures = 0;
function check(label, cond, extra) {
  if (cond) console.log('  OK  ' + label);
  else { failures++; console.log('  FAIL ' + label + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); }
}
const townLog = document.getElementById('townLog');
const logTexts = () => townLog.children.map((c) => c.innerHTML);
const st = (rep, crit) => rep.criteriaResults[crit] && rep.criteriaResults[crit].status;

/* ============ A. Clean runs: all six scenarios, 3 executions each ============ */
console.log('\n=== A. Clean NPCs — Run All (6 scenarios × 3 executions) ===');
Runner.config.executions = 3;
Runner.config.faults = {};
let reps = await Runner.runAll();
console.log('  ' + reps.map((r) => `${r.scenarioId}:${r.outcome}`).join('  '));
check('six scenarios executed', reps.length === 6);
check('all six PASS on clean NPCs', reps.every((r) => r.outcome === 'PASS'), reps.flatMap((r) => r.issues));
check('all four criteria PASS where applicable', reps.every((r) => Object.values(r.criteriaResults).every((x) => x.status === 'PASS')));
check('targets span several NPCs', new Set(reps.map((r) => r.target)).size === 3, reps.map((r) => r.target));
check('ambient town restored after batch', !Town.isTestMode());
check('observation sheets generated (6×3)', Evaluation.sheets.length === 18, Evaluation.sheets.length);
const sheet = Evaluation.sheets.find((s) => s.scenarioId === 'STRESS_01');
console.log('  sample sheet (STRESS_01):', JSON.stringify({
  observed: sheet.observedBehavior, transition: sheet.transitionTimeMs,
  recovery: sheet.recoveryBehavior, outcome: sheet.finalOutcome }));
check('sheet records recovery behaviour', /recovered in/.test(sheet.recoveryBehavior), sheet.recoveryBehavior);
check('sheet records transition times', /\d/.test(sheet.transitionTimeMs), sheet.transitionTimeMs);
const abandonSheet = Evaluation.sheets.find((s) => s.scenarioId === 'STRESS_02');
check('abandonment counted as interruption (STRESS_02)', /interrupted=2/.test(abandonSheet.observedBehavior), abandonSheet.observedBehavior);
const logs = logTexts();
check('town log narrates Scout → NPC dialogue', logs.some((t) => t.includes('Scout → Sana') && t.includes('bread')));
check('town log narrates NPC replies', logs.some((t) => t.includes('Sana → Scout')));
check('town log narrates interruption + recovery', logs.some((t) => t.includes('Scout interrupts Sana')) && logs.some((t) => t.includes('ready to interact again')));
check('town log narrates abandonment (Ivy interrupted mid-conversation)', logs.some((t) => t.includes('Ivy is interrupted')));
check('log entries carry scenario id + execution number', logs.some((t) => t.includes('NORMAL_01') && t.includes('execution 1/3')));

/* ============ B. Seeded-fault detection matrix (proposal §5) ============ */
console.log('\n=== B. Seeded-fault detection matrix ===');
const CASES = [
  { fault: 'skip_states',           run: () => Runner.runScenario('NORMAL_01'), expect: { criterion: 'state_integrity',    status: 'FAIL',    outcome: 'FAIL' } },
  { fault: 'off_role_dialogue',     run: () => Runner.runScenario('NORMAL_01'), expect: { criterion: 'role_consistency',   status: 'FAIL',    outcome: 'FAIL' } },
  { fault: 'delayed_reply',         run: () => Runner.runScenario('NORMAL_01'), expect: { criterion: 'state_integrity',    status: 'PARTIAL', outcome: 'PARTIAL' } },
  { fault: 'unstable_reply',        run: () => Runner.runScenario('NORMAL_01'), expect: { criterion: 'determinism',        status: 'PARTIAL', outcome: 'PARTIAL' } },
  { fault: 'delayed_recovery',      run: () => Runner.runScenario('STRESS_01'), expect: { criterion: 'recovery_stability', status: 'PARTIAL', outcome: 'PARTIAL' } },
  { fault: 'stuck_after_interrupt', run: () => Runner.runScenario('STRESS_01'), expect: { criterion: 'recovery_stability', status: 'FAIL',    outcome: 'FAIL' } },
  { fault: 'animation_desync',      run: () => Runner.runScenario('NORMAL_01'), expect: { criterion: 'state_integrity',    status: 'FAIL',    outcome: 'FAIL' } },
];
const matrix = [];
for (const c of CASES) {
  Runner.config.faults = { [c.fault]: true };
  const [rep] = await c.run();
  const got = st(rep, c.expect.criterion);
  matrix.push({ fault: c.fault, scenario: rep.scenarioId, criterion: c.expect.criterion, criterionStatus: got, outcome: rep.outcome });
  check(`${c.fault}: ${c.expect.criterion}=${c.expect.status}, outcome=${c.expect.outcome}`,
    got === c.expect.status && rep.outcome === c.expect.outcome,
    { got, outcome: rep.outcome, issues: rep.issues.slice(0, 3) });
}
console.table(matrix);
check('stuck fault also breaks state integrity', st(Evaluation.reports.find((r) => r.injectedFaults.includes('stuck_after_interrupt')), 'state_integrity') === 'FAIL');

/* faults must not leak into later clean runs */
Runner.config.faults = {};
const [cleanAgain] = await Runner.runScenario('STRESS_01');
check('clean STRESS_01 passes again after fault runs (no fault leakage)', cleanAgain.outcome === 'PASS', cleanAgain.issues);
check('town not left in test mode', !Town.isTestMode());

/* ============ C. CSV exports ============ */
console.log('\n=== C. CSV exports ===');
const repCsv = Evaluation.reportsCsv();
check('report CSV: BOM + header + one row per report', repCsv.charCodeAt(0) === 0xFEFF
  && repCsv.slice(1).trim().split('\r\n').length === 1 + Evaluation.reports.length);
check('report CSV lists criteria statuses + outcome', repCsv.includes('determinism_status') && repCsv.includes('outcome'));
const shCsv = Evaluation.sheetsCsv();
check('sheets CSV: header + one row per execution', shCsv.slice(1).trim().split('\r\n').length === 1 + Evaluation.sheets.length);
check('sheets CSV carries paper fields', ['expected_behavior', 'observed_behavior', 'transition_time_ms', 'recovery_behavior', 'final_outcome'].every((h) => shCsv.includes(h)));
const trCsv = Evaluation.traceCsv();
const trLines = trCsv.slice(1).trim().split('\r\n');
check('trace CSV: header + one row per event', trLines.length === 1 + Evaluation.traceRows.length, trLines.length);
check('trace CSV quoting is balanced', trLines.every((l) => l.split('"').length % 2 === 1));
check('trace CSV holds verbatim dialogue', trCsv.includes('blue-bound novel'));
console.log(`  reports=${Evaluation.reports.length}, sheets=${Evaluation.sheets.length}, trace rows=${Evaluation.traceRows.length}`);

/* ============ D. Spot checks on the oracles' internals ============ */
console.log('\n=== D. Oracle spot checks ===');
const cls = Criteria.classifyUtterance('Try the blue-bound novel on the second shelf — a wonderful story.');
check('utterance classification finds library topic', cls.topics.includes('library'), cls);
const b2 = Evaluation.reports.find((r) => r.scenarioId === 'BOUNDARY_02');
check('BOUNDARY_02 counts only the target NPC\'s requests', b2.outcome === 'PASS'
  && /accepted=2 rejected=1/.test(b2.evidence.find((e) => e.includes('requests:'))), b2.evidence);
const animRep = Evaluation.reports.find((r) => r.injectedFaults.includes('animation_desync'));
check('animation fault detected via the animation channel',
  animRep.issues.some((i) => i.includes('animation') && i.includes('does not match state')), animRep.issues);
check('criteria layer contains no game state names (grep)',
  !/\b(IDLE|GREETING|TALKING|INTERRUPTED|RECOVERING)\b/.test(
    readFileSync(join(BASE, 'criteria.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')));

/* ============ E. Generality: a second SUT through the unchanged oracles ============ */
console.log('\n=== E. Generality check — Gatewatch mini-SUT via QUEST_SPEC ===');
function runGatewatch(sut, exec) {
  Observation.begin({ scenarioId: MINI_SCENARIO.id, targetNPC: 'warden', execution: exec }, sut);
  Observation.record('run_started', { execution: exec, total: 3, category: 'stress', target: 'warden' });
  const say = () => {
    Observation.record('request_sent', { utterance: 'Any quest for a traveller like me?', intent: 'ask_quest' }, 'warden');
    const r = sut.request();
    Observation.record('request_result', { accepted: r.accepted, reason: r.reason || null }, 'warden');
  };
  say();                                        // accepted → HAIL
  sut.advance(350);                             // reply (BRIEFING) at t=300
  Observation.record('interrupt_sent', {}, 'warden');
  const ir = sut.interrupt();
  Observation.record('interrupt_result', { ok: ir.ok, reason: ir.reason }, 'warden');
  say();                                        // immediately → rejected (recovering)
  sut.advance(500);                             // recovery completes at interrupt+400
  say();                                        // accepted again
  sut.advance(1500);                            // briefing completes
  Observation.record('run_finished', { finalObservation: sut.observe() }, 'warden');
  return Observation.end();
}
const gwTraces = [1, 2, 3].map((i) => runGatewatch(createMiniSUT(), i));
const gwResults = Criteria.assess(gwTraces, MINI_SCENARIO, QUEST_SPEC);
const gwOutcome = Evaluation.determineOutcome(gwResults, MINI_SCENARIO);
console.log('  clean Gatewatch:', Object.entries(gwResults).map(([k, v]) => `${k}=${v.status}`).join(' '), '→', gwOutcome);
check('clean Gatewatch passes all four criteria (unchanged oracles, new spec)', gwOutcome === 'PASS',
  Object.fromEntries(Object.entries(gwResults).map(([k, v]) => [k, v.issues])));
check('Gatewatch role consistency uses quest-giver spec',
  gwResults.role_consistency.evidence.some((e) => e.includes('quest-giver')), gwResults.role_consistency.evidence);
const gwStuck = [1, 2, 3].map((i) => runGatewatch(createMiniSUT({ stuck: true }), i));
const gwStuckResults = Criteria.assess(gwStuck, MINI_SCENARIO, QUEST_SPEC);
const gwStuckOutcome = Evaluation.determineOutcome(gwStuckResults, MINI_SCENARIO);
console.log('  stuck Gatewatch:', Object.entries(gwStuckResults).map(([k, v]) => `${k}=${v.status}`).join(' '), '→', gwStuckOutcome);
check('seeded stuck fault in Gatewatch → recovery FAIL, outcome FAIL',
  gwStuckResults.recovery_stability.status === 'FAIL' && gwStuckOutcome === 'FAIL',
  gwStuckResults.recovery_stability.issues);
check('Tinyville spec still active for the main game', Criteria.getGameSpec().name === 'tinyville');

console.log('\n==================================================');
console.log(failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED');
process.exit(failures === 0 ? 0 : 1);

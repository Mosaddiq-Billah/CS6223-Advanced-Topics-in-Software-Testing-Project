/* =============================================================================
 * evaluation.js — EVALUATION OUTCOME DETERMINATION.
 *
 * Aggregates the criteria results of a scenario run into the framework's
 * three-valued outcome (Nendya et al., 2026; proposal §3.5):
 *
 *   PASS    — the scenario satisfies all evaluated behavioural criteria;
 *   PARTIAL — a minor behavioural issue, interaction remains operational;
 *   FAIL    — a significant violation or unrecoverable failure
 *             (any FAIL of a criterion the scenario marks critical).
 *
 * This layer also produces the AUTOMATED OBSERVATION SHEETS — the structured
 * sheet the paper's participants filled in by hand (scenario type, test
 * actions, expected behaviour, observed behaviour, transition time, role
 * consistency, recovery behaviour, final outcome), generated here from the
 * recorded trace — plus three CSV exports:
 *   1. the scenario-level report (criteria statuses, outcome, evidence),
 *   2. the per-execution observation sheets,
 *   3. the full event trace (the raw behavioural evidence).
 * ========================================================================== */
(function (global) {
  'use strict';

  const reports = [];
  const sheets = [];
  const traceRows = [];

  /* ---------------------- outcome determination ---------------------- */
  function determineOutcome(results, scenario) {
    const critical = scenario.criticalCriteria || scenario.criteria;
    const entries = Object.entries(results);
    if (!entries.length) return 'ABORTED';
    if (entries.some(([n, r]) => r.status === 'FAIL' && critical.includes(n))) return 'FAIL';
    if (entries.some(([, r]) => r.status !== 'PASS')) return 'PARTIAL';
    return 'PASS';
  }

  /* ------------------------- trace derivations ------------------------- */
  /* Facts read off a single execution trace for the observation sheet.
   * States are interpreted through the game test specification's semantic
   * state model, never through hard-coded state names. */
  function deriveFacts(trace, npc, sm) {
    const facts = {
      accepted: 0, rejected: 0, completed: 0, interrupted: 0,
      transitionTimes: [],       // engaged → replying (reply transition), ms
      recoveryTimes: [],         // interruption → ready again, ms
      finalState: sm.initial, utterances: 0,
    };
    let greetAt = null, interruptAt = null;
    for (const e of trace) {
      if (e.type === 'npc_state' && e.npc === npc) {
        const { from, to } = e.data;
        if (sm.engaged.includes(to) && !sm.replying.includes(to)) greetAt = e.t;
        if (sm.replying.includes(to) && greetAt !== null) { facts.transitionTimes.push(e.t - greetAt); greetAt = null; }
        if (to === sm.interrupted) { facts.interrupted++; interruptAt = e.t; }
        if (sm.ready.includes(to) && interruptAt !== null) { facts.recoveryTimes.push(e.t - interruptAt); interruptAt = null; }
        if (from === sm.completion.from && to === sm.completion.to) facts.completed++;
        facts.finalState = to;
      } else if (e.type === 'request_result' && e.npc === npc) {
        if (e.data.accepted) facts.accepted++;
        else if (e.data.reason !== 'out_of_range') facts.rejected++;
      } else if (e.type === 'npc_utterance' && e.npc === npc) {
        facts.utterances++;
      }
    }
    const fin = trace.filter((e) => e.type === 'run_finished').pop();
    if (fin && fin.data.finalObservation) facts.finalState = fin.data.finalObservation.state;
    return facts;
  }
  function summariseActions(trace) {
    return trace.filter((e) => e.type === 'action_started')
      .map((e) => e.data.action + (e.data.detail ? '→' + e.data.detail : ''))
      .join('; ');
  }

  /* ----------------------------- reports ----------------------------- */
  function buildReport(runId, scenario, traces, results, info) {
    let outcome = determineOutcome(results, scenario);
    if (info.aborted || info.error) outcome = 'ABORTED';
    const evidence = [], issues = [];
    for (const [name, r] of Object.entries(results)) {
      r.evidence.forEach((e) => evidence.push(`[${name}] ${e}`));
      r.issues.forEach((i) => issues.push(`[${name}] ${i}`));
    }
    if (info.error) issues.push('[runner] ' + info.error);
    const injected = Object.keys(info.faults || {}).filter((k) => info.faults[k]);
    const report = {
      runId, timestamp: new Date().toISOString(),
      scenarioId: scenario.id, scenarioName: scenario.name, category: scenario.category,
      target: scenario.target, executions: traces.length,
      criteriaResults: results, outcome, evidence, issues, injectedFaults: injected,
    };
    reports.push(report);

    // one automated observation sheet per execution
    const sm = ((info && info.spec) || Criteria.getGameSpec()).expectations.stateModel;
    traces.forEach((trace, i) => {
      const f = deriveFacts(trace, scenario.target, sm);
      sheets.push({
        runId, scenarioId: scenario.id, scenarioType: scenario.category,
        targetNPC: scenario.target, execution: i + 1,
        testActions: summariseActions(trace),
        expectedBehavior: scenario.objective,
        observedBehavior: `accepted=${f.accepted}, rejected=${f.rejected}, completed=${f.completed}, ` +
          `interrupted=${f.interrupted}, utterances=${f.utterances}, final state=${f.finalState}`,
        transitionTimeMs: f.transitionTimes.join('; ') || 'n/a',
        roleConsistency: results.role_consistency ? results.role_consistency.status : 'N/A',
        recoveryBehavior: f.interrupted
          ? (f.recoveryTimes.length === f.interrupted
            ? 'recovered in ' + f.recoveryTimes.join('; ') + ' ms'
            : `only ${f.recoveryTimes.length}/${f.interrupted} interruption(s) recovered`)
          : 'no interruption',
        finalOutcome: outcome,
        injectedFaults: injected.join(';'),
      });
    });
    return report;
  }

  /* --------------------------- trace archive --------------------------- */
  function addTrace(runId, scenario, execution, trace, faults) {
    const injected = Object.keys(faults || {}).filter((k) => faults[k]).join(';');
    for (const e of trace) {
      const d = e.data || {};
      let utterance = '', detail = '';
      if (e.type === 'npc_utterance') utterance = d.text;
      else if (e.type === 'request_sent') { utterance = d.utterance; detail = 'intent=' + (d.intent || ''); }
      else if (e.type === 'request_result') detail = d.accepted ? 'accepted' : 'rejected (' + d.reason + ')';
      else if (e.type === 'interrupt_result') detail = d.ok ? 'interrupted' : 'no effect (' + d.reason + ')';
      else if (e.type === 'npc_state') detail = d.from + '→' + d.to;
      else if (e.type === 'move_started') detail = 'to ' + d.to;
      else if (e.type === 'move_finished') detail = (d.arrived ? 'arrived at ' : 'did not reach ') + d.to;
      else if (e.type === 'wait') detail = d.ms + ' ms';
      else if (e.type === 'await_ready') detail = (d.ready ? 'ready' : 'timeout') + ' after ' + d.waitedMs + ' ms';
      else if (e.type === 'observation') detail = 'state=' + d.state;
      else if (e.type === 'action_started') detail = d.action + (d.detail ? '→' + d.detail : '');
      else if (e.type === 'run_finished') detail = 'final state=' + ((d.finalObservation || {}).state || '?');
      const actor = (e.type === 'npc_state' || e.type === 'npc_utterance' || e.type === 'request_result' || e.type === 'interrupt_result')
        ? (e.npc || '') : 'scout';
      traceRows.push([runId, scenario.id, scenario.category, execution, scenario.target,
        e.t, e.seq, e.type, actor, e.npc || '', utterance, detail, injected]);
    }
  }

  /* ------------------------------ CSV export ------------------------------ */
  function csvEscape(v) {
    let s = v === null || v === undefined ? '' : String(v);
    if (/^[=+@]/.test(s)) s = "'" + s;         // neutralise spreadsheet formulas
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function rowsToCsv(rows) {
    // UTF-8 BOM for Excel compatibility
    return '﻿' + rows.map((row) => row.map(csvEscape).join(',')).join('\r\n') + '\r\n';
  }
  function reportsCsv() {
    const head = ['run_id', 'timestamp', 'scenario_id', 'scenario_name', 'category', 'target_npc', 'executions',
      ...Criteria.NAMES.map((n) => n + '_status'), 'outcome', 'injected_faults', 'evidence', 'issues'];
    const rows = reports.map((r) => [
      r.runId, r.timestamp, r.scenarioId, r.scenarioName, r.category, r.target, r.executions,
      ...Criteria.NAMES.map((n) => (r.criteriaResults[n] ? r.criteriaResults[n].status : 'N/A')),
      r.outcome, r.injectedFaults.join(';'), r.evidence.join(' | '), r.issues.join(' | '),
    ]);
    return rowsToCsv([head, ...rows]);
  }
  function sheetsCsv() {
    const head = ['run_id', 'scenario_id', 'scenario_type', 'target_npc', 'execution', 'test_actions',
      'expected_behavior', 'observed_behavior', 'transition_time_ms', 'role_consistency',
      'recovery_behavior', 'final_outcome', 'injected_faults'];
    const rows = sheets.map((s) => [s.runId, s.scenarioId, s.scenarioType, s.targetNPC, s.execution,
      s.testActions, s.expectedBehavior, s.observedBehavior, s.transitionTimeMs, s.roleConsistency,
      s.recoveryBehavior, s.finalOutcome, s.injectedFaults]);
    return rowsToCsv([head, ...rows]);
  }
  function traceCsv() {
    const head = ['run_id', 'scenario_id', 'category', 'execution', 'target_npc', 't_ms', 'seq',
      'event_type', 'actor', 'npc', 'utterance', 'detail', 'injected_faults'];
    return rowsToCsv([head, ...traceRows]);
  }
  function download(filename, text) {
    const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  global.Evaluation = {
    reports, sheets, traceRows,
    determineOutcome, buildReport, addTrace,
    reportsCsv, sheetsCsv, traceCsv,
    downloadReports: () => download('npc_behavior_test_report.csv', reportsCsv()),
    downloadSheets: () => download('npc_observation_sheets.csv', sheetsCsv()),
    downloadTrace: () => download('npc_behavior_trace.csv', traceCsv()),
  };
})(window);

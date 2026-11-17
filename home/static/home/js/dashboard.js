//  * dashboard.js — testing dashboard UI.

(function (global) {
  'use strict';

  function initUI() {
    const $ = (id) => document.getElementById(id);
    if (!$('testPanel')) return;
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const badge = (s) => `<span class="badge ${s}">${s}</span>`;
    const name = (id) => (Town.NPC_PROFILES[id] ? Town.NPC_PROFILES[id].name : String(id || ''));
    const glyph = (id) => (Town.NPC_PROFILES[id] ? Town.NPC_PROFILES[id].glyph : '');
    const place = (k) => (Town.LOCATIONS[k] ? Town.LOCATIONS[k].label : name(k));
    const runButtons = ['btnRunNormal', 'btnRunBoundary', 'btnRunStress', 'btnRunAll', 'btnRunOne'];

    /* ------------- narration: observed events → town-log lines ------------- */
    /* Only what was actually observed is shown; dialogue text comes verbatim
     * from the recorded events. */
    function narrate(ev, meta) {
      const d = ev.data, npc = ev.npc, q = (s) => '“' + esc(s) + '”';
      let line = null;
      switch (ev.type) {
        case 'run_started':
          line = { html: '🤖 <b>Scout</b> starts <b>' + meta.scenarioId + '</b> (' + d.category + ', execution ' + d.execution + '/' + d.total + ') targeting ' + glyph(d.target) + ' ' + name(d.target) + '.', cls: 'think' };
          break;
        case 'move_started': line = { html: '🤖 Scout walks toward ' + esc(place(d.to)) + '.', cls: 'dim' }; break;
        case 'move_finished': line = { html: '🤖 Scout ' + (d.arrived ? 'arrives at ' : 'could not reach ') + esc(place(d.to)) + '.', cls: 'dim' }; break;
        case 'request_sent': line = { html: '<b>🤖 Scout → ' + name(npc) + ':</b> ' + q(d.utterance), cls: 'talk' }; break;
        case 'request_result':
          if (!d.accepted) line = { html: glyph(npc) + ' ' + name(npc) + ' does not take the request (' + esc(d.reason || '') + ').', cls: 'dim' };
          break;
        case 'npc_utterance': line = { html: '<b>' + glyph(npc) + ' ' + name(npc) + ' → Scout:</b> ' + q(d.text), cls: 'talk' }; break;
        case 'interrupt_sent': line = { html: '🤖 Scout interrupts ' + name(npc) + '.', cls: 'warn' }; break;
        case 'interrupt_result':
          if (!d.ok) line = { html: '🤖 Interrupting ' + name(npc) + ' had no effect (' + esc(d.reason || '') + ').', cls: 'dim' };
          break;
        case 'npc_state':
          if (d.to === 'INTERRUPTED') line = { html: glyph(npc) + ' ' + name(npc) + ' is interrupted mid-' + (d.from === 'GREETING' ? 'greeting' : 'conversation') + '.', cls: 'dim' };
          else if (d.to === 'IDLE' && d.from === 'RECOVERING') line = { html: glyph(npc) + ' ' + name(npc) + ' recovers and is ready to interact again.', cls: 'dim' };
          else if (d.to === 'IDLE' && d.from === 'TALKING') line = { html: glyph(npc) + ' ' + name(npc) + ' finishes the conversation and returns to IDLE.', cls: 'dim' };
          break;
        case 'wait': line = { html: '🤖 Scout waits ' + d.ms + ' ms.', cls: 'dim' }; break;
        case 'await_ready': line = { html: '🤖 Scout waited for ' + name(npc) + ' — ' + (d.ready ? 'ready' : 'TIMEOUT') + ' after ' + d.waitedMs + ' ms.', cls: d.ready ? 'dim' : 'warn' }; break;
        case 'observation': line = { html: '🤖 Scout observes ' + name(npc) + ': state=' + esc(d.state) + '.', cls: 'dim' }; break;
        case 'run_finished': line = { html: '🤖 ' + meta.scenarioId + ' execution ' + meta.execution + ' finished — ' + name(npc) + ' final state: ' + esc((d.finalObservation || {}).state || '?') + '.', cls: 'think' }; break;
        default: break;                        // action_started / settled: too noisy
      }
      if (line) Town.logTestEntry(line.html, line.cls);
    }
    Observation.onRecord = narrate;

    /* ------------------------------ rendering ------------------------------ */
    function setRunning(on) {
      runButtons.forEach((b) => { $(b).disabled = on; });
      $('btnStop').disabled = !on;
      ['execCount', 'faultSelect', 'animateToggle', 'scenarioSelect'].forEach((id) => { $(id).disabled = on; });
    }
    function applyConfig() {
      Runner.config.executions = Math.min(10, Math.max(1, parseInt($('execCount').value, 10) || 3));
      Runner.config.pacingMs = $('animateToggle').checked ? 90 : 0;
      TestAgent.config.pacingMs = Runner.config.pacingMs;
      const f = $('faultSelect').value;
      Runner.config.faults = f ? { [f]: true } : {};
    }
    function showCriteria(rep) {
      $('criteriaTable').innerHTML = Criteria.NAMES.map((n) => {
        const r = rep.criteriaResults[n];
        return `<tr><td>${n.replace(/_/g, ' ')}</td><td>${r ? badge(r.status) : '<span class="na">N/A</span>'}</td>` +
          `<td class="ev">${r ? esc(r.issues[0] || r.evidence[0] || '') : 'not applicable to this scenario'}</td></tr>`;
      }).join('');
      $('outcomeBadge').innerHTML = badge(rep.outcome);
    }
    function showLatestSheet(rep) {
      const sheet = Evaluation.sheets.filter((s) => s.runId === rep.runId).pop();
      if (!sheet) return;
      const rows = [
        ['Scenario / type', sheet.scenarioId + ' (' + sheet.scenarioType + '), execution ' + sheet.execution],
        ['Target NPC', name(sheet.targetNPC) + ' — ' + (Town.NPC_PROFILES[sheet.targetNPC] || {}).role],
        ['Test actions', sheet.testActions],
        ['Expected behaviour', sheet.expectedBehavior],
        ['Observed behaviour', sheet.observedBehavior],
        ['Transition time (ms)', sheet.transitionTimeMs],
        ['Role consistency', sheet.roleConsistency],
        ['Recovery behaviour', sheet.recoveryBehavior],
        ['Final outcome', sheet.finalOutcome],
      ];
      $('sheetTable').innerHTML = rows.map(([k, v]) => `<tr><th>${k}</th><td>${esc(v)}</td></tr>`).join('');
    }
    function addReportRow(rep) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${esc(rep.runId)}</td><td>${esc(rep.category)}</td><td>${esc(name(rep.target))}</td><td>${rep.executions}</td>` +
        Criteria.NAMES.map((n) => `<td>${rep.criteriaResults[n] ? badge(rep.criteriaResults[n].status) : '–'}</td>`).join('') +
        `<td>${badge(rep.outcome)}</td><td class="ev">${esc(rep.issues.slice(0, 2).join(' | ') || 'no issues')}</td>`;
      $('reportBody').appendChild(tr);
    }
    function log(msg, cls) {
      const d = document.createElement('div');
      d.className = 'entry ' + (cls || '');
      d.textContent = msg;
      $('testLog').appendChild(d);
      $('testLog').scrollTop = $('testLog').scrollHeight;
    }
    function resetStatus() {
      $('stScenario').textContent = '—'; $('stActivity').textContent = 'idle';
      $('stTarget').textContent = '—'; $('stAction').textContent = '—';
    }

    TestAgent.onActivity = (text, target) => {
      $('stActivity').textContent = text;
      if (target) $('stTarget').textContent = name(target);
      const el = document.getElementById('agent-scout'); if (el) el.title = 'Scout: ' + text;
    };
    Runner.onUpdate = (kind, p) => {
      if (kind === 'batch_started') { setRunning(true); $('outcomeBadge').innerHTML = '<span class="na">running…</span>'; }
      else if (kind === 'batch_finished') { setRunning(false); $('stActivity').textContent = 'idle'; }
      else if (kind === 'scenario') { $('stScenario').textContent = `${p.id} — ${p.name}`; $('stTarget').textContent = name(p.target); }
      else if (kind === 'action') {
        const a = p.a, detail = a.action + (a.target || a.to ? ' → ' + (a.target || a.to) : '') + (a.ms ? ' ' + a.ms + 'ms' : '');
        $('stAction').textContent = `execution ${p.exec}/${p.total} · action ${p.index}/${p.count}: ${detail}`;
      }
      else if (kind === 'report') { showCriteria(p); showLatestSheet(p); addReportRow(p); }
      else if (kind === 'restart') { resetStatus(); $('outcomeBadge').innerHTML = '<span class="na">—</span>'; setRunning(false); log('Town restarted: test state reset.', 'warn'); }
      else if (kind === 'log') log(p.msg, p.cls);
    };

    /* -------------------------------- wiring -------------------------------- */
    const run = (fn) => () => { applyConfig(); fn().catch((e) => log('Cannot start: ' + e.message, 'fail')); };
    $('btnRunNormal').addEventListener('click', run(() => Runner.runCategory('normal')));
    $('btnRunBoundary').addEventListener('click', run(() => Runner.runCategory('boundary')));
    $('btnRunStress').addEventListener('click', run(() => Runner.runCategory('stress')));
    $('btnRunAll').addEventListener('click', run(() => Runner.runAll()));
    $('btnRunOne').addEventListener('click', run(() => Runner.runScenario($('scenarioSelect').value)));
    $('btnStop').addEventListener('click', () => Runner.stop());
    const guard = (listName, fn) => () => {
      if (!Evaluation[listName].length) { log('Nothing to download yet — run a test first.', 'warn'); return; }
      fn();
    };
    $('btnCsvReport').addEventListener('click', guard('reports', () => Evaluation.downloadReports()));
    $('btnCsvSheets').addEventListener('click', guard('sheets', () => Evaluation.downloadSheets()));
    $('btnCsvTrace').addEventListener('click', guard('traceRows', () => Evaluation.downloadTrace()));

    $('faultSelect').innerHTML = '<option value="">none (clean NPCs)</option>' +
      Town.FAULTS.map((f) => `<option value="${f}">${f}</option>`).join('');
    $('scenarioSelect').innerHTML = Scenarios.list
      .map((s) => `<option value="${s.id}">${s.id} — ${esc(s.name)}</option>`).join('');
    document.addEventListener('town:restart', () => Runner.onTownRestart());
    resetStatus(); setRunning(false);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initUI);
  else initUI();
})(window);

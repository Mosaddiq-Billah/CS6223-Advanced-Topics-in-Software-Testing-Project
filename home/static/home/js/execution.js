/* =============================================================================
 * execution.js — SCENARIO EXECUTION.
 *
 * TestAgent ("Scout"): the automated TEST NPC of the proposal. It replaces the
 * human testers of Nendya et al. (2026): it navigates the environment,
 * initiates/ interrupts/ repeats interactions exactly as the scenario
 * prescribes, and reports every tester-side event to the observation layer.
 * It is scenario-agnostic (dispatches on the action's `action` field) and
 * touches the game ONLY through Town's public black-box interface.
 *
 * Runner: executes scenarios — for each scenario, N independent executions
 * from an identical reproducible initial condition (reset world, same seed),
 * each producing one observation trace; the criteria layer then assesses the
 * traces and the evaluation layer determines the Pass/Partial/Fail outcome.
 * Correctness depends only on the virtual clock; `pacingMs` merely slows the
 * on-screen animation for human viewers.
 * ========================================================================== */
(function (global) {
  'use strict';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ------------------------------ Test agent ------------------------------ */
  const TestAgent = {
    id: 'scout',
    config: { pacingMs: 0 },
    activity: 'idle', currentTarget: null, onActivity: null,

    reset() { this.setActivity('idle', null); },
    setActivity(text, target) {
      this.activity = text; this.currentTarget = target || null;
      if (this.onActivity) this.onActivity(text, this.currentTarget);
    },
    async pace() { if (this.config.pacingMs > 0) await sleep(this.config.pacingMs); },

    /** Walk, one grid cell at a time, to a location key or NPC id. */
    async approach(dest) {
      this.setActivity('walking to ' + dest, dest);
      Observation.record('move_started', { to: dest });
      let r = { arrived: false, position: null };
      for (let guard = 0; guard < 200; guard++) {
        r = Town.moveTestAgent(dest);
        if (r.moved) await this.pace();
        if (r.arrived || !r.moved) break;
      }
      Observation.record('move_finished', { to: dest, arrived: r.arrived, position: r.position });
      return r.arrived;
    },

    /** Request an interaction (the SUT's policy decides accept/reject). */
    async say(npc, text, intent) {
      this.setActivity('talking to ' + npc, npc);
      Observation.record('request_sent', { utterance: text, intent: intent || null }, npc);
      const r = Town.requestInteraction(npc, text);
      Observation.record('request_result', { accepted: r.accepted, reason: r.reason || null }, npc);
      await this.pace();
      return r;
    },

    /** Advance virtual time (scheduled NPC transitions fire meanwhile). */
    async wait(ms) {
      this.setActivity('waiting ' + ms + ' ms', this.currentTarget);
      Town.advanceClock(ms);
      Observation.record('wait', { ms });
      await this.pace();
    },

    /** Poll the public observation until the NPC is interaction-ready. */
    async awaitReady(npc, timeoutMs, pollMs) {
      const poll = pollMs || 50, limit = timeoutMs || 2000;
      this.setActivity('waiting for ' + npc + ' to be ready', npc);
      let waited = 0;
      while (!Town.observe(npc).ready && waited < limit) { Town.advanceClock(poll); waited += poll; }
      const ready = Town.observe(npc).ready;
      Observation.record('await_ready', { ready, waitedMs: waited }, npc);
      await this.pace();
      return ready;
    },

    async interrupt(npc) {
      this.setActivity('interrupting ' + npc, npc);
      Observation.record('interrupt_sent', {}, npc);
      const r = Town.interruptInteraction(npc);
      Observation.record('interrupt_result', { ok: r.ok, reason: r.reason }, npc);
      await this.pace();
      return r;
    },

    observe(npc) {
      this.setActivity('observing ' + npc, npc);
      const obs = Town.observe(npc);
      Observation.record('observation', obs, npc);
      return obs;
    },

    /** Execute one scenario action (data → behaviour). */
    async execute(a) {
      switch (a.action) {
        case 'approach': return this.approach(a.target);
        case 'say': return this.say(a.to, a.text, a.intent);
        case 'wait': return this.wait(a.ms);
        case 'await_ready': return this.awaitReady(a.target, a.timeoutMs, a.pollMs);
        case 'interrupt': return this.interrupt(a.target);
        case 'observe': return this.observe(a.target);
        default: throw new Error('Unknown test-agent action: ' + a.action);
      }
    },
  };

  /* -------------------------------- Runner -------------------------------- */
  const Runner = {
    config: { executions: 3, settleMs: 1000, pacingMs: 0, faults: {}, seed: 20260101 },
    running: false, stopRequested: false, runCounter: 0, onUpdate: null,

    runScenario(id) { return this._batch([Scenarios.byId(id)]); },
    runCategory(cat) { return this._batch(Scenarios.byCategory(cat)); },
    runAll() { return this._batch(Scenarios.list.slice()); },
    stop() { this.stopRequested = true; this._log('Stop requested…', 'warn'); },

    async _batch(scenarios) {
      if (this.running) throw new Error('A test run is already in progress');
      if (!scenarios.length || scenarios.some((s) => !s)) throw new Error('No scenarios to run');
      this.running = true; this.stopRequested = false;
      this._notify('batch_started');
      const produced = [];
      try {
        Town.enterTestMode();
        Town.injectFaults(this.config.faults);
        for (const sc of scenarios) {
          if (this.stopRequested) break;
          const rep = await this._runScenario(sc);
          produced.push(rep);
          this._notify('report', rep);
        }
      } catch (err) {
        this._log('Batch error: ' + err.message, 'fail');
      } finally {
        Observation.end();                     // defensive: never leave a trace open
        Town.exitTestMode();                   // always restore the ambient town
        TestAgent.reset();
        this.running = false;
        this._notify('batch_finished');
      }
      return produced;
    },

    async _runScenario(sc) {
      const runId = 'RUN-' + String(++this.runCounter).padStart(3, '0') + '-' + sc.id;
      const n = Math.max(1, this.config.executions | 0);
      this._log(`▶ ${runId} “${sc.name}” (${sc.category}, target ${sc.target}) — ${n} execution(s)`, 'head');
      this._notify('scenario', sc);
      Town.seedRandom(this.config.seed);       // reproducible randomness per scenario run
      const traces = [];
      let aborted = false, error = null;
      try {
        for (let i = 1; i <= n; i++) {
          if (this.stopRequested) { aborted = true; break; }
          const trace = await this._execute(sc, i, n);
          traces.push(trace);
          Evaluation.addTrace(runId, sc, i, trace, this.config.faults);
        }
      } catch (e) {
        aborted = true; error = e.message;
        this._log(`✖ ${sc.id} aborted: ${e.message}`, 'fail');
      }
      let results = {};
      if (traces.length && !error) {
        try { results = Criteria.assess(traces, sc); }
        catch (e) { error = 'criteria error: ' + e.message; }
      }
      const rep = Evaluation.buildReport(runId, sc, traces, results, { aborted, error, faults: this.config.faults });
      this._log(`■ ${runId}: ${rep.outcome}` + (rep.issues.length ? ` — ${rep.issues.length} issue(s)` : ''),
        rep.outcome === 'PASS' ? 'pass' : rep.outcome === 'PARTIAL' ? 'warn' : 'fail');
      return rep;
    },

    /** One execution from the reproducible initial condition. */
    async _execute(sc, exec, total) {
      Town.resetTestWorld(sc.initial);
      TestAgent.reset();
      Observation.begin({ scenarioId: sc.id, targetNPC: sc.target, execution: exec });
      try {
        Observation.record('run_started', { execution: exec, total, category: sc.category, target: sc.target });
        const actions = Scenarios.expand(sc.actions);
        for (let i = 0; i < actions.length; i++) {
          if (this.stopRequested) throw new Error('stopped by user');
          if (!Town.isTestMode()) throw new Error('test mode ended (town was restarted)');
          const a = actions[i];
          this._notify('action', { exec, total, index: i + 1, count: actions.length, a });
          Observation.record('action_started', { index: i + 1, action: a.action, detail: a.target || a.to || '' });
          await TestAgent.execute(a);
          await sleep(0);                      // keep the UI responsive / allow Stop
        }
        Town.advanceClock(this.config.settleMs);   // let pending transitions finish
        Observation.record('settled', { ms: this.config.settleMs });
        Observation.record('run_finished', { finalObservation: Town.observe(sc.target) }, sc.target);
      } catch (e) {
        Observation.end();
        throw e;
      }
      const trace = Observation.end();
      this._log(`  execution ${exec}/${total}: ${trace.length} events recorded`, 'dim');
      return trace;
    },

    /** Called when the town is restarted: abort any run, clear UI state. */
    onTownRestart() {
      if (this.running) this.stop();
      TestAgent.reset();
      this._notify('restart');
    },

    _notify(kind, payload) { if (this.onUpdate) this.onUpdate(kind, payload); },
    _log(msg, cls) { if (this.onUpdate) this.onUpdate('log', { msg, cls }); },
  };

  global.TestAgent = TestAgent;
  global.Runner = Runner;
})(window);

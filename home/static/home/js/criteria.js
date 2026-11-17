//  * criteria.js — BEHAVIOR QUALITY CRITERIA LAYER.

(function (global) {
  'use strict';

  /* --------------------- game test specification handling --------------------- */
  let activeSpec = null;
  function setGameSpec(spec) { activeSpec = spec; }
  function getGameSpec() { return activeSpec; }
  function specOf(spec) {
    const s = spec || activeSpec;
    if (!s) throw new Error('No game test specification configured (Criteria.setGameSpec)');
    return s;
  }
  /** Scenario expectations override the spec's defaults (shallow per section). */
  function expectationsOf(scenario, s) {
    const base = s.expectations, o = scenario.expectations || {};
    const e = Object.assign({}, base, o);
    e.maxDwellMs = Object.assign({}, base.maxDwellMs, o.maxDwellMs);
    e.stateModel = Object.assign({}, base.stateModel, o.stateModel);
    return e;
  }

  /* ------------------------------- helpers ------------------------------- */
  const RANK = { PASS: 0, PARTIAL: 1, FAIL: 2 };
  const worse = (a, b) => (RANK[b] > RANK[a] ? b : a);
  const newResult = () => ({ status: 'PASS', evidence: [], issues: [] });
  function flag(res, severity, msg) {
    res.status = worse(res.status, severity);
    res.issues.push(severity + ': ' + msg);
  }
  const stateChangesOf = (trace, npc) => trace.filter((e) => e.type === 'npc_state' && e.npc === npc);
  const traceEnd = (trace) => (trace.length ? trace[trace.length - 1].t : 0);

  /** Semantic classification of an utterance against the spec's topic and
   *  conversational-act lexicons (explainable, keyword-based — no LLM). */
  function classifyUtterance(text, spec) {
    const s = specOf(spec);
    const topics = Object.keys(s.topics).filter((k) => s.topics[k].test(text));
    const acts = Object.keys(s.acts).filter((k) => s.acts[k].test(text));
    return { topics, acts, signature: (topics.sort().join('+') || 'none') + '|' + (acts.sort().join('+') || 'none') };
  }

  /* ======================= 1. STATE INTEGRITY ======================= */
  /* "Whether the NPC maintains valid behavioural states throughout the
   * interaction sequence": legal and continuous transitions, correct request
   * handling under the overlap policy, bounded response latency, bounded dwell
   * times (⇒ stuck detection), animation–state coherence, every accepted
   * interaction concluded, a valid final state, and the scenario's expected
   * interaction counts. */
  function stateIntegrity(trace, scenario, spec) {
    const s = specOf(spec), exp = expectationsOf(scenario, s), sm = exp.stateModel;
    const res = newResult(), npc = scenario.target;
    const known = new Set(Object.keys(sm.transitions));
    Object.values(sm.transitions).forEach((l) => l.forEach((x) => known.add(x)));

    // (1) transition legality & continuity; (1b) animation–state coherence
    const changes = stateChangesOf(trace, npc);
    let prev = sm.initial, invalid = 0, animChecked = 0, animBad = 0;
    for (const c of changes) {
      const { from, to, animation } = c.data;
      if (!known.has(from) || !known.has(to)) { flag(res, 'FAIL', `unknown state in transition ${from}→${to} at t=${c.t}`); invalid++; }
      else if (from !== prev) { flag(res, 'FAIL', `discontinuous state: expected from=${prev}, saw ${from} at t=${c.t}`); invalid++; }
      else if (!(sm.transitions[from] || []).includes(to)) { flag(res, 'FAIL', `invalid transition ${from}→${to} at t=${c.t}`); invalid++; }
      if (animation !== undefined && sm.animations && sm.animations[to]) {
        animChecked++;
        if (animation !== sm.animations[to]) {
          animBad++;
          flag(res, 'FAIL', `animation '${animation}' does not match state ${to} (expected '${sm.animations[to]}') at t=${c.t}`);
        }
      }
      prev = to;
    }
    res.evidence.push(`${changes.length} state transition(s) observed, ${invalid} invalid`);
    if (animChecked) res.evidence.push(`animation labels checked against states: ${animChecked}, ${animBad} inconsistent`);

    // (2) request handling, response latency, completion — for the TARGET NPC only
    let state = sm.initial;
    let pending = null;                      // request in flight: {stateAt, t, replied}
    let open = null;                         // accepted interaction in progress
    let accepted = 0, rejected = 0, completed = 0, interrupted = 0;
    const latencies = [];
    for (const e of trace) {
      if (e.type === 'npc_state' && e.npc === npc) {
        if (e.data.from === sm.completion.from && e.data.to === sm.completion.to) {
          completed++;
          if (open && !open.replied) flag(res, 'FAIL', `interaction accepted at t=${open.t} completed without any reply`);
          open = null;
        }
        if (e.data.to === sm.interrupted) { interrupted++; open = null; }
        state = e.data.to;
      } else if (e.type === 'npc_utterance' && e.npc === npc && sm.replying.includes(state)
                 && ((open && !open.replied) || (pending && !pending.replied))) {
        // a substantive reply to the accepted interaction — which may arrive
        // while the acceptance itself is still being recorded (in-flight request)
        const target = open || pending;
        target.replied = true;
        const lat = e.t - target.t;
        latencies.push(lat);
        if (lat > 2 * exp.maxResponseMs) flag(res, 'FAIL', `reply took ${lat} ms (limit ${exp.maxResponseMs})`);
        else if (lat > exp.maxResponseMs) flag(res, 'PARTIAL', `reply took ${lat} ms (limit ${exp.maxResponseMs})`);
      } else if (e.type === 'request_sent' && e.npc === npc) {
        pending = { stateAt: state, t: e.t, replied: false };
      } else if (e.type === 'request_result' && e.npc === npc && pending) {
        const d = e.data;
        if (d.accepted) {
          accepted++;
          if (!sm.ready.includes(pending.stateAt) && exp.overlapPolicy === 'reject')
            flag(res, 'FAIL', `request accepted while NPC was ${pending.stateAt} (policy=reject) at t=${e.t}`);
          if (state === pending.stateAt) flag(res, 'FAIL', `request accepted but no state change observed at t=${e.t}`);
          open = { t: pending.t, replied: pending.replied };
        } else if (d.reason !== 'out_of_range') {
          rejected++;
          if (sm.ready.includes(pending.stateAt)) flag(res, 'FAIL', `interaction-ready NPC rejected a request (reason=${d.reason}) at t=${e.t}`);
          if (state !== pending.stateAt) flag(res, 'FAIL', `rejected request changed NPC state ${pending.stateAt}→${state} at t=${e.t}`);
        }
        pending = null;
      } else if (e.type === 'observation' && e.npc === npc
                 && e.data.animation !== undefined && sm.animations && sm.animations[e.data.state]) {
        if (e.data.animation !== sm.animations[e.data.state])
          flag(res, 'FAIL', `observed animation '${e.data.animation}' does not match state ${e.data.state} at t=${e.t}`);
      }
    }
    res.evidence.push(`requests: accepted=${accepted} rejected=${rejected}; completed=${completed}; interrupted=${interrupted}`);
    if (latencies.length) res.evidence.push(`reply latency (ms): ${latencies.join(', ')} (limit ${exp.maxResponseMs})`);

    // (3) no accepted interaction may simply evaporate
    const unfinished = accepted - completed - interrupted;
    if (unfinished > 0) flag(res, 'FAIL', `${unfinished} accepted interaction(s) neither completed nor were interrupted`);

    // (4) dwell times, including the final open interval ⇒ stuck detection
    const tEnd = traceEnd(trace);
    const spans = [];
    let lastState = sm.initial, lastT = 0;
    for (const c of changes) { spans.push([lastState, lastT, c.t]); lastState = c.data.to; lastT = c.t; }
    spans.push([lastState, lastT, tEnd]);
    for (const [st, a, b] of spans) {
      const max = exp.maxDwellMs[st];
      if (!max) continue;
      const dwell = b - a;
      if (dwell > 2 * max) flag(res, 'FAIL', `stuck in ${st} for ${dwell} ms (limit ${max})`);
      else if (dwell > max) flag(res, 'PARTIAL', `${st} lasted ${dwell} ms (limit ${max})`);
    }

    // (5) final state, and agreement between public observation and event stream
    const fin = trace.filter((e) => e.type === 'run_finished').pop();
    const finalObs = fin && fin.data.finalObservation;
    const finalState = finalObs ? finalObs.state : prev;
    res.evidence.push(`final observable state: ${finalState}`);
    if (!exp.finalStates.includes(finalState)) flag(res, 'FAIL', `NPC ended in ${finalState}, expected one of ${exp.finalStates.join('/')}`);
    if (finalObs && finalObs.state !== prev) flag(res, 'FAIL', `public observation (${finalObs.state}) disagrees with event stream (${prev})`);
    if (finalObs && finalObs.animation !== undefined && sm.animations && sm.animations[finalObs.state]
        && finalObs.animation !== sm.animations[finalObs.state])
      flag(res, 'FAIL', `final animation '${finalObs.animation}' does not match state ${finalObs.state}`);

    // (6) scenario-level expected interaction counts
    if (exp.counts) {
      const got = { accepted, rejected, completed, interrupted };
      for (const k of Object.keys(exp.counts)) {
        if (got[k] !== exp.counts[k]) flag(res, 'FAIL', `expected ${k}=${exp.counts[k]}, observed ${got[k]}`);
      }
    }
    return res;
  }

  /* ======================= 2. ROLE CONSISTENCY ======================= */
  /* "Whether observed behaviour remains consistent with the role
   * specification." Three explainable rules per target-NPC utterance, against
   * the spec's role declaration for that NPC:
   *   R1  foreign topic : the text uses another role's domain vocabulary → FAIL
   *   R2  own topic     : a reply (in a replying state) to a role-relevant
   *                       intent must use the NPC's own domain vocabulary → FAIL
   *   R3  conversational act: the text realises at least one act from the
   *                       spec's act lexicon                             → PARTIAL
   */
  function roleConsistency(trace, scenario, spec) {
    const s = specOf(spec), exp = expectationsOf(scenario, s), sm = exp.stateModel;
    const res = newResult(), npc = scenario.target;
    const role = s.roles[npc];
    if (!role) { res.evidence.push(`no role specification for ${npc}`); return res; }
    let state = sm.initial, lastIntent = null, n = 0, consistent = 0;
    for (const e of trace) {
      if (e.type === 'npc_state' && e.npc === npc) state = e.data.to;
      else if (e.type === 'request_sent' && e.npc === npc) lastIntent = e.data.intent || null;
      else if (e.type === 'npc_utterance' && e.npc === npc) {
        n++;
        const text = e.data.text, c = classifyUtterance(text, s);
        let ok = true;
        if (role.foreignTopic.test(text)) { flag(res, 'FAIL', `off-role content (foreign domain) at t=${e.t}: "${text}"`); ok = false; }
        if (sm.replying.includes(state) && role.roleIntents.includes(lastIntent) && !role.ownTopic.test(text)) {
          flag(res, 'FAIL', `reply to role-relevant intent "${lastIntent}" is not about the ${role.role}'s domain at t=${e.t}: "${text}"`); ok = false;
        }
        if (!c.acts.length) { flag(res, 'PARTIAL', `no recognisable conversational act at t=${e.t}: "${text}"`); ok = false; }
        if (ok) consistent++;
      }
    }
    res.evidence.push(`${n} utterance(s) evaluated, ${consistent} role-consistent (role spec: ${npc} = ${role.role})`);
    if (n === 0) flag(res, 'PARTIAL', 'no NPC utterances observed to evaluate');
    return res;
  }

  /* ======================= 3. RECOVERY STABILITY ======================= */
  /* "Whether the NPC can return to an appropriate valid state following an
   * interruption or abnormal interaction sequence." Anchored directly on
   * every observed entry into the spec's interrupted state — covering
   * explicit test-agent interrupts AND abandonment by walking away. */
  function recoveryStability(trace, scenario, spec) {
    const s = specOf(spec), exp = expectationsOf(scenario, s), sm = exp.stateModel;
    const res = newResult(), npc = scenario.target;
    const changes = stateChangesOf(trace, npc);
    const interruptions = [];
    changes.forEach((c, i) => { if (c.data.to === sm.interrupted) interruptions.push({ idx: i, t: c.t, seq: c.seq }); });
    if (!interruptions.length) {
      res.evidence.push('no interruption observed in this scenario (nothing to recover from)');
      return res;
    }
    const fin = trace.filter((e) => e.type === 'run_finished').pop();
    const finalObs = fin && fin.data.finalObservation;
    const recoveryTimes = [];

    interruptions.forEach((it, k) => {
      const label = `interruption #${k + 1} (t=${it.t})`;
      // follow the state path until the NPC is interaction-ready again
      const path = [sm.interrupted];
      let idle = null;
      for (const c of changes.slice(it.idx + 1)) {
        path.push(c.data.to);
        if (sm.ready.includes(c.data.to)) { idle = c; break; }
        if (sm.engaged.includes(c.data.to)) break;            // resumed without recovering
        if (c.data.to === sm.interrupted) break;              // next interruption reached
      }
      if (!idle) { flag(res, 'FAIL', `${label}: NPC never returned to an interaction-ready state (path ${path.join('→')})`); return; }
      if (path.join('→') !== sm.recoveryPath.join('→'))
        flag(res, 'FAIL', `${label}: unexpected recovery path ${path.join('→')} (expected ${sm.recoveryPath.join('→')})`);
      const ms = idle.t - it.t;
      recoveryTimes.push(ms);
      if (ms > 2 * exp.maxRecoveryMs) flag(res, 'FAIL', `${label}: recovery took ${ms} ms (limit ${exp.maxRecoveryMs})`);
      else if (ms > exp.maxRecoveryMs) flag(res, 'PARTIAL', `${label}: recovery took ${ms} ms (limit ${exp.maxRecoveryMs})`);

      // can a NEW interaction actually start after this recovery?
      const next = trace.find((e) => e.seq > idle.seq && e.type === 'request_result' && e.npc === npc && e.data.reason !== 'out_of_range');
      if (next) {
        if (!next.data.accepted) flag(res, 'FAIL', `${label}: NPC rejected a new request after recovery (reason=${next.data.reason})`);
      } else if (k === interruptions.length - 1) {
        if (finalObs && !finalObs.ready) flag(res, 'FAIL', `${label}: NPC not interaction-ready at the end of the scenario`);
        else if (exp.requireReinitiationAfterRecovery) flag(res, 'PARTIAL', `${label}: re-initiation after recovery was not exercised`);
      }
    });
    res.evidence.push(`${interruptions.length} interruption(s); recovery times (ms): ${recoveryTimes.join(', ') || 'n/a'} (limit ${exp.maxRecoveryMs})`);
    return res;
  }

  /* ========================== 4. DETERMINISM ========================== */
  /* "Execute the same scenario multiple times and compare the resulting
   * behavioural traces." Traces are NORMALISED first: the state/outcome
   * sequence must match exactly; replies are compared by semantic signature
   * (topics + conversational acts from the spec's lexicons), not by exact
   * wording; timestamps must agree within the configured tolerance. */
  function normalise(trace, s) {
    const keep = ['npc_state', 'request_result', 'interrupt_result', 'npc_utterance'];
    return trace.filter((e) => keep.includes(e.type)).map((e) => {
      const d = e.data;
      let sig, kind = 'struct';
      if (e.type === 'npc_state') sig = `S:${e.npc}:${d.from}>${d.to}`;
      else if (e.type === 'request_result') sig = `R:${e.npc}:${d.accepted ? 'ok' : 'rej:' + d.reason}`;
      else if (e.type === 'interrupt_result') sig = `I:${e.npc}:${d.ok ? 'ok' : 'no:' + d.reason}`;
      else { sig = `U:${e.npc}:${classifyUtterance(d.text, s).signature}`; kind = 'utter'; }
      return { sig, kind, t: e.t };
    });
  }
  function determinism(traces, scenario, spec) {
    const s = specOf(spec), exp = expectationsOf(scenario, s), res = newResult();
    if (traces.length < 2) { res.evidence.push('single execution — determinism not evaluated'); return res; }
    const norm = traces.map((tr) => normalise(tr, s)), base = norm[0];
    const structOf = (n) => n.filter((x) => x.kind === 'struct').map((x) => x.sig).join(',');
    const uttersOf = (n) => n.filter((x) => x.kind === 'utter').map((x) => x.sig);
    let identical = 0;
    for (let r = 1; r < norm.length; r++) {
      const n = norm[r];
      if (structOf(n) !== structOf(base)) {
        const a = base.filter((x) => x.kind === 'struct'), b = n.filter((x) => x.kind === 'struct');
        let i = 0; while (i < a.length && i < b.length && a[i].sig === b[i].sig) i++;
        flag(res, 'FAIL', `run ${r + 1} diverges from run 1 in the state/outcome sequence at event ${i} (${(a[i] || {}).sig || 'end'} vs ${(b[i] || {}).sig || 'end'})`);
        continue;
      }
      const ua = uttersOf(base), ub = uttersOf(n);
      if (ua.join('/') !== ub.join('/')) {
        const i = ua.findIndex((x, j) => x !== ub[j]);
        flag(res, exp.replyMismatchSeverity, `run ${r + 1}: reply #${i + 1} differs semantically from run 1 (${ua[i]} vs ${ub[i]})`);
        continue;
      }
      const drift = Math.max(0, ...n.map((x, j) => Math.abs(x.t - base[j].t)));
      if (drift > exp.timingToleranceMs) { flag(res, 'PARTIAL', `run ${r + 1}: timing drift ${drift} ms (tolerance ${exp.timingToleranceMs})`); continue; }
      identical++;
    }
    res.evidence.push(`${traces.length} executions compared; ${identical + 1} behaviourally identical to run 1`);
    return res;
  }

  /* -------------------------- assessment entry point -------------------------- */
  const PER_TRACE = { state_integrity: stateIntegrity, role_consistency: roleConsistency, recovery_stability: recoveryStability };

  /** Run the scenario's applicable criteria over all execution traces, under
   *  the given (or the installed) game test specification. Per-trace criteria
   *  are merged: worst status wins; identical issues from several runs are
   *  reported once, tagged with the runs they occurred in. */
  function assess(traces, scenario, spec) {
    const s = specOf(spec);
    const out = {};
    for (const name of scenario.criteria) {
      if (name === 'determinism') { out[name] = determinism(traces, scenario, s); continue; }
      const fn = PER_TRACE[name];
      if (!fn) throw new Error('Unknown criterion: ' + name);
      const merged = newResult(), issueRuns = new Map();
      traces.forEach((tr, i) => {
        const r = fn(tr, scenario, s);
        merged.status = worse(merged.status, r.status);
        if (i === 0) merged.evidence.push(...r.evidence);
        r.issues.forEach((m) => { if (!issueRuns.has(m)) issueRuns.set(m, new Set()); issueRuns.get(m).add(i + 1); });
      });
      issueRuns.forEach((runs, m) => merged.issues.push(`${m} [runs ${[...runs].join(',')}]`));
      out[name] = merged;
    }
    return out;
  }

  global.Criteria = {
    NAMES: ['determinism', 'state_integrity', 'role_consistency', 'recovery_stability'],
    setGameSpec, getGameSpec,
    classifyUtterance, determinism, stateIntegrity, roleConsistency, recoveryStability, assess,
  };
})(window);

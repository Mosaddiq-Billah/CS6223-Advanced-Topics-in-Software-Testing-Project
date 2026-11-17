//  * observation.js — BEHAVIOR OBSERVATION LAYER.

(function (global) {
  'use strict';
  let events = [], meta = null, unsubscribe = null, seq = 0, active = false, sut = null;

  const Observation = {
    onRecord: null,

    /** begin({scenarioId, targetNPC, execution}, sut?) — starts a fresh trace
     *  and subscribes to the SUT's public event stream. The SUT handle needs
     *  only {now(), onEvent(cb)}; it defaults to the global Town, but any
     *  game exposing that interface can be observed (see tools/minisut.mjs). */
    begin(m, sutArg) {
      this.end();
      sut = sutArg || global.Town;
      meta = { scenarioId: m.scenarioId, targetNPC: m.targetNPC, execution: m.execution };
      events = []; seq = 0; active = true;
      unsubscribe = sut.onEvent((ev) => Observation.record(ev.type, ev.data, ev.npc, ev.t));
    },

    /** record(type, data, npc?, t?) — appends one event to the current trace. */
    record(type, data, npc, t) {
      if (!active) return null;
      const ev = {
        seq: seq++, scenarioId: meta.scenarioId, execution: meta.execution,
        t: t === undefined ? sut.now() : t,
        type, npc: npc || null,
        data: data ? JSON.parse(JSON.stringify(data)) : {},
      };
      events.push(ev);
      if (Observation.onRecord) { try { Observation.onRecord(ev, meta); } catch (e) { console.error(e); } }
      return ev;
    },

    /** end() — stops recording and returns the finished trace. */
    end() {
      if (unsubscribe) { unsubscribe(); unsubscribe = null; }
      const out = events;
      events = []; active = false; meta = null; sut = null;
      return out;
    },

    isRecording: () => active,
  };
  global.Observation = Observation;
})(window);

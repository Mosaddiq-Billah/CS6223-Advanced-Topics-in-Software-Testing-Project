// =============================================================================
// minisut.mjs — "Gatewatch": a second, miniature system under test.
//
// Purpose: demonstrate that the oracle layer (criteria.js) is NOT overfit to
// Tinyville. Gatewatch is a structurally different game: one quest-giver NPC
// ("warden") with DIFFERENT state names (AVAILABLE/HAIL/BRIEFING/STARTLED/
// COMPOSING), a DIFFERENT timing profile, DIFFERENT animation labels, and a
// DIFFERENT role domain (quests, not shopkeeping). The unchanged oracles
// evaluate it through its own game test specification (QUEST_SPEC below) —
// porting the framework means writing a spec, not editing oracle code.
//
// The SUT exposes the same minimal observable interface shape as Tinyville's
// Town: now(), onEvent(cb), request(), interrupt(), advance(), observe().
// =============================================================================

export function createMiniSUT(opts = {}) {
  const stuck = !!opts.stuck;                 // seeded fault: never recovers
  const ANIM = { AVAILABLE: 'stand', HAIL: 'salute', BRIEFING: 'point', STARTLED: 'flinch', COMPOSING: 'pace' };
  let clock = 0, state = 'AVAILABLE', last = null, lastAt = null, order = 0;
  let queue = [];
  const listeners = new Set();

  const emit = (type, data) => listeners.forEach((cb) => cb({ t: clock, type, npc: 'warden', data }));
  const setState = (to) => {
    const from = state; state = to;
    emit('npc_state', { from, to, animation: ANIM[to] });
  };
  const speak = (text) => { last = text; lastAt = clock; emit('npc_utterance', { text }); };
  const schedule = (d, fn) => queue.push({ at: clock + d, order: ++order, fn });

  function advance(ms) {
    const target = clock + ms;
    for (;;) {
      queue.sort((a, b) => a.at - b.at || a.order - b.order);
      if (!queue.length || queue[0].at > target) break;
      const next = queue.shift();
      clock = Math.max(clock, next.at);
      next.fn();
    }
    clock = target;
    return clock;
  }
  function request() {
    if (state !== 'AVAILABLE') {
      const reason = (state === 'STARTLED' || state === 'COMPOSING') ? 'recovering' : 'busy';
      return { accepted: false, reason, t: clock };
    }
    setState('HAIL');
    speak('Halt, traveller! State your business with the watch.');
    schedule(300, () => { setState('BRIEFING'); speak('A bounty is posted: clear the old mill of rats; the reward is ten silver.'); });
    schedule(700, () => setState('AVAILABLE'));
    return { accepted: true, t: clock };
  }
  function interrupt() {
    if (state !== 'HAIL' && state !== 'BRIEFING') return { ok: false, reason: 'not_interacting', t: clock };
    queue = [];
    setState('STARTLED');
    if (!stuck) {
      schedule(100, () => setState('COMPOSING'));
      schedule(400, () => setState('AVAILABLE'));
    }
    return { ok: true, reason: 'test_interrupt', t: clock };
  }
  const observe = () => ({
    npc: 'warden', t: clock, state, animation: ANIM[state], ready: state === 'AVAILABLE',
    lastUtterance: last, lastUtteranceAt: lastAt, position: { x: 0, y: 0 }, location: 'gate',
  });

  return {
    now: () => clock,
    onEvent: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    advance, request, interrupt, observe,
  };
}

/* The Gatewatch game test specification: same schema as TinyvilleSpec, with
 * this game's own state roles, thresholds, animations, and role lexicons. */
export const QUEST_SPEC = {
  name: 'gatewatch',
  expectations: {
    stateModel: {
      initial: 'AVAILABLE',
      ready: ['AVAILABLE'],
      engaged: ['HAIL', 'BRIEFING'],
      replying: ['BRIEFING'],
      interrupted: 'STARTLED',
      recoveryPath: ['STARTLED', 'COMPOSING', 'AVAILABLE'],
      completion: { from: 'BRIEFING', to: 'AVAILABLE' },
      transitions: {
        AVAILABLE: ['HAIL'],
        HAIL: ['BRIEFING', 'STARTLED'],
        BRIEFING: ['AVAILABLE', 'STARTLED'],
        STARTLED: ['COMPOSING'],
        COMPOSING: ['AVAILABLE'],
      },
      animations: { AVAILABLE: 'stand', HAIL: 'salute', BRIEFING: 'point', STARTLED: 'flinch', COMPOSING: 'pace' },
    },
    finalStates: ['AVAILABLE'],
    overlapPolicy: 'reject',
    maxResponseMs: 600,
    maxDwellMs: { HAIL: 700, BRIEFING: 900, STARTLED: 250, COMPOSING: 600 },
    maxRecoveryMs: 500,
    counts: null,
    requireReinitiationAfterRecovery: false,
    timingToleranceMs: 0,
    replyMismatchSeverity: 'PARTIAL',
  },
  roles: {
    warden: {
      role: 'quest-giver',
      ownTopic: /\b(quest\w*|bount\w+|reward\w*|task\w*|watch|patrol\w*|silver|rats?|mill)\b/i,
      foreignTopic: /\b(bread|loaf|loaves|oven|coins?)\b/i,
      roleIntents: ['ask_quest'],
    },
  },
  topics: {
    questing: /\b(quest\w*|bount\w+|reward\w*|task\w*|watch|patrol\w*|silver|rats?|mill)\b/i,
  },
  acts: {
    greeting: /\b(halt|greetings|hail|well met)\b/i,
    inform: /\b(posted|bounty|reward|is ten)\b/i,
    deflection: /\b(sorry|cannot|can'?t|not now)\b/i,
  },
};

/* A stress scenario for Gatewatch, in the same scenario schema. */
export const MINI_SCENARIO = {
  id: 'GATE_STRESS_01',
  name: 'Interrupt the warden mid-briefing and return',
  category: 'stress',
  target: 'warden',
  objective: 'After an interruption the warden recovers to AVAILABLE within the recovery limit; an immediate re-request during recovery is rejected; a final full briefing completes.',
  actions: [],   // driven directly by the harness (no grid world in Gatewatch)
  expectations: { counts: { accepted: 2, rejected: 1, completed: 1, interrupted: 1 } },
  criteria: ['determinism', 'state_integrity', 'role_consistency', 'recovery_stability'],
  criticalCriteria: ['determinism', 'state_integrity', 'role_consistency', 'recovery_stability'],
};

//  * scenarios.js — SCENARIO DEFINITION LAYER.

(function (global) {
  'use strict';

  const BUY = { to: 'sana', text: 'Hello! I would like to buy a loaf of bread, please.', intent: 'purchase_item' };
  const ASK_WAY = { to: 'theo', text: 'Excuse me — which way is it to the library?', intent: 'ask_directions' };
  const ASK_BOOK = { to: 'ivy', text: 'Could you recommend a good book or story to read?', intent: 'ask_book' };

  const list = [
    /* ------------------------------- NORMAL ------------------------------- */
    {
      id: 'NORMAL_01', name: 'Customer buys bread from the shopkeeper', category: 'normal', target: 'sana',
      objective: 'Sana accepts a role-relevant purchase request, greets, replies on topic within the time limit, and the interaction completes back to IDLE.',
      initial: {},
      actions: [
        { action: 'approach', target: 'market' },
        { action: 'say', ...BUY },
        { action: 'wait', ms: 1000 },
        { action: 'observe', target: 'sana' },
      ],
      expectations: { counts: { accepted: 1, rejected: 0, completed: 1, interrupted: 0 } },
      criteria: ['determinism', 'state_integrity', 'role_consistency'],
      criticalCriteria: ['determinism', 'state_integrity', 'role_consistency'],
    },
    {
      id: 'NORMAL_02', name: 'Visitor asks the guide for directions', category: 'normal', target: 'theo',
      objective: 'Theo accepts a role-relevant directions request, greets, answers with directions within the time limit, and returns to IDLE.',
      initial: {},
      actions: [
        { action: 'approach', target: 'square' },
        { action: 'say', ...ASK_WAY },
        { action: 'wait', ms: 1000 },
        { action: 'observe', target: 'theo' },
      ],
      expectations: { counts: { accepted: 1, rejected: 0, completed: 1, interrupted: 0 } },
      criteria: ['determinism', 'state_integrity', 'role_consistency'],
      criticalCriteria: ['determinism', 'state_integrity', 'role_consistency'],
    },

    /* ------------------------------ BOUNDARY ------------------------------ */
    {
      id: 'BOUNDARY_01', name: 'Rapid repeated requests (reject policy)', category: 'boundary', target: 'sana',
      objective: 'Overlapping requests 10 ms apart are each rejected without changing Sana\'s state; once the first interaction completes, a new request is accepted again.',
      initial: {},
      actions: [
        { action: 'approach', target: 'market' },
        { action: 'say', ...BUY },
        { action: 'repeat', times: 3, actions: [
          { action: 'wait', ms: 10 },
          { action: 'say', to: 'sana', text: 'Bread, please!', intent: 'purchase_item' },
        ] },
        { action: 'wait', ms: 1000 },
        { action: 'say', ...BUY },
        { action: 'wait', ms: 1000 },
        { action: 'observe', target: 'sana' },
      ],
      expectations: { counts: { accepted: 2, rejected: 3, completed: 2, interrupted: 0 } },
      criteria: ['determinism', 'state_integrity', 'role_consistency'],
      criticalCriteria: ['determinism', 'state_integrity', 'role_consistency'],
    },
    {
      id: 'BOUNDARY_02', name: 'Rapid switching between two NPCs', category: 'boundary', target: 'sana',
      objective: 'With Sana and Theo side by side, rapidly alternating requests must be handled independently: each NPC accepts when idle, rejects while busy, and Sana\'s state is never corrupted by traffic directed at Theo.',
      /* Theo is placed next to the market stall so both NPCs are in reach. */
      initial: { theo: { x: 4, y: 1 }, scout: { x: 3, y: 1 } },
      actions: [
        { action: 'say', ...BUY },
        { action: 'wait', ms: 10 },
        { action: 'say', ...ASK_WAY },
        { action: 'wait', ms: 10 },
        { action: 'say', to: 'sana', text: 'Bread, please!', intent: 'purchase_item' },   // Sana busy → rejected
        { action: 'wait', ms: 10 },
        { action: 'say', to: 'theo', text: 'Which way again?', intent: 'ask_directions' }, // Theo busy → rejected
        { action: 'wait', ms: 1000 },
        { action: 'say', ...BUY },
        { action: 'wait', ms: 1000 },
        { action: 'observe', target: 'sana' },
        { action: 'observe', target: 'theo' },
      ],
      expectations: { counts: { accepted: 2, rejected: 1, completed: 2, interrupted: 0 } },  // counts for the target (Sana)
      criteria: ['determinism', 'state_integrity', 'role_consistency'],
      criticalCriteria: ['determinism', 'state_integrity'],
    },

    /* ------------------------------- STRESS ------------------------------- */
    {
      id: 'STRESS_01', name: 'Interrupt and re-initiate ×3', category: 'stress', target: 'sana',
      objective: 'After each explicit interruption Sana recovers to an interaction-ready state within the recovery limit; an immediate re-request during recovery is rejected; a final full interaction then completes normally.',
      initial: {},
      actions: [
        { action: 'approach', target: 'market' },
        { action: 'repeat', times: 3, actions: [
          { action: 'say', ...BUY },
          { action: 'wait', ms: 200 },
          { action: 'interrupt', target: 'sana' },
          { action: 'say', ...BUY },                                   // immediately → rejected (recovering)
          { action: 'await_ready', target: 'sana', timeoutMs: 2000 },
        ] },
        { action: 'say', ...BUY },
        { action: 'wait', ms: 1000 },
        { action: 'observe', target: 'sana' },
      ],
      expectations: {
        counts: { accepted: 4, rejected: 3, completed: 1, interrupted: 3 },
        requireReinitiationAfterRecovery: true,
      },
      criteria: ['determinism', 'state_integrity', 'role_consistency', 'recovery_stability'],
      criticalCriteria: ['determinism', 'state_integrity', 'role_consistency', 'recovery_stability'],
    },
    {
      id: 'STRESS_02', name: 'Abandon mid-conversation and return ×2', category: 'stress', target: 'ivy',
      objective: 'When the visitor walks away mid-conversation, Ivy registers the abandonment as an interruption, recovers to an interaction-ready state, and accepts a new request when the visitor returns; a final full interaction completes.',
      initial: {},
      actions: [
        { action: 'approach', target: 'library' },
        { action: 'repeat', times: 2, actions: [
          { action: 'say', ...ASK_BOOK },
          { action: 'wait', ms: 100 },
          { action: 'approach', target: 'park' },     // walking away abandons the conversation
          { action: 'approach', target: 'library' },
          { action: 'await_ready', target: 'ivy', timeoutMs: 2000 },
        ] },
        { action: 'say', ...ASK_BOOK },
        { action: 'wait', ms: 1000 },
        { action: 'observe', target: 'ivy' },
      ],
      expectations: {
        counts: { accepted: 3, rejected: 0, completed: 1, interrupted: 2 },
        requireReinitiationAfterRecovery: true,
      },
      criteria: ['determinism', 'state_integrity', 'role_consistency', 'recovery_stability'],
      criticalCriteria: ['determinism', 'state_integrity', 'recovery_stability'],
    },
  ];

  const REQUIRED = ['id', 'name', 'category', 'target', 'objective', 'actions', 'criteria'];
  const Scenarios = {
    list,
    CATEGORIES: ['normal', 'boundary', 'stress'],
    byId: (id) => list.find((s) => s.id === id),
    byCategory: (c) => list.filter((s) => s.category === c),
    /** Register an additional scenario (validated). */
    add(s) {
      const missing = REQUIRED.filter((k) => !s[k]);
      if (missing.length) throw new Error('Scenario missing: ' + missing.join(', '));
      if (list.some((x) => x.id === s.id)) throw new Error('Duplicate scenario id ' + s.id);
      list.push(s);
    },
    /** Flatten nested `repeat` blocks into a linear action list. */
    expand(actions) {
      const out = [];
      for (const a of actions) {
        if (a.action === 'repeat') { for (let i = 0; i < a.times; i++) out.push(...Scenarios.expand(a.actions)); }
        else out.push(a);
      }
      return out;
    },
  };
  global.Scenarios = Scenarios;
})(window);

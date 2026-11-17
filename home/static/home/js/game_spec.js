// * game_spec.js — the TINYVILLE GAME TEST SPECIFICATION.

(function (global) {
  'use strict';

  const TinyvilleSpec = {
    name: 'tinyville',

    /* Default expected-behaviour model; any scenario can override parts of it. */
    expectations: {
      /* Semantic state model: oracles refer to states only through these roles. */
      stateModel: {
        initial: 'IDLE',
        ready: ['IDLE'],                       // a new request must be accepted here
        engaged: ['GREETING', 'TALKING'],      // active interaction (interruptible)
        replying: ['TALKING'],                 // the substantive reply arrives here
        interrupted: 'INTERRUPTED',
        recoveryPath: ['INTERRUPTED', 'RECOVERING', 'IDLE'],
        completion: { from: 'TALKING', to: 'IDLE' },
        transitions: {
          IDLE: ['GREETING'],
          GREETING: ['TALKING', 'INTERRUPTED'],
          TALKING: ['IDLE', 'INTERRUPTED'],
          INTERRUPTED: ['RECOVERING'],
          RECOVERING: ['IDLE'],
        },
        /* Expected animation label per state (animation–state coherence). */
        animations: { IDLE: 'idle', GREETING: 'wave', TALKING: 'talk', INTERRUPTED: 'startled', RECOVERING: 'settling' },
      },
      finalStates: ['IDLE'],
      overlapPolicy: 'reject',                 // overlapping requests rejected, state untouched
      maxResponseMs: 500,                      // accepted request → substantive reply
      maxDwellMs: { GREETING: 400, TALKING: 500, INTERRUPTED: 150, RECOVERING: 400 },
      maxRecoveryMs: 300,                      // interruption → back to ready
      counts: null,                            // optional {accepted, rejected, completed, interrupted}
      requireReinitiationAfterRecovery: false,
      timingToleranceMs: 0,                    // determinism: allowed drift across runs
      replyMismatchSeverity: 'PARTIAL',        // determinism: semantically different reply, same states
    },

    /* Role specifications, from the NPCs' PUBLIC role declarations.
     * `ownTopic` is the role's domain vocabulary; `foreignTopic` is vocabulary
     * of the OTHER roles' domains, minus terms the role may legitimately use
     * (e.g., the guide may name the library when giving directions to it). */
    roles: {
      sana: {
        role: 'shopkeeper',
        ownTopic: /\b(shop|stall|market|bread|loaf|loaves|coin|coins|buy|sold|stock|wares|appl\w+)\b/i,
        foreignTopic: /\b(dewey|catalogu\w+|manuscript|borrow\w*)\b|\broute\b|\bshel(f|ves)\b/i,
        roleIntents: ['purchase_item'],
      },
      theo: {
        role: 'guide',
        ownTopic: /\b(street|streets|lane|route|map|direction\w*|north|south|east|west|follow|way|traveller)\b/i,
        foreignTopic: /\b(loaf|loaves|bread|oven|coins?)\b|\bshel(f|ves)\b/i,
        roleIntents: ['ask_directions'],
      },
      ivy: {
        role: 'librarian',
        ownTopic: /\b(book\w*|novel\w*|stor(y|ies)|shel(f|ves)|read\w*|librar\w+|chapter\w*|checked out)\b/i,
        foreignTopic: /\b(coins?|loaf|loaves|oven)\b|\broute\b|\bstreets?\b/i,
        roleIntents: ['ask_book'],
      },
    },

    /* Topic lexicons for semantic utterance classification (determinism). */
    topics: {
      shopkeeping: /\b(shop|stall|market|bread|loaf|loaves|coin|coins|buy|sold|stock|wares|appl\w+)\b/i,
      guiding: /\b(street|streets|lane|route|map|direction\w*|north|south|east|west|follow|way|traveller)\b/i,
      library: /\b(book\w*|novel\w*|stor(y|ies)|shel(f|ves)|read\w*|librar\w+|chapter\w*|checked out)\b/i,
    },

    /* Conversational-act lexicon: GENERIC English patterns only — deliberately
     * no fragments of any particular NPC's scripted lines. */
    acts: {
      greeting: /\b(hello|hi|hey|welcome|shh|greetings|good (morning|day|afternoon|evening))\b/i,
      offer: /\b(what can i|how can i help|would you like|looking for|care to)\b/i,
      acknowledgment: /\b(of course|sure|certainly|absolutely|gladly)\b/i,
      directive: /\b(try|follow|take|head|turn|go|visit)\b/i,
      deflection: /\b(sorry|afraid|apolog\w+|unfortunately|can'?t|cannot)\b/i,
      closing: /\b(thank|enjoy|see you|safe travels)\b/i,
    },
  };

  global.TinyvilleSpec = TinyvilleSpec;
  global.Criteria.setGameSpec(TinyvilleSpec);
})(window);

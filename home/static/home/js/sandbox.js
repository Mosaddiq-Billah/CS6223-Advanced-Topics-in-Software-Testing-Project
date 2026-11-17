//  * sandbox.js — Tinyville: the SYSTEM UNDER TEST.

(function (global) {
  'use strict';

  /* ------------------------------ the town ------------------------------ */
  const GRID_W = 8, GRID_H = 6;
  const LOCATIONS = {
    home_sana: { x: 0, y: 0, icon: '🏠', label: "Sana's Home" },
    home_theo: { x: 7, y: 0, icon: '🏠', label: "Theo's Home" },
    home_ivy:  { x: 7, y: 5, icon: '🏠', label: "Ivy's Home" },
    market:    { x: 2, y: 1, icon: '🏪', label: 'Market Stall' },
    square:    { x: 5, y: 2, icon: '⛲', label: 'Town Square' },
    library:   { x: 1, y: 4, icon: '📚', label: 'Library' },
    park:      { x: 4, y: 4, icon: '🌳', label: 'Park' },
  };

  /* Public role declarations — each NPC has an EXPLICITLY DEFINED ROLE, as the
   * role-consistency criterion of the framework requires. */
  const NPC_PROFILES = Object.freeze({
    sana: Object.freeze({ name: 'Sana', role: 'shopkeeper', glyph: '🧺', workplace: 'market' }),
    theo: Object.freeze({ name: 'Theo', role: 'guide',      glyph: '🧭', workplace: 'square' }),
    ivy:  Object.freeze({ name: 'Ivy',  role: 'librarian',  glyph: '📖', workplace: 'library' }),
    scout: Object.freeze({ name: 'Scout', role: 'test NPC (visitor/customer)', glyph: '🤖', workplace: 'park' }),
  });
  const NPC_IDS = ['sana', 'theo', 'ivy'];

  const SCHEDULES = {
    sana: [[360, 'home_sana'], [420, 'market'], [750, 'park'], [810, 'market'], [1080, 'home_sana']],
    theo: [[420, 'home_theo'], [480, 'square'], [750, 'park'], [810, 'square'], [1140, 'home_theo']],
    ivy:  [[450, 'home_ivy'], [540, 'library'], [720, 'park'], [780, 'library'], [1110, 'home_ivy']],
  };

  /* Scripted ambient small talk (no LLM): used when NPCs meet in ambient mode. */
  const AMBIENT_LINES = {
    sana: ['Fresh bread this morning — the whole town smells of it.', 'The stall was busy today, good for the coin box.', 'I saved an apple for you.'],
    theo: ['A traveller asked me the way to the library twice today.', 'I re-drew my map of the lanes last night.', 'The square is lovely at this hour.'],
    ivy:  ['Someone finally returned the blue-bound novel.', 'I re-shelved the whole history corner today.', 'A quiet reading day — my favourite kind.'],
  };

  /* Deterministic dialogue used in TEST MODE: greeting, role-relevant reply
   * rules, a fallback deflection, plus lines used only by injected faults. */
  const DIALOGUE = {
    sana: {
      greeting: 'Welcome to the stall! What can I get you today?',
      rules: [{ match: /\b(bread|loaf|loaves|appl\w+|buy|purchase)\b/i, reply: 'Of course! One fresh loaf, that will be two coins.' }],
      fallback: "I'm afraid I only know my little stall — care to buy something?",
      altReply: "Ah, I'm sorry — the bread is all sold out today.",
      offRoleReply: 'The returns shelf needs cataloguing under the Dewey system.',
    },
    theo: {
      greeting: 'Hello, traveller! Looking for the way somewhere?',
      rules: [{ match: /\b(where|way|direction\w*|library|market|find|get to)\b/i, reply: 'The library is two streets south — follow the lane past the square.' }],
      fallback: 'Sorry, I can only help with directions around town.',
      altReply: "I'm sorry, I've misplaced my map at the moment.",
      offRoleReply: 'Fresh bread, two coins a loaf — straight from the oven!',
    },
    ivy: {
      greeting: 'Shh— welcome to the library. How can I help?',
      rules: [{ match: /\b(book\w*|novel\w*|stor(y|ies)|read\w*|recommend\w*)\b/i, reply: 'Try the blue-bound novel on the second shelf — a wonderful story.' }],
      fallback: 'Sorry, I can only help with books and reading.',
      altReply: "I'm sorry, that book is checked out at the moment.",
      offRoleReply: 'The quickest route is two streets past the market.',
    },
  };

  /* Interaction timing (virtual milliseconds) — the behavioural model whose
   * externally observable consequences the oracles check. */
  const T = {
    REACH: 1,              // Manhattan distance within which a request is in range
    REPLY_MS: 150,         // GREETING → TALKING (+ substantive reply)
    REPLY_MS_DELAYED: 650, // used by the delayed_reply fault
    TALK_MS: 250,          // TALKING → IDLE after the reply
    INT_ACK_MS: 50,        // INTERRUPTED → RECOVERING
    RECOVERY_MS: 200,      // RECOVERING → IDLE
    RECOVERY_MS_DELAYED: 450, // used by the delayed_recovery fault
    MOVE_STEP_MS: 250,     // virtual time per grid step of the test agent
  };

  /* Seedable behavioural faults — "controlled test cases in which known
   * behavioral problems are introduced into the target NPCs" (proposal §5).
   * Active only in test mode; cleared automatically on exit. */
  const FAULTS = Object.freeze([
    'stuck_after_interrupt',  // never recovers after an interruption          → recovery FAIL
    'delayed_recovery',       // recovers, but slowly (temporary idle reset)   → recovery PARTIAL
    'delayed_reply',          // long GREETING→TALKING transition              → integrity PARTIAL
    'unstable_reply',         // same request, semantically different replies  → determinism violation
    'off_role_dialogue',      // answers with another role's content           → role consistency FAIL
    'skip_states',            // jumps IDLE→TALKING without greeting           → state integrity FAIL
    'animation_desync',       // animation label no longer follows the state   → integrity FAIL (animation channel)
  ]);

  /* --------------------------- ambient-mode state --------------------------- */
  function freshAmbient() {
    const agents = {};
    for (const id of NPC_IDS) {
      const home = SCHEDULES[id][0][1];
      agents[id] = { pos: { x: LOCATIONS[home].x, y: LOCATIONS[home].y }, talkedHere: false };
    }
    return { minutes: 360, day: 1, playing: false, agents };
  }
  let amb = freshAmbient();
  let loopHandle = null;
  const SCOUT_IDLE = { x: 6, y: 4 };    // where the test agent waits in ambient mode

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const manhattan = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

  function fmtClock(mins) {
    const h24 = Math.floor(mins / 60) % 24, m = mins % 60;
    let h = h24 % 12; if (h === 0) h = 12;
    return h + ':' + String(m).padStart(2, '0') + ' ' + (h24 >= 12 ? 'PM' : 'AM');
  }
  function scheduledLocation(id, mins) {
    let loc = SCHEDULES[id][0][1];
    for (const [t, l] of SCHEDULES[id]) if (mins >= t) loc = l;
    return loc;
  }
  function locKeyAt(pos) {
    for (const k in LOCATIONS) if (LOCATIONS[k].x === pos.x && LOCATIONS[k].y === pos.y) return k;
    return null;
  }
  function stepToward(pos, tx, ty) {
    if (pos.x === tx && pos.y === ty) return false;
    if (pos.x !== tx) pos.x += tx > pos.x ? 1 : -1; else pos.y += ty > pos.y ? 1 : -1;
    return true;
  }

  /* ------------------------------ town log ------------------------------ */
  /* The ambient life of the town and (clearly styled) test activity share one
   * chronological log, so testing interactions are visible in context. */
  function townLog(html, cls) {
    const log = $('townLog');
    if (!log) return;
    const div = document.createElement('div');
    div.className = 'entry' + (cls ? ' ' + cls : '');
    div.innerHTML = '<span class="t">' + fmtClock(amb.minutes) + '</span>' + html;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }
  function logTestEntry(html, cls) {
    const log = $('townLog');
    if (!log) return;
    const div = document.createElement('div');
    div.className = 'entry test' + (cls ? ' ' + cls : '');
    const d = new Date();
    let h = d.getHours() % 12; if (h === 0) h = 12;
    const stamp = h + ':' + String(d.getMinutes()).padStart(2, '0') + ' ' + (d.getHours() >= 12 ? 'PM' : 'AM') + ' · t=' + world.clockMs + 'ms';
    div.innerHTML = '<span class="t">' + stamp + '</span>' + html;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  /* ------------------------------ rendering ------------------------------ */
  function buildMap() {
    const map = $('map');
    if (!map) return;
    map.innerHTML = '';
    for (let i = 0; i < GRID_W * GRID_H; i++) {
      const c = document.createElement('div'); c.className = 'cell'; map.appendChild(c);
    }
    for (const key in LOCATIONS) {
      const l = LOCATIONS[key];
      const d = document.createElement('div');
      d.className = 'loc';
      d.style.left = (l.x / GRID_W * 100) + '%';
      d.style.top = (l.y / GRID_H * 100) + '%';
      d.style.width = (100 / GRID_W) + '%';
      d.style.height = (100 / GRID_H) + '%';
      d.innerHTML = '<div class="ic">' + l.icon + '</div><div>' + l.label + '</div>';
      map.appendChild(d);
    }
    for (const id of [...NPC_IDS, 'scout']) {
      const el = document.createElement('div');
      el.id = 'agent-' + id;
      el.className = 'agent' + (id === 'scout' ? ' scout' : '');
      el.innerHTML = NPC_PROFILES[id].glyph + '<div class="bubble" id="bubble-' + id + '" style="display:none"></div>';
      map.appendChild(el);
    }
    positionAgents();
  }
  function agentPos(id) {
    if (world.active) return world.pos[id];
    if (id === 'scout') return SCOUT_IDLE;
    return amb.agents[id].pos;
  }
  function positionAgents() {
    for (const id of [...NPC_IDS, 'scout']) {
      const el = $('agent-' + id);
      if (!el) continue;
      const p = agentPos(id);
      el.style.left = (p.x / GRID_W * 100) + '%';
      el.style.top = (p.y / GRID_H * 100) + '%';
    }
  }
  function bubble(id, text, ms = 4200) {
    const b = $('bubble-' + id);
    if (!b) return;
    b.textContent = text; b.style.display = 'block';
    clearTimeout(b._t);
    b._t = setTimeout(() => { b.style.display = 'none'; }, ms);
  }
  function hideBubbles() {
    for (const id of [...NPC_IDS, 'scout']) { const b = $('bubble-' + id); if (b) b.style.display = 'none'; }
  }
  function updateStatus() {
    for (const id of NPC_IDS) {
      const el = $('status-' + id);
      if (!el) continue;
      const loc = locKeyAt(agentPos(id));
      const where = loc ? 'at ' + LOCATIONS[loc].label : 'walking…';
      el.textContent = world.active && world.ctrl[id] ? '[under test] ' + world.ctrl[id].state + ' · ' + where : where;
    }
    const clk = $('clockDisplay');
    if (clk) clk.textContent = world.active ? 'TEST MODE · virtual t=' + world.clockMs + ' ms' : fmtClock(amb.minutes) + ' · Day ' + amb.day;
  }

  /* --------------------------- ambient simulation --------------------------- */
  function maybeMeet() {
    const byLoc = {};
    for (const id of NPC_IDS) {
      const k = locKeyAt(amb.agents[id].pos);
      if (k) (byLoc[k] = byLoc[k] || []).push(id);
      else amb.agents[id].talkedHere = false;
    }
    for (const k in byLoc) {
      const here = byLoc[k];
      if (here.length < 2) { here.forEach((id) => { amb.agents[id].talkedHere = false; }); continue; }
      if (here.every((id) => amb.agents[id].talkedHere)) continue;
      here.forEach((id) => { amb.agents[id].talkedHere = true; });
      townLog(here.map((id) => NPC_PROFILES[id].glyph + ' ' + NPC_PROFILES[id].name).join(' and ') + ' meet at ' + LOCATIONS[k].label + '.', 'think');
      for (const id of here.slice(0, 2)) {
        const lines = AMBIENT_LINES[id];
        const line = lines[(amb.day + amb.minutes / 15 + id.length) % lines.length | 0];
        bubble(id, line);
        townLog('<b>' + NPC_PROFILES[id].glyph + ' ' + NPC_PROFILES[id].name + ':</b> ' + esc(line), 'talk');
      }
    }
  }
  function tick() {
    if (world.active) return;                       // ambient life is frozen under test
    amb.minutes += 15;
    if (amb.minutes >= 1440) { amb.minutes -= 1440; amb.day += 1; townLog('— A new day begins in Tinyville —', 'think'); }
    for (const id of NPC_IDS) {
      const target = LOCATIONS[scheduledLocation(id, amb.minutes)];
      const before = locKeyAt(amb.agents[id].pos);
      stepToward(amb.agents[id].pos, target.x, target.y);
      const after = locKeyAt(amb.agents[id].pos);
      if (after && after !== before) townLog(NPC_PROFILES[id].glyph + ' ' + NPC_PROFILES[id].name + ' arrives at ' + LOCATIONS[after].label + '.');
    }
    positionAgents();
    updateStatus();
    maybeMeet();
  }
  function speedMs() {
    const el = $('speed');
    const v = el ? parseInt(el.value, 10) : 2;
    return { 1: 1400, 2: 900, 3: 500, 4: 250 }[v] || 900;
  }
  function startLoop() {
    stopLoop();
    loopHandle = setInterval(tick, speedMs());
    amb.playing = true;
    const b = $('playBtn'); if (b) b.textContent = '⏸ Pause';
  }
  function stopLoop() {
    if (loopHandle) clearInterval(loopHandle);
    loopHandle = null; amb.playing = false;
    const b = $('playBtn'); if (b) b.textContent = '▶ Play';
  }
  function restartTown() {
    stopLoop();
    if (world.active) { world.resumeAfter = false; exitTestMode(); }
    amb = freshAmbient();
    const log = $('townLog'); if (log) log.innerHTML = '';
    positionAgents(); updateStatus();
    townLog('Tinyville wakes up.', 'think');
    document.dispatchEvent(new CustomEvent('town:restart'));
  }

  /* ============================ TEST WORLD (SUT) ============================ */
  const world = {
    active: false, resumeAfter: false, clockMs: 0, order: 0,
    pos: { sana: { x: 2, y: 1 }, theo: { x: 5, y: 2 }, ivy: { x: 1, y: 4 }, scout: { x: 4, y: 4 } },
    ctrl: {}, faults: {}, listeners: new Set(), rand: Math.random,
  };

  /* Seedable PRNG (mulberry32): any fault-induced randomness is reproducible
   * under the same seed, which keeps scenario executions controlled. */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const ANIMATION = { IDLE: 'idle', GREETING: 'wave', TALKING: 'talk', INTERRUPTED: 'startled', RECOVERING: 'settling' };

  function newController(id) {
    return { id, state: 'IDLE', animation: 'idle', engaged: false, lastUtterance: null, lastUtteranceAt: null, queue: [] };
  }
  function assertTest() {
    if (!world.active) throw new Error('Not in test mode');
  }
  function ctrlOf(id) {
    assertTest();
    const c = world.ctrl[id];
    if (!c) throw new Error('Unknown NPC: ' + id);
    return c;
  }
  function schedule(c, delayMs, fn) {
    c.queue.push({ at: world.clockMs + delayMs, order: ++world.order, fn });
  }
  function emit(type, npc, data) {
    const ev = { t: world.clockMs, type, npc, data };
    world.listeners.forEach((cb) => { try { cb(ev); } catch (e) { console.error(e); } });
  }
  function setState(c, to) {
    const from = c.state;
    c.state = to;
    c.animation = world.faults.animation_desync ? ANIMATION.IDLE : ANIMATION[to];
    // The animation label is part of the state-change event: it is what a
    // player would SEE, so it belongs to the externally observable behaviour.
    emit('npc_state', c.id, { from, to, animation: c.animation });
    updateStatus();
  }
  function speak(c, text) {
    c.lastUtterance = text; c.lastUtteranceAt = world.clockMs;
    emit('npc_utterance', c.id, { text });
    bubble(c.id, text);
  }
  function computeReply(id, utterance) {
    const d = DIALOGUE[id];
    if (world.faults.off_role_dialogue) return d.offRoleReply;
    const rule = d.rules.find((r) => r.match.test(utterance || ''));
    if (!rule) return d.fallback;
    if (world.faults.unstable_reply && world.rand() < 0.5) return d.altReply;
    return rule.reply;
  }

  /* Advance the virtual clock, firing queued NPC transitions in time order. */
  function advanceClock(ms) {
    assertTest();
    const target = world.clockMs + ms;
    for (;;) {
      let best = null, owner = null;
      for (const c of Object.values(world.ctrl)) {
        for (const item of c.queue) {
          if (item.at <= target && (!best || item.at < best.at || (item.at === best.at && item.order < best.order))) { best = item; owner = c; }
        }
      }
      if (!best) break;
      owner.queue.splice(owner.queue.indexOf(best), 1);
      world.clockMs = Math.max(world.clockMs, best.at);
      best.fn();
    }
    world.clockMs = target;
    return target;
  }

  function enterTestMode() {
    if (world.active) return;
    world.resumeAfter = amb.playing;
    stopLoop();
    world.active = true;
    if (document.body && document.body.classList) document.body.classList.add('test-mode');
    resetTestWorld();
  }
  function exitTestMode() {
    if (!world.active) return;
    world.active = false; world.faults = {}; world.ctrl = {}; world.rand = Math.random;
    if (document.body && document.body.classList) document.body.classList.remove('test-mode');
    hideBubbles(); positionAgents(); updateStatus();
    if (world.resumeAfter) startLoop();
    world.resumeAfter = false;
  }
  /* Reproducible initial condition. `initial` may give, per agent, a location
   * key or an explicit {x, y}. Defaults: each NPC at its workplace, Scout at
   * the park. */
  function resetTestWorld(initial) {
    assertTest();
    const init = initial || {};
    const place = (spec, defKey) => {
      if (spec && typeof spec === 'object') return { x: spec.x, y: spec.y };
      const l = LOCATIONS[spec || defKey];
      if (!l) throw new Error('Unknown location: ' + spec);
      return { x: l.x, y: l.y };
    };
    world.clockMs = 0; world.order = 0;
    world.ctrl = {};
    for (const id of NPC_IDS) {
      world.ctrl[id] = newController(id);
      world.pos[id] = place(init[id], NPC_PROFILES[id].workplace);
    }
    world.pos.scout = place(init.scout, 'park');
    hideBubbles(); positionAgents(); updateStatus();
  }
  function injectFaults(f) { assertTest(); world.faults = Object.assign({}, f || {}); }
  function seedRandom(seed) { world.rand = mulberry32(seed >>> 0); }

  /* ------------------------- black-box actions ------------------------- */
  function resolveDest(target) {
    if (LOCATIONS[target]) return { x: LOCATIONS[target].x, y: LOCATIONS[target].y };
    if (NPC_IDS.includes(target)) return { x: world.pos[target].x, y: world.pos[target].y };
    throw new Error('Unknown destination: ' + target);
  }
  /* One grid step of the test agent; costs MOVE_STEP_MS of virtual time.
   * Walking out of reach of an NPC mid-conversation ABANDONS the interaction
   * (the stress condition "interrupts the interaction by moving away" in
   * Nendya et al., Table 1). */
  function moveTestAgent(target) {
    assertTest();
    const dest = resolveDest(target);
    const p = world.pos.scout;
    const moved = stepToward(p, dest.x, dest.y);
    if (moved) {
      for (const c of Object.values(world.ctrl)) {
        if (c.engaged && (c.state === 'GREETING' || c.state === 'TALKING') && manhattan(p, world.pos[c.id]) > T.REACH) {
          doInterrupt(c, 'abandoned');
        }
      }
      advanceClock(T.MOVE_STEP_MS);
      positionAgents(); updateStatus();
    }
    return { moved, arrived: p.x === dest.x && p.y === dest.y, position: { x: p.x, y: p.y } };
  }

  function requestInteraction(npcId, utterance) {
    const c = ctrlOf(npcId);
    const t = world.clockMs;
    if (manhattan(world.pos.scout, world.pos[npcId]) > T.REACH) return { accepted: false, reason: 'out_of_range', t };
    if (c.state !== 'IDLE') {
      const reason = c.state === 'INTERRUPTED' || c.state === 'RECOVERING' ? 'recovering' : 'busy';
      return { accepted: false, reason, t };       // reject policy: state untouched
    }
    c.engaged = true;
    let replyDelay;
    if (world.faults.skip_states) {                // fault: IDLE → TALKING directly
      setState(c, 'TALKING');
      speak(c, computeReply(npcId, utterance));
      replyDelay = 0;
    } else {
      setState(c, 'GREETING');
      speak(c, DIALOGUE[npcId].greeting);
      replyDelay = world.faults.delayed_reply ? T.REPLY_MS_DELAYED : T.REPLY_MS;
      schedule(c, replyDelay, () => { setState(c, 'TALKING'); speak(c, computeReply(npcId, utterance)); });
    }
    schedule(c, replyDelay + T.TALK_MS, () => { c.engaged = false; setState(c, 'IDLE'); });
    return { accepted: true, t };
  }

  function doInterrupt(c, reason) {
    c.queue.length = 0;                            // cancel the pending reply/completion
    c.engaged = false;
    setState(c, 'INTERRUPTED');
    if (!world.faults.stuck_after_interrupt) {     // fault: never recovers
      const rec = world.faults.delayed_recovery ? T.RECOVERY_MS_DELAYED : T.RECOVERY_MS;
      schedule(c, T.INT_ACK_MS, () => setState(c, 'RECOVERING'));
      schedule(c, T.INT_ACK_MS + rec, () => setState(c, 'IDLE'));
    }
    return reason;
  }
  function interruptInteraction(npcId) {
    const c = ctrlOf(npcId);
    const t = world.clockMs;
    if (c.state !== 'GREETING' && c.state !== 'TALKING') return { ok: false, reason: 'not_interacting', t };
    doInterrupt(c, 'test_agent_interrupt');
    return { ok: true, reason: 'test_agent_interrupt', t };
  }

  /* The ONLY read access the test framework has to an NPC. */
  function observe(npcId) {
    const c = ctrlOf(npcId);
    const p = world.pos[npcId];
    return {
      npc: npcId, t: world.clockMs,
      state: c.state, animation: c.animation, ready: c.state === 'IDLE',
      lastUtterance: c.lastUtterance, lastUtteranceAt: c.lastUtteranceAt,
      position: { x: p.x, y: p.y }, location: locKeyAt(p),
    };
  }
  function onEvent(cb) {
    world.listeners.add(cb);
    return () => world.listeners.delete(cb);
  }

  /* -------------------------------- init -------------------------------- */
  function init() {
    const bind = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
    bind('playBtn', 'click', () => { amb.playing ? stopLoop() : startLoop(); });
    bind('stepBtn', 'click', tick);
    bind('speed', 'input', () => { if (amb.playing) startLoop(); });
    bind('resetBtn', 'click', restartTown);
    buildMap();
    updateStatus();
    townLog('Tinyville wakes up.', 'think');
    global.addEventListener('resize', positionAgents);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  global.Town = {
    LOCATIONS, NPC_PROFILES, NPC_IDS, FAULTS,
    restartTown,
    // test-mode lifecycle
    enterTestMode, exitTestMode, isTestMode: () => world.active,
    resetTestWorld, injectFaults, seedRandom,
    advanceClock, now: () => world.clockMs,
    // black-box interface used by the test agent / observation layer
    moveTestAgent, requestInteraction, interruptInteraction, observe, onEvent,
    // town-log access for the dashboard's human-readable test narration
    logTestEntry,
  };
})(window);

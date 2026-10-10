import {
  GameState,
  TIERS,
  buyGc,
  buyMalloc,
  buyNice,
  canFork,
  canSpawn,
  childRam,
  cyclesPerSec,
  doFork,
  forkCost,
  freeMemory,
  gcCost,
  lineageMult,
  log,
  mallocCost,
  newGame,
  niceCost,
  nudgeDaemon,
  ramUsed,
  spawn,
  sweepVictimMult,
  tierCost,
  tick,
} from './sim';
import { fmt, fmtRate, fmtTime } from './format';

const SAVE_KEY = 'daemon-idle-save-v1';
const TICK_MS = 50; // fixed sim step
const OFFLINE_CAP_S = 8 * 3600;
const AUTOSAVE_MS = 10_000;

// --- persistence -----------------------------------------------------------

function save(s: GameState): void {
  s.lastSave = Date.now();
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable — ignore */
  }
}

function load(): GameState {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return newGame();
    const parsed = JSON.parse(raw) as Partial<GameState>;
    const s: GameState = { ...newGame(), ...parsed };
    // guard against shape drift
    if (!Array.isArray(s.counts) || s.counts.length !== TIERS.length) {
      s.counts = TIERS.map(() => 0);
    }
    if (!Array.isArray(s.legacy)) s.legacy = [];
    if (!Array.isArray(s.log)) s.log = [];

    const elapsed = Math.min(
      OFFLINE_CAP_S,
      (Date.now() - (s.lastSave || Date.now())) / 1000,
    );
    if (elapsed > 5) applyOffline(s, elapsed);
    return s;
  } catch {
    return newGame();
  }
}

function applyOffline(s: GameState, seconds: number): void {
  const before = s.cycles;
  let remaining = seconds;
  while (remaining > 0) {
    const dt = Math.min(1, remaining);
    tick(s, dt);
    remaining -= dt;
  }
  log(s, `offline ${fmtTime(seconds)}: +${fmt(s.cycles - before)} cycles`);
}

// --- dom refs --------------------------------------------------------------

const $ = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
};

const el = {
  cycles: $('cycles'),
  cps: $('cps'),
  lineage: $('lineage'),
  forks: $('forks'),
  sweeps: $('sweeps'),
  ramText: $('ramText'),
  ramBar: $('ramBar'),
  leakBar: $('leakBar'),
  sweepText: $('sweepText'),
  sweepBar: $('sweepBar'),
  spawnPanel: $('spawnPanel'),
  upgradePanel: $('upgradePanel'),
  legacyPanel: $('legacyPanel'),
  log: $('log'),
};

// --- buttons ---------------------------------------------------------------

interface ActionButton {
  el: HTMLButtonElement;
  name: () => string;
  cost: () => number;
  enabled: () => boolean;
  run: () => void;
}

const spawnButtons: ActionButton[] = TIERS.map((tier, i) => {
  const b = document.createElement('button');
  b.className = 'act';
  b.innerHTML =
    `<span class="name">${tier.name} <small>${tier.desc}</small></span>` +
    `<span class="cost"></span>`;
  b.addEventListener('click', () => {
    spawn(state, i);
    render(true);
  });
  el.spawnPanel.appendChild(b);
  return {
    el: b,
    name: () => `${tier.name}`,
    cost: () => tierCost(state, i),
    enabled: () => canSpawn(state, i),
    run: () => spawn(state, i),
  };
});

const upgradeButtons: ActionButton[] = [];

function addUpgrade(
  name: () => string,
  cost: () => number,
  enabled: () => boolean,
  run: () => void,
): void {
  const b = document.createElement('button');
  b.className = 'act';
  b.innerHTML = `<span class="name"></span><span class="cost"></span>`;
  b.addEventListener('click', () => {
    run();
    render(true);
  });
  el.upgradePanel.appendChild(b);
  upgradeButtons.push({ el: b, name, cost, enabled, run });
}

addUpgrade(
  () => 'free()',
  () => 0,
  () => state.leak > 0,
  () => freeMemory(state),
);
addUpgrade(
  () => `nice(+1)  ·  reap ${Math.round((1 - sweepVictimMult(state)) * 100)}% fewer  ·  lvl ${state.nice}`,
  () => niceCost(state),
  () => state.cycles >= niceCost(state),
  () => buyNice(state),
);
addUpgrade(
  () => `malloc(+8MB)  ·  ceiling ${state.ramCap}MB`,
  () => mallocCost(state),
  () => state.cycles >= mallocCost(state),
  () => buyMalloc(state),
);
addUpgrade(
  () => (state.gc === 0 ? 'gc  ·  auto-flush the leak' : `gc  ·  auto-flush lvl ${state.gc}`),
  () => gcCost(state),
  () => state.cycles >= gcCost(state),
  () => buyGc(state),
);
addUpgrade(
  () => `fork()  ·  prestige  ·  lineage ×${(1 + (state.forks + 1) * 0.1).toFixed(1)}`,
  () => forkCost(state),
  () => canFork(state),
  () => doFork(state),
);

// --- render ----------------------------------------------------------------

let lastLogSig = '';

function render(force = false): void {
  el.cycles.textContent = fmt(state.cycles);
  el.cps.textContent = fmt(cyclesPerSec(state));
  el.lineage.textContent = `×${lineageMult(state).toFixed(1)}`;
  el.forks.textContent = String(state.forks);
  el.sweeps.textContent = String(state.sweepsSurvived);

  // RAM meter
  const used = ramUsed(state);
  const cap = state.ramCap;
  const child = childRam(state);
  el.ramText.textContent =
    `${Math.ceil(used)} / ${cap} MB` +
    (state.leak > 0.5 ? `  (leak ${Math.ceil(state.leak)}MB)` : '');
  const childPct = Math.min(100, (child / cap) * 100);
  const leakPct = Math.max(0, Math.min(100 - childPct, (state.leak / cap) * 100));
  el.ramBar.style.width = `${childPct}%`;
  el.ramBar.style.background = used > cap * 0.9 ? 'var(--danger)' : '';
  el.leakBar.style.left = `${childPct}%`;
  el.leakBar.style.width = `${leakPct}%`;

  // sweep meter
  const frac = 1 - state.sweepTimer / state.sweepInterval;
  el.sweepBar.style.width = `${Math.min(100, frac * 100)}%`;
  const total = totalChildren();
  const severity = Math.min(0.35, 0.15 + state.sweepsSurvived * 0.002);
  const est = total === 0 ? 0 : Math.max(1, Math.round(total * severity * sweepVictimMult(state)));
  el.sweepText.textContent = `${fmtTime(state.sweepTimer)}  ·  reaping ~${est}`;

  // action buttons
  for (let i = 0; i < spawnButtons.length; i++) {
    const b = spawnButtons[i];
    const ok = b.enabled();
    const ramFull = ramUsed(state) + TIERS[i].ram > state.ramCap;
    b.el.disabled = !ok;
    const costEl = b.el.querySelector('.cost') as HTMLElement;
    costEl.textContent = `${state.counts[i]}  ·  ${fmt(b.cost())}${ramFull ? '  ⚠ ram' : ''}`;
    costEl.classList.toggle('ok', ok);
  }

  for (const b of upgradeButtons) {
    const ok = b.enabled();
    b.el.disabled = !ok;
    const cost = b.cost();
    (b.el.querySelector('.name') as HTMLElement).textContent = b.name();
    const costEl = b.el.querySelector('.cost') as HTMLElement;
    costEl.textContent = cost > 0 ? fmt(cost) : '';
    costEl.classList.toggle('ok', ok);
  }

  renderLegacy();
  renderLog(force);
}

function renderLegacy(): void {
  if (state.legacy.length === 0) {
    if (el.legacyPanel.dataset.sig !== 'none') {
      el.legacyPanel.dataset.sig = 'none';
      el.legacyPanel.innerHTML = `<div class="none">none yet — fork to leave one behind</div>`;
    }
    return;
  }
  const sig = state.legacy.map((d) => `${d.name}:${d.crashed}`).join('|');
  if (el.legacyPanel.dataset.sig !== sig) {
    el.legacyPanel.dataset.sig = sig;
    el.legacyPanel.innerHTML = '';
    state.legacy.forEach((d, i) => {
      const div = document.createElement('div');
      div.className = `daemon${d.crashed ? ' crashed' : ''}`;
      div.innerHTML = d.crashed
        ? `<span>${d.name} — crashed</span><span class="rate">click to restart</span>`
        : `<span>${d.name}</span><span class="rate"></span>`;
      div.addEventListener('click', () => {
        nudgeDaemon(state, i);
        render(true);
      });
      el.legacyPanel.appendChild(div);
    });
  }
  // refresh live rates cheaply
  state.legacy.forEach((d, i) => {
    const row = el.legacyPanel.children[i];
    const rateEl = row?.querySelector('.rate');
    if (rateEl && !d.crashed) rateEl.textContent = fmtRate(d.rate * lineageMult(state));
  });
}

function renderLog(force: boolean): void {
  const sig = state.log.join('\n');
  if (!force && sig === lastLogSig) return;
  lastLogSig = sig;
  el.log.innerHTML = '';
  for (const line of state.log) {
    const d = document.createElement('div');
    d.textContent = `> ${line}`;
    el.log.appendChild(d);
  }
}

function totalChildren(): number {
  return state.counts.reduce((a, b) => a + b, 0);
}

// --- boot ------------------------------------------------------------------

const state = load();
log(state, `welcome back — uptime ${fmtTime(state.playtime)}`);

let acc = 0;
let last = performance.now();
let lastSaveAt = performance.now();

function frame(now: number): void {
  const dtMs = Math.min(1000, now - last);
  last = now;
  acc += dtMs;
  while (acc >= TICK_MS) {
    tick(state, TICK_MS / 1000);
    acc -= TICK_MS;
  }
  render();

  if (now - lastSaveAt > AUTOSAVE_MS) {
    save(state);
    lastSaveAt = now;
  }
  requestAnimationFrame(frame);
}

window.addEventListener('beforeunload', () => save(state));
document.addEventListener('visibilitychange', () => {
  if (document.hidden) save(state);
});

render(true);
requestAnimationFrame(frame);

// expose for debugging in the console
(window as unknown as { daemon: GameState }).daemon = state;

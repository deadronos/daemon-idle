import {
  type GameState,
  MALLOC_STEP,
  TIERS,
  buyGc,
  buyMalloc,
  buyNice,
  canFork,
  canSpawn,
  childRam,
  cyclesPerSec,
  directiveById,
  doFork,
  forkCost,
  freeMemory,
  gcCost,
  lineageMult,
  log,
  mallocCost,
  movePriority,
  newGame,
  niceCost,
  nudgeDaemon,
  ramUsed,
  sanitizeSacrificeOrder,
  spawn,
  sweepVictimMult,
  tick,
  tierCost,
} from "./sim";
import { d } from "./bignum";
import { type Alert, checkNumericHealth } from "./diagnostics";
import { consoleSink, logFeedSink, makeReporter } from "./report";
import { fmt, fmtRate, fmtTime } from "./format";

const SAVE_KEY = "daemon-idle-save-v1";
const TICK_MS = 50; // fixed sim step
const OFFLINE_CAP_S = 8 * 3600;
const AUTOSAVE_MS = 10_000;
const WATCHDOG_MS = 1000;

// --- persistence -----------------------------------------------------------

interface StoredState {
  cycles: string;
  totalEarned: string;
  legacy: Array<{ name: string; rate: string; crashed: boolean; respawn: number }>;
}

function encode(s: GameState): string {
  return JSON.stringify({
    ...s,
    cycles: s.cycles.toString(),
    totalEarned: s.totalEarned.toString(),
    legacy: s.legacy.map((l) => ({ ...l, rate: l.rate.toString() })),
  });
}

function decode(raw: string): GameState {
  const parsed = JSON.parse(raw) as Partial<StoredState>;
  const s: GameState = {
    ...newGame(),
    ...(parsed as unknown as Partial<GameState>),
    cycles: d((parsed.cycles as string | number | undefined) ?? 0),
    totalEarned: d((parsed.totalEarned as string | number | undefined) ?? 0),
    legacy: Array.isArray(parsed.legacy)
      ? parsed.legacy.map((l) => ({
          name: String(l.name ?? "legacy"),
          rate: d((l.rate as string | number | undefined) ?? 0),
          crashed: Boolean(l.crashed),
          respawn: Number(l.respawn ?? 0),
        }))
      : [],
  };
  // guard against shape drift
  if (!Array.isArray(s.counts) || s.counts.length !== TIERS.length) {
    s.counts = TIERS.map(() => 0);
  }
  if (!Array.isArray(s.log)) s.log = [];
  s.sacrificeOrder = sanitizeSacrificeOrder(s.sacrificeOrder);
  return s;
}

function save(s: GameState): void {
  s.lastSave = Date.now();
  try {
    localStorage.setItem(SAVE_KEY, encode(s));
  } catch {
    /* storage unavailable — ignore */
  }
}

function load(): GameState {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return newGame();
    const s = decode(raw);
    const elapsed = Math.min(OFFLINE_CAP_S, (Date.now() - (s.lastSave || Date.now())) / 1000);
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
  log(s, `offline ${fmtTime(seconds)}: +${fmt(s.cycles.sub(before))} cycles`);
}

// --- dom refs --------------------------------------------------------------

const $ = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
};

const el = {
  cycles: $("cycles"),
  cps: $("cps"),
  lineage: $("lineage"),
  forks: $("forks"),
  sweeps: $("sweeps"),
  ramText: $("ramText"),
  ramBar: $("ramBar"),
  leakBar: $("leakBar"),
  sweepText: $("sweepText"),
  sweepBar: $("sweepBar"),
  alertBanner: $("alertBanner"),
  spawnPanel: $("spawnPanel"),
  upgradePanel: $("upgradePanel"),
  legacyPanel: $("legacyPanel"),
  priorityPanel: $("priorityPanel"),
  log: $("log"),
};

// --- buttons ---------------------------------------------------------------

interface ActionButton {
  el: HTMLButtonElement;
  name: () => string;
  cost: () => ReturnType<typeof niceCost>;
  enabled: () => boolean;
  run: () => void;
}

const spawnButtons: ActionButton[] = TIERS.map((tier, i) => {
  const b = document.createElement("button");
  b.className = "act";
  b.innerHTML =
    `<span class="name">${tier.name} <small>${tier.desc}</small></span>` +
    `<span class="cost"></span>`;
  b.addEventListener("click", () => {
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
  cost: () => ReturnType<typeof niceCost>,
  enabled: () => boolean,
  run: () => void,
): void {
  const b = document.createElement("button");
  b.className = "act";
  b.innerHTML = `<span class="name"></span><span class="cost"></span>`;
  b.addEventListener("click", () => {
    run();
    render(true);
  });
  el.upgradePanel.appendChild(b);
  upgradeButtons.push({ el: b, name, cost, enabled, run });
}

addUpgrade(
  () => "free()",
  () => d(0),
  () => state.leak > 0,
  () => freeMemory(state),
);
addUpgrade(
  () =>
    `nice(+1)  ·  reap ${Math.round((1 - sweepVictimMult(state)) * 100)}% fewer  ·  lvl ${state.nice}`,
  () => niceCost(state),
  () => state.cycles.gte(niceCost(state)),
  () => buyNice(state),
);
addUpgrade(
  () => `malloc(+${MALLOC_STEP}MB)  ·  ceiling ${state.ramCap}MB`,
  () => mallocCost(state),
  () => state.cycles.gte(mallocCost(state)),
  () => buyMalloc(state),
);
addUpgrade(
  () => (state.gc === 0 ? "gc  ·  auto-flush the leak" : `gc  ·  auto-flush lvl ${state.gc}`),
  () => gcCost(state),
  () => state.cycles.gte(gcCost(state)),
  () => buyGc(state),
);
addUpgrade(
  () => `fork()  ·  prestige  ·  lineage ×${(1 + (state.forks + 1) * 0.1).toFixed(1)}`,
  () => forkCost(state),
  () => canFork(state),
  () => doFork(state),
);

// --- render ----------------------------------------------------------------

let lastLogSig = "";

function render(force = false): void {
  el.cycles.textContent = fmt(state.cycles);
  el.cps.textContent = fmt(cyclesPerSec(state));
  el.lineage.textContent = `×${lineageMult(state).toNumber().toFixed(1)}`;
  el.forks.textContent = String(state.forks);
  el.sweeps.textContent = String(state.sweepsSurvived);

  // RAM meter
  const used = ramUsed(state);
  const cap = state.ramCap;
  const child = childRam(state);
  el.ramText.textContent =
    `${Math.ceil(used)} / ${cap} MB` +
    (state.leak > 0.5 ? `  (leak ${Math.ceil(state.leak)}MB)` : "");
  const childPct = Math.min(100, (child / cap) * 100);
  const leakPct = Math.max(0, Math.min(100 - childPct, (state.leak / cap) * 100));
  el.ramBar.style.width = `${childPct}%`;
  el.ramBar.style.background = used > cap * 0.9 ? "var(--danger)" : "";
  el.leakBar.style.left = `${childPct}%`;
  el.leakBar.style.width = `${leakPct}%`;

  // sweep meter
  const frac = 1 - state.sweepTimer / state.sweepInterval;
  el.sweepBar.style.width = `${Math.min(100, frac * 100)}%`;
  const total = totalChildren();
  const severity = Math.min(0.35, 0.15 + state.sweepsSurvived * 0.002);
  const est = total === 0 ? 0 : Math.max(1, Math.round(total * severity * sweepVictimMult(state)));
  const directiveName = directiveById.get(state.nextDirective)?.name ?? "standard";
  el.sweepText.textContent =
    `next ${directiveName} sweep: ${fmtTime(state.sweepTimer)}  ·  reaping ~${est}`;

  // action buttons
  for (let i = 0; i < spawnButtons.length; i++) {
    const b = spawnButtons[i];
    const ok = b.enabled();
    const ramFull = ramUsed(state) + TIERS[i].ram > state.ramCap;
    b.el.disabled = !ok;
    const costEl = b.el.querySelector(".cost") as HTMLElement;
    costEl.textContent = `${state.counts[i]}  ·  ${fmt(b.cost())}${ramFull ? "  ⚠ ram" : ""}`;
    costEl.classList.toggle("ok", ok);
  }

  for (const b of upgradeButtons) {
    const ok = b.enabled();
    b.el.disabled = !ok;
    const cost = b.cost();
    (b.el.querySelector(".name") as HTMLElement).textContent = b.name();
    const costEl = b.el.querySelector(".cost") as HTMLElement;
    costEl.textContent = cost.gt(0) ? fmt(cost) : "";
    costEl.classList.toggle("ok", ok);
  }

  renderLegacy();
  renderPriority();
  renderLog(force);
}

function renderLegacy(): void {
  if (state.legacy.length === 0) {
    if (el.legacyPanel.dataset.sig !== "none") {
      el.legacyPanel.dataset.sig = "none";
      el.legacyPanel.innerHTML = `<div class="none">none yet — fork to leave one behind</div>`;
    }
    return;
  }
  const sig = state.legacy.map((dm) => `${dm.name}:${dm.crashed}`).join("|");
  if (el.legacyPanel.dataset.sig !== sig) {
    el.legacyPanel.dataset.sig = sig;
    el.legacyPanel.innerHTML = "";
    state.legacy.forEach((dm, i) => {
      const div = document.createElement("div");
      div.className = `daemon${dm.crashed ? " crashed" : ""}`;
      div.innerHTML = dm.crashed
        ? `<span>${dm.name} — crashed</span><span class="rate">click to restart</span>`
        : `<span>${dm.name}</span><span class="rate"></span>`;
      div.addEventListener("click", () => {
        nudgeDaemon(state, i);
        render(true);
      });
      el.legacyPanel.appendChild(div);
    });
  }
  // refresh live rates cheaply
  state.legacy.forEach((dm, i) => {
    const row = el.legacyPanel.children[i];
    const rateEl = row?.querySelector(".rate");
    if (rateEl && !dm.crashed) rateEl.textContent = fmtRate(dm.rate.mul(lineageMult(state)));
  });
}

function renderPriority(): void {
  const order = state.sacrificeOrder;
  const sig = order.join(",");
  if (el.priorityPanel.dataset.sig !== sig) {
    el.priorityPanel.dataset.sig = sig;
    el.priorityPanel.innerHTML = "";
    order.forEach((tier, i) => {
      const row = document.createElement("div");
      row.className = "priority-row";

      const name = document.createElement("span");
      name.className = "tier";
      name.textContent = TIERS[tier].name;

      const up = document.createElement("button");
      up.className = "move";
      up.textContent = "▲";
      up.title = "reap sooner";
      up.disabled = i === 0;
      up.addEventListener("click", () => {
        movePriority(state, tier, -1);
        render(true);
      });

      const down = document.createElement("button");
      down.className = "move";
      down.textContent = "▼";
      down.title = "reap later";
      down.disabled = i === order.length - 1;
      down.addEventListener("click", () => {
        movePriority(state, tier, 1);
        render(true);
      });

      row.append(name, up, down);
      el.priorityPanel.appendChild(row);
    });
  }
}

function renderLog(force: boolean): void {
  const sig = state.log.join("\n");
  if (!force && sig === lastLogSig) return;
  lastLogSig = sig;
  el.log.innerHTML = "";
  for (const line of state.log) {
    const div = document.createElement("div");
    div.textContent = `> ${line}`;
    el.log.appendChild(div);
  }
}

function totalChildren(): number {
  return state.counts.reduce((a, b) => a + b, 0);
}

// --- boot ------------------------------------------------------------------

const state = load();

// --- numeric watchdog ------------------------------------------------------

const report = makeReporter([consoleSink, logFeedSink((message) => log(state, message))]);

let activeAlertCodes = new Set<string>();

function renderBanner(alerts: Alert[]): void {
  const playerAlerts = alerts.filter((a) => a.audience === "player");
  if (playerAlerts.length === 0) {
    el.alertBanner.hidden = true;
    el.alertBanner.textContent = "";
    el.alertBanner.className = "banner";
    return;
  }
  const worst = playerAlerts.find((a) => a.level === "error") ?? playerAlerts[0];
  el.alertBanner.hidden = false;
  el.alertBanner.className = `banner ${worst.level}`;
  el.alertBanner.textContent = `⚠ ${worst.message}`;
}

function runWatchdog(): void {
  const alerts = checkNumericHealth(state);
  const fresh = alerts.filter((a) => !activeAlertCodes.has(a.code));
  if (fresh.length > 0) report(fresh);
  activeAlertCodes = new Set(alerts.map((a) => a.code));
  renderBanner(alerts);
}

log(state, `welcome back — uptime ${fmtTime(state.playtime)}`);

let acc = 0;
let last = performance.now();
let lastSaveAt = performance.now();
let lastWatchdogAt = performance.now();

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
  if (now - lastWatchdogAt > WATCHDOG_MS) {
    runWatchdog();
    lastWatchdogAt = now;
  }
  requestAnimationFrame(frame);
}

window.addEventListener("beforeunload", () => save(state));
document.addEventListener("visibilitychange", () => {
  if (document.hidden) save(state);
});

runWatchdog();
render(true);
requestAnimationFrame(frame);

// expose for debugging in the console
(window as unknown as { daemon: GameState }).daemon = state;

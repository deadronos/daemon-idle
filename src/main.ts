import {
  type GameState,
  HEAT_THROTTLE_AT,
  MALLOC_STEP,
  TIERS,
  buyCooling,
  buyGc,
  buyMalloc,
  buyNice,
  buyPerk,
  buyShield,
  canFork,
  canSpawn,
  childRam,
  coolCost,
  cyclesPerSec,
  directiveById,
  doFork,
  estimateVictims,
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
  offlineCapS,
  offlineCost,
  buyOfflineCap,
  ramCapTotal,
  ramUsed,
  shieldCost,
  spawn,
  spawnMax,
  sweepVictimMult,
  tick,
  tierCost,
} from "./sim";
import { d } from "./bignum";
import {
  PERKS,
  canBuyPerk,
  perkById,
  perkCost,
  perkMods,
  pointsForFork,
  type PerkDef,
} from "./perks";
import {
  MILESTONES,
  METRICS,
  hasUnlock,
  milestoneProgress,
  orderedMilestones,
  UNLOCK,
  type MetricId,
} from "./milestones";
import { type Alert, checkNumericHealth } from "./diagnostics";
import { consoleSink, logFeedSink, makeReporter } from "./report";
import { fmt, fmtRate, fmtTime } from "./format";
import { encode, loadFrom } from "./persistence";

const SAVE_KEY = "daemon-idle-save-v1";
const TICK_MS = 50; // fixed sim step
const AUTOSAVE_MS = 10_000;
const WATCHDOG_MS = 1000;

// --- persistence -----------------------------------------------------------

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
    return loadFrom(raw, Date.now());
  } catch {
    return newGame();
  }
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
  heatText: $("heatText"),
  heatBar: $("heatBar"),
  shieldRow: $("shieldRow"),
  shieldText: $("shieldText"),
  alertBanner: $("alertBanner"),
  spawnPanel: $("spawnPanel"),
  upgradePanel: $("upgradePanel"),
  legacyPanel: $("legacyPanel"),
  priorityPanel: $("priorityPanel"),
  perkSection: $("perkSection"),
  lineageText: $("lineageText"),
  lineageNext: $("lineageNext"),
  perkPanel: $("perkPanel"),
  milestonePanel: $("milestonePanel"),
  buyMaxWrap: $("buyMaxWrap"),
  buyMaxToggle: $<HTMLInputElement>("buyMaxToggle"),
  autoWrap: $("autoWrap"),
  autoNiceToggle: $<HTMLInputElement>("autoNiceToggle"),
  autoMallocToggle: $<HTMLInputElement>("autoMallocToggle"),
  autoFreeToggle: $<HTMLInputElement>("autoFreeToggle"),
  freeThresholdInput: $<HTMLInputElement>("freeThresholdInput"),
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
    if (state.buyMax && hasUnlock(state, UNLOCK.buyMax)) spawnMax(state, i);
    else spawn(state, i);
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

el.buyMaxToggle.addEventListener("change", () => {
  state.buyMax = el.buyMaxToggle.checked;
  render(true);
});

el.autoNiceToggle.addEventListener("change", () => {
  state.autoNice = el.autoNiceToggle.checked;
  render(true);
});
el.autoMallocToggle.addEventListener("change", () => {
  state.autoMalloc = el.autoMallocToggle.checked;
  render(true);
});
el.autoFreeToggle.addEventListener("change", () => {
  state.autoFree = el.autoFreeToggle.checked;
  render(true);
});
el.freeThresholdInput.addEventListener("change", () => {
  state.freeThreshold = Math.max(0, Math.floor(Number(el.freeThresholdInput.value) || 0));
  render(true);
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
    hasUnlock(state, UNLOCK.nice)
      ? `nice(+1)  ·  reap ${Math.round((1 - sweepVictimMult(state)) * 100)}% fewer  ·  lvl ${state.nice}`
      : `🔒 nice  ·  ${unlockSource(UNLOCK.nice)}`,
  () => niceCost(state),
  () => hasUnlock(state, UNLOCK.nice) && state.cycles.gte(niceCost(state)),
  () => buyNice(state),
);
addUpgrade(
  () => `malloc(+${MALLOC_STEP}MB)  ·  ceiling ${state.ramCap}MB`,
  () => mallocCost(state),
  () => state.cycles.gte(mallocCost(state)),
  () => buyMalloc(state),
);
addUpgrade(
  () =>
    `SIGTERM handler  ·  ${state.shields} charge${state.shields === 1 ? "" : "s"}  ·  absorb sweep victims`,
  () => shieldCost(state),
  () => state.cycles.gte(shieldCost(state)),
  () => buyShield(state),
);
addUpgrade(
  () =>
    hasUnlock(state, UNLOCK.gc)
      ? state.gc === 0
        ? "gc  ·  auto-flush the leak"
        : `gc  ·  auto-flush lvl ${state.gc}`
      : `🔒 gc  ·  ${unlockSource(UNLOCK.gc)}`,
  () => gcCost(state),
  () => hasUnlock(state, UNLOCK.gc) && state.cycles.gte(gcCost(state)),
  () => buyGc(state),
);
addUpgrade(
  () =>
    state.cooling === 0
      ? "cooling  ·  heat sheds faster"
      : `cooling  ·  heat sheds faster  ·  lvl ${state.cooling}`,
  () => coolCost(state),
  () => state.cycles.gte(coolCost(state)),
  () => buyCooling(state),
);
addUpgrade(
  () => `fork()  ·  prestige  ·  lineage ×${(1 + (state.forks + 1) * 0.1).toFixed(1)}`,
  () => forkCost(state),
  () => canFork(state),
  () => doFork(state),
);
addUpgrade(
  () => `nohup(+4h)  ·  offline cap ${Math.round(offlineCapS(state) / 3600)}h`,
  () => offlineCost(state),
  () => state.cycles.gte(offlineCost(state)),
  () => buyOfflineCap(state),
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
  const cap = ramCapTotal(state);
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
  const directiveName = directiveById.get(state.nextDirective)?.name ?? "standard";
  el.sweepText.textContent = `next ${directiveName} sweep: ${fmtTime(state.sweepTimer)}  ·  reaping ~${estimateVictims(state)}`;

  // heat meter — throttles income above HEAT_THROTTLE_AT
  el.heatText.textContent = `heat ${Math.round(state.heat)} / 100`;
  el.heatBar.style.width = `${Math.min(100, state.heat)}%`;
  const hot = state.heat > HEAT_THROTTLE_AT;
  el.heatBar.style.background = hot ? "var(--danger)" : "";
  el.heatText.style.color = hot ? "var(--danger)" : "";

  // shields readout — only meaningful while charges remain
  el.shieldRow.hidden = state.shields <= 0;
  el.shieldText.textContent = String(state.shields);

  // action buttons
  el.buyMaxWrap.hidden = !hasUnlock(state, UNLOCK.buyMax);
  el.buyMaxToggle.checked = state.buyMax;
  el.autoWrap.hidden = !hasUnlock(state, UNLOCK.autoNice);
  el.autoNiceToggle.checked = state.autoNice;
  el.autoMallocToggle.checked = state.autoMalloc;
  el.autoFreeToggle.checked = state.autoFree;
  // don't clobber a field the user is typing into (change fires on blur/Enter only)
  if (document.activeElement !== el.freeThresholdInput) {
    el.freeThresholdInput.value = String(state.freeThreshold);
  }
  const maxOn = state.buyMax && hasUnlock(state, UNLOCK.buyMax);
  for (let i = 0; i < spawnButtons.length; i++) {
    const b = spawnButtons[i];
    const ok = b.enabled();
    const ramFull = ramUsed(state) + TIERS[i].ram > ramCapTotal(state);
    b.el.disabled = !ok;
    const costEl = b.el.querySelector(".cost") as HTMLElement;
    costEl.textContent = `${state.counts[i]}  ·  ${fmt(b.cost())}${maxOn ? "  ×max" : ""}${ramFull ? "  ⚠ ram" : ""}`;
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
  renderPerks();
  renderMilestones();
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

      const name = document.createElement("span");
      name.textContent = dm.crashed ? `${dm.name} — crashed` : dm.name;

      const rate = document.createElement("span");
      rate.className = "rate";
      if (dm.crashed) rate.textContent = "click to restart";

      div.append(name, rate);
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
    if (rateEl && !dm.crashed)
      rateEl.textContent = fmtRate(
        dm.rate.mul(lineageMult(state)).mul(perkMods(state).legacyRateMult),
      );
  });
}

const METRIC_UNIT: Partial<Record<MetricId, string>> = {
  totalEarned: "cycles",
  sweepsSurvived: "sweeps",
  forks: "forks",
  playtime: "s",
  children: "children",
  ramCap: "MB",
};

/** Name of the milestone that grants `unlockId` (for the locked-upgrade hint). */
function unlockSource(unlockId: string): string {
  return MILESTONES.find((m) => m.unlocks.includes(unlockId))?.name ?? "locked";
}

/**
 * The milestones panel: pending first (closest to firing on top), achieved dimmed below.
 * Rows are rebuilt only when the done/unlock sets change; progress refreshes each frame.
 */
function renderMilestones(): void {
  const ordered = orderedMilestones(state);
  const sig = `${ordered.map((m) => m.id).join(",")}|${Object.keys(state.unlocks).sort().join(",")}`;
  if (el.milestonePanel.dataset.sig !== sig) {
    el.milestonePanel.dataset.sig = sig;
    el.milestonePanel.innerHTML = "";
    for (const m of ordered) {
      const row = document.createElement("div");
      row.className = "milestone";
      row.dataset.milestone = m.id;

      const head = document.createElement("div");
      head.className = "milestone-head";
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = m.name;
      const status = document.createElement("span");
      status.className = "status";
      head.append(name, status);

      const bar = document.createElement("div");
      bar.className = "bar";
      const fill = document.createElement("div");
      fill.className = "fill";
      bar.appendChild(fill);

      const desc = document.createElement("p");
      desc.className = "hint";
      desc.textContent = m.desc;

      row.append(head, bar, desc);
      el.milestonePanel.appendChild(row);
    }
  }

  for (const m of ordered) {
    const row = el.milestonePanel.querySelector(`[data-milestone="${m.id}"]`);
    if (!row) continue;
    const doneNow = Boolean(state.milestonesDone[m.id]);
    row.classList.toggle("done", doneNow);
    const fill = row.querySelector(".fill") as HTMLElement;
    const status = row.querySelector(".status") as HTMLElement;
    if (doneNow) {
      fill.style.width = "100%";
      status.textContent = `✓ unlocked: ${m.unlocks.join(", ")}`;
    } else {
      const value = Math.floor(METRICS[m.metric](state));
      fill.style.width = `${Math.min(100, milestoneProgress(state, m) * 100)}%`;
      const unit = METRIC_UNIT[m.metric] ? ` ${METRIC_UNIT[m.metric]}` : "";
      status.textContent = `${value} / ${m.at}${unit}`;
    }
  }
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
      up.setAttribute("aria-label", `reap ${TIERS[tier].name} sooner`);
      up.disabled = i === 0;
      up.addEventListener("click", () => {
        movePriority(state, tier, -1);
        render(true);
      });

      const down = document.createElement("button");
      down.className = "move";
      down.textContent = "▼";
      down.title = "reap later";
      down.setAttribute("aria-label", `reap ${TIERS[tier].name} later`);
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

/** Human-readable effect of a node, from its `mod`/`perLevel`. */
function perkEffectText(p: PerkDef): string {
  const v = p.perLevel;
  let text: string;
  switch (p.mod) {
    case "incomeMult":
      text = `+${Math.round(v * 100)}% income`;
      break;
    case "rootMult":
      text = `root ×${1 + v}`;
      break;
    case "tierCostMult":
      text = `−${Math.round(v * 100)}% tier cost`;
      break;
    case "niceAdd":
      text = `+${v} nice`;
      break;
    case "ramCapAdd":
      text = `+${v} MB ram`;
      break;
    case "heatGenMult":
      text = `−${Math.round(v * 100)}% heat`;
      break;
    case "startShieldsAdd":
      text = `+${v} start shield`;
      break;
    case "forkCostMult":
      text = `−${Math.round(v * 100)}% fork cost`;
      break;
    case "pointsMult":
      text = `+${Math.round(v * 100)}% points`;
      break;
    case "legacyRateMult":
      text = `legacy ×${1 + v}`;
      break;
    case "startCycles":
      text = `+${v} start cycles`;
      break;
  }
  return p.maxLevel === Infinity ? `${text} · √L` : text;
}

/** Depth of a node in its branch's prerequisite chain (branch roots are 0). */
function perkDepth(p: PerkDef): number {
  let depth = 0;
  let cur: PerkDef | undefined = p;
  while (cur?.requires) {
    const next = PERKS.find((q) => q.id === cur!.requires);
    if (!next) break;
    depth++;
    cur = next;
    if (depth > PERKS.length) break; // cycle guard; the roster is a DAG
  }
  return depth;
}

/**
 * The prestige / perk-tree panel. Hidden until the player has forked at least once
 * (fork #1 creates the first claimable points). Nodes are rebuilt only when lineage or
 * the owned perks change; the "next fork" preview updates every frame.
 */
function renderPerks(): void {
  const show = state.forks >= 1;
  el.perkSection.hidden = !show;
  if (!show) return;

  el.lineageText.textContent = `${state.lineage} pt`;
  el.lineageNext.textContent = String(
    Math.floor(pointsForFork(state) * perkMods(state).pointsMult),
  );

  const owned = Object.entries(state.perks)
    .filter(([, lvl]) => lvl > 0)
    .map(([id, lvl]) => `${id}${lvl}`)
    .sort()
    .join(",");
  const sig = `${state.lineage}|${owned}`;
  if (el.perkPanel.dataset.sig === sig) return;
  el.perkPanel.dataset.sig = sig;
  el.perkPanel.innerHTML = "";

  for (const branch of ["growth", "survival", "lineage"] as const) {
    const col = document.createElement("div");
    col.className = "perk-branch";
    const head = document.createElement("div");
    head.className = "perk-branch-head";
    head.textContent = branch;
    col.appendChild(head);

    const nodes = PERKS.filter((p) => p.branch === branch).sort(
      (a, b) => perkDepth(a) - perkDepth(b),
    );
    for (const p of nodes) {
      const level = state.perks[p.id] ?? 0;
      const cost = perkCost(state, p.id);
      const b = document.createElement("button");
      b.className = "act perk";
      const effect = perkEffectText(p);
      const req = p.requires ? `  ← ${perkById(p.requires)?.name ?? p.requires}` : "";
      b.innerHTML =
        `<span class="name">${p.name} <small>${effect}${req}</small></span>` +
        `<span class="cost"></span>`;
      b.disabled = !canBuyPerk(state, p.id);
      const costEl = b.querySelector(".cost") as HTMLElement;
      costEl.textContent = `L${level}  ·  ${cost}pt${p.maxLevel === Infinity ? "  ∞" : ""}`;
      costEl.classList.toggle("ok", !b.disabled);
      b.addEventListener("click", () => {
        buyPerk(state, p.id);
        render(true);
      });
      col.appendChild(b);
    }
    el.perkPanel.appendChild(col);
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

// --- boot ------------------------------------------------------------------

const state = load();
// Persist the load-time `lastSave` stamp immediately: without this, a hard kill before the
// first autosave would leave the on-disk stamp unchanged and re-apply the offline window.
save(state);

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

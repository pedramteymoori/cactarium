// Cactarium dashboard, structured after Glasshouse's ui/ scripts (MIT, Copyright (c) 2026 Rory Gallagher).
'use strict';
// The Metrics tab: temperature trace, system readouts, storage, HDMI ports and
// the expandable process lists. History is kept here, in the page, as in Glasshouse.

/* ================= metrics ================= */
let sysTimer = 0;
let cpuTimer = 0;
let cpuInFlight = false;
let tempHist = [];
let tempAt = 0;

const TEMP_WARN = 75, TEMP_CRIT = 85;
const TRACE_SLOTS = 56, TEMP_KEEP = 240;

function startMetrics() {
  if (S) renderMetrics(S.stats);
  metricsLoop();
  if ($('#disc-cpu').open) startCpuPolling();
}
function stopMetrics() { clearTimeout(sysTimer); sysTimer = 0; stopCpuPolling(); }

async function metricsLoop() {
  clearTimeout(sysTimer);
  if (activeTab !== 'metrics') return;
  if (!document.hidden) {
    try { renderMetrics(await api('/api/stats')); } catch (_) { /* ignore */ }
  }
  sysTimer = setTimeout(metricsLoop, 2000);
}

// The hero stays white through the normal band and takes colour only when something is wrong.
function thermal(c) { return c >= TEMP_CRIT ? 'var(--red)' : c >= TEMP_WARN ? 'var(--cand)' : 'var(--w100)'; }
function headroom(pct, warn) { return pct >= warn ? 'var(--red)' : pct >= warn * 0.8 ? 'var(--cand)' : 'var(--green)'; }

function metricRow(k, val, pct, sub, warn, flat) {
  $('#val-' + k).innerHTML = val; // numbers and a unit only, built here
  const bar = $('#bar-' + k);
  bar.style.width = clamp(pct, 0, 100) + '%';
  bar.style.background = flat ? 'var(--w60)' : headroom(pct, warn);
  setText($('#sub-' + k), sub || '');
  $('#row-' + k).classList.toggle('hi', pct >= warn);
}

function drawTrace(vals) {
  const host = $('#trace');
  if (!vals.length) { host.textContent = ''; return; }
  const lo = Math.min(...vals), hi = Math.max(...vals), span = (hi - lo) || 1;
  const recent = vals.slice(-TRACE_SLOTS);
  // Always lay out every slot, right-aligned, so two samples are not two slabs.
  const kids = [];
  for (let i = recent.length; i < TRACE_SLOTS; i++) kids.push(h('i', { class: 'void' }));
  recent.forEach((v, i) => {
    const cls = i === recent.length - 1 ? 'now' : (i > recent.length - 14 ? 'warm' : '');
    const bar = h('i', { class: cls });
    bar.style.height = (8 + (v - lo) / span * 92) + '%';
    kids.push(bar);
  });
  host.replaceChildren(...kids);
}

function renderTemperature(st) {
  const temps = st.temps || [];
  const hot = temps.reduce((a, t) => (!a || t.c > a.c) ? t : a, null);
  const has = !!hot;
  $('#tempblock').hidden = !has && !tempHist.length;
  setText($('#temp'), has ? hot.c.toFixed(0) : '—');
  $('#degsym').hidden = !has;
  $('#tempbig').classList.toggle('none', !has);
  if (has) {
    document.documentElement.style.setProperty('--hot', thermal(hot.c));
    // applyState and the 2 s loop both land here; count each sample once.
    if (st.time !== tempAt) tempHist.push(Math.round(hot.c));
    tempAt = st.time;
    if (tempHist.length > TEMP_KEEP) tempHist.shift();
  }
  drawTrace(tempHist);
  setText($('#trange'), tempHist.length ? 'MIN ' + Math.min(...tempHist) + '   MAX ' + Math.max(...tempHist) : (has ? 'WARMING UP' : 'NO THERMAL SENSOR'));
  setText($('#tempname'), has ? hot.name : '');
}

function renderReadouts(st) {
  const cores = st.cpu_cores || [];
  const cpu = Number(st.cpu_percent) || 0;
  metricRow('cpu', cpu.toFixed(0) + '<small>%</small>', cpu, cores.map(p => p.toFixed(0) + '%').join('  ·  '), 85);

  const memTotal = Number(st.mem_total_kb) || 0;
  const memUsed = memTotal - (Number(st.mem_avail_kb) || 0);
  const mu = memTotal ? memUsed / memTotal * 100 : 0;
  metricRow('mem', mu.toFixed(0) + '<small>%</small>', mu, memTotal ? Math.round(memUsed / 1024) + ' / ' + Math.round(memTotal / 1024) + ' MB' : '', 90);

  const swapTotal = Number(st.swap_total_kb) || 0;
  $('#row-swap').hidden = !swapTotal;
  if (swapTotal) {
    const used = swapTotal - (Number(st.swap_free_kb) || 0);
    const su = used / swapTotal * 100;
    metricRow('swap', su.toFixed(0) + '<small>%</small>', su, Math.round(used / 1024) + ' / ' + Math.round(swapTotal / 1024) + ' MB', 70);
  }

  // The link in use: Wi-Fi when the TV has it, else the busiest interface.
  const ifs = st.net || [];
  const wf = st.wifi;
  const link = (wf && ifs.find(n => n.name === wf.iface)) || ifs.slice().sort((a, b) => (b.rx_bytes + b.tx_bytes) - (a.rx_bytes + a.tx_bytes))[0];
  $('#row-net').hidden = !link;
  if (link) {
    const rx = (Number(link.rx_rate) || 0) / 1024, tx = (Number(link.tx_rate) || 0) / 1024;
    const parts = [];
    if (wf && wf.level_dbm) parts.push(Math.round(wf.level_dbm) + ' dBm');
    if (tx > 0) parts.push(tx.toFixed(0) + ' kB/s up');
    parts.push('↓ ' + humanBytes(link.rx_bytes) + ' ↑ ' + humanBytes(link.tx_bytes));
    // Throughput has no threshold to cross, so its bar is not coloured by level.
    metricRow('net', rx.toFixed(0) + '<small>kB/s</small>', Math.min(100, rx / 20), parts.join('  ·  '), 101, true);
  }

  const addrs = [st.hostname].concat(st.addresses || []).filter(Boolean);
  $('#row-addr').hidden = !addrs.length;
  $('#sub-addr').replaceChildren(...addrs.flatMap((a, i) => i ? [h('br'), a] : [a]));
}

function renderStorage(st) {
  const disks = st.storage || [];
  const app = disks.find(d => d.path === '/mtd_rwarea') || disks[0];
  $('#appstore-cell').hidden = !app;
  const other = [];
  if (app) {
    const gb = b => (b / 1073741824).toFixed(1);
    const tot = pick(app, 'total_b', 'TotalB'), free = pick(app, 'free_b', 'FreeB');
    setText($('#appstore'), gb(free));
    setText($('#appstore-sub'), (tot ? Math.round((tot - free) / tot * 100) : 0) + '% of ' + gb(tot) + ' GB used');
    disks.filter(d => d !== app).forEach(d => {
      other.push(d.path + ': ' + humanBytes(pick(d, 'free_b', 'FreeB')) + ' free of ' + humanBytes(pick(d, 'total_b', 'TotalB')));
    });
  }
  setText($('#store-other'), other.join('  ·  '));

  const fl = st.flash;
  $('#flash-row').hidden = !fl;
  if (fl) {
    setText($('#flash-wear'), (fl.wear || '').replace('-', '–') || '—');
    // The flash reports wear in tenths of its life, one segment each.
    const upper = /(\d+)%/.exec((fl.wear || '').replace(/^.*-/, ''));
    const tenths = upper ? Math.min(10, Math.ceil(parseInt(upper[1], 10) / 10)) : /exceed/i.test(fl.wear) ? 10 : 0;
    const meter = $('#flash-meter');
    if (meter.dataset.tenths !== String(tenths)) {
      meter.dataset.tenths = String(tenths);
      meter.replaceChildren(...Array.from({ length: 10 }, (_, i) => h('i', { class: i < tenths ? 'on' : '' })));
    }
    const health = $('#flash-health');
    health.className = 'pill ' + (fl.eol === 'Urgent' ? 'bad' : fl.eol === 'Warning' ? 'warn' : fl.eol === 'Normal' ? 'good' : 'idle');
    setText(health, fl.eol || '—');
  }
  $('#storeblock').hidden = !app && !fl;
}

function renderSystemInfo(st) {
  setText($('#sysUp'), st.uptime_sec ? humanUptime(st.uptime_sec) : '--');
  setText($('#sysLoad'), st.load ? st.load.map(x => x.toFixed(2)).join('  ') : '--');
  setText($('#sysProcs'), st.procs || '--');
  const self = st.self || {};
  setText($('#sysRss'), self.rss_kb ? humanBytes(self.rss_kb * 1024) : '--');
  setText($('#sysGo'), self.goroutines || '--');
}

const pick = (o, a, b) => (o[a] ?? o[b] ?? 0);

function renderMetrics(st) {
  if (!st) return;
  renderTemperature(st);
  renderReadouts(st);
  renderStorage(st);
  renderSystemInfo(st);
  renderHdmi();
}

/* ---- HDMI ports: from the PHI bridge's input list, carried in /api/state ---- */
function hdmiJack() {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'port-jack');
  svg.setAttribute('viewBox', '0 0 26 15');
  svg.setAttribute('width', '22');
  svg.setAttribute('height', '13');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', 'M 3,2 H 23 V 8 L 20,13 H 6 L 3,8 Z');
  path.setAttribute('fill', 'none'); path.setAttribute('stroke', 'currentColor'); path.setAttribute('stroke-width', '1.3');
  const bar = document.createElementNS(NS, 'rect');
  for (const [k, v] of [['x', 7], ['y', 5], ['width', 12], ['height', 2], ['rx', 0.5]]) bar.setAttribute(k, v);
  bar.setAttribute('fill', 'currentColor');
  svg.append(path, bar);
  return svg;
}

function hdmiPort(i) {
  let cls, state, label;
  if (i.current) { cls = 'port live'; state = 'Active'; label = i.name; }
  else if (i.connected === false) { cls = 'port empty'; state = 'Empty'; label = 'Unconnected'; }
  else { cls = 'port seen'; state = i.connected ? 'Idle' : 'Unknown'; label = i.name; }
  const el = h('div', { class: cls },
    h('div', { class: 'ptop' },
      h('span', { class: 'pn num', text: i.port }),
      h('div', { class: 'pstatus-wrap' }, hdmiJack(), h('span', { class: 'pst', text: state }))),
    h('div', { class: 'pl', text: label }));
  if (i.name !== i.label && i.label && !(i.connected === false)) el.append(h('div', { class: 'pd', text: i.label }));
  return el;
}

function renderHdmi() {
  const tv = S && S.tv;
  const ports = ((tv && tv.inputs) || []).filter(i => i.kind === 'hdmi');
  const block = $('#hdmiblock');
  block.hidden = !tv || !tv.reachable;
  if (block.hidden) return;
  const act = ports.find(i => i.current);
  setText($('#hdmi-cur'), ports.length ? ': ' + (act ? act.name : 'no active input') : '');
  const sig = JSON.stringify(ports);
  const grid = $('#hdmi-grid');
  if (grid.dataset.sig === sig) return;
  grid.dataset.sig = sig;
  if (!ports.length) { grid.replaceChildren(h('div', { class: 'sub', text: 'Not available while an app is open.' })); return; }
  grid.replaceChildren(...ports.map(hdmiPort));
}

/* ---- process lists: read only while their disclosure is open ---- */
function procRow(p, val) {
  return h('div', { class: 'proc' },
    h('div', { class: 'p-name' }, p.name, h('span', { class: 'p-pid', text: p.pid })),
    h('div', { class: 'p-mb', text: val }));
}

async function loadProcesses() {
  const list = $('#proc-list');
  try {
    const d = await api('/api/processes');
    if (!d.ok) throw new Error(d.error || 'failed');
    setText($('#proc-cur'), d.count + ' running · ' + Math.round(d.total_mb).toLocaleString() + ' MB resident');
    list.replaceChildren(...d.top.map(p => procRow(p, p.mb.toFixed(1) + ' MB')));
  } catch (e) {
    list.replaceChildren(h('div', { class: 'sub', text: 'Could not read the process list — ' + e.message }));
  }
}

async function loadCpuProcesses() {
  // Each read holds the request open for the length of the sample, so a slow one must not stack.
  if (cpuInFlight) return;
  cpuInFlight = true;
  const list = $('#cpu-list');
  if (!list.firstChild) list.replaceChildren(h('div', { class: 'sub', text: 'Measuring…' }));
  try {
    const d = await api('/api/cpu');
    if (!d.ok) throw new Error(d.error || 'failed');
    setText($('#cpu-cur'), d.busy.toFixed(1) + '% busy · ' + d.top.length + ' active');
    list.replaceChildren(...(d.top.length ? d.top.map(p => procRow(p, p.pct.toFixed(1) + '%'))
      : [h('div', { class: 'sub', text: 'Nothing used any CPU over the sample.' })]));
  } catch (e) {
    list.replaceChildren(h('div', { class: 'sub', text: 'Could not measure CPU usage — ' + e.message }));
  } finally {
    cpuInFlight = false;
  }
}

function startCpuPolling() {
  if (cpuTimer) return;
  loadCpuProcesses();
  cpuTimer = setInterval(loadCpuProcesses, 3000);
}
function stopCpuPolling() { clearInterval(cpuTimer); cpuTimer = 0; }

$('#disc-proc').addEventListener('toggle', e => { if (e.target.open) loadProcesses(); });
$('#disc-cpu').addEventListener('toggle', e => { if (e.target.open && activeTab === 'metrics') startCpuPolling(); else stopCpuPolling(); });

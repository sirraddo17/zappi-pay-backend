// Server check (the VPS the API runs on): memory, swap, disk, load and
// uptime — read from the operating system, nothing changed. Used by
// Admin → 🗄️ Server & Database, the hourly watch and the admin AI.

const os = require('os');
const fs = require('fs');

const MB = 1024 * 1024;

function meminfo() {
  try {
    const raw = fs.readFileSync('/proc/meminfo', 'utf8');
    const get = (k) => { const m = new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(raw); return m ? Number(m[1]) * 1024 : null; };
    return { available: get('MemAvailable'), swapTotal: get('SwapTotal'), swapFree: get('SwapFree') };
  } catch {
    return {};
  }
}

function disk(p = '/') {
  try {
    if (typeof fs.statfsSync !== 'function') return null;
    const s = fs.statfsSync(p);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    return { totalGb: Math.round((total / 1024 ** 3) * 10) / 10, freeGb: Math.round((free / 1024 ** 3) * 10) / 10, usedPct: total ? Math.round(((total - free) / total) * 1000) / 10 : null };
  } catch {
    return null;
  }
}

function check() {
  const m = meminfo();
  const total = os.totalmem();
  const available = m.available ?? os.freemem();
  const cpus = os.cpus()?.length || 1;
  const load = os.loadavg();
  return {
    memory: { totalMb: Math.round(total / MB), availableMb: Math.round(available / MB), usedPct: Math.round(((total - available) / total) * 1000) / 10 },
    swap: m.swapTotal ? { totalMb: Math.round(m.swapTotal / MB), usedMb: Math.round((m.swapTotal - (m.swapFree || 0)) / MB) } : { totalMb: 0, usedMb: 0 },
    disk: disk('/'),
    cpu: { cores: cpus, load1: Math.round(load[0] * 100) / 100, load15: Math.round(load[2] * 100) / 100 },
    uptimeDays: Math.round((os.uptime() / 86400) * 10) / 10,
    apiUpMinutes: Math.round(process.uptime() / 60),
    apiMemoryMb: Math.round(process.memoryUsage().rss / MB),
    node: process.version,
    host: os.hostname(),
    checkedAt: new Date(),
  };
}

function warnings(s) {
  const w = [];
  if (s.memory.availableMb < 80) w.push({ level: 'bad', text: `The server has only ${s.memory.availableMb} MB of memory free — the app may crash. Restart it (pm2 restart zappi-pay-api) and consider a bigger VPS.` });
  else if (s.memory.availableMb < 150) w.push({ level: 'warn', text: `The server is low on memory (${s.memory.availableMb} MB free).` });
  if (s.swap.totalMb && s.swap.usedMb / s.swap.totalMb > 0.5) w.push({ level: 'warn', text: `The server is using ${s.swap.usedMb} MB of swap — it is short of memory.` });
  if (s.disk?.usedPct >= 95) w.push({ level: 'bad', text: `The server disk is ${s.disk.usedPct}% full (${s.disk.freeGb} GB free). Clear old logs: pm2 flush` });
  else if (s.disk?.usedPct >= 85) w.push({ level: 'warn', text: `The server disk is ${s.disk.usedPct}% full (${s.disk.freeGb} GB free).` });
  if (s.cpu.load15 > s.cpu.cores * 1.5) w.push({ level: 'warn', text: `The server has been very busy for 15 minutes (load ${s.cpu.load15} on ${s.cpu.cores} core${s.cpu.cores === 1 ? '' : 's'}).` });
  return w;
}

module.exports = { check, warnings };

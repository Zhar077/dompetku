/* DompetKu PWA — offline-first, sinkron ke Google Sheet lewat Apps Script API. */
'use strict';

const APP_VERSION = '2.3.0';
const STORAGE_KEY = 'dompetku.state.v1';
const SYNC_INTERVAL_MS = 60 * 1000;
const J_CAIR = 'Pencairan Pinjaman';
const J_BAYAR = 'Pembayaran Pinjaman';
const BULAN = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
const HARI = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];

const $ = id => document.getElementById(id);

/* =====================================================================
 * State (disimpan di localStorage HP)
 * ===================================================================== */

const EMPTY_STATE = {
  url: '', key: '',
  categories: [], accounts: [], txs: [], loans: [],
  queue: [],          // [{op:'upsert',tx} | {op:'delete',id} | {op:'upsertLoan',loan} | {op:'deleteLoan',id}]
  lastSync: '', lastError: '', sheetUrl: '',
};

let S = loadState();
let month = todayStr().slice(0, 7);
let view = (S.url && S.key) ? 'home' : 'settings';
let editing = null;      // transaksi biasa yang diedit
let editingLoan = null;  // pinjaman yang diedit
let payLoan = null;      // pinjaman untuk form pembayaran
let editingPay = null;   // pembayaran yang diedit
let detailLoanId = null;
let jenis = 'Pengeluaran';
let loanJenis = 'Utang';
let syncing = false;
let hideSaldo = true;    // saldo selalu tersembunyi setiap app dibuka

/** Tampilkan saldo, atau samarkan bila disembunyikan. */
function rpH(n) { return hideSaldo ? 'Rp ••••••' : rp(n); }
function eyeBtn() {
  return `<button type="button" class="eye" data-eye aria-label="${hideSaldo ? 'Tampilkan saldo' : 'Sembunyikan saldo'}">${hideSaldo ? '👁️ Lihat' : '🙈 Tutup'}</button>`;
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const s = Object.assign({}, EMPTY_STATE, JSON.parse(raw));
      if (!Array.isArray(s.loans)) s.loans = [];
      return s;
    }
  } catch (e) { /* storage diblokir / rusak */ }
  return JSON.parse(JSON.stringify(EMPTY_STATE));
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(S));
    return true;
  } catch (e) {
    toast('Tidak bisa menyimpan di HP (memori penuh atau mode privat).');
    return false;
  }
}

/* =====================================================================
 * Util
 * ===================================================================== */

function pad(n) { return String(n).padStart(2, '0'); }
function todayStr() { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function nowStr() { const d = new Date(); return todayStr() + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); }
const rp = n => (n < 0 ? '-' : '') + 'Rp ' + Math.abs(Math.round(n)).toLocaleString('id-ID');
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const monthName = m => { const [y, mo] = m.split('-'); return BULAN[+mo - 1] + ' ' + y; };
const money = el => Number(String(el.value).replace(/\D/g, '')) || 0;
const setMoney = (el, n) => { el.value = n ? Number(n).toLocaleString('id-ID') : ''; };
function shiftMonth(m, d) {
  let [y, mo] = m.split('-').map(Number);
  mo += d;
  while (mo < 1) { mo += 12; y--; }
  while (mo > 12) { mo -= 12; y++; }
  return y + '-' + pad(mo);
}
function dayLabel(s) {
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return HARI[dt.getDay()] + ', ' + d + ' ' + BULAN[m - 1].slice(0, 3) + ' ' + y;
}
function shortDate(s) { const [y, m, d] = s.split('-').map(Number); return d + ' ' + BULAN[m - 1].slice(0, 3) + ' ' + y; }
function timeAgo(iso) {
  if (!iso) return 'belum pernah';
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return 'baru saja';
  if (diff < 3600) return Math.floor(diff / 60) + ' menit lalu';
  if (diff < 86400) return Math.floor(diff / 3600) + ' jam lalu';
  return Math.floor(diff / 86400) + ' hari lalu';
}
function uuid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  const b = new Uint8Array(16); crypto.getRandomValues(b);
  b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
}

function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 3000);
}

/* =====================================================================
 * Perhitungan
 * ===================================================================== */

/** Perubahan saldo akun akibat satu transaksi (sama dengan txDeltas_ di Code.gs). */
function txDeltas(t) {
  const d = txDeltasBase(t);
  if (t.biaya > 0) d.push([t.akun, -t.biaya]); // biaya admin dipotong dari akun asal
  return d;
}

function txDeltasBase(t) {
  const j = t.jumlah, total = t.jumlah + (t.bunga || 0);
  const utang = t.kategori === 'Utang';
  switch (t.jenis) {
    case 'Pemasukan': return [[t.akun, j]];
    case 'Pengeluaran': return [[t.akun, -j]];
    case 'Transfer': return t.akunTujuan ? [[t.akun, -j], [t.akunTujuan, j]] : [[t.akun, -j]];
    case J_CAIR: return [[t.akun, utang ? j : -j]];
    case J_BAYAR: return [[t.akun, utang ? -total : total]];
    default: return [];
  }
}

function loanStats(l) {
  const pays = S.txs.filter(t => t.pinjamanId === l.id && t.jenis === J_BAYAR)
    .sort((a, b) => (b.tanggal + b.dibuatPada).localeCompare(a.tanggal + a.dibuatPada));
  const dibayar = l.dibayarAwal + pays.reduce((s, p) => s + p.jumlah, 0);
  const bungaTotal = pays.reduce((s, p) => s + (p.bunga || 0), 0);
  const sisa = Math.max(0, l.pokok - dibayar);
  const lunas = sisa <= 0;
  const pct = l.pokok > 0 ? Math.min(100, (l.pokok - sisa) / l.pokok * 100) : 0;

  let due = null;
  if (!lunas && l.cicilan > 0 && l.jatuhTempo > 0) {
    const today = todayStr(), ym = today.slice(0, 7);
    const [y, mo, d] = today.split('-').map(Number);
    const dueDay = Math.min(l.jatuhTempo, new Date(y, mo, 0).getDate());
    if (l.tanggal.slice(0, 7) < ym) {
      const paid = pays.some(p => p.tanggal.slice(0, 7) === ym);
      due = { date: ym + '-' + pad(dueDay), paid, late: !paid && d > dueDay, daysLeft: dueDay - d };
    }
  }
  let sisaKali = 0;
  if (!lunas && l.cicilan > 0) {
    const pokokPerBulan = l.cicilan - (l.adaBunga ? l.bungaPerBulan : 0);
    if (pokokPerBulan > 0) sisaKali = Math.ceil(sisa / pokokPerBulan);
  }
  return { loan: l, pays, dibayar, bungaTotal, sisa, lunas, pct, due, sisaKali };
}

function dueText(st) {
  const d = st.due;
  if (!d) return '';
  const verb = st.loan.jenis === 'Utang' ? 'bayar' : 'terima';
  if (d.paid) return `<span class="in">✓ Sudah ${verb} bulan ini</span>`;
  if (d.late) return `<span class="out">⚠️ Terlambat · jatuh tempo ${shortDate(d.date)}</span>`;
  if (d.daysLeft === 0) return '<span class="warn">⏰ Jatuh tempo hari ini</span>';
  return `<span class="${d.daysLeft <= 3 ? 'warn' : 'muted'}">Jatuh tempo ${shortDate(d.date)} (${d.daysLeft} hari lagi)</span>`;
}

function compute(m) {
  const saldo = {};
  S.accounts.forEach(a => { saldo[a.nama] = a.saldoAwal; });
  S.txs.forEach(t => txDeltas(t).forEach(([akun, n]) => { saldo[akun] = (saldo[akun] || 0) + n; }));
  const accounts = Object.keys(saldo).map(nama => ({ nama, saldo: saldo[nama] }));
  const totalSaldo = accounts.reduce((s, a) => s + a.saldo, 0);

  const transactions = S.txs
    .filter(t => t.tanggal.indexOf(m) === 0)
    .sort((a, b) => (b.tanggal + b.dibuatPada).localeCompare(a.tanggal + a.dibuatPada));

  let pemasukan = 0, pengeluaran = 0;
  const perKategori = {};
  const addExp = (k, n) => { pengeluaran += n; perKategori[k] = (perKategori[k] || 0) + n; };
  transactions.forEach(t => {
    if (t.jenis === 'Pemasukan') pemasukan += t.jumlah;
    else if (t.jenis === 'Pengeluaran') addExp(t.kategori, t.jumlah);
    else if (t.jenis === J_BAYAR && t.bunga > 0) {
      // Bunga = biaya (utang) atau pendapatan (piutang). Pokok bukan pemasukan/pengeluaran.
      if (t.kategori === 'Utang') addExp('Bunga Pinjaman', t.bunga);
      else pemasukan += t.bunga;
    }
    if (t.biaya > 0) addExp('Biaya Admin', t.biaya);
  });
  const byCategory = Object.keys(perKategori).map(nama => {
    const cat = S.categories.find(c => c.nama === nama);
    return { nama, total: perKategori[nama], anggaran: cat ? cat.anggaran : 0 };
  });
  S.categories.filter(c => c.jenis === 'Pengeluaran' && c.anggaran > 0 && !(c.nama in perKategori))
    .forEach(c => byCategory.push({ nama: c.nama, total: 0, anggaran: c.anggaran }));
  byCategory.sort((a, b) => b.total - a.total);

  const loans = S.loans.map(loanStats);
  const utang = loans.filter(s => s.loan.jenis === 'Utang').reduce((a, s) => a + s.sisa, 0);
  const piutang = loans.filter(s => s.loan.jenis === 'Piutang').reduce((a, s) => a + s.sisa, 0);

  return {
    accounts, totalSaldo, transactions, byCategory, loans, utang, piutang,
    netWorth: totalSaldo + piutang - utang,
    summary: { pemasukan, pengeluaran, selisih: pemasukan - pengeluaran },
  };
}

/* =====================================================================
 * Perubahan lokal + antrian
 * ===================================================================== */

function applyOpLocal(o) {
  if (o.op === 'upsert') {
    const i = S.txs.findIndex(t => t.id === o.tx.id);
    if (i >= 0) S.txs[i] = Object.assign({}, o.tx); else S.txs.push(Object.assign({}, o.tx));
  } else if (o.op === 'delete') {
    S.txs = S.txs.filter(t => t.id !== o.id);
  } else if (o.op === 'upsertLoan') {
    const i = S.loans.findIndex(l => l.id === o.loan.id);
    if (i >= 0) S.loans[i] = Object.assign({}, o.loan); else S.loans.push(Object.assign({}, o.loan));
  } else if (o.op === 'deleteLoan') {
    S.loans = S.loans.filter(l => l.id !== o.id);
    S.txs = S.txs.filter(t => t.pinjamanId !== o.id);
  }
}

function enqueue(ops) {
  ops = Array.isArray(ops) ? ops : [ops];
  ops.forEach(o => { applyOpLocal(o); S.queue.push(o); });
  saveState();
  render();
  sync(false);
}

function pendingIds() {
  const set = new Set();
  S.queue.forEach(o => set.add(o.op === 'upsert' ? o.tx.id : o.op === 'upsertLoan' ? o.loan.id : o.id));
  return set;
}

/* =====================================================================
 * API & sinkronisasi
 * ===================================================================== */

async function api(body, cfg, timeoutMs) {
  cfg = cfg || S;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 45000);
  let res;
  try {
    res = await fetch(cfg.url, {
      method: 'POST',
      // text/plain supaya browser tidak mengirim "preflight" yang tidak didukung Apps Script
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({}, body, { key: cfg.key })),
      redirect: 'follow',
      signal: ctrl.signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Waktu habis. Sinyal lemah?');
    throw new Error('Tidak bisa terhubung. Cek internet, URL, dan akses deployment "Anyone".');
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error('Server membalas HTTP ' + res.status + '.');
  let json;
  try { json = await res.json(); } catch (e) {
    throw new Error('Balasan bukan data. Pastikan URL berakhiran /exec dan akses "Anyone".');
  }
  if (!json.ok) throw new Error(json.error || 'Terjadi kesalahan di server.');
  return json;
}

function applyServerData(d) {
  S.categories = d.categories || [];
  S.accounts = d.accounts || [];
  S.txs = d.transactions || [];
  S.loans = d.loans || [];
  if (d.sheetUrl) S.sheetUrl = d.sheetUrl;
}

async function sync(manual) {
  if (!S.url || !S.key) { if (manual) toast('Isi URL & API key dulu di Setelan.'); return; }
  if (syncing) return;
  if (!navigator.onLine) { renderStatus(); if (manual) toast('Sedang offline. Akan sinkron otomatis saat online.'); return; }

  syncing = true;
  renderStatus();
  const sent = S.queue.slice();
  try {
    const res = await api(sent.length ? { action: 'sync', ops: sent } : { action: 'pull' });
    // Antrian yang sudah terkirim dibuang; yang ditambah selama proses tetap disimpan.
    S.queue = S.queue.slice(sent.length);
    applyServerData(res.data);
    S.queue.forEach(applyOpLocal);
    S.lastSync = new Date().toISOString();
    S.lastError = '';
    saveState();
    const failed = (res.results || []).filter(r => !r.ok);
    if (failed.length) toast(failed.length + ' perubahan ditolak: ' + failed[0].error);
    else if (manual) toast('Tersinkron ✓');
  } catch (e) {
    S.lastError = e.message;
    saveState();
    if (manual) toast('Gagal sinkron: ' + e.message);
  } finally {
    syncing = false;
    render();
  }
}

/* =====================================================================
 * Render
 * ===================================================================== */

const VIEWS = ['home', 'history', 'loans', 'report', 'settings'];

function render() {
  $('monthnav').hidden = view === 'settings' || view === 'loans';
  $('monthLabel').textContent = monthName(month);
  VIEWS.forEach(v => { $('view-' + v).hidden = v !== view; });
  document.querySelectorAll('nav button[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  $('settingsBtn').classList.toggle('active', view === 'settings');
  renderStatus();
  const d = compute(month);
  if (view === 'home') renderHome(d);
  if (view === 'history') renderHistory(d);
  if (view === 'loans') renderLoans(d);
  if (view === 'report') renderReport(d);
  if (view === 'settings') renderSettings();
  if (detailLoanId && $('loanDetail').classList.contains('show')) renderLoanDetail();
}

function renderStatus() {
  const el = $('status');
  const n = S.queue.length;
  if (!S.url || !S.key) el.textContent = '⚙️ Belum terhubung';
  else if (syncing) el.textContent = '🔄 Sinkron…';
  else if (!navigator.onLine) el.textContent = n ? `📴 Offline · ${n} antre` : '📴 Offline';
  else if (S.lastError) el.textContent = n ? `⚠️ ${n} belum sinkron` : '⚠️ Gagal sinkron';
  else if (n) el.textContent = `⏳ ${n} belum sinkron`;
  else el.textContent = '✓ Tersinkron';
}

function loanById(id) { return S.loans.find(l => l.id === id); }

function txRow(t, pending) {
  let title, sub, amount = t.jumlah, cls, sign;
  if (t.jenis === J_CAIR || t.jenis === J_BAYAR) {
    const loan = loanById(t.pinjamanId);
    const utang = t.kategori === 'Utang';
    title = t.jenis === J_CAIR ? (utang ? 'Pinjaman diterima' : 'Meminjamkan') : (utang ? 'Bayar utang' : 'Terima pembayaran');
    sub = (loan ? loan.nama : 'Pinjaman') + ' · ' + t.akun + (t.bunga ? ' · bunga ' + rp(t.bunga) : '');
    amount = t.jumlah + (t.bunga || 0);
    const plus = txDeltas(t)[0][1] >= 0;
    cls = plus ? 'in' : 'out'; sign = plus ? '+' : '−';
  } else if (t.jenis === 'Transfer') {
    title = 'Transfer'; sub = `${t.akun} → ${t.akunTujuan}`; cls = 'tf'; sign = '';
  } else {
    const inc = t.jenis === 'Pemasukan';
    title = t.kategori; sub = t.akun; cls = inc ? 'in' : 'out'; sign = inc ? '+' : '−';
  }
  if (t.biaya > 0) sub += ' · admin ' + rp(t.biaya);
  return `<div class="row tx" data-id="${esc(t.id)}">
    <div class="left"><div class="title">${pending.has(t.id) ? '⏳ ' : ''}${esc(title)}</div>
    <div class="sub">${esc(sub)}${t.catatan ? ' · ' + esc(t.catatan) : ''}</div></div>
    <div class="num ${cls}">${sign}${rp(amount)}</div></div>`;
}

function setupNotice() {
  if (S.url && S.key) {
    if (!S.lastSync && !S.txs.length) return '<div class="notice">Menunggu sinkron pertama… Pastikan HP online.</div>';
    return '';
  }
  return '<div class="notice">Belum terhubung ke Google Sheet. Ketuk <b>⚙️</b> di kanan atas untuk mengisi URL &amp; API key.</div>';
}

function renderHome(d) {
  const s = d.summary;
  const pending = pendingIds();
  const accRows = d.accounts.map(a => `<div class="row"><span>${esc(a.nama)}</span>
    <span class="num ${a.saldo < 0 && !hideSaldo ? 'out' : ''}">${rpH(a.saldo)}</span></div>`).join('') || '<div class="muted">Belum ada akun.</div>';
  const recent = d.transactions.slice(0, 6).map(t => txRow(t, pending)).join('')
    || '<div class="empty">Belum ada transaksi bulan ini.<br>Ketuk + untuk mulai mencatat.</div>';

  const active = d.loans.filter(st => !st.lunas);
  let loanCard = '';
  if (active.length) {
    const dues = active.filter(st => st.due && !st.due.paid)
      .sort((a, b) => a.due.date.localeCompare(b.due.date));
    const dueRows = dues.map(st => `<div class="row loanrow" data-loan="${esc(st.loan.id)}">
      <div class="left"><div class="title">${esc(st.loan.nama)}</div><div class="sub">${dueText(st)}</div></div>
      <div class="num ${st.loan.jenis === 'Utang' ? 'out' : 'in'}">${rp(st.loan.cicilan)}</div></div>`).join('');
    loanCard = `<div class="card"><h2>Pinjaman</h2>
      <div class="grid3">
        <div><div class="muted">Sisa utang</div><span class="num out">${rp(d.utang)}</span></div>
        <div><div class="muted">Sisa piutang</div><span class="num in">${rp(d.piutang)}</span></div>
        <div><div class="muted">Jatuh tempo</div><span class="num">${dues.length} cicilan</span></div>
      </div>${dueRows ? '<div style="margin-top:6px">' + dueRows + '</div>' : ''}</div>`;
  }

  $('view-home').innerHTML = `${setupNotice()}
    <div class="card"><div style="display:flex;justify-content:space-between;align-items:center">
        <h2 style="margin:0">Total saldo</h2>${eyeBtn()}</div>
      <div class="big" style="margin-top:6px">${rpH(d.totalSaldo)}</div>
      ${(d.utang || d.piutang) ? `<div class="muted">Kekayaan bersih (saldo + piutang − utang): <b>${rpH(d.netWorth)}</b></div>` : ''}</div>
    <div class="card"><h2>${monthName(month)}</h2>
      <div class="grid3">
        <div><div class="muted">Masuk</div><span class="num in">${rp(s.pemasukan)}</span></div>
        <div><div class="muted">Keluar</div><span class="num out">${rp(s.pengeluaran)}</span></div>
        <div><div class="muted">Selisih</div><span class="num ${s.selisih < 0 ? 'out' : 'in'}">${rp(s.selisih)}</span></div>
      </div></div>
    ${loanCard}
    <div class="card"><h2>Saldo per akun</h2>${accRows}</div>
    <div class="card"><h2>Transaksi terbaru</h2>${recent}</div>`;
}

function renderHistory(d) {
  const list = d.transactions;
  if (!list.length) { $('view-history').innerHTML = '<div class="card empty">Tidak ada transaksi di bulan ini.</div>'; return; }
  const pending = pendingIds();
  let html = '', cur = '';
  list.forEach(t => {
    if (t.tanggal !== cur) {
      if (cur) html += '</div>';
      cur = t.tanggal;
      html += `<div class="daylabel">${dayLabel(cur)}</div><div class="card" style="padding:4px 16px">`;
    }
    html += txRow(t, pending);
  });
  $('view-history').innerHTML = html + '</div>';
}

function loanCardHtml(st, pending) {
  const l = st.loan;
  const utang = l.jenis === 'Utang';
  const info = [];
  if (l.cicilan > 0) info.push(`Cicilan ${rp(l.cicilan)}/bln${st.sisaKali ? ` · ±${st.sisaKali}x lagi` : ''}`);
  if (l.adaBunga) info.push('Berbunga');
  return `<div class="card loanrow" data-loan="${esc(l.id)}" style="cursor:pointer">
    <div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline">
      <div class="title" style="font-weight:700;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${pending.has(l.id) ? '⏳ ' : ''}${esc(l.nama)}</div>
      <div class="num ${st.lunas ? 'in' : utang ? 'out' : 'in'}">${st.lunas ? 'Lunas ✓' : rp(st.sisa)}</div>
    </div>
    <div class="bar"><i class="${st.lunas ? '' : ''}" style="width:${st.pct}%"></i></div>
    <div class="muted" style="display:flex;justify-content:space-between;gap:8px;margin-top:4px">
      <span>${utang ? 'Dibayar' : 'Diterima'} ${rp(l.pokok - st.sisa)} dari ${rp(l.pokok)}</span><span>${Math.round(st.pct)}%</span></div>
    ${info.length ? `<div class="muted">${info.join(' · ')}</div>` : ''}
    ${st.due ? `<div style="font-size:13px;margin-top:2px">${dueText(st)}</div>` : ''}
  </div>`;
}

function renderLoans(d) {
  const pending = pendingIds();
  const group = (jen, title, hint) => {
    const items = d.loans.filter(st => st.loan.jenis === jen && !st.lunas);
    if (!items.length) return '';
    return `<div class="daylabel">${title} <span style="font-weight:400">· ${hint}</span></div>` + items.map(st => loanCardHtml(st, pending)).join('');
  };
  const lunas = d.loans.filter(st => st.lunas);
  const body = group('Utang', 'UTANG', 'aku meminjam') + group('Piutang', 'PIUTANG', 'aku meminjamkan')
    + (lunas.length ? `<details style="margin-top:14px"><summary class="daylabel" style="cursor:pointer">Sudah lunas (${lunas.length})</summary>
        ${lunas.map(st => loanCardHtml(st, pending)).join('')}</details>` : '');
  $('view-loans').innerHTML = `
    <div class="card"><h2>Ringkasan pinjaman</h2>
      <div class="grid3">
        <div><div class="muted">Sisa utang</div><span class="num out">${rp(d.utang)}</span></div>
        <div><div class="muted">Sisa piutang</div><span class="num in">${rp(d.piutang)}</span></div>
        <div><div class="muted">Kekayaan bersih ${eyeBtn()}</div><span class="num ${d.netWorth < 0 && !hideSaldo ? 'out' : ''}">${rpH(d.netWorth)}</span></div>
      </div></div>
    <button class="btn primary" id="newLoanBtn" style="width:100%;margin-bottom:4px">+ Tambah pinjaman</button>
    ${body || '<div class="card empty">Belum ada pinjaman.<br>Catat utang (kamu meminjam) atau piutang (kamu meminjamkan).</div>'}`;
  $('newLoanBtn').onclick = () => openLoanForm(null);
}

function renderReport(d) {
  const s = d.summary;
  const rows = d.byCategory.map(c => {
    let bar = '';
    if (c.anggaran > 0) {
      const pct = Math.min(100, c.total / c.anggaran * 100);
      const cls = c.total > c.anggaran ? 'over' : pct >= 80 ? 'warn' : '';
      const sisa = c.anggaran - c.total;
      bar = `<div class="bar"><i class="${cls}" style="width:${pct}%"></i></div>
        <div class="muted">${sisa >= 0 ? 'Sisa ' + rp(sisa) : 'Lebih ' + rp(-sisa)} dari anggaran ${rp(c.anggaran)}</div>`;
    } else if (s.pengeluaran > 0) {
      const pct = c.total / s.pengeluaran * 100;
      bar = `<div class="bar"><i style="width:${pct}%"></i></div>
        <div class="muted">${Math.round(pct)}% dari total pengeluaran</div>`;
    }
    return `<div class="row" style="display:block"><div style="display:flex;justify-content:space-between;gap:10px">
      <span>${esc(c.nama)}</span><span class="num">${rp(c.total)}</span></div>${bar}</div>`;
  }).join('') || '<div class="empty">Belum ada pengeluaran.</div>';
  const rate = s.pemasukan > 0 ? Math.round(s.selisih / s.pemasukan * 100) : 0;
  $('view-report').innerHTML = `
    <div class="card"><h2>Pengeluaran ${monthName(month)}</h2><div class="big out">${rp(s.pengeluaran)}</div>
      <div class="muted">Pemasukan ${rp(s.pemasukan)} · Tingkat tabungan ${rate}%</div></div>
    <div class="card"><h2>Per kategori</h2>${rows}</div>
    <p class="muted" style="text-align:center">Pokok pinjaman tidak dihitung sebagai pemasukan/pengeluaran; hanya bunganya.<br>
    Ubah kategori, anggaran, dan saldo awal di Google Sheet, lalu sinkron.</p>`;
}

function renderSettings() {
  if (document.activeElement !== $('s-url')) $('s-url').value = S.url;
  if (document.activeElement !== $('s-key')) $('s-key').value = S.key;
  const n = S.queue.length;
  $('s-info').innerHTML = `Terakhir sinkron: <b>${esc(timeAgo(S.lastSync))}</b><br>
    Belum terkirim: <b>${n}</b> perubahan<br>
    Total transaksi di HP: <b>${S.txs.length}</b> · pinjaman: <b>${S.loans.length}</b>
    ${S.lastError ? `<br><span class="out">Error terakhir: ${esc(S.lastError)}</span>` : ''}`;
  const a = $('s-sheet');
  if (S.sheetUrl && /^https:\/\/docs\.google\.com\//.test(S.sheetUrl)) { a.href = S.sheetUrl; a.hidden = false; }
  else a.hidden = true;
  $('s-version').textContent = 'Versi app ' + APP_VERSION;
}

/* =====================================================================
 * Navigasi
 * ===================================================================== */

function go(v) { view = v; render(); window.scrollTo(0, 0); }

document.querySelectorAll('nav button[data-view]').forEach(b => { b.onclick = () => go(b.dataset.view); });
$('settingsBtn').onclick = () => go('settings');
$('prevM').onclick = () => { month = shiftMonth(month, -1); render(); };
$('nextM').onclick = () => { month = shiftMonth(month, 1); render(); };
$('status').onclick = () => sync(true);
document.querySelector('main').addEventListener('click', e => {
  if (e.target.closest('[data-eye]')) { hideSaldo = !hideSaldo; render(); return; }
  const lr = e.target.closest('.loanrow');
  if (lr) { openLoanDetail(lr.dataset.loan); return; }
  const el = e.target.closest('.tx'); if (!el) return;
  openTx(S.txs.find(x => x.id === el.dataset.id));
});

function openTx(t) {
  if (!t) return;
  if (t.jenis === J_BAYAR) {
    const loan = loanById(t.pinjamanId);
    if (loan) openPayForm(loan, t); else toast('Pinjaman untuk transaksi ini sudah dihapus.');
  } else if (t.jenis === J_CAIR) {
    if (loanById(t.pinjamanId)) openLoanDetail(t.pinjamanId); else toast('Pinjaman untuk transaksi ini sudah dihapus.');
  } else {
    openForm(t);
  }
}

/* ---------- Bottom sheets ---------- */
const SHEETS = ['form', 'loanForm', 'payForm', 'loanDetail'];
function showSheet(id) {
  SHEETS.forEach(s => $(s).classList.toggle('show', s === id));
  $('overlay').classList.add('show');
}
function closeSheets() {
  SHEETS.forEach(s => $(s).classList.remove('show'));
  $('overlay').classList.remove('show');
  editing = editingLoan = payLoan = editingPay = null;
  detailLoanId = null;
  if (document.activeElement) document.activeElement.blur();
}
$('overlay').onclick = closeSheets;
document.querySelectorAll('[data-close]').forEach(b => { b.onclick = closeSheets; });

document.querySelectorAll('input.money').forEach(el => el.addEventListener('input', () => {
  const digits = el.value.replace(/\D/g, '').replace(/^0+/, '').slice(0, 13);
  el.value = digits ? Number(digits).toLocaleString('id-ID') : '';
}));

function fillSelect(sel, items, value) {
  sel.innerHTML = items.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
  if (value && items.includes(value)) sel.value = value;
}
function accountNames() { return compute(month).accounts.map(a => a.nama); }
function ensureData() {
  if (S.accounts.length) return true;
  toast(S.url ? 'Data belum termuat. Sinkron dulu saat online.' : 'Hubungkan ke Google Sheet dulu di Setelan.');
  if (!S.url) go('settings');
  return false;
}
function defaultDate() { const today = todayStr(); return month === today.slice(0, 7) ? today : month + '-01'; }

/* =====================================================================
 * Setelan
 * ===================================================================== */

$('s-save').onclick = async () => {
  const url = $('s-url').value.trim();
  const key = $('s-key').value.trim();
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url)) {
    toast('URL harus berbentuk https://script.google.com/macros/s/…/exec'); return;
  }
  if (key.length < 16) { toast('API key terlalu pendek. Salin ulang dari Apps Script.'); return; }
  const btn = $('s-save');
  btn.disabled = true; btn.textContent = 'Mengetes…';
  try {
    await api({ action: 'ping' }, { url, key });
    const changed = url !== S.url;
    S.url = url; S.key = key; S.lastError = '';
    if (changed) { S.txs = []; S.categories = []; S.accounts = []; S.loans = []; S.lastSync = ''; }
    saveState();
    toast('Terhubung ✓ Mengambil data…');
    await sync(false);
    go('home');
  } catch (e) {
    toast('Gagal: ' + e.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Simpan & tes koneksi';
  }
};

$('s-sync').onclick = () => sync(true);

$('s-reset').onclick = () => {
  const n = S.queue.length;
  const msg = n
    ? `Ada ${n} perubahan yang BELUM terkirim ke Sheet dan akan hilang. Tetap hapus data di HP ini?`
    : 'Hapus semua data DompetKu di HP ini? Data di Google Sheet tetap aman.';
  if (!confirm(msg)) return;
  S = JSON.parse(JSON.stringify(EMPTY_STATE));
  saveState();
  go('settings');
  toast('Data di HP dihapus.');
};

/* =====================================================================
 * Form transaksi biasa
 * ===================================================================== */

function setJenis(j) {
  jenis = j;
  document.querySelectorAll('#seg button').forEach(b => b.classList.toggle('on', b.dataset.j === j));
  const tf = j === 'Transfer';
  $('wrap-kategori').hidden = tf;
  $('wrap-tujuan').hidden = !tf;
  $('lbl-akun').textContent = tf ? 'Dari akun' : 'Akun';
  const tgl = $('wrap-tanggal');
  if (tf) $('wrap-tanggal2').appendChild(tgl); else $('wrap-tujuan').after(tgl);
  $('wrap-tanggal2').hidden = !tf;
  const cats = S.categories.filter(c => c.jenis === j).map(c => c.nama);
  if (editing && editing.jenis === j && editing.kategori && !cats.includes(editing.kategori)) cats.unshift(editing.kategori);
  fillSelect($('f-kategori'), cats, editing && editing.kategori);
}

function openForm(t) {
  if (!ensureData()) return;
  closeSheets();
  editing = t || null;
  const accs = accountNames();
  $('formTitle').textContent = t ? 'Ubah transaksi' : 'Tambah transaksi';
  $('delBtn').hidden = !t;
  fillSelect($('f-akun'), accs, t && t.akun);
  fillSelect($('f-tujuan'), accs, t && t.akunTujuan);
  if (!t && accs.length > 1) $('f-tujuan').value = accs[1];
  setMoney($('f-jumlah'), t ? t.jumlah : 0);
  showFee('f', t ? t.biaya : 0);
  $('f-tanggal').value = t ? t.tanggal : defaultDate();
  $('f-catatan').value = t ? t.catatan : '';
  setJenis(t ? t.jenis : 'Pengeluaran');
  $('scanRow').hidden = !!t;
  $('scanInfo').hidden = true;
  clearNeeds();
  showSheet('form');
}

/* =====================================================================
 * Scan nota (foto → Gemini lewat Apps Script → isi form)
 * ===================================================================== */

const NEED_FIELDS = ['f-jumlah', 'f-kategori', 'f-akun', 'f-tanggal'];
function clearNeeds() { NEED_FIELDS.forEach(id => $(id).classList.remove('need')); }
NEED_FIELDS.forEach(id => ['input', 'change'].forEach(ev => $(id).addEventListener(ev, () => $(id).classList.remove('need'))));

/** Kecilkan foto ke maks 1280px (JPEG) supaya cepat dikirim & hemat kuota. */
function shrinkImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const max = 1280;
      const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * scale);
      c.height = Math.round(img.naturalHeight * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.8).split(',')[1]);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Foto tidak bisa dibuka.')); };
    img.src = url;
  });
}

function selectWithBlank(sel, placeholder) {
  if (!sel.querySelector('option[value=""]')) {
    const o = document.createElement('option');
    o.value = ''; o.textContent = placeholder;
    sel.insertBefore(o, sel.firstChild);
  }
  sel.value = '';
}

function applyScan(r) {
  setJenis(r.jenis || 'Pengeluaran');
  const missing = [];
  if (r.total) setMoney($('f-jumlah'), r.total); else { $('f-jumlah').value = ''; missing.push('f-jumlah'); }
  if (r.tanggal) $('f-tanggal').value = r.tanggal; else missing.push('f-tanggal');
  if (r.kategori) $('f-kategori').value = r.kategori; else { selectWithBlank($('f-kategori'), '— pilih kategori —'); missing.push('f-kategori'); }
  if (r.akun) $('f-akun').value = r.akun; else { selectWithBlank($('f-akun'), '— pilih akun —'); missing.push('f-akun'); }
  if (r.biaya > 0) showFee('f', r.biaya);
  const note = r.catatan || r.toko;
  if (note) $('f-catatan').value = note.slice(0, 200);
  clearNeeds();
  missing.forEach(id => $(id).classList.add('need'));

  const names = { 'f-jumlah': 'jumlah', 'f-tanggal': 'tanggal', 'f-kategori': 'kategori', 'f-akun': 'akun' };
  const box = $('scanInfo');
  box.classList.toggle('ok', !missing.length && r.keyakinan === 'tinggi');
  box.innerHTML = (r.toko ? `<b>${esc(r.toko)}</b> · ` : '')
    + (missing.length
      ? `Lengkapi yang ditandai kuning: <b>${missing.map(id => names[id]).join(', ')}</b>.`
      : 'Semua kolom terisi.')
    + (r.keyakinan === 'rendah' ? ' <span class="warn">AI kurang yakin — cek angkanya.</span>' : ' Cek lagi sebelum simpan.');
  box.hidden = false;
  const first = missing[0];
  if (first) setTimeout(() => $(first).focus(), 100);
}

/* Biaya admin (opsional) — prefix 'f' = form transaksi, 'p' = form pembayaran pinjaman */
function showFee(prefix, n) {
  const open = n > 0;
  $(prefix + '-feeLink').hidden = open;
  $(prefix + '-feeWrap').hidden = !open;
  setMoney($(prefix + '-biaya'), n || 0);
}
function feeValue(prefix) { return $(prefix + '-feeWrap').hidden ? 0 : money($(prefix + '-biaya')); }
['f', 'p'].forEach(px => {
  $(px + '-feeLink').onclick = () => { showFee(px, 0); $(px + '-feeWrap').hidden = false; $(px + '-feeLink').hidden = true; $(px + '-biaya').focus(); };
  $(px + '-feeDel').onclick = () => { showFee(px, 0); if (px === 'p') updatePayTotal(); };
});

/* Scan: tombol Kamera (langsung buka kamera) & Galeri (pilih foto) */
function startScan(inputId) {
  if (!S.url || !S.key) { toast('Hubungkan ke Google Sheet dulu di Setelan.'); return; }
  if (!navigator.onLine) { toast('Scan nota butuh internet. Isi manual dulu ya.'); return; }
  $(inputId).value = '';
  $(inputId).click();
}
$('scanCamBtn').onclick = () => startScan('scanFileCam');
$('scanBtn').onclick = () => startScan('scanFile');

$('scanFileCam').onchange = () => handleScanFile($('scanFileCam').files[0]);
$('scanFile').onchange = () => handleScanFile($('scanFile').files[0]);

async function handleScanFile(file) {
  if (!file) return;
  const btns = [$('scanCamBtn'), $('scanBtn')];
  btns.forEach(b => { b.disabled = true; });
  $('scanCamBtn').textContent = '⏳ Membaca…';
  $('scanInfo').hidden = false; $('scanInfo').classList.remove('ok');
  $('scanInfo').textContent = 'Membaca nota dengan AI… (biasanya 5–20 detik, bisa lebih lama kalau server sibuk)';
  try {
    const image = await shrinkImage(file);
    const res = await api({ action: 'scanNota', image, mime: 'image/jpeg' }, null, 150000);
    if (!$('form').classList.contains('show') || editing) return; // form sudah ditutup
    if (res.scan.bukanNota) {
      $('scanInfo').innerHTML = '<span class="warn">Foto ini tidak terlihat seperti nota.</span> Coba foto ulang atau isi manual.';
      return;
    }
    applyScan(res.scan);
  } catch (e) {
    $('scanInfo').innerHTML = `<span class="out">Gagal membaca nota:</span> ${esc(e.message)}`;
  } finally {
    btns.forEach(b => { b.disabled = false; });
    $('scanCamBtn').textContent = '📷 Kamera';
  }
}

$('addBtn').onclick = () => openForm(null);
document.querySelectorAll('#seg button').forEach(b => { b.onclick = () => setJenis(b.dataset.j); });

$('form').onsubmit = e => {
  e.preventDefault();
  const jumlah = money($('f-jumlah'));
  if (!jumlah) { toast('Isi jumlah dulu'); return; }
  const tanggal = $('f-tanggal').value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tanggal)) { toast('Isi tanggal'); return; }
  const akun = $('f-akun').value;
  if (!akun) { toast('Pilih akun'); return; }
  const akunTujuan = jenis === 'Transfer' ? $('f-tujuan').value : '';
  if (jenis === 'Transfer' && akun === akunTujuan) { toast('Akun asal dan tujuan tidak boleh sama'); return; }
  const kategori = jenis === 'Transfer' ? 'Transfer' : $('f-kategori').value;
  if (!kategori) { toast('Pilih kategori'); return; }

  const tx = {
    id: editing ? editing.id : uuid(),
    tanggal, jenis, kategori, akun, jumlah, akunTujuan,
    catatan: $('f-catatan').value.trim().slice(0, 200),
    dibuatPada: editing ? editing.dibuatPada : nowStr(),
    pinjamanId: '', bunga: 0, biaya: feeValue('f'),
  };
  closeSheets();
  month = tanggal.slice(0, 7);
  enqueue({ op: 'upsert', tx });
  toast(navigator.onLine ? 'Tersimpan ✓' : 'Tersimpan di HP · sinkron saat online');
};

$('delBtn').onclick = () => {
  if (!editing || !confirm('Hapus transaksi ini?')) return;
  const id = editing.id;
  closeSheets();
  enqueue({ op: 'delete', id });
  toast('Dihapus');
};

/* =====================================================================
 * Pinjaman: detail
 * ===================================================================== */

function openLoanDetail(id) {
  if (!loanById(id)) return;
  closeSheets();
  detailLoanId = id;
  renderLoanDetail();
  showSheet('loanDetail');
}

function renderLoanDetail() {
  const l = loanById(detailLoanId);
  if (!l) { closeSheets(); return; }
  const st = loanStats(l);
  const utang = l.jenis === 'Utang';
  const pending = pendingIds();
  const row = (k, v) => `<div class="row"><span class="muted" style="font-size:14px">${k}</span><span class="num">${v}</span></div>`;
  const pays = st.pays.map(p => `<div class="row tx paytx" data-id="${esc(p.id)}">
      <div class="left"><div class="title">${pending.has(p.id) ? '⏳ ' : ''}${shortDate(p.tanggal)}</div>
      <div class="sub">${esc(p.akun)}${p.bunga ? ' · pokok ' + rp(p.jumlah) + ' + bunga ' + rp(p.bunga) : ''}${p.catatan ? ' · ' + esc(p.catatan) : ''}</div></div>
      <div class="num ${utang ? 'out' : 'in'}">${rp(p.jumlah + (p.bunga || 0))}</div></div>`).join('')
    || '<div class="muted" style="padding:8px 0">Belum ada pembayaran.</div>';

  $('loanDetailBody').innerHTML = `
    <h3 style="margin-bottom:2px">${esc(l.nama)}</h3>
    <div class="muted" style="margin-bottom:10px">${utang ? 'Utang · aku meminjam' : 'Piutang · aku meminjamkan'}${st.lunas ? ' · <span class="in">Lunas ✓</span>' : ''}</div>
    <div class="big ${st.lunas ? 'in' : utang ? 'out' : 'in'}">${rp(st.sisa)}</div>
    <div class="muted">sisa dari pokok ${rp(l.pokok)}</div>
    <div class="bar" style="margin:8px 0 4px"><i style="width:${st.pct}%"></i></div>
    ${st.due ? `<div style="font-size:14px;margin:6px 0">${dueText(st)}</div>` : ''}
    <div style="margin-top:8px">
      ${row(utang ? 'Sudah dibayar' : 'Sudah diterima', rp(st.dibayar))}
      ${l.dibayarAwal ? row('· sebelum dicatat di app', rp(l.dibayarAwal)) : ''}
      ${l.adaBunga || st.bungaTotal ? row(utang ? 'Total bunga dibayar' : 'Total bunga diterima', rp(st.bungaTotal)) : ''}
      ${l.cicilan ? row('Cicilan per bulan', rp(l.cicilan) + (st.sisaKali ? ` (±${st.sisaKali}x lagi)` : '')) : ''}
      ${l.jatuhTempo ? row('Jatuh tempo', 'tiap tgl ' + l.jatuhTempo) : ''}
      ${l.adaBunga && l.bungaPerBulan ? row('Bunga per bulan', rp(l.bungaPerBulan)) : ''}
      ${row('Mulai', shortDate(l.tanggal))}
      ${l.catatan ? `<div class="muted" style="padding-top:8px">${esc(l.catatan)}</div>` : ''}
    </div>
    <div class="actions">
      <button type="button" class="btn ghost" id="ld-edit">Ubah</button>
      <button type="button" class="btn primary" id="ld-pay" ${st.lunas ? 'disabled' : ''}>${utang ? 'Bayar cicilan' : 'Terima pembayaran'}</button>
    </div>
    <div class="daylabel" style="margin-top:18px">RIWAYAT PEMBAYARAN</div>
    <div>${pays}</div>
    <div class="actions"><button type="button" class="btn ghost" data-close2>Tutup</button></div>`;
  $('ld-edit').onclick = () => openLoanForm(l);
  $('ld-pay').onclick = () => openPayForm(l, null);
  $('loanDetailBody').querySelector('[data-close2]').onclick = closeSheets;
  $('loanDetailBody').querySelectorAll('.paytx').forEach(el => {
    el.onclick = () => { const p = S.txs.find(t => t.id === el.dataset.id); if (p) openPayForm(l, p); };
  });
}

/* =====================================================================
 * Pinjaman: tambah / ubah
 * ===================================================================== */

function setLoanJenis(j) {
  loanJenis = j;
  document.querySelectorAll('#lseg button').forEach(b => b.classList.toggle('on', b.dataset.lj === j));
  const utang = j === 'Utang';
  $('l-nama').placeholder = utang ? 'mis. KTA BCA, Paylater, Pinjam ke Budi' : 'mis. Budi, Sepupu Rina';
  $('lbl-l-akun').textContent = utang ? 'Uang masuk ke akun' : 'Uang keluar dari akun';
  $('lbl-l-cair').textContent = utang
    ? 'Tambahkan uang pinjaman ke saldo akun ini'
    : 'Kurangi saldo akun ini (uang sudah diberikan)';
  $('lbl-l-awal').textContent = utang ? 'Sudah dibayar sebelumnya (opsional)' : 'Sudah dikembalikan sebelumnya (opsional)';
}

function cairTxId(loanId) { return loanId + '-cair'; }

function openLoanForm(l) {
  if (!ensureData()) return;
  closeSheets();
  editingLoan = l || null;
  $('loanFormTitle').textContent = l ? 'Ubah pinjaman' : 'Tambah pinjaman';
  $('l-del').hidden = !l;
  setLoanJenis(l ? l.jenis : 'Utang');
  $('l-nama').value = l ? l.nama : '';
  setMoney($('l-pokok'), l ? l.pokok : 0);
  $('l-tanggal').value = l ? l.tanggal : todayStr();
  fillSelect($('l-akun'), accountNames(), l && l.akun);
  $('l-cair').checked = l ? !!S.txs.find(t => t.id === cairTxId(l.id)) : true;
  setMoney($('l-awal'), l ? l.dibayarAwal : 0);
  $('l-cicil').checked = l ? l.cicilan > 0 : false;
  setMoney($('l-cicilan'), l ? l.cicilan : 0);
  $('l-tempo').value = l && l.jatuhTempo ? l.jatuhTempo : '';
  $('l-bunga').checked = l ? l.adaBunga : false;
  setMoney($('l-bungaBln'), l ? l.bungaPerBulan : 0);
  $('l-catatan').value = l ? l.catatan : '';
  toggleLoanFields();
  showSheet('loanForm');
}

function toggleLoanFields() {
  $('wrap-cicil').hidden = !$('l-cicil').checked;
  $('wrap-bunga').hidden = !$('l-bunga').checked;
}
$('l-cicil').onchange = toggleLoanFields;
$('l-bunga').onchange = toggleLoanFields;
document.querySelectorAll('#lseg button').forEach(b => { b.onclick = () => setLoanJenis(b.dataset.lj); });

$('loanForm').onsubmit = e => {
  e.preventDefault();
  const nama = $('l-nama').value.trim().slice(0, 100);
  if (!nama) { toast('Isi nama pinjaman'); return; }
  const pokok = money($('l-pokok'));
  if (!pokok) { toast('Isi jumlah pokok pinjaman'); return; }
  const tanggal = $('l-tanggal').value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tanggal)) { toast('Isi tanggal mulai'); return; }
  const dibayarAwal = money($('l-awal'));
  if (dibayarAwal > pokok) { toast('"Sudah dibayar" melebihi pokok'); return; }
  const cicil = $('l-cicil').checked;
  const cicilan = cicil ? money($('l-cicilan')) : 0;
  const jatuhTempo = cicil ? Number($('l-tempo').value) || 0 : 0;
  if (cicil && !cicilan) { toast('Isi jumlah cicilan per bulan'); return; }
  if (cicil && (jatuhTempo < 1 || jatuhTempo > 31)) { toast('Tanggal jatuh tempo harus 1–31'); return; }
  const adaBunga = $('l-bunga').checked;

  const loan = {
    id: editingLoan ? editingLoan.id : uuid(),
    nama, jenis: loanJenis, pokok, tanggal, akun: $('l-akun').value, dibayarAwal,
    cicilan, jatuhTempo, adaBunga, bungaPerBulan: adaBunga ? money($('l-bungaBln')) : 0,
    catatan: $('l-catatan').value.trim().slice(0, 200),
    dibuatPada: editingLoan ? editingLoan.dibuatPada : nowStr(),
  };
  const ops = [{ op: 'upsertLoan', loan }];
  const cid = cairTxId(loan.id);
  const existingCair = S.txs.find(t => t.id === cid);
  if ($('l-cair').checked) {
    ops.push({ op: 'upsert', tx: {
      id: cid, tanggal, jenis: J_CAIR, kategori: loan.jenis, akun: loan.akun, jumlah: pokok, akunTujuan: '',
      catatan: '', dibuatPada: existingCair ? existingCair.dibuatPada : nowStr(), pinjamanId: loan.id, bunga: 0,
    } });
  } else if (existingCair) {
    ops.push({ op: 'delete', id: cid });
  }
  const id = loan.id;
  closeSheets();
  enqueue(ops);
  openLoanDetail(id);
  toast('Pinjaman tersimpan ✓');
};

$('l-del').onclick = () => {
  const l = editingLoan;
  if (!l) return;
  const n = S.txs.filter(t => t.pinjamanId === l.id).length;
  if (!confirm(`Hapus pinjaman "${l.nama}" beserta ${n} transaksi terkaitnya? Saldo akun akan dihitung ulang.`)) return;
  closeSheets();
  enqueue({ op: 'deleteLoan', id: l.id });
  toast('Pinjaman dihapus');
};

/* =====================================================================
 * Pinjaman: pembayaran
 * ===================================================================== */

function updatePayTotal() {
  const total = money($('p-pokok')) + ($('wrap-p-bunga').hidden ? 0 : money($('p-bunga'))) + feeValue('p');
  $('p-total').textContent = rp(total);
}
['p-pokok', 'p-bunga', 'p-biaya'].forEach(id => $(id).addEventListener('input', updatePayTotal));

function openPayForm(l, p) {
  if (!ensureData()) return;
  closeSheets();
  payLoan = l; editingPay = p || null;
  const st = loanStats(l);
  const utang = l.jenis === 'Utang';
  const sisaUntukForm = st.sisa + (p ? p.jumlah : 0);
  $('payTitle').textContent = (p ? 'Ubah ' : '') + (utang ? 'pembayaran utang' : 'penerimaan piutang');
  $('paySub').textContent = `${l.nama} · sisa ${rp(sisaUntukForm)}`;
  $('lbl-p-akun').textContent = utang ? 'Bayar dari akun' : 'Masuk ke akun';
  $('p-del').hidden = !p;
  const showBunga = l.adaBunga || (p && p.bunga > 0);
  $('wrap-p-bunga').hidden = !showBunga;
  let bunga = 0, pokok = 0;
  if (p) { bunga = p.bunga || 0; pokok = p.jumlah; }
  else if (l.cicilan > 0) {
    bunga = l.adaBunga ? l.bungaPerBulan : 0;
    pokok = Math.min(sisaUntukForm, Math.max(0, l.cicilan - bunga));
  }
  setMoney($('p-pokok'), pokok);
  setMoney($('p-bunga'), bunga);
  showFee('p', p ? p.biaya : 0);
  fillSelect($('p-akun'), accountNames(), p ? p.akun : l.akun);
  $('p-tanggal').value = p ? p.tanggal : todayStr();
  $('p-catatan').value = p ? p.catatan : '';
  $('p-sisa').textContent = 'Sisa pokok: ' + rp(sisaUntukForm);
  updatePayTotal();
  showSheet('payForm');
}

$('p-lunas').onclick = () => {
  if (!payLoan) return;
  const sisa = loanStats(payLoan).sisa + (editingPay ? editingPay.jumlah : 0);
  setMoney($('p-pokok'), sisa); updatePayTotal();
};

$('payForm').onsubmit = e => {
  e.preventDefault();
  const l = payLoan; if (!l) return;
  const pokok = money($('p-pokok'));
  const bunga = $('wrap-p-bunga').hidden ? 0 : money($('p-bunga'));
  if (!(pokok + bunga > 0)) { toast('Isi jumlah pembayaran'); return; }
  const sisa = loanStats(l).sisa + (editingPay ? editingPay.jumlah : 0);
  if (pokok > sisa) { toast('Pokok melebihi sisa pinjaman (' + rp(sisa) + ')'); return; }
  const tanggal = $('p-tanggal').value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tanggal)) { toast('Isi tanggal'); return; }
  const tx = {
    id: editingPay ? editingPay.id : uuid(),
    tanggal, jenis: J_BAYAR, kategori: l.jenis, akun: $('p-akun').value, jumlah: pokok, akunTujuan: '',
    catatan: $('p-catatan').value.trim().slice(0, 200),
    dibuatPada: editingPay ? editingPay.dibuatPada : nowStr(),
    pinjamanId: l.id, bunga, biaya: feeValue('p'),
  };
  const id = l.id;
  const lunasSekarang = pokok === sisa;
  closeSheets();
  enqueue({ op: 'upsert', tx });
  openLoanDetail(id);
  toast(lunasSekarang ? '🎉 Pinjaman lunas!' : 'Pembayaran tersimpan ✓');
};

$('p-del').onclick = () => {
  if (!editingPay || !confirm('Hapus pembayaran ini?')) return;
  const id = editingPay.id, loanId = payLoan.id;
  closeSheets();
  enqueue({ op: 'delete', id });
  openLoanDetail(loanId);
  toast('Pembayaran dihapus');
};

/* =====================================================================
 * Pemicu sinkron otomatis
 * ===================================================================== */

window.addEventListener('online', () => { renderStatus(); sync(false); });
window.addEventListener('offline', renderStatus);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(false); });
setInterval(() => { if (document.visibilityState === 'visible') sync(false); }, SYNC_INTERVAL_MS);

/* =====================================================================
 * Service worker (mode offline + update)
 * ===================================================================== */

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').then(reg => {
    const offer = w => {
      $('updateBar').classList.add('show');
      $('updateBtn').onclick = () => w.postMessage('skipWaiting');
    };
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w && w.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w);
      });
    });
    setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
  }).catch(() => {});
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded) return; reloaded = true; location.reload();
  });
}

/* Minta browser tidak menghapus data lokal saat memori HP penuh. */
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

render();
sync(false);

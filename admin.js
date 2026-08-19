// =====================================================================
// XAYA AI — admin.js
// Logic untuk admin.html. Terpisah total dari app.js (aplikasi user).
// Pakai akun login yang sama (Supabase Auth), tapi akses ditolak
// kalau role di tabel profiles bukan 'admin'.
// =====================================================================

function waitForConfig(timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (function check() {
      if (window.XAYA_CONFIG && window.supabase && window.supabase.createClient) return resolve();
      if (window.__CONFIG_LOAD_FAILED || Date.now() - start > timeoutMs) return reject(new Error('config.js atau library Supabase gagal dimuat'));
      setTimeout(check, 50);
    })();
  });
}

let supabase;
try {
  await waitForConfig();
  const { createClient } = window.supabase;
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.XAYA_CONFIG;
  supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
} catch (e) {
  document.getElementById('admin-error').textContent = 'Gagal memuat konfigurasi: ' + e.message;
  document.getElementById('admin-error').style.display = 'block';
  throw e;
}

const EMAIL_DOMAIN = '@xaya.local';
let currentAdmin = null;
let wdFilter = 'pending';
let contentFilter = 'videos';

function $(sel){ return document.querySelector(sel); }
function $all(sel){ return document.querySelectorAll(sel); }
function rupiah(n){ return 'Rp' + Number(n||0).toLocaleString('id-ID'); }
function esc(s){ return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function showToast(msg, type='info'){
  const el = $('#admin-toast');
  el.textContent = msg;
  el.style.color = type === 'error' ? 'var(--red)' : 'var(--text)';
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2600);
}

// ---------------------------------------------------------------------
// LOGIN
// ---------------------------------------------------------------------
$('#admin-submit').onclick = async () => {
  const username = $('#admin-username').value.trim().toLowerCase().replace(/[^a-z0-9_]/g,'');
  const password = $('#admin-password').value;
  const errEl = $('#admin-error');
  errEl.style.display = 'none';

  if (!username || !password) {
    errEl.textContent = 'Username dan password wajib diisi.';
    errEl.style.display = 'block';
    return;
  }

  const btn = $('#admin-submit');
  btn.disabled = true;
  try {
    const { error } = await supabase.auth.signInWithPassword({ email: username + EMAIL_DOMAIN, password });
    if (error) throw error;
    await checkAdminAndEnter();
  } catch (e) {
    errEl.textContent = e.message.includes('Invalid login') ? 'Username atau password salah.' : e.message;
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false;
  }
};

$('#admin-password').addEventListener('keydown', e => { if (e.key === 'Enter') $('#admin-submit').click(); });

async function checkAdminAndEnter() {
  const { data: userData } = await supabase.auth.getUser();
  const user = userData.user;
  if (!user) { showLoginScreen(); return; }

  const { data: profile, error } = await supabase.from('profiles').select('*').eq('id', user.id).single();
  if (error || !profile) {
    await supabase.auth.signOut();
    $('#admin-error').textContent = 'Profil tidak ditemukan.';
    $('#admin-error').style.display = 'block';
    showLoginScreen();
    return;
  }
  if (profile.role !== 'admin') {
    await supabase.auth.signOut();
    $('#admin-error').textContent = 'Akun ini bukan admin.';
    $('#admin-error').style.display = 'block';
    showLoginScreen();
    return;
  }

  currentAdmin = profile;
  $('#admin-whoami').textContent = '@' + profile.username;
  showShell();
  loadDashboard();
}

function showLoginScreen() {
  $('#admin-login-screen').style.display = 'flex';
  $('#admin-shell').classList.remove('active');
}
function showShell() {
  $('#admin-login-screen').style.display = 'none';
  $('#admin-shell').classList.add('active');
}

$('#admin-logout').onclick = async () => {
  await supabase.auth.signOut();
  currentAdmin = null;
  showLoginScreen();
};

// ---------------------------------------------------------------------
// TABS
// ---------------------------------------------------------------------
$all('.a-tab').forEach(tab => tab.onclick = () => {
  $all('.a-tab').forEach(t => t.classList.remove('active'));
  tab.classList.add('active');
  const view = tab.dataset.tab;
  $all('.a-view').forEach(v => v.classList.toggle('active', v.dataset.view === view));
  if (view === 'dashboard') loadDashboard();
  if (view === 'withdrawals') loadWithdrawals();
  if (view === 'users') loadUsers();
  if (view === 'content') loadContent();
});

// ---------------------------------------------------------------------
// DASHBOARD
// ---------------------------------------------------------------------
async function loadDashboard() {
  const grid = $('#stats-grid');
  const { data, error } = await supabase.rpc('admin_get_stats');
  if (error) { grid.innerHTML = `<div class="a-empty">Gagal memuat statistik: ${esc(error.message)}</div>`; return; }

  grid.innerHTML = `
    <div class="a-stat-card"><div class="a-stat-label">Total Pengguna</div><div class="a-stat-value">${data.total_users}</div></div>
    <div class="a-stat-card"><div class="a-stat-label">Pengguna Diblokir</div><div class="a-stat-value red">${data.banned_users}</div></div>
    <div class="a-stat-card"><div class="a-stat-label">Total Saldo Beredar</div><div class="a-stat-value green">${rupiah(data.total_balance)}</div></div>
    <div class="a-stat-card"><div class="a-stat-label">Penarikan Menunggu</div><div class="a-stat-value yellow">${data.pending_withdrawals}</div></div>
    <div class="a-stat-card"><div class="a-stat-label">Nilai Penarikan Menunggu</div><div class="a-stat-value yellow">${rupiah(data.pending_withdrawal_amount)}</div></div>
    <div class="a-stat-card"><div class="a-stat-label">Total Video</div><div class="a-stat-value">${data.total_videos}</div></div>
    <div class="a-stat-card"><div class="a-stat-label">Status Aktif</div><div class="a-stat-value">${data.total_statuses}</div></div>
  `;

  const badge = $('#badge-withdrawals');
  if (data.pending_withdrawals > 0) {
    badge.textContent = data.pending_withdrawals;
    badge.style.display = 'inline-block';
  } else {
    badge.style.display = 'none';
  }
}

// ---------------------------------------------------------------------
// WITHDRAWALS
// ---------------------------------------------------------------------
$all('[data-wd-filter]').forEach(chip => chip.onclick = () => {
  $all('[data-wd-filter]').forEach(c => c.classList.remove('active'));
  chip.classList.add('active');
  wdFilter = chip.dataset.wdFilter;
  loadWithdrawals();
});

async function loadWithdrawals() {
  const list = $('#withdrawals-list');
  list.innerHTML = `<div class="a-loading">Memuat...</div>`;

  let query = supabase.from('withdrawals').select('*, profiles(username, display_name)').order('created_at', { ascending: false });
  if (wdFilter !== 'all') query = query.eq('status', wdFilter);
  const { data, error } = await query;

  if (error) { list.innerHTML = `<div class="a-empty">Gagal memuat: ${esc(error.message)}</div>`; return; }
  if (!data || !data.length) {
    list.innerHTML = `<div class="a-empty"><svg class="icon" viewBox="0 0 24 24"><path d="M9 12h6M12 9v6"/><circle cx="12" cy="12" r="9"/></svg>Tidak ada data.</div>`;
    return;
  }

  const statusLabel = { pending: 'Menunggu', success: 'Selesai', rejected: 'Ditolak' };
  list.innerHTML = data.map(w => `
    <div class="a-row">
      <div class="a-row-avatar">${esc((w.profiles?.username || '?').slice(0,1).toUpperCase())}</div>
      <div class="a-row-mid">
        <div class="a-row-title">@${esc(w.profiles?.username || 'unknown')} <span class="a-pill ${w.status}">${statusLabel[w.status] || w.status}</span></div>
        <div class="a-row-sub">${rupiah(w.amount)} + fee ${rupiah(w.fee)} · ${esc(w.method?.toUpperCase())} · ${esc(w.account_name)} (${esc(w.account_number)})</div>
        <div class="a-row-sub">${new Date(w.created_at).toLocaleString('id-ID')}</div>
      </div>
      ${w.status === 'pending' ? `
        <div class="a-row-right">
          <button class="a-icon-btn approve" data-approve="${w.id}" title="Setujui">
            <svg class="icon" style="width:16px;height:16px" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg>
          </button>
          <button class="a-icon-btn reject" data-reject="${w.id}" title="Tolak">
            <svg class="icon" style="width:16px;height:16px" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>
      ` : ''}
    </div>
  `).join('');

  $all('[data-approve]').forEach(btn => btn.onclick = () => approveWithdrawal(btn.dataset.approve, btn));
  $all('[data-reject]').forEach(btn => btn.onclick = () => openRejectModal(btn.dataset.reject));
}

async function approveWithdrawal(id, btn) {
  btn.disabled = true;
  const { error } = await supabase.rpc('admin_approve_withdrawal', { p_id: id });
  if (error) { showToast(error.message, 'error'); btn.disabled = false; return; }
  showToast('Penarikan disetujui');
  loadWithdrawals();
  loadDashboard();
}

let rejectTargetId = null;
function openRejectModal(id) {
  rejectTargetId = id;
  $('#reject-note').value = '';
  $('#modal-reject').classList.add('open');
}
$('#reject-cancel').onclick = () => $('#modal-reject').classList.remove('open');
$('#reject-confirm').onclick = async () => {
  const note = $('#reject-note').value.trim() || null;
  const { error } = await supabase.rpc('admin_reject_withdrawal', { p_id: rejectTargetId, p_note: note });
  if (error) { showToast(error.message, 'error'); return; }
  $('#modal-reject').classList.remove('open');
  showToast('Penarikan ditolak, saldo dikembalikan');
  loadWithdrawals();
  loadDashboard();
};

// ---------------------------------------------------------------------
// USERS
// ---------------------------------------------------------------------
let usersCache = [];
let userSearchTimer = null;
$('#user-search').addEventListener('input', () => {
  clearTimeout(userSearchTimer);
  userSearchTimer = setTimeout(renderUsers, 150);
});

async function loadUsers() {
  const list = $('#users-list');
  list.innerHTML = `<div class="a-loading">Memuat...</div>`;
  const { data, error } = await supabase.from('profiles').select('*').order('created_at', { ascending: false });
  if (error) { list.innerHTML = `<div class="a-empty">Gagal memuat: ${esc(error.message)}</div>`; return; }
  usersCache = data || [];
  renderUsers();
}

function renderUsers() {
  const list = $('#users-list');
  const q = $('#user-search').value.trim().toLowerCase();
  const filtered = q ? usersCache.filter(u => u.username.toLowerCase().includes(q) || (u.display_name||'').toLowerCase().includes(q)) : usersCache;

  if (!filtered.length) {
    list.innerHTML = `<div class="a-empty"><svg class="icon" viewBox="0 0 24 24"><circle cx="9" cy="8" r="4"/><path d="M2 21c0-4 3-7 7-7s7 3 7 7"/></svg>Tidak ada pengguna.</div>`;
    return;
  }

  list.innerHTML = filtered.map(u => `
    <div class="a-row">
      <div class="a-row-avatar">${u.avatar_url ? `<img src="${esc(u.avatar_url)}">` : esc(u.username.slice(0,1).toUpperCase())}</div>
      <div class="a-row-mid">
        <div class="a-row-title">
          @${esc(u.username)}
          ${u.role === 'admin' ? '<span class="a-pill admin">Admin</span>' : ''}
          ${u.banned ? '<span class="a-pill banned">Diblokir</span>' : ''}
        </div>
        <div class="a-row-sub">${rupiah(u.balance)} · bergabung ${new Date(u.created_at).toLocaleDateString('id-ID')}</div>
      </div>
      <div class="a-row-right">
        <button class="a-icon-btn" data-edit-balance="${u.id}" title="Ubah saldo">
          <svg class="icon" style="width:15px;height:15px" viewBox="0 0 24 24"><path d="M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
        </button>
        <button class="a-icon-btn ${u.banned ? '' : 'danger'}" data-toggle-ban="${u.id}" data-banned="${u.banned}" title="${u.banned ? 'Buka blokir' : 'Blokir'}">
          <svg class="icon" style="width:15px;height:15px" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M4.9 4.9l14.2 14.2"/></svg>
        </button>
        <button class="a-icon-btn danger" data-delete-user="${u.id}" title="Hapus akun">
          <svg class="icon" style="width:15px;height:15px" viewBox="0 0 24 24"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6"/></svg>
        </button>
      </div>
    </div>
  `).join('');

  $all('[data-edit-balance]').forEach(btn => btn.onclick = () => openBalanceModal(btn.dataset.editBalance));
  $all('[data-toggle-ban]').forEach(btn => btn.onclick = () => toggleBan(btn.dataset.toggleBan, btn.dataset.banned === 'true'));
  $all('[data-delete-user]').forEach(btn => btn.onclick = () => confirmDeleteUser(btn.dataset.deleteUser));
}

let balanceTargetId = null;
function openBalanceModal(userId) {
  balanceTargetId = userId;
  const u = usersCache.find(x => x.id === userId);
  $('#balance-input').value = u ? u.balance : 0;
  $('#modal-balance').classList.add('open');
}
$('#balance-cancel').onclick = () => $('#modal-balance').classList.remove('open');
$('#balance-confirm').onclick = async () => {
  const val = Number($('#balance-input').value);
  if (!Number.isFinite(val) || val < 0) { showToast('Nominal tidak valid', 'error'); return; }
  const { error } = await supabase.rpc('admin_set_balance', { p_user_id: balanceTargetId, p_balance: Math.round(val) });
  if (error) { showToast(error.message, 'error'); return; }
  $('#modal-balance').classList.remove('open');
  showToast('Saldo diperbarui');
  loadUsers();
  loadDashboard();
};

async function toggleBan(userId, currentlyBanned) {
  const { error } = await supabase.rpc('admin_set_banned', { p_user_id: userId, p_banned: !currentlyBanned });
  if (error) { showToast(error.message, 'error'); return; }
  showToast(currentlyBanned ? 'Blokir dibuka' : 'Pengguna diblokir');
  loadUsers();
  loadDashboard();
}

let genericConfirmAction = null;
function openGenericConfirm(title, body, action) {
  $('#generic-modal-title').textContent = title;
  $('#generic-modal-body').textContent = body;
  genericConfirmAction = action;
  $('#modal-confirm-generic').classList.add('open');
}
$('#generic-cancel').onclick = () => $('#modal-confirm-generic').classList.remove('open');
$('#generic-confirm').onclick = async () => {
  const action = genericConfirmAction;
  $('#modal-confirm-generic').classList.remove('open');
  if (action) await action();
};

function confirmDeleteUser(userId) {
  const u = usersCache.find(x => x.id === userId);
  openGenericConfirm(
    'Hapus akun ini?',
    `@${u?.username || ''} akan dihapus permanen beserta seluruh data (video, status, riwayat penarikan). Tindakan ini tidak bisa dibatalkan.`,
    async () => {
      const { error } = await supabase.rpc('admin_delete_user', { p_user_id: userId });
      if (error) { showToast(error.message, 'error'); return; }
      showToast('Akun dihapus');
      loadUsers();
      loadDashboard();
    }
  );
}

// ---------------------------------------------------------------------
// CONTENT MODERATION
// ---------------------------------------------------------------------
$all('[data-content-filter]').forEach(chip => chip.onclick = () => {
  $all('[data-content-filter]').forEach(c => c.classList.remove('active'));
  chip.classList.add('active');
  contentFilter = chip.dataset.contentFilter;
  loadContent();
});

async function loadContent() {
  const grid = $('#content-grid');
  grid.innerHTML = `<div class="a-loading">Memuat...</div>`;

  if (contentFilter === 'videos') {
    const { data, error } = await supabase.from('videos').select('*, profiles(username)').eq('deleted_by_admin', false).order('created_at', { ascending: false }).limit(60);
    if (error) { grid.innerHTML = `<div class="a-empty">Gagal memuat: ${esc(error.message)}</div>`; return; }
    if (!data || !data.length) { grid.innerHTML = `<div class="a-empty">Belum ada video.</div>`; return; }
    grid.innerHTML = data.map(v => `
      <div class="a-media-cell">
        <video src="${esc(v.video_url)}" muted></video>
        <div class="a-media-user">@${esc(v.profiles?.username || '?')}</div>
        <button class="a-media-del" data-del-video="${v.id}" title="Hapus">
          <svg class="icon" style="width:14px;height:14px" viewBox="0 0 24 24"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6"/></svg>
        </button>
      </div>
    `).join('');
    $all('[data-del-video]').forEach(btn => btn.onclick = () => confirmDeleteContent('video', btn.dataset.delVideo));
  } else {
    const { data, error } = await supabase.from('statuses').select('*, profiles(username)').eq('deleted_by_admin', false).order('created_at', { ascending: false }).limit(60);
    if (error) { grid.innerHTML = `<div class="a-empty">Gagal memuat: ${esc(error.message)}</div>`; return; }
    if (!data || !data.length) { grid.innerHTML = `<div class="a-empty">Belum ada status.</div>`; return; }
    grid.innerHTML = data.map(s => `
      <div class="a-media-cell">
        ${s.media_type === 'video' ? `<video src="${esc(s.media_url)}" muted></video>` : `<img src="${esc(s.media_url)}">`}
        <div class="a-media-user">@${esc(s.profiles?.username || '?')}</div>
        <button class="a-media-del" data-del-status="${s.id}" title="Hapus">
          <svg class="icon" style="width:14px;height:14px" viewBox="0 0 24 24"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6"/></svg>
        </button>
      </div>
    `).join('');
    $all('[data-del-status]').forEach(btn => btn.onclick = () => confirmDeleteContent('status', btn.dataset.delStatus));
  }
}

function confirmDeleteContent(kind, id) {
  openGenericConfirm(
    kind === 'video' ? 'Hapus video ini?' : 'Hapus status ini?',
    'Konten akan disembunyikan dari semua pengguna.',
    async () => {
      const rpc = kind === 'video' ? 'admin_delete_video' : 'admin_delete_status';
      const { error } = await supabase.rpc(rpc, { p_id: id });
      if (error) { showToast(error.message, 'error'); return; }
      showToast('Konten dihapus');
      loadContent();
      loadDashboard();
    }
  );
}

// ---------------------------------------------------------------------
// INIT
// ---------------------------------------------------------------------
(async function init() {
  const { data: { session } } = await supabase.auth.getSession();
  if (session) {
    await checkAdminAndEnter();
  } else {
    showLoginScreen();
  }
})();

// Ambil config dari config.js (window.XAYA_CONFIG). Kalau file itu gagal dimuat
// atau belum ada, tampilkan error yang jelas di splash — bukan diam/stuck.
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
  window.supabase = supabase;
} catch (e) {
  document.getElementById('splash-spinner').style.display = 'none';
  document.getElementById('splash-error').style.display = 'block';
  throw e;
}

const ALLOWED_AMOUNTS = [10, 500, 1000, 2000, 5000, 10000];
const WITHDRAWAL_FEE = 1000;
const EMAIL_DOMAIN = '@xaya.local';

let currentUser = null;
let currentProfile = null;
let claimTimer = null;
let lastKnownBalance = 0;
let isRegisterMode = false;
let statusFileObj = null, statusFileType = null;
let videoFileObj = null;
let selectedWdAmount = null, selectedWdMethod = null;
let statusItems = [];
let statusTimer = null;

function $(sel){ return document.querySelector(sel); }
function $all(sel){ return document.querySelectorAll(sel); }
function showScreen(id){ $all('.screen').forEach(s=>s.classList.remove('active')); $('#'+id).classList.add('active'); }
function showToast(msg, type='info'){
  const el = $('#toast');
  el.textContent = msg;
  el.style.color = type==='error' ? 'var(--red)' : 'var(--text)';
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(()=>el.classList.remove('show'), 2500);
}
function rupiah(n){ return 'Rp' + Number(n||0).toLocaleString('id-ID'); }
function initials(name){ return (name||'?').slice(0,1).toUpperCase(); }

$('#toggle-pw').onclick = () => {
  const inp = $('#auth-password');
  inp.type = inp.type === 'password' ? 'text' : 'password';
};

function wireRegisterToggle() {
  const el = document.getElementById('go-register');
  if (!el) return;
  el.onclick = () => {
    isRegisterMode = !isRegisterMode;
    $('#auth-submit').textContent = isRegisterMode ? 'Daftar' : 'Login';
    $('#auth-switch').innerHTML = isRegisterMode
      ? 'Sudah punya akun? <b id="go-register">Login</b>'
      : 'Belum punya akun? <b id="go-register">Daftar</b>';
    wireRegisterToggle();
  };
}
wireRegisterToggle();

$('#auth-submit').onclick = async () => {
  const username = $('#auth-username').value.trim().toLowerCase().replace(/[^a-z0-9_]/g,'');
  const password = $('#auth-password').value;
  const errEl = $('#auth-error');
  errEl.style.display = 'none';

  if (!username || username.length < 3) {
    errEl.textContent = 'Username minimal 3 karakter (huruf/angka/underscore).';
    errEl.style.display = 'block';
    return;
  }
  if (!password || password.length < 6) {
    errEl.textContent = 'Password minimal 6 karakter.';
    errEl.style.display = 'block';
    return;
  }

  const btn = $('#auth-submit');
  btn.disabled = true;
  const email = username + EMAIL_DOMAIN;

  try {
    if (isRegisterMode) {
      const { data, error } = await supabase.auth.signUp({
        email, password, options: { data: { username } }
      });
      if (error) throw error;
      if (!data.session) {
        errEl.textContent = 'Akun dibuat. Silakan login.';
        errEl.style.display = 'block';
        document.getElementById('go-register').click();
        btn.disabled = false;
        return;
      }
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
    }
    await onAuthed();
  } catch (e) {
    errEl.textContent = e.message.includes('Invalid login') ? 'Username atau password salah.' : e.message;
    errEl.style.display = 'block';
    btn.disabled = false;
  }
};

$('#logout-btn').onclick = async () => {
  stopHeartbeat();
  await supabase.auth.signOut();
  currentUser = null; currentProfile = null;
  showScreen('screen-auth');
};

async function onAuthed() {
  const { data: userData } = await supabase.auth.getUser();
  currentUser = userData.user;
  showScreen('screen-app');
  navigate('home');
  startHeartbeat();
  // Muat profile, status, dan video bareng-bareng (bukan berurutan) biar tampil lebih cepat
  loadProfile();
  loadStatuses();
  loadVideoFeed();
}

async function loadProfile() {
  const { data, error } = await supabase.from('profiles').select('*').eq('id', currentUser.id).single();
  if (error) { console.error(error); return; }
  currentProfile = data;
  lastKnownBalance = data.balance;
  renderBalance(data.balance);
  $('#welcome-name').textContent = 'Welcome back, ' + (data.display_name || data.username);
  renderProfileHeader();
}

function renderBalance(balance) {
  $('#topbar-balance').textContent = rupiah(balance);
  $('#wallet-balance').textContent = rupiah(balance);
  $('#stat-balance').textContent = rupiah(balance);
}

function navigate(page) {
  $all('.page-view').forEach(p => p.style.display = p.dataset.page === page ? 'block' : 'none');
  $all('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.nav === page));
  const label = { home:'Home', status:'Status', video:'Video', wallet:'Wallet', profile:'Profil' }[page];
  $('#page-title').innerHTML = '<span></span>' + label;
  if (page === 'profile') renderProfileHeader();
  if (page === 'wallet') loadWithdrawHistory();
  $('#fab-upload').style.display = (page === 'wallet') ? 'none' : 'flex';
}
$all('[data-nav]').forEach(el => el.addEventListener('click', () => navigate(el.dataset.nav)));

function startHeartbeat() {
  stopHeartbeat();
  claim();
  claimTimer = setInterval(claim, 5 * 60 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') claim();
  });
}
function stopHeartbeat() { if (claimTimer) clearInterval(claimTimer); claimTimer = null; }
async function claim() {
  const { data, error } = await supabase.rpc('claim_online_reward');
  if (error) { console.error(error); return; }
  if (data.balance > lastKnownBalance) {
    showToast(`+${rupiah(data.balance - lastKnownBalance)} saldo diterima`);
  }
  lastKnownBalance = data.balance;
  renderBalance(data.balance);
}

async function loadStatuses() {
  const { data, error } = await supabase
    .from('statuses')
    .select('*, profiles(username, display_name, avatar_url)')
    .eq('deleted_by_admin', false).eq('deleted_by_user', false)
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false });

  if (error) { console.error(error); return; }
  statusItems = data || [];
  const row = $('#status-row');
  const others = statusItems.filter(s => s.user_id !== currentUser.id);

  let html = `
    <div class="status-circle" id="add-status-circle">
      <div class="ring add add-badge"><div class="avatar-img">${currentProfile?.avatar_url ? `<img src="${currentProfile.avatar_url}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">` : initials(currentProfile?.display_name || currentProfile?.username)}</div></div>
      <span>Status Kamu</span>
    </div>`;

  others.forEach((s) => {
    const name = s.profiles?.display_name || s.profiles?.username || 'User';
    html += `
      <div class="status-circle" data-status-id="${s.id}">
        <div class="ring"><div class="avatar-img">${s.profiles?.avatar_url ? `<img src="${s.profiles.avatar_url}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">` : initials(name)}</div></div>
        <span>${name}</span>
      </div>`;
  });

  row.innerHTML = html;
  $('#add-status-circle').onclick = () => openSheet('status-upload-overlay');
  row.querySelectorAll('[data-status-id]').forEach(el => {
    el.onclick = () => openStatusViewer(statusItems.findIndex(s => s.id === el.dataset.statusId));
  });

  $('#status-empty').style.display = others.length ? 'none' : 'flex';
}

function openStatusViewer(index) {
  if (index < 0 || index >= statusItems.length) { closeStatusViewer(); return; }
  const s = statusItems[index];
  const name = s.profiles?.display_name || s.profiles?.username || 'User';
  $('#viewer-username').textContent = name;
  $('#viewer-avatar').innerHTML = s.profiles?.avatar_url ? `<img src="${s.profiles.avatar_url}" style="width:100%;height:100%;object-fit:cover">` : '';
  $('#viewer-caption').textContent = s.caption || '';

  const mediaEl = $('#viewer-media');
  mediaEl.innerHTML = s.media_type === 'video'
    ? `<video src="${s.media_url}" autoplay playsinline></video>`
    : `<img src="${s.media_url}" />`;

  $('#viewer-progress').innerHTML = statusItems.map((_, i) =>
    `<div class="bar"><i style="width:${i < index ? '100' : '0'}%"></i></div>`
  ).join('');

  $('#status-viewer').classList.add('open');
  clearTimeout(statusTimer);
  const bar = $('#viewer-progress').children[index]?.firstElementChild;
  if (bar) {
    requestAnimationFrame(() => { bar.style.transition = 'width 5s linear'; bar.style.width = '100%'; });
  }
  statusTimer = setTimeout(() => openStatusViewer(index + 1), 5000);
}
function closeStatusViewer() {
  clearTimeout(statusTimer);
  $('#status-viewer').classList.remove('open');
  $('#viewer-media').innerHTML = '';
}
$('#viewer-close').onclick = closeStatusViewer;

async function loadVideoFeed() {
  const { data, error } = await supabase
    .from('videos')
    .select('*, profiles(username, display_name, avatar_url)')
    .eq('deleted_by_admin', false).eq('deleted_by_user', false)
    .order('created_at', { ascending: false })
    .limit(20);

  const feed = $('#video-feed');
  if (error) { feed.innerHTML = `<div class="empty">Gagal memuat video.</div>`; return; }
  if (!data.length) {
    feed.innerHTML = `
      <div class="empty">
        <svg class="icon" viewBox="0 0 24 24"><rect x="2" y="6" width="15" height="12" rx="2"/><path d="M17 10l5-3v10l-5-3"/></svg>
        Belum ada video. Jadilah yang pertama upload!
      </div>`;
    return;
  }

  feed.innerHTML = data.map(v => {
    const name = v.profiles?.display_name || v.profiles?.username || 'User';
    return `
    <div class="video-card">
      <video src="${v.video_url}" controls playsinline preload="metadata" data-video-id="${v.id}"></video>
      <div class="video-meta">
        <div class="video-user">
          <div class="avatar-sm">${v.profiles?.avatar_url ? `<img src="${v.profiles.avatar_url}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">` : initials(name)}</div>
          ${name}
        </div>
        ${v.caption ? `<div class="video-caption">${v.caption}</div>` : ''}
        <div class="video-stats">
          <svg class="icon" viewBox="0 0 24 24"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>
          ${v.view_count} views
        </div>
      </div>
    </div>`;
  }).join('');

  feed.querySelectorAll('video').forEach(vid => {
    vid.addEventListener('play', () => {
      supabase.rpc('register_video_view', { p_video_id: vid.dataset.videoId }).catch(console.error);
    }, { once: true });
  });
}

function openSheet(id) { $('#' + id).classList.add('open'); }
function closeSheet(id) { $('#' + id).classList.remove('open'); }

$('#fab-upload').onclick = () => openSheet('upload-overlay');
$('#choose-status').onclick = () => { closeSheet('upload-overlay'); openSheet('status-upload-overlay'); };
$('#choose-video').onclick = () => { closeSheet('upload-overlay'); openSheet('video-upload-overlay'); };

$('#status-drop').onclick = () => $('#status-file').click();
$('#status-file').onchange = (e) => {
  const f = e.target.files[0]; if (!f) return;
  statusFileObj = f;
  statusFileType = f.type.startsWith('video') ? 'video' : 'image';
  const url = URL.createObjectURL(f);
  $('#status-preview-img').style.display = statusFileType === 'image' ? 'block' : 'none';
  $('#status-preview-vid').style.display = statusFileType === 'video' ? 'block' : 'none';
  if (statusFileType === 'image') $('#status-preview-img').src = url; else $('#status-preview-vid').src = url;
  $('#submit-status-upload').disabled = false;
};
$('#cancel-status-upload').onclick = () => { closeSheet('status-upload-overlay'); resetStatusForm(); };
function resetStatusForm() {
  statusFileObj = null; $('#status-file').value = '';
  $('#status-preview-img').style.display = 'none'; $('#status-preview-vid').style.display = 'none';
  $('#status-caption').value = ''; $('#submit-status-upload').disabled = true;
}
$('#submit-status-upload').onclick = async () => {
  if (!statusFileObj) return;
  const btn = $('#submit-status-upload'); btn.disabled = true; btn.textContent = 'Mengunggah...';
  try {
    const path = `statuses/${currentUser.id}/${Date.now()}-${statusFileObj.name}`;
    const { error: upErr } = await supabase.storage.from('media').upload(path, statusFileObj);
    if (upErr) throw upErr;
    const { data: pub } = supabase.storage.from('media').getPublicUrl(path);

    const { error } = await supabase.from('statuses').insert({
      user_id: currentUser.id, media_url: pub.publicUrl, media_type: statusFileType,
      caption: $('#status-caption').value.trim() || null,
    });
    if (error) throw error;

    showToast('Status dipublikasikan');
    closeSheet('status-upload-overlay'); resetStatusForm();
    loadStatuses();
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Publikasikan';
  }
};

$('#video-drop').onclick = () => $('#video-file').click();
$('#video-file').onchange = (e) => {
  const f = e.target.files[0]; if (!f) return;
  videoFileObj = f;
  $('#video-preview').style.display = 'block';
  $('#video-preview').src = URL.createObjectURL(f);
  $('#submit-video-upload').disabled = false;
};
$('#cancel-video-upload').onclick = () => { closeSheet('video-upload-overlay'); resetVideoForm(); };
function resetVideoForm() {
  videoFileObj = null; $('#video-file').value = '';
  $('#video-preview').style.display = 'none';
  $('#video-caption').value = ''; $('#submit-video-upload').disabled = true;
}
$('#submit-video-upload').onclick = async () => {
  if (!videoFileObj) return;
  const btn = $('#submit-video-upload'); btn.disabled = true; btn.textContent = 'Mengunggah...';
  try {
    const path = `videos/${currentUser.id}/${Date.now()}-${videoFileObj.name}`;
    const { error: upErr } = await supabase.storage.from('media').upload(path, videoFileObj);
    if (upErr) throw upErr;
    const { data: pub } = supabase.storage.from('media').getPublicUrl(path);

    const { error } = await supabase.from('videos').insert({
      user_id: currentUser.id, video_url: pub.publicUrl,
      caption: $('#video-caption').value.trim() || null,
    });
    if (error) throw error;

    showToast('Video dipublikasikan');
    closeSheet('video-upload-overlay'); resetVideoForm();
    loadVideoFeed();
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Publikasikan';
  }
};

function renderProfileHeader() {
  if (!currentProfile) return;
  $('#profile-display-name').textContent = currentProfile.display_name || currentProfile.username;
  $('#profile-username').textContent = '@' + currentProfile.username;
  $('#profile-avatar').innerHTML = currentProfile.avatar_url
    ? `<img src="${currentProfile.avatar_url}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`
    : `<svg class="icon" style="width:32px;height:32px" viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg>`;
  loadProfileMedia('videos');
}

$all('.tab').forEach(t => t.onclick = () => {
  $all('.tab').forEach(x => x.classList.remove('active'));
  t.classList.add('active');
  loadProfileMedia(t.dataset.tab);
});

async function loadProfileMedia(kind) {
  const grid = $('#profile-media-grid');
  grid.innerHTML = '';
  if (kind === 'videos') {
    const { data } = await supabase.from('videos').select('*').eq('user_id', currentUser.id).eq('deleted_by_user', false).order('created_at', { ascending: false });
    $('#stat-videos').textContent = data?.length || 0;
    grid.innerHTML = (data || []).map(v => `
      <div class="cell"><video src="${v.video_url}" muted></video><div class="views"><svg class="icon" viewBox="0 0 24 24"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>${v.view_count}</div></div>
    `).join('') || `<div class="empty" style="grid-column:1/-1">Belum ada video.</div>`;
  } else {
    const { data } = await supabase.from('statuses').select('*').eq('user_id', currentUser.id).eq('deleted_by_user', false).order('created_at', { ascending: false });
    $('#stat-status').textContent = data?.length || 0;
    grid.innerHTML = (data || []).map(s => `
      <div class="cell">${s.media_type === 'video' ? `<video src="${s.media_url}" muted></video>` : `<img src="${s.media_url}">`}</div>
    `).join('') || `<div class="empty" style="grid-column:1/-1">Belum ada status.</div>`;
  }
}

$('#edit-avatar-btn').onclick = () => $('#avatar-file').click();
$('#avatar-file').onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const path = `avatars/${currentUser.id}/${Date.now()}-${f.name}`;
    const { error: upErr } = await supabase.storage.from('media').upload(path, f);
    if (upErr) throw upErr;
    const { data: pub } = supabase.storage.from('media').getPublicUrl(path);
    const { error } = await supabase.from('profiles').update({ avatar_url: pub.publicUrl }).eq('id', currentUser.id);
    if (error) throw error;
    currentProfile.avatar_url = pub.publicUrl;
    renderProfileHeader();
    showToast('Foto profil diperbarui');
  } catch (err) {
    showToast(err.message, 'error');
  }
};

$('#edit-profile-btn').onclick = () => {
  $('#edit-display-name').value = currentProfile.display_name || '';
  openSheet('edit-profile-overlay');
};
$('#cancel-edit-profile').onclick = () => closeSheet('edit-profile-overlay');
$('#save-edit-profile').onclick = async () => {
  const name = $('#edit-display-name').value.trim();
  const { error } = await supabase.from('profiles').update({ display_name: name || null }).eq('id', currentUser.id);
  if (error) { showToast(error.message, 'error'); return; }
  currentProfile.display_name = name;
  renderProfileHeader();
  closeSheet('edit-profile-overlay');
  showToast('Profil diperbarui');
};

const amountGrid = $('#amount-grid');
amountGrid.innerHTML = ALLOWED_AMOUNTS.map(a => `<div class="chip" data-amount="${a}">${rupiah(a)}</div>`).join('');

$('#open-withdraw').onclick = () => openSheet('withdraw-overlay');
$('#cancel-withdraw').onclick = () => closeSheet('withdraw-overlay');

amountGrid.querySelectorAll('.chip').forEach(el => el.onclick = () => {
  amountGrid.querySelectorAll('.chip').forEach(c => c.classList.remove('selected'));
  el.classList.add('selected');
  selectedWdAmount = Number(el.dataset.amount);
  updateWdSummary(); validateWd();
});
$('#method-grid').querySelectorAll('.chip').forEach(el => el.onclick = () => {
  $('#method-grid').querySelectorAll('.chip').forEach(c => c.classList.remove('selected'));
  el.classList.add('selected');
  selectedWdMethod = el.dataset.method;
  validateWd();
});
[$('#wd-account-number'), $('#wd-account-name')].forEach(i => i.addEventListener('input', validateWd));

function updateWdSummary() {
  if (!selectedWdAmount) { $('#wd-summary').style.display = 'none'; return; }
  $('#wd-summary').style.display = 'block';
  $('#wd-sum-amount').textContent = rupiah(selectedWdAmount);
  $('#wd-sum-total').textContent = rupiah(selectedWdAmount + WITHDRAWAL_FEE);
}
function validateWd() {
  $('#confirm-withdraw').disabled = !(selectedWdAmount && selectedWdMethod && $('#wd-account-number').value.trim() && $('#wd-account-name').value.trim());
}

$('#confirm-withdraw').onclick = async () => {
  const btn = $('#confirm-withdraw'); btn.disabled = true;
  const { error } = await supabase.rpc('request_withdrawal', {
    p_amount: selectedWdAmount, p_method: selectedWdMethod,
    p_account_number: $('#wd-account-number').value.trim(),
    p_account_name: $('#wd-account-name').value.trim(),
  });
  if (error) { showToast(error.message, 'error'); btn.disabled = false; return; }
  showToast('Permintaan penarikan terkirim');
  closeSheet('withdraw-overlay');
  await loadProfile();
  loadWithdrawHistory();
};

async function loadWithdrawHistory() {
  const { data, error } = await supabase.from('withdrawals').select('*').order('created_at', { ascending: false });
  const list = $('#tx-list');
  if (error || !data?.length) {
    list.innerHTML = `<div class="empty"><svg class="icon" viewBox="0 0 24 24"><path d="M9 12h6M12 9v6"/><circle cx="12" cy="12" r="9"/></svg>Belum ada riwayat.</div>`;
    return;
  }
  list.innerHTML = data.map(w => `
    <div class="tx-item">
      <div class="tx-icon"><svg class="icon" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="3"/><circle cx="12" cy="12" r="3"/></svg></div>
      <div class="tx-mid">
        <div class="tx-title">Tarik ke ${w.method.toUpperCase()}</div>
        <div class="tx-time">${new Date(w.created_at).toLocaleString('id-ID')}</div>
      </div>
      <div class="tx-right">
        <div class="tx-amount">-${rupiah(w.amount + (w.fee || 0))}</div>
        <span class="status-pill ${w.status}">${{pending:'Menunggu',success:'Selesai',rejected:'Ditolak'}[w.status] || w.status}</span>
      </div>
    </div>
  `).join('');
}

(async function init() {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (session) { await onAuthed(); }
    else { showScreen('screen-auth'); }
  } catch (e) {
    console.error(e);
    document.getElementById('splash-spinner').style.display = 'none';
    document.getElementById('splash-error').style.display = 'block';
    document.querySelector('#splash-error div').textContent = 'Gagal terhubung ke server: ' + e.message;
  }
})();

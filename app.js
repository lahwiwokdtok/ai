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

const VERIFIED_BADGE_SVG = `<span class="verified-badge"><svg viewBox="0 0 24 24" fill="#3ba3ff"><path d="M12 2l2.4 1.7 2.9-.4 1.1 2.7 2.7 1.1-.4 2.9L22 12l-1.7 2.4.4 2.9-2.7 1.1-1.1 2.7-2.9-.4L12 22l-2.4-1.7-2.9.4-1.1-2.7-2.7-1.1.4-2.9L2 12l1.7-2.4-.4-2.9 2.7-1.1 1.1-2.7 2.9.4z"/><path d="M9 12l2 2 4-4" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;

function displayNameOf(p) {
  if (!p) return 'User';
  if (p.is_verified && p.verified_name) return p.verified_name;
  return p.display_name || p.username || 'User';
}
function nameWithBadge(p) {
  return escHtml(displayNameOf(p)) + (p?.is_verified ? VERIFIED_BADGE_SVG : '');
}

function timeAgo(dateStr) {
  const diff = (Date.now() - new Date(dateStr).getTime()) / 1000;
  if (diff < 60) return 'baru saja';
  if (diff < 3600) return Math.floor(diff / 60) + ' menit lalu';
  if (diff < 86400) return Math.floor(diff / 3600) + ' jam lalu';
  if (diff < 604800) return Math.floor(diff / 86400) + ' hari lalu';
  return new Date(dateStr).toLocaleDateString('id-ID', { day: '2-digit', month: 'short' });
}

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
  if (chatChannel) { supabase.removeChannel(chatChannel); chatChannel = null; }
  if (dmChannel) { supabase.removeChannel(dmChannel); dmChannel = null; }
  if (dmNotifyChannel) { supabase.removeChannel(dmNotifyChannel); dmNotifyChannel = null; }
  if (chatNotifyChannel) { supabase.removeChannel(chatNotifyChannel); chatNotifyChannel = null; }
  if (notifChannel) { supabase.removeChannel(notifChannel); notifChannel = null; }
  chatMessagesCache = []; chatLoaded = false;
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
  subscribeGlobalNotifications();
  checkUnreadDm();
  checkUnreadNotif();
  subscribeNotifRealtime();
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
  $('#welcome-name').textContent = 'Welcome back, ' + displayNameOf(data);
  renderProfileHeader();
}

function renderBalance(balance) {
  $('#topbar-balance').textContent = rupiah(balance);
  $('#wallet-balance').textContent = rupiah(balance);
  $('#stat-balance').textContent = rupiah(balance);
}

let currentPageName = 'home';
function navigate(page) {
  currentPageName = page;
  $all('.page-view').forEach(p => p.style.display = p.dataset.page === page ? (p.dataset.page === 'chat' ? 'flex' : 'block') : 'none');
  $all('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.nav === page));
  const label = { home:'Home', chat:'Chat', status:'Status', video:'Video', wallet:'Wallet', profile:'Profil' }[page];
  $('#page-title').innerHTML = '<span></span>' + label;
  if (page === 'profile') renderProfileHeader();
  if (page === 'wallet') loadWithdrawHistory();
  if (page === 'chat') { loadChatMessages(); subscribeChatRealtime(); scrollChatToBottom(); $('#chat-nav-dot').classList.remove('show'); }
  $('#fab-upload').style.display = (page === 'wallet' || page === 'chat') ? 'none' : 'flex';
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
    .select('*, profiles(id, username, display_name, avatar_url, is_verified, verified_name)')
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
  const p = s.profiles;
  $('#viewer-username').innerHTML = nameWithBadge(p);
  $('#viewer-avatar').innerHTML = p?.avatar_url ? `<img src="${escHtml(p.avatar_url)}" style="width:100%;height:100%;object-fit:cover">` : initials(displayNameOf(p));
  $('#viewer-caption').textContent = s.caption || '';

  const isOwn = s.user_id === currentUser.id;
  $('#viewer-menu-wrap').style.display = isOwn ? 'block' : 'none';
  $('#viewer-delete-status').onclick = () => {
    closeStatusViewer();
    deleteOwnStatus(s.id, () => loadStatuses());
  };
  $('#viewer-user-info').onclick = () => { closeStatusViewer(); openUserProfile(p?.id); };

  const mediaEl = $('#viewer-media');
  mediaEl.innerHTML = s.media_type === 'video'
    ? `<video src="${escHtml(s.media_url)}" autoplay playsinline></video>`
    : `<img src="${escHtml(s.media_url)}" />`;

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
$('#viewer-menu-btn').onclick = (e) => {
  e.stopPropagation();
  $('#viewer-menu-dropdown').classList.toggle('open');
};

async function loadVideoFeed() {
  const { data, error } = await supabase
    .from('videos')
    .select('*, profiles(id, username, display_name, avatar_url, is_verified, verified_name)')
    .eq('deleted_by_admin', false).eq('deleted_by_user', false)
    .order('is_promoted', { ascending: false })
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

  // Cek video mana saja yang sudah disukai user ini
  let likedSet = new Set();
  const { data: myLikes } = await supabase.from('video_likes').select('video_id').eq('user_id', currentUser.id).in('video_id', data.map(v => v.id));
  (myLikes || []).forEach(l => likedSet.add(l.video_id));

  feed.innerHTML = data.map(v => {
    const p = v.profiles;
    const isLiked = likedSet.has(v.id);
    const isOwn = v.user_id === currentUser.id;
    return `
    <div class="video-card content-menu-wrap">
      <video src="${v.video_url}" controls playsinline preload="metadata" data-video-id="${v.id}"></video>
      ${isOwn ? `
        <button class="content-menu-btn" data-menu-toggle><svg class="icon" style="width:14px;height:14px" viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg></button>
        <div class="content-menu-dropdown"><button class="content-menu-item" data-del-own-video="${v.id}"><svg class="icon" style="width:14px;height:14px" viewBox="0 0 24 24"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6"/></svg>Hapus</button></div>
      ` : ''}
      <div class="video-meta">
        ${v.is_promoted ? `<div class="promo-tag"><svg class="icon" style="width:11px;height:11px" viewBox="0 0 24 24"><path d="M13 2L3 14h7v8l10-12h-7z"/></svg>Promosi</div>` : ''}
        <div class="video-user name-clickable" data-open-profile="${p?.id || ''}">
          <div class="avatar-sm">${p?.avatar_url ? `<img src="${escHtml(p.avatar_url)}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">` : initials(displayNameOf(p))}</div>
          ${nameWithBadge(p)}
        </div>
        ${v.caption ? `<div class="video-caption">${escHtml(v.caption)}</div>` : ''}
        <div class="video-stats">
          <svg class="icon" viewBox="0 0 24 24"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>
          ${v.view_count} views
        </div>
        <div class="video-actions">
          <button class="vaction ${isLiked ? 'liked' : ''}" data-like-video="${v.id}">
            <svg class="icon" viewBox="0 0 24 24"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z"/></svg>
            <span data-like-count="${v.id}">${v.like_count || 0}</span>
          </button>
          <button class="vaction clickable-count" data-show-likes="${v.id}" title="Lihat yang suka">
            <svg class="icon" style="width:14px;height:14px" viewBox="0 0 24 24"><circle cx="9" cy="8" r="4"/><path d="M2 21c0-4 3-7 7-7s7 3 7 7"/></svg>
          </button>
          <button class="vaction" data-open-comments="${v.id}">
            <svg class="icon" viewBox="0 0 24 24"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
            <span data-comment-count="${v.id}">${v.comment_count || 0}</span>
          </button>
        </div>
      </div>
    </div>`;
  }).join('');

  feed.querySelectorAll('video').forEach(vid => {
    vid.addEventListener('play', () => {
      supabase.rpc('register_video_view', { p_video_id: vid.dataset.videoId }).catch(console.error);
    }, { once: true });
  });
  wireContentMenus(feed);
  $all('[data-like-video]').forEach(btn => btn.onclick = () => toggleLike(btn.dataset.likeVideo, btn));
  $all('[data-show-likes]').forEach(btn => btn.onclick = () => openLikesList(btn.dataset.showLikes));
  $all('[data-open-comments]').forEach(btn => btn.onclick = () => openComments(btn.dataset.openComments));
  $all('[data-open-profile]').forEach(el => el.onclick = () => { if (el.dataset.openProfile) openUserProfile(el.dataset.openProfile); });
  $all('[data-del-own-video]').forEach(btn => btn.onclick = (e) => { e.stopPropagation(); deleteOwnVideo(btn.dataset.delOwnVideo); });
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
  $('#profile-display-name').innerHTML = nameWithBadge(currentProfile);
  $('#profile-username').textContent = '@' + currentProfile.username;
  $('#profile-avatar').innerHTML = currentProfile.avatar_url
    ? `<img src="${escHtml(currentProfile.avatar_url)}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`
    : `<svg class="icon" style="width:32px;height:32px" viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg>`;
  const bioEl = $('#profile-bio');
  if (currentProfile.bio) { bioEl.textContent = currentProfile.bio; bioEl.style.display = 'block'; }
  else { bioEl.style.display = 'none'; }
  $('#stat-followers').textContent = currentProfile.follower_count || 0;
  $('#stat-following').textContent = currentProfile.following_count || 0;
  loadProfileMedia('videos');
}
$('#profile-avatar').onclick = () => { if (currentProfile?.avatar_url) openPhotoViewer(currentProfile.avatar_url); };
$('#stat-followers-btn').onclick = () => openFollowList(currentUser.id, 'followers', displayNameOf(currentProfile));
$('#stat-following-btn').onclick = () => openFollowList(currentUser.id, 'following', displayNameOf(currentProfile));

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
      <div class="cell content-menu-wrap" data-open-video='${escHtml(JSON.stringify({ id: v.id, url: v.video_url, caption: v.caption || '' }))}'>
        <video src="${escHtml(v.video_url)}" muted></video>
        <div class="views"><svg class="icon" viewBox="0 0 24 24"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>${v.view_count}</div>
        <button class="content-menu-btn" data-menu-toggle><svg class="icon" style="width:14px;height:14px" viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg></button>
        <div class="content-menu-dropdown"><button class="content-menu-item" data-del-own-video="${v.id}"><svg class="icon" style="width:14px;height:14px" viewBox="0 0 24 24"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6"/></svg>Hapus</button></div>
      </div>
    `).join('') || `<div class="empty" style="grid-column:1/-1">Belum ada video.</div>`;
  } else {
    const { data } = await supabase.from('statuses').select('*').eq('user_id', currentUser.id).eq('deleted_by_user', false).order('created_at', { ascending: false });
    $('#stat-status').textContent = data?.length || 0;
    grid.innerHTML = (data || []).map(s => `
      <div class="cell content-menu-wrap">
        ${s.media_type === 'video' ? `<video src="${escHtml(s.media_url)}" muted></video>` : `<img src="${escHtml(s.media_url)}">`}
        <button class="content-menu-btn" data-menu-toggle><svg class="icon" style="width:14px;height:14px" viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg></button>
        <div class="content-menu-dropdown"><button class="content-menu-item" data-del-own-status="${s.id}"><svg class="icon" style="width:14px;height:14px" viewBox="0 0 24 24"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6"/></svg>Hapus</button></div>
      </div>
    `).join('') || `<div class="empty" style="grid-column:1/-1">Belum ada status.</div>`;
  }
  wireContentMenus(grid);
  grid.querySelectorAll('[data-open-video]').forEach(el => el.addEventListener('click', (e) => {
    if (e.target.closest('[data-menu-toggle]') || e.target.closest('.content-menu-dropdown')) return;
    openVideoPlayer(JSON.parse(el.dataset.openVideo));
  }));
  grid.querySelectorAll('[data-del-own-video]').forEach(el => el.onclick = (e) => { e.stopPropagation(); deleteOwnVideo(el.dataset.delOwnVideo); });
  grid.querySelectorAll('[data-del-own-status]').forEach(el => el.onclick = (e) => { e.stopPropagation(); deleteOwnStatus(el.dataset.delOwnStatus, () => loadProfileMedia('statuses')); });
}

// Titik-tiga generik: buka/tutup dropdown, tutup semua yang lain saat klik salah satu
function wireContentMenus(scope) {
  scope.querySelectorAll('[data-menu-toggle]').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const dropdown = btn.nextElementSibling;
      const wasOpen = dropdown.classList.contains('open');
      document.querySelectorAll('.content-menu-dropdown.open').forEach(d => d.classList.remove('open'));
      if (!wasOpen) dropdown.classList.add('open');
    };
  });
}
document.addEventListener('click', () => {
  document.querySelectorAll('.content-menu-dropdown.open').forEach(d => d.classList.remove('open'));
});

async function deleteOwnVideo(videoId) {
  const { error } = await supabase.from('videos').update({ deleted_by_user: true }).eq('id', videoId).eq('user_id', currentUser.id);
  if (error) { showToast(error.message, 'error'); return; }
  showToast('Video dihapus');
  loadProfileMedia('videos');
  loadVideoFeed();
}
async function deleteOwnStatus(statusId, afterFn) {
  const { error } = await supabase.from('statuses').update({ deleted_by_user: true }).eq('id', statusId).eq('user_id', currentUser.id);
  if (error) { showToast(error.message, 'error'); return; }
  showToast('Status dihapus');
  loadStatuses();
  if (afterFn) afterFn();
}

function openVideoPlayer(v) {
  $('#vp-video').src = v.url || v.video_url;
  $('#vp-caption').textContent = v.caption || '';
  $('#video-player-overlay').classList.add('open');
}
$('#vp-close').onclick = () => {
  const vid = $('#vp-video');
  vid.pause(); vid.src = '';
  $('#video-player-overlay').classList.remove('open');
};

function openPhotoViewer(url) {
  $('#pv-img').src = url;
  $('#photo-viewer').classList.add('open');
}
$('#pv-close').onclick = () => $('#photo-viewer').classList.remove('open');
$('#photo-viewer').onclick = (e) => { if (e.target.id === 'photo-viewer') $('#photo-viewer').classList.remove('open'); };

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
  $('#edit-bio').value = currentProfile.bio || '';
  openSheet('edit-profile-overlay');
};
$('#cancel-edit-profile').onclick = () => closeSheet('edit-profile-overlay');
$('#save-edit-profile').onclick = async () => {
  const name = $('#edit-display-name').value.trim();
  const bio = $('#edit-bio').value.trim();
  const { error } = await supabase.from('profiles').update({ display_name: name || null, bio: bio || null }).eq('id', currentUser.id);
  if (error) { showToast(error.message, 'error'); return; }
  currentProfile.display_name = name;
  currentProfile.bio = bio;
  renderProfileHeader();
  closeSheet('edit-profile-overlay');
  showToast('Profil diperbarui');
};

const amountGrid = $('#amount-grid');
amountGrid.innerHTML = ALLOWED_AMOUNTS.map(a => `<div class="chip" data-amount="${a}">${rupiah(a)}</div>`).join('');

$('#open-withdraw').onclick = () => { resetWithdrawForm(); openSheet('withdraw-overlay'); };
$('#cancel-withdraw').onclick = () => closeSheet('withdraw-overlay');

function resetWithdrawForm() {
  selectedWdAmount = null; selectedWdMethod = null;
  amountGrid.querySelectorAll('.chip').forEach(c => c.classList.remove('selected'));
  $('#method-grid').querySelectorAll('.chip').forEach(c => c.classList.remove('selected'));
  $('#wd-account-number').value = '';
  $('#wd-account-name').value = '';
  $('#wd-summary').style.display = 'none';
  $('#confirm-withdraw').disabled = true;
  $('#confirm-withdraw').textContent = 'Ajukan';
}

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
  const btn = $('#confirm-withdraw');
  btn.disabled = true;
  btn.textContent = 'Mengajukan...';
  try {
    const { error } = await supabase.rpc('request_withdrawal', {
      p_amount: selectedWdAmount, p_method: selectedWdMethod,
      p_account_number: $('#wd-account-number').value.trim(),
      p_account_name: $('#wd-account-name').value.trim(),
    });
    if (error) throw error;
    showToast('Permintaan penarikan terkirim');
    closeSheet('withdraw-overlay');
    resetWithdrawForm();
    await loadProfile();
    loadWithdrawHistory();
  } catch (e) {
    showToast(e.message, 'error');
    btn.disabled = false;
    btn.textContent = 'Ajukan';
  }
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

// =====================================================================
// CHAT GLOBAL
// =====================================================================
const ADMIN_ACCESS_CODE = 'admin1234';
let chatMessagesCache = [];
let chatChannel = null;
let chatImageFileObj = null;
let chatLoaded = false;

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

function scrollChatToBottom() {
  const el = $('#chat-messages');
  if (el) requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
}

async function loadChatMessages() {
  if (chatLoaded) return;
  chatLoaded = true;
  const { data, error } = await supabase
    .from('chat_messages')
    .select('*, profiles(id, username, display_name, avatar_url, role, is_verified, verified_name)')
    .eq('deleted_by_admin', false)
    .order('created_at', { ascending: true })
    .limit(200);

  if (error) {
    $('#chat-messages').innerHTML = `<div class="chat-empty">Gagal memuat chat: ${escHtml(error.message)}</div>`;
    chatLoaded = false;
    return;
  }
  chatMessagesCache = data || [];
  renderChatMessages();
  scrollChatToBottom();
}

function renderChatMessages() {
  const box = $('#chat-messages');
  if (!chatMessagesCache.length) {
    box.innerHTML = `
      <div class="chat-empty">
        <svg class="icon" style="width:26px;height:26px" viewBox="0 0 24 24"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
        Belum ada pesan. Jadilah yang pertama menyapa!
      </div>`;
    return;
  }
  const isAdmin = currentProfile?.role === 'admin';
  box.innerHTML = chatMessagesCache.map(m => {
    const isOwn = m.user_id === currentUser.id;
    const p = m.profiles;
    const avatar = p?.avatar_url
      ? `<img src="${escHtml(p.avatar_url)}">`
      : initials(displayNameOf(p));
    const time = new Date(m.created_at).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
    const canDelete = isAdmin || isOwn;
    return `
      <div class="chat-msg ${isOwn ? 'own' : ''}">
        <div class="chat-msg-avatar ${!isOwn ? 'name-clickable' : ''}" ${!isOwn ? `data-open-profile="${p?.id || ''}"` : ''}>${avatar}</div>
        <div class="chat-msg-body">
          ${!isOwn ? `<div class="chat-msg-name name-clickable" data-open-profile="${p?.id || ''}">${nameWithBadge(p)}</div>` : ''}
          <div class="chat-msg-bubble">
            ${m.content ? escHtml(m.content) : ''}
            ${m.image_url ? `<img src="${escHtml(m.image_url)}" />` : ''}
          </div>
          <div class="chat-msg-time">${time}</div>
        </div>
        ${canDelete ? `<div class="chat-msg-del" data-del-chat="${m.id}"><svg class="icon" style="width:13px;height:13px" viewBox="0 0 24 24"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6"/></svg></div>` : ''}
      </div>`;
  }).join('');

  $all('[data-del-chat]').forEach(el => el.onclick = () => deleteChatMessage(el.dataset.delChat));
  $all('#chat-messages [data-open-profile]').forEach(el => el.onclick = () => { if (el.dataset.openProfile) openUserProfile(el.dataset.openProfile); });
}

async function deleteChatMessage(id) {
  const isAdmin = currentProfile?.role === 'admin';
  const msg = chatMessagesCache.find(m => m.id === id);
  const isOwn = msg && msg.user_id === currentUser.id;

  let error;
  if (isAdmin && !isOwn) {
    ({ error } = await supabase.rpc('admin_delete_chat_message', { p_id: id }));
  } else {
    ({ error } = await supabase.from('chat_messages').update({ deleted_by_admin: true }).eq('id', id).eq('user_id', currentUser.id));
  }
  if (error) { showToast(error.message, 'error'); return; }
  chatMessagesCache = chatMessagesCache.filter(m => m.id !== id);
  renderChatMessages();
}

function subscribeChatRealtime() {
  if (chatChannel) return;
  chatChannel = supabase
    .channel('chat_messages_global')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages' }, async (payload) => {
      const row = payload.new;
      if (row.deleted_by_admin) return;
      const { data: profile } = await supabase.from('profiles').select('id, username, display_name, avatar_url, role, is_verified, verified_name').eq('id', row.user_id).single();
      chatMessagesCache.push({ ...row, profiles: profile });
      renderChatMessages();
      scrollChatToBottom();
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'chat_messages' }, (payload) => {
      const row = payload.new;
      if (row.deleted_by_admin) {
        chatMessagesCache = chatMessagesCache.filter(m => m.id !== row.id);
        renderChatMessages();
      }
    })
    .subscribe();
}

$('#chat-text-input').addEventListener('input', (e) => {
  updateChatSendState();
  e.target.style.height = 'auto';
  e.target.style.height = Math.min(e.target.scrollHeight, 90) + 'px';
});
$('#chat-text-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); }
});

$('#chat-attach-btn').onclick = () => $('#chat-image-file').click();
$('#chat-image-file').onchange = (e) => {
  const f = e.target.files[0]; if (!f) return;
  chatImageFileObj = f;
  $('#chat-preview-img').src = URL.createObjectURL(f);
  $('#chat-preview-name').textContent = f.name;
  $('#chat-image-preview').classList.add('show');
  updateChatSendState();
};
$('#chat-remove-preview').onclick = () => {
  chatImageFileObj = null;
  $('#chat-image-file').value = '';
  $('#chat-image-preview').classList.remove('show');
  updateChatSendState();
};

function updateChatSendState() {
  const hasText = $('#chat-text-input').value.trim().length > 0;
  $('#chat-send-btn').disabled = !(hasText || chatImageFileObj);
}

$('#chat-send-btn').onclick = () => sendChatMessage();

async function sendChatMessage() {
  const textEl = $('#chat-text-input');
  const text = textEl.value.trim();
  if (!text && !chatImageFileObj) return;

  const btn = $('#chat-send-btn');
  btn.disabled = true;

  try {
    let imageUrl = null;
    if (chatImageFileObj) {
      const path = `chat/${currentUser.id}/${Date.now()}-${chatImageFileObj.name}`;
      const { error: upErr } = await supabase.storage.from('media').upload(path, chatImageFileObj);
      if (upErr) throw upErr;
      const { data: pub } = supabase.storage.from('media').getPublicUrl(path);
      imageUrl = pub.publicUrl;
    }

    const { error } = await supabase.from('chat_messages').insert({
      user_id: currentUser.id,
      content: text || null,
      image_url: imageUrl,
    });
    if (error) throw error;

    textEl.value = ''; textEl.style.height = 'auto';
    chatImageFileObj = null;
    $('#chat-image-file').value = '';
    $('#chat-image-preview').classList.remove('show');
    updateChatSendState();
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    btn.disabled = false;
    updateChatSendState();
  }
}

// =====================================================================
// LIKE VIDEO
// =====================================================================
async function toggleLike(videoId, btn) {
  btn.disabled = true;
  try {
    const { data, error } = await supabase.rpc('toggle_video_like', { p_video_id: videoId });
    if (error) throw error;
    btn.classList.toggle('liked', data.liked);
    const countEl = document.querySelector(`[data-like-count="${videoId}"]`);
    if (countEl) countEl.textContent = data.like_count;
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function openLikesList(videoId) {
  const box = $('#likes-list');
  box.innerHTML = `<div class="empty" style="padding:20px 0">Memuat...</div>`;
  openSheet('likes-list-overlay');

  const { data, error } = await supabase
    .from('video_likes')
    .select('user_id, profiles(id, username, display_name, avatar_url, is_verified, verified_name)')
    .eq('video_id', videoId)
    .order('created_at', { ascending: false });

  if (error) { box.innerHTML = `<div class="empty">Gagal memuat.</div>`; return; }
  if (!data.length) { box.innerHTML = `<div class="empty" style="padding:20px 0">Belum ada yang menyukai.</div>`; return; }

  box.innerHTML = data.map(l => {
    const p = l.profiles;
    return `
      <div class="likes-row" data-open-profile="${p?.id || ''}">
        <div class="avatar-sm">${p?.avatar_url ? `<img src="${escHtml(p.avatar_url)}">` : initials(displayNameOf(p))}</div>
        <div class="likes-row-name">${nameWithBadge(p)}</div>
      </div>`;
  }).join('');
  box.querySelectorAll('[data-open-profile]').forEach(el => el.onclick = () => {
    closeSheet('likes-list-overlay');
    openUserProfile(el.dataset.openProfile);
  });
}

// =====================================================================
// KOMENTAR (dengan balasan berjenjang)
// =====================================================================
let currentCommentVideoId = null;
let replyToCommentId = null;
let replyToName = null;

async function openComments(videoId) {
  currentCommentVideoId = videoId;
  replyToCommentId = null;
  $('#comment-replying-to').classList.remove('show');
  $('#comment-input').value = '';
  updateCommentSendState();
  openSheet('comments-overlay');
  await loadComments();
}
$('#close-comments').onclick = () => closeSheet('comments-overlay');

async function loadComments() {
  const box = $('#comments-list');
  box.innerHTML = `<div class="empty" style="padding:20px 0">Memuat...</div>`;

  const { data, error } = await supabase
    .from('video_comments')
    .select('*, profiles(id, username, display_name, avatar_url, is_verified, verified_name)')
    .eq('video_id', currentCommentVideoId)
    .eq('deleted_by_user', false).eq('deleted_by_admin', false)
    .order('created_at', { ascending: true });

  if (error) { box.innerHTML = `<div class="empty">Gagal memuat komentar.</div>`; return; }
  if (!data.length) { box.innerHTML = `<div class="empty" style="padding:20px 0">Belum ada komentar. Jadilah yang pertama!</div>`; return; }

  let myLikedComments = new Set();
  const { data: myCommentLikes } = await supabase.from('comment_likes').select('comment_id').eq('user_id', currentUser.id).in('comment_id', data.map(c => c.id));
  (myCommentLikes || []).forEach(l => myLikedComments.add(l.comment_id));

  const topLevel = data.filter(c => !c.parent_comment_id);
  const repliesOf = (id) => data.filter(c => c.parent_comment_id === id);

  const renderComment = (c, isReply) => {
    const p = c.profiles;
    const isAdmin = currentProfile?.role === 'admin';
    const canDelete = isAdmin || c.user_id === currentUser.id;
    const isLiked = myLikedComments.has(c.id);
    const time = new Date(c.created_at).toLocaleString('id-ID', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' });
    return `
      <div class="comment-item ${isReply ? 'reply' : ''}">
        <div class="comment-avatar" data-open-profile="${p?.id || ''}">${p?.avatar_url ? `<img src="${escHtml(p.avatar_url)}">` : initials(displayNameOf(p))}</div>
        <div class="comment-body">
          <div class="comment-name" data-open-profile="${p?.id || ''}">${nameWithBadge(p)}</div>
          <div class="comment-text">${escHtml(c.content)}</div>
          <div class="comment-meta">
            <span>${time}</span>
            <span class="comment-like-btn ${isLiked ? 'liked' : ''}" data-like-comment="${c.id}">
              <svg class="icon" viewBox="0 0 24 24"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z"/></svg>
              <span data-comment-like-count="${c.id}">${c.like_count || 0}</span>
            </span>
            <span data-reply-to="${c.id}" data-reply-name="${escHtml(displayNameOf(p))}" style="cursor:pointer">Balas</span>
            ${canDelete ? `<span data-del-comment="${c.id}" style="color:var(--red); cursor:pointer">Hapus</span>` : ''}
          </div>
        </div>
      </div>`;
  };

  let html = '';
  topLevel.forEach(c => {
    html += renderComment(c, false);
    repliesOf(c.id).forEach(r => html += renderComment(r, true));
  });
  box.innerHTML = html;

  box.querySelectorAll('[data-open-profile]').forEach(el => el.onclick = () => { if (el.dataset.openProfile) { closeSheet('comments-overlay'); openUserProfile(el.dataset.openProfile); } });
  box.querySelectorAll('[data-reply-to]').forEach(el => el.onclick = () => setReplyTarget(el.dataset.replyTo, el.dataset.replyName));
  box.querySelectorAll('[data-del-comment]').forEach(el => el.onclick = () => deleteComment(el.dataset.delComment));
  box.querySelectorAll('[data-like-comment]').forEach(el => el.onclick = () => toggleCommentLike(el.dataset.likeComment, el));
}

async function toggleCommentLike(commentId, el) {
  el.style.pointerEvents = 'none';
  try {
    const { data, error } = await supabase.rpc('toggle_comment_like', { p_comment_id: commentId });
    if (error) throw error;
    el.classList.toggle('liked', data.liked);
    const countEl = document.querySelector(`[data-comment-like-count="${commentId}"]`);
    if (countEl) countEl.textContent = data.like_count;
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    el.style.pointerEvents = '';
  }
}

function setReplyTarget(commentId, name) {
  replyToCommentId = commentId;
  replyToName = name;
  $('#comment-replying-text').textContent = 'Membalas ' + name;
  $('#comment-replying-to').classList.add('show');
  $('#comment-input').focus();
}
$('#cancel-reply').onclick = () => {
  replyToCommentId = null;
  $('#comment-replying-to').classList.remove('show');
};

$('#comment-input').addEventListener('input', updateCommentSendState);
$('#comment-input').addEventListener('keydown', e => { if (e.key === 'Enter') sendComment(); });
function updateCommentSendState() {
  $('#comment-send-btn').disabled = $('#comment-input').value.trim().length === 0;
}
$('#comment-send-btn').onclick = () => sendComment();

async function sendComment() {
  const input = $('#comment-input');
  const text = input.value.trim();
  if (!text) return;
  const btn = $('#comment-send-btn');
  btn.disabled = true;
  try {
    const { error } = await supabase.from('video_comments').insert({
      video_id: currentCommentVideoId,
      user_id: currentUser.id,
      parent_comment_id: replyToCommentId,
      content: text,
    });
    if (error) throw error;
    input.value = '';
    replyToCommentId = null;
    $('#comment-replying-to').classList.remove('show');
    await loadComments();
    const countEl = document.querySelector(`[data-comment-count="${currentCommentVideoId}"]`);
    if (countEl) countEl.textContent = Number(countEl.textContent) + 1;
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    updateCommentSendState();
  }
}

async function deleteComment(id) {
  const isAdmin = currentProfile?.role === 'admin';
  let error;
  if (isAdmin) {
    ({ error } = await supabase.rpc('admin_delete_comment', { p_id: id }));
  } else {
    ({ error } = await supabase.from('video_comments').update({ deleted_by_user: true }).eq('id', id).eq('user_id', currentUser.id));
  }
  if (error) { showToast(error.message, 'error'); return; }
  await loadComments();
  const countEl = document.querySelector(`[data-comment-count="${currentCommentVideoId}"]`);
  if (countEl) countEl.textContent = Math.max(0, Number(countEl.textContent) - 1);
}

// =====================================================================
// PROFIL PENGGUNA LAIN
// =====================================================================
let viewingProfileId = null;

async function openUserProfile(userId) {
  if (!userId) return;
  if (userId === currentUser.id) { navigate('profile'); return; }
  viewingProfileId = userId;

  $('#op-avatar').innerHTML = '';
  $('#op-name').innerHTML = 'Memuat...';
  $('#op-username').textContent = '';
  $('#op-bio').style.display = 'none';
  $('#op-video-grid').innerHTML = '';
  $('#other-profile-screen').classList.add('open');

  const { data: p, error } = await supabase.from('profiles').select('*').eq('id', userId).single();
  if (error || !p) { $('#op-name').textContent = 'Pengguna tidak ditemukan'; return; }

  $('#op-avatar').innerHTML = p.avatar_url ? `<img src="${escHtml(p.avatar_url)}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">` : initials(displayNameOf(p));
  $('#op-avatar').onclick = () => { if (p.avatar_url) openPhotoViewer(p.avatar_url); };
  $('#op-name').innerHTML = nameWithBadge(p);
  $('#op-username').textContent = '@' + p.username;
  if (p.bio) { $('#op-bio').textContent = p.bio; $('#op-bio').style.display = 'block'; }

  $('#op-stat-followers').textContent = p.follower_count || 0;
  $('#op-stat-following').textContent = p.following_count || 0;
  $('#op-stat-followers-btn').onclick = () => openFollowList(userId, 'followers', displayNameOf(p));
  $('#op-stat-following-btn').onclick = () => openFollowList(userId, 'following', displayNameOf(p));

  // Status follow
  const { data: existingFollow } = await supabase.from('follows').select('follower_id').eq('follower_id', currentUser.id).eq('following_id', userId).maybeSingle();
  setFollowBtnState(!!existingFollow);
  $('#op-follow-btn').onclick = () => toggleFollowUI(userId);

  const { data: videos } = await supabase.from('videos').select('*').eq('user_id', userId).eq('deleted_by_admin', false).eq('deleted_by_user', false).order('created_at', { ascending: false });
  const totalLikes = (videos || []).reduce((sum, v) => sum + (v.like_count || 0), 0);
  $('#op-stat-videos').textContent = videos?.length || 0;
  $('#op-stat-likes').textContent = totalLikes;

  $('#op-video-grid').innerHTML = (videos || []).map(v => `
    <div class="cell" data-open-video='${escHtml(JSON.stringify({ id: v.id, url: v.video_url, caption: v.caption || '' }))}'>
      <video src="${escHtml(v.video_url)}" muted></video>
      <div class="views"><svg class="icon" viewBox="0 0 24 24"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z"/></svg>${v.like_count || 0}</div>
    </div>
  `).join('') || `<div class="empty" style="grid-column:1/-1">Belum ada video.</div>`;
  $('#op-video-grid').querySelectorAll('[data-open-video]').forEach(el => el.onclick = () => openVideoPlayer(JSON.parse(el.dataset.openVideo)));
}
function setFollowBtnState(following) {
  const btn = $('#op-follow-btn');
  btn.classList.toggle('following', following);
  btn.innerHTML = following
    ? `<svg class="icon" style="width:15px;height:15px" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg>Mengikuti`
    : `<svg class="icon" style="width:15px;height:15px" viewBox="0 0 24 24"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M20 8v6M23 11h-6"/></svg>Ikuti`;
}
async function toggleFollowUI(userId) {
  const btn = $('#op-follow-btn');
  btn.disabled = true;
  try {
    const { data, error } = await supabase.rpc('toggle_follow', { p_target: userId });
    if (error) throw error;
    setFollowBtnState(data.following);
    $('#op-stat-followers').textContent = data.follower_count;
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    btn.disabled = false;
  }
}
$('#op-back-btn').onclick = () => $('#other-profile-screen').classList.remove('open');
$('#op-chat-btn').onclick = () => { if (viewingProfileId) openDmChat(viewingProfileId); };

// =====================================================================
// DAFTAR PENGIKUT / MENGIKUTI
// =====================================================================
async function openFollowList(userId, type, ownerName) {
  const box = $('#follow-list');
  box.innerHTML = `<div class="empty" style="padding:20px 0">Memuat...</div>`;
  $('#follow-list-title').innerHTML = `${type === 'followers' ? 'Pengikut' : 'Mengikuti'} ${escHtml(ownerName || '')}`;
  openSheet('follow-list-overlay');

  const col = type === 'followers' ? 'following_id' : 'follower_id';
  const otherCol = type === 'followers' ? 'follower_id' : 'following_id';
  const { data, error } = await supabase
    .from('follows')
    .select(`${otherCol}, profiles!follows_${otherCol}_fkey(id, username, display_name, avatar_url, is_verified, verified_name)`)
    .eq(col, userId)
    .order('created_at', { ascending: false });

  if (error) { box.innerHTML = `<div class="empty">Gagal memuat.</div>`; return; }
  if (!data.length) { box.innerHTML = `<div class="empty" style="padding:20px 0">${type === 'followers' ? 'Belum ada pengikut.' : 'Belum mengikuti siapa pun.'}</div>`; return; }

  box.innerHTML = data.map(row => {
    const p = row.profiles;
    return `
      <div class="likes-row" data-open-profile="${p?.id || ''}">
        <div class="avatar-sm">${p?.avatar_url ? `<img src="${escHtml(p.avatar_url)}">` : initials(displayNameOf(p))}</div>
        <div class="likes-row-name">${nameWithBadge(p)}</div>
      </div>`;
  }).join('');
  box.querySelectorAll('[data-open-profile]').forEach(el => el.onclick = () => {
    closeSheet('follow-list-overlay');
    openUserProfile(el.dataset.openProfile);
  });
}

// =====================================================================
// DM (CHAT PRIBADI)
// =====================================================================
let dmConversationId = null;
let dmOtherUser = null;
let dmChannel = null;
let dmThreadsCache = [];

$('#inbox-btn').onclick = () => openDmInbox();

async function openDmInbox() {
  const box = $('#dm-thread-list');
  box.innerHTML = `<div class="empty" style="padding:20px 0">Memuat...</div>`;
  openSheet('dm-inbox-overlay');

  const { data, error } = await supabase
    .from('dm_conversations')
    .select('*, a:user_a(id, username, display_name, avatar_url, is_verified, verified_name), b:user_b(id, username, display_name, avatar_url, is_verified, verified_name)')
    .or(`user_a.eq.${currentUser.id},user_b.eq.${currentUser.id}`)
    .order('last_message_at', { ascending: false });

  if (error) { box.innerHTML = `<div class="empty">Gagal memuat pesan.</div>`; return; }
  dmThreadsCache = data || [];
  if (!dmThreadsCache.length) { box.innerHTML = `<div class="empty" style="padding:20px 0">Belum ada pesan.</div>`; return; }

  const rows = await Promise.all(dmThreadsCache.map(async (t) => {
    const other = t.user_a === currentUser.id ? t.b : t.a;
    const { data: lastMsg } = await supabase.from('dm_messages').select('content, image_url, sender_id, read_at').eq('conversation_id', t.id).order('created_at', { ascending: false }).limit(1).maybeSingle();
    const unread = lastMsg && lastMsg.sender_id !== currentUser.id && !lastMsg.read_at;
    const preview = lastMsg ? (lastMsg.content || (lastMsg.image_url ? '📷 Gambar' : '')) : '';
    return { t, other, preview, unread };
  }));

  updateInboxDot(rows.some(r => r.unread));

  box.innerHTML = rows.map(({ t, other, preview, unread }) => `
    <div class="dm-thread-row" data-open-dm="${other?.id || ''}">
      <div class="avatar-sm">${other?.avatar_url ? `<img src="${escHtml(other.avatar_url)}">` : initials(displayNameOf(other))}</div>
      <div class="dm-thread-mid">
        <div class="dm-thread-name">${nameWithBadge(other)}</div>
        <div class="dm-thread-preview">${escHtml(preview)}</div>
      </div>
      ${unread ? '<div class="dm-unread-dot"></div>' : ''}
    </div>
  `).join('');

  box.querySelectorAll('[data-open-dm]').forEach(el => el.onclick = () => { closeSheet('dm-inbox-overlay'); openDmChat(el.dataset.openDm); });
}

function updateInboxDot(show) {
  $('#inbox-dot').classList.toggle('show', !!show);
}

async function openDmChat(otherUserId) {
  if (otherUserId === currentUser.id) return;
  const { data: convId, error } = await supabase.rpc('get_or_create_dm', { p_other_user_id: otherUserId });
  if (error) { showToast(error.message, 'error'); return; }
  dmConversationId = convId;

  const { data: p } = await supabase.from('profiles').select('*').eq('id', otherUserId).single();
  dmOtherUser = p;
  $('#dm-chat-avatar').innerHTML = p?.avatar_url ? `<img src="${escHtml(p.avatar_url)}" style="width:100%;height:100%;object-fit:cover">` : initials(displayNameOf(p));
  $('#dm-chat-name').innerHTML = nameWithBadge(p);

  $('#other-profile-screen').classList.remove('open');
  $('#dm-chat-overlay').classList.add('open');

  await loadDmMessages();
  subscribeDmRealtime();
  markDmRead();
}
$('#dm-back-btn').onclick = () => {
  $('#dm-chat-overlay').classList.remove('open');
  if (dmChannel) { supabase.removeChannel(dmChannel); dmChannel = null; }
};
$('#dm-chat-avatar').onclick = () => { if (dmOtherUser) openUserProfile(dmOtherUser.id); };
$('#dm-chat-name').onclick = () => { if (dmOtherUser) openUserProfile(dmOtherUser.id); };

async function loadDmMessages() {
  const box = $('#dm-chat-messages');
  box.innerHTML = `<div class="chat-empty">Memuat...</div>`;
  const { data, error } = await supabase
    .from('dm_messages')
    .select('*')
    .eq('conversation_id', dmConversationId)
    .eq('deleted_by_sender', false)
    .order('created_at', { ascending: true })
    .limit(300);
  if (error) { box.innerHTML = `<div class="chat-empty">Gagal memuat: ${escHtml(error.message)}</div>`; return; }
  renderDmMessages(data || []);
}

function renderDmMessages(messages) {
  const box = $('#dm-chat-messages');
  if (!messages.length) {
    box.innerHTML = `<div class="chat-empty">Belum ada pesan. Mulai obrolan!</div>`;
    return;
  }
  box.innerHTML = messages.map(m => {
    const isOwn = m.sender_id === currentUser.id;
    const time = new Date(m.created_at).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
    return `
      <div class="chat-msg ${isOwn ? 'own' : ''}">
        <div class="chat-msg-avatar">${isOwn ? initials(displayNameOf(currentProfile)) : (dmOtherUser?.avatar_url ? `<img src="${escHtml(dmOtherUser.avatar_url)}">` : initials(displayNameOf(dmOtherUser)))}</div>
        <div class="chat-msg-body">
          <div class="chat-msg-bubble">
            ${m.content ? escHtml(m.content) : ''}
            ${m.image_url ? `<img src="${escHtml(m.image_url)}" />` : ''}
          </div>
          <div class="chat-msg-time">${time}</div>
        </div>
      </div>`;
  }).join('');
  requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; });
}

function subscribeDmRealtime() {
  if (dmChannel) { supabase.removeChannel(dmChannel); dmChannel = null; }
  dmChannel = supabase
    .channel('dm_' + dmConversationId)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'dm_messages', filter: `conversation_id=eq.${dmConversationId}` }, () => {
      loadDmMessages();
      if (document.querySelector('#dm-chat-overlay.open')) markDmRead();
    })
    .subscribe();
}

async function markDmRead() {
  await supabase.from('dm_messages').update({ read_at: new Date().toISOString() })
    .eq('conversation_id', dmConversationId).neq('sender_id', currentUser.id).is('read_at', null);
  updateInboxDot(false);
}

let dmImageFileObj = null;
$('#dm-text-input').addEventListener('input', (e) => {
  updateDmSendState();
  e.target.style.height = 'auto';
  e.target.style.height = Math.min(e.target.scrollHeight, 90) + 'px';
});
$('#dm-text-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendDmMessage(); } });
$('#dm-attach-btn').onclick = () => $('#dm-image-file').click();
$('#dm-image-file').onchange = (e) => {
  const f = e.target.files[0]; if (!f) return;
  dmImageFileObj = f;
  $('#dm-preview-img').src = URL.createObjectURL(f);
  $('#dm-preview-name').textContent = f.name;
  $('#dm-image-preview').classList.add('show');
  updateDmSendState();
};
$('#dm-remove-preview').onclick = () => {
  dmImageFileObj = null;
  $('#dm-image-file').value = '';
  $('#dm-image-preview').classList.remove('show');
  updateDmSendState();
};
function updateDmSendState() {
  const hasText = $('#dm-text-input').value.trim().length > 0;
  $('#dm-send-btn').disabled = !(hasText || dmImageFileObj);
}
$('#dm-send-btn').onclick = () => sendDmMessage();

async function sendDmMessage() {
  const textEl = $('#dm-text-input');
  const text = textEl.value.trim();
  if (!text && !dmImageFileObj) return;
  const btn = $('#dm-send-btn');
  btn.disabled = true;
  try {
    let imageUrl = null;
    if (dmImageFileObj) {
      const path = `dm/${currentUser.id}/${Date.now()}-${dmImageFileObj.name}`;
      const { error: upErr } = await supabase.storage.from('media').upload(path, dmImageFileObj);
      if (upErr) throw upErr;
      const { data: pub } = supabase.storage.from('media').getPublicUrl(path);
      imageUrl = pub.publicUrl;
    }
    const { error } = await supabase.from('dm_messages').insert({
      conversation_id: dmConversationId, sender_id: currentUser.id,
      content: text || null, image_url: imageUrl,
    });
    if (error) throw error;
    textEl.value = ''; textEl.style.height = 'auto';
    dmImageFileObj = null; $('#dm-image-file').value = '';
    $('#dm-image-preview').classList.remove('show');
    await loadDmMessages();
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    btn.disabled = false;
    updateDmSendState();
  }
}

// =====================================================================
// NOTIFIKASI GLOBAL (DM & chat dari siapa pun, aktif di semua halaman)
// =====================================================================
let dmNotifyChannel = null;
let chatNotifyChannel = null;

async function checkUnreadDm() {
  const { count, error } = await supabase
    .from('dm_messages')
    .select('id', { count: 'exact', head: true })
    .neq('sender_id', currentUser.id)
    .is('read_at', null);
  if (!error && count > 0) updateInboxDot(true);
}

function subscribeGlobalNotifications() {
  if (dmNotifyChannel) supabase.removeChannel(dmNotifyChannel);
  if (chatNotifyChannel) supabase.removeChannel(chatNotifyChannel);

  dmNotifyChannel = supabase
    .channel('dm_notify_' + currentUser.id)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'dm_messages' }, async (payload) => {
      const row = payload.new;
      if (row.sender_id === currentUser.id) return; // pesan sendiri, abaikan

      const dmOpenForThisConvo = $('#dm-chat-overlay').classList.contains('open') && dmConversationId === row.conversation_id;
      if (dmOpenForThisConvo) return; // sudah ditangani channel per-thread

      updateInboxDot(true);
      const { data: sender } = await supabase.from('profiles').select('username, display_name, is_verified, verified_name').eq('id', row.sender_id).single();
      if (notifSoundEnabled()) showToast('Pesan baru dari ' + displayNameOf(sender));
    })
    .subscribe();

  chatNotifyChannel = supabase
    .channel('chat_notify_' + currentUser.id)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages' }, (payload) => {
      const row = payload.new;
      if (row.user_id === currentUser.id) return;
      if (currentPageName === 'chat') return; // sudah kelihatan di layar
      $('#chat-nav-dot').classList.add('show');
    })
    .subscribe();
}

// =====================================================================
// NOTIFIKASI (like, komentar, balasan, follow, verified, promosi, admin)
// =====================================================================
let notifChannel = null;

function notifIcon(type) {
  const icons = {
    like_video: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z"/>',
    like_comment: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z"/>',
    comment: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>',
    reply: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>',
    follow: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M20 8v6M23 11h-6"/>',
    verified: '<path d="M12 2l2.4 1.7 2.9-.4 1.1 2.7 2.7 1.1-.4 2.9L22 12l-1.7 2.4.4 2.9-2.7 1.1-1.1 2.7-2.9-.4L12 22l-2.4-1.7-2.9.4-1.1-2.7-2.7-1.1.4-2.9L2 12l1.7-2.4-.4-2.9 2.7-1.1 1.1-2.7 2.9.4z"/><path d="M9 12l2 2 4-4" stroke-width="1.5" fill="none"/>',
    promoted: '<path d="M13 2L3 14h7v8l10-12h-7z"/>',
    admin_broadcast: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
  };
  return icons[type] || icons.admin_broadcast;
}

function notifText(n) {
  const actor = n.actor ? escHtml(displayNameOf(n.actor)) : null;
  switch (n.type) {
    case 'like_video': return `<b>${actor}</b> menyukai video kamu`;
    case 'like_comment': return `<b>${actor}</b> menyukai komentar kamu`;
    case 'comment': return `<b>${actor}</b> mengomentari video kamu`;
    case 'reply': return `<b>${actor}</b> membalas komentar kamu`;
    case 'follow': return `<b>${actor}</b> mulai mengikuti kamu`;
    case 'verified': return `Akun kamu telah diverifikasi ✓`;
    case 'promoted': return `Video kamu dijadikan konten promosi`;
    case 'admin_broadcast': return escHtml(n.message || '');
    default: return escHtml(n.message || 'Notifikasi baru');
  }
}

$('#notif-btn').onclick = () => openNotifList();

async function openNotifList() {
  const box = $('#notif-list');
  box.innerHTML = `<div class="empty" style="padding:20px 0">Memuat...</div>`;
  openSheet('notif-list-overlay');

  const { data, error } = await supabase
    .from('notifications')
    .select('*, actor:profiles!notifications_actor_id_fkey(id, username, display_name, is_verified, verified_name), video:videos(id, video_url, caption)')
    .eq('user_id', currentUser.id)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) { box.innerHTML = `<div class="empty">Gagal memuat notifikasi.</div>`; return; }
  if (!data.length) { box.innerHTML = `<div class="empty" style="padding:20px 0">Belum ada notifikasi.</div>`; return; }

  box.innerHTML = data.map(n => `
    <div class="notif-row ${!n.is_read ? 'unread' : ''}" data-notif-id="${n.id}" data-notif-type="${n.type}" data-notif-actor="${n.actor?.id || ''}">
      <div class="notif-icon"><svg class="icon" viewBox="0 0 24 24">${notifIcon(n.type)}</svg></div>
      <div class="notif-body">
        <div class="notif-text">${notifText(n)}</div>
        <div class="notif-time">${timeAgo(n.created_at)}</div>
      </div>
      ${!n.is_read ? '<div class="notif-dot-unread"></div>' : ''}
    </div>
  `).join('');

  box.querySelectorAll('[data-notif-id]').forEach((el, i) => {
    el.onclick = () => {
      const n = data[i];
      closeSheet('notif-list-overlay');
      if (n.video) openVideoPlayer({ id: n.video.id, url: n.video.video_url, caption: n.video.caption || '' });
      else if (n.type === 'follow' && n.actor?.id) openUserProfile(n.actor.id);
    };
  });

  // Tandai semua sudah dibaca
  await supabase.from('notifications').update({ is_read: true }).eq('user_id', currentUser.id).eq('is_read', false);
  $('#notif-dot').classList.remove('show');
}

async function checkUnreadNotif() {
  const { count, error } = await supabase.from('notifications').select('id', { count: 'exact', head: true }).eq('user_id', currentUser.id).eq('is_read', false);
  if (!error && count > 0) $('#notif-dot').classList.add('show');
}

function subscribeNotifRealtime() {
  if (notifChannel) supabase.removeChannel(notifChannel);
  notifChannel = supabase
    .channel('notif_' + currentUser.id)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${currentUser.id}` }, () => {
      $('#notif-dot').classList.add('show');
    })
    .subscribe();
}

// =====================================================================
// AKSES ADMIN (lewat ikon profil di topbar)
// =====================================================================
$('#admin-access-btn').onclick = () => {
  $('#admin-access-code').value = '';
  $('#admin-access-error').style.display = 'none';
  openSheet('admin-access-overlay');
  setTimeout(() => $('#admin-access-code').focus(), 100);
};
$('#cancel-admin-access').onclick = () => closeSheet('admin-access-overlay');
$('#admin-access-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#submit-admin-access').click(); });
$('#submit-admin-access').onclick = () => {
  const code = $('#admin-access-code').value.trim();
  const errEl = $('#admin-access-error');
  if (code !== ADMIN_ACCESS_CODE) {
    errEl.textContent = 'Kode akses salah.';
    errEl.style.display = 'block';
    return;
  }
  // Kode cuma membuka pintu masuk ke halaman admin — otorisasi asli tetap
  // dicek di server (role admin) begitu login di admin.html.
  window.location.href = './admin.html';
};

// =====================================================================
// PENGATURAN (tema, dll)
// =====================================================================
const THEME_KEY = 'xaya_theme';
const NOTIF_SOUND_KEY = 'xaya_notif_sound';

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  $('#theme-dark-opt').classList.toggle('active', theme === 'dark');
  $('#theme-light-opt').classList.toggle('active', theme === 'light');
}
function initTheme() {
  const saved = localStorage.getItem(THEME_KEY) || 'dark';
  applyTheme(saved);
}
$('#theme-dark-opt').onclick = () => { localStorage.setItem(THEME_KEY, 'dark'); applyTheme('dark'); };
$('#theme-light-opt').onclick = () => { localStorage.setItem(THEME_KEY, 'light'); applyTheme('light'); };

function initNotifSoundToggle() {
  const on = localStorage.getItem(NOTIF_SOUND_KEY) !== 'off';
  $('#toggle-notif-sound').classList.toggle('on', on);
}
$('#toggle-notif-sound').onclick = () => {
  const el = $('#toggle-notif-sound');
  const nowOn = !el.classList.contains('on');
  el.classList.toggle('on', nowOn);
  localStorage.setItem(NOTIF_SOUND_KEY, nowOn ? 'on' : 'off');
};
function notifSoundEnabled() { return localStorage.getItem(NOTIF_SOUND_KEY) !== 'off'; }

$('#settings-btn').onclick = () => { initTheme(); initNotifSoundToggle(); openSheet('settings-overlay'); };
$('#close-settings').onclick = () => closeSheet('settings-overlay');
$('#settings-logout-row').onclick = () => { closeSheet('settings-overlay'); $('#logout-btn').click(); };

initTheme(); // terapkan tema tersimpan sesegera mungkin, sebelum login

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

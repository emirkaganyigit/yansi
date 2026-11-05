const icons = {
  monitor: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/>',
  devices: '<rect x="2" y="4" width="14" height="11" rx="2"/><path d="M5 19h7m-4-4v4"/><rect x="16" y="10" width="6" height="11" rx="1.5"/>',
  folder: '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
  share: '<rect x="3" y="10" width="18" height="11" rx="2"/><path d="M12 3v12M8 7l4-4 4 4"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
  link: '<path d="m10 14 4-4m-6 7-2 2a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m4-2 2-2a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" transform="translate(1 0)"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M15 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h3"/>',
  wifi: '<path d="M3 8a14 14 0 0 1 18 0M6 12a9 9 0 0 1 12 0m-9 4a4.5 4.5 0 0 1 6 0"/><circle cx="12" cy="20" r=".5" fill="currentColor"/>',
  power: '<path d="M12 2v10m-6-7a9 9 0 1 0 12 0"/>',
  sliders: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3" fill="white"/><circle cx="16" cy="17" r="3" fill="white"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v1"/>',
  upload: '<path d="M12 16V3m-5 5 5-5 5 5M3 15v5a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-5"/>',
  download: '<path d="M12 3v13m-5-5 5 5 5-5M3 15v5a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Z"/><path d="M14 2v6h6M8 13h8m-8 4h5"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
};
function icon(name) { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.file}</svg>`; }
document.querySelectorAll('[data-icon]').forEach(element => { element.innerHTML = icon(element.dataset.icon); });

const api = window.yansi;
const $ = id => document.getElementById(id);
let state = { running: false, port: 8080, addresses: [], viewers: [], files: [], sharing: false };
let stream = null;
let systemAudioSession = null;
let systemAudioFailure = '';
let systemAudioController = null;
let stoppingSharing = null;
let selectedQuality = 720;
let streamMode = 'motion';
let codecPreference = 'auto';
let captureBusy = false;
let captureGeneration = 0;
let sharingPublished = false;
let selectedAddress = '';
let disposed = false;
const peers = new Map();
const statsSampler = window.YansiStreamStats?.createSampler();
let samplingStats = false;
const h264Available = RTCRtpReceiver.getCapabilities('video')?.codecs.some(codec => codec.mimeType.toLowerCase() === 'video/h264');
if (!h264Available) {
  const option = $('codec-preference').querySelector('[value="h264"]');
  option.disabled = true;
  option.textContent = 'H.264 bu bilgisayarda sunulmuyor';
}

function renderDiagnostics() {
  const peer = [...peers.values()].find(item => item.pc.connectionState === 'connected') || [...peers.values()][0];
  const sent = peer?.stats;
  const received = peer?.receiverStatsAt && Date.now() - peer.receiverStatsAt < 8000 ? peer.receiverStats : null;
  const formatted = (number, unit, digits = 1) => Number.isFinite(number) ? `${number.toLocaleString('tr-TR', { maximumFractionDigits: digits })} ${unit}` : '—';
  $('stats-send-fps').textContent = formatted(sent?.fps, 'kare/sn') + (sent?.width && sent?.height ? ` · ${sent.width}×${sent.height}` : '');
  $('stats-receive-fps').textContent = formatted(received?.fps, 'kare/sn') + (received?.width && received?.height ? ` · ${received.width}×${received.height}` : '');
  $('stats-rtt').textContent = formatted(sent?.rttMs, 'ms');
  $('stats-bitrate').textContent = formatted(sent?.bitrateKbps == null ? null : sent.bitrateKbps / 1000, 'Mbit/sn', 2);
  const codec = sent?.codec?.replace(/^video\//, '') || '—';
  $('stats-encode').textContent = `${codec}${Number.isFinite(sent?.encodeMs) ? ` · ${formatted(sent.encodeMs, 'ms/kare')}` : ''}`;
  $('stats-decode').textContent = formatted(received?.decodeMs, 'ms/kare');
  const summary = $('stats-summary');
  summary.textContent = !peer ? 'Bağlantı bekleniyor' : sent?.fps == null ? 'Ölçülüyor…' : `${formatted(sent.fps, 'kare/sn gönderim')} · ${formatted(received?.fps, 'kare/sn TV')}`;
  let note = 'Gerçek ölçümler bağlantı kurulduğunda görünür. Sabit ekranda kare sayısı düşebilir.';
  if (sent?.qualityLimitationReason === 'cpu') note = 'Bilgisayarın video kodlama yükü yayını sınırlıyor. Akıcı mod, kare hızını korumak için çözünürlüğü azaltabilir.';
  else if (sent?.qualityLimitationReason === 'bandwidth') note = 'Ağ kapasitesi yayını sınırlıyor. Kablolu PC bağlantısı veya güçlü bir 5 GHz Wi-Fi bağlantısı deneyebilirsin.';
  else if (peer) note = 'Kare hızları gerçek sayaçlardan ölçülür; sabit ekranda azalabilir. Ağ gidiş-dönüş süresi, toplam ekran gecikmesi değildir.';
  if (sent?.encoderImplementation) note += ` Kodlayıcı: ${sent.encoderImplementation}.`;
  if (received?.decoderImplementation) note += ` TV çözücü: ${received.decoderImplementation}.`;
  $('stats-note').textContent = note;
}

const statsTimer = setInterval(async () => {
  if (samplingStats || disposed || !statsSampler) return;
  samplingStats = true;
  try {
    for (const [id, peer] of peers) {
      try {
        const report = await statsSampler.sample(peer.pc);
        if (peers.get(id) === peer) peer.stats = report;
      } catch { /* Closing peers can reject a final statistics request. */ }
    }
    renderDiagnostics();
  } finally { samplingStats = false; }
}, 2000);

async function configureVideoSender(sender) {
  if (!sender?.track || sender.track.kind !== 'video') return;
  const parameters = sender.getParameters();
  parameters.degradationPreference = streamMode === 'motion' ? 'maintain-framerate' : 'maintain-resolution';
  const maxBitrate = selectedQuality === 1080 ? (streamMode === 'motion' ? 5_000_000 : 6_000_000) : 3_000_000;
  for (const encoding of parameters.encodings || []) { encoding.maxBitrate = maxBitrate; encoding.maxFramerate = 30; }
  try { await sender.setParameters(parameters); }
  catch (error) {
    const fallback = sender.getParameters();
    for (const encoding of fallback.encodings || []) encoding.maxBitrate = maxBitrate;
    try { await sender.setParameters(fallback); } catch { console.warn('Görüntü gönderim ayarı uygulanamadı', error); }
  }
}
const pages = {
  screen: ['Ekranını büyüt.', 'Bir pencereyi ya da tüm ekranını, aynı ağdaki bir cihaza yansıt.'],
  files: ['Dosyaların elinin altında.', 'Cihazların arasında dosya gönder, indir ve paylaş.'],
  devices: ['Cihazlarına yer aç.', 'Bağlantıları onayla, ekranını kimin izlediğini gör.'],
};

function toast(message, kind = '') {
  const item = document.createElement('div');
  item.className = `toast ${kind}`;
  item.textContent = message;
  $('toast-region').append(item);
  setTimeout(() => item.remove(), kind === 'error' ? 7000 : 4500);
}
function errorMessage(error) { return error?.message || String(error || 'İşlem tamamlanamadı.'); }
async function run(action) {
  if (!api) { toast('Bu bir arayüz önizlemesi. Paylaşım için Yansı masaüstü uygulamasını aç.', 'warning'); return; }
  try { return await action(); } catch (error) { toast(errorMessage(error), 'error'); }
}
function changeView(view) {
  if (!pages[view]) return;
  document.querySelectorAll('.view').forEach(element => { element.hidden = element.id !== `view-${view}`; });
  document.querySelectorAll('[data-view]').forEach(element => {
    const active = element.dataset.view === view;
    element.classList.toggle('active', active);
    if (active) element.setAttribute('aria-current', 'page'); else element.removeAttribute('aria-current');
  });
  $('page-title').textContent = pages[view][0];
  $('page-description').textContent = pages[view][1];
}
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => changeView(button.dataset.view)));
document.querySelectorAll('[data-go-view]').forEach(button => button.addEventListener('click', () => changeView(button.dataset.goView)));

function humanSize(size) {
  if (!Number.isFinite(size)) return '';
  if (size < 1024) return `${size} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = size / 1024, index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
  return `${value.toLocaleString('tr-TR', { maximumFractionDigits: 1 })} ${units[index]}`;
}
function viewerName(viewer) {
  if (viewer.name) return viewer.name;
  if (/TV|AFT|MiBOX|Mi Box|BRAVIA/i.test(viewer.userAgent || '')) return 'Televizyon tarayıcısı';
  if (/iPhone|iPad/i.test(viewer.userAgent || '')) return 'iPhone / iPad';
  if (/Android/i.test(viewer.userAgent || '')) return 'Android cihaz';
  return 'Web tarayıcısı';
}
function renderViewers(container) {
  container.replaceChildren();
  if (!state.viewers.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-inline';
    empty.innerHTML = `<span class="empty-icon">${icon('devices')}</span><div><strong>Henüz bir cihaz bağlanmadı</strong><p>Televizyonunda adresi açtığında bağlantı isteğini burada göreceksin.</p></div>`;
    container.append(empty);
    return;
  }
  for (const viewer of state.viewers) {
    const pending = viewer.status === 'pending';
    const row = document.createElement('div');
    row.className = `viewer-row${pending ? ' pending' : ''}`;
    const badge = document.createElement('span'); badge.className = 'viewer-icon'; badge.innerHTML = icon('devices');
    const info = document.createElement('div'); info.className = 'viewer-info';
    const name = document.createElement('strong'); name.textContent = viewerName(viewer);
    const detail = document.createElement('p');
    const pc = peers.get(viewer.id)?.pc;
    detail.textContent = `${viewer.address || 'Yerel cihaz'} · ${pending ? 'Bağlanmak için onay bekliyor' : pc?.connectionState === 'connected' ? 'Ekranını izliyor' : stream ? 'Görüntüye bağlanıyor' : 'Bağlı · Ekran paylaşımı bekliyor'}`;
    info.append(name, detail);
    const actions = document.createElement('div'); actions.className = 'viewer-actions';
    const addAction = (text, className, action) => {
      const button = document.createElement('button'); button.className = `button small ${className}`; button.textContent = text;
      button.addEventListener('click', () => { button.disabled = true; run(action).finally(() => { if (button.isConnected) button.disabled = false; }); });
      actions.append(button);
    };
    if (pending) {
      addAction('Reddet', 'secondary', () => api.rejectViewer(viewer.id));
      addAction('Onayla', 'primary', async () => {
        const approved = await api.approveViewer(viewer.id);
        if (approved === false) throw new Error(state.viewers.some(item => item.status === 'approved') ? 'Bu sürümde aynı anda bir cihaz bağlanabilir. Önce bağlı cihazın bağlantısını kes.' : 'Bu bağlantı isteği artık geçerli değil. Cihazdan tekrar bağlan.');
      });
    } else addAction('Bağlantıyı kes', 'secondary', () => api.disconnectViewer(viewer.id));
    row.append(badge, info, actions); container.append(row);
  }
}
function renderFiles(container, source) {
  container.replaceChildren();
  const files = state.files.filter(file => file.source === source);
  if (!files.length) {
    const p = document.createElement('p'); p.className = 'empty-files'; p.textContent = source === 'shared' ? 'Paylaşmak için bir dosya seç.' : 'Henüz gelen dosya yok.'; container.append(p); return;
  }
  for (const file of files) {
    const row = document.createElement('div'); row.className = 'file-row';
    const badge = document.createElement('span'); badge.innerHTML = icon('file');
    const info = document.createElement('div'); info.className = 'file-info';
    const name = document.createElement('strong'); name.textContent = file.name;
    const size = document.createElement('small'); size.textContent = `${humanSize(file.size)} · ${source === 'received' ? 'Bu bilgisayara alındı' : 'İndirmeye hazır'}`;
    info.append(name, size); row.append(badge, info);
    if (api?.openFile) {
      const open = document.createElement('button'); open.className = 'text-button'; open.textContent = 'Aç ↗'; open.addEventListener('click', () => run(() => api.openFile(file.id))); row.append(open);
    }
    if (source === 'shared' && api?.removeFile) {
      const remove = document.createElement('button'); remove.className = 'icon-button'; remove.setAttribute('aria-label', `${file.name} paylaşımını kaldır`); remove.innerHTML = icon('close');
      remove.addEventListener('click', () => run(() => api.removeFile(file.id))); row.append(remove);
    }
    container.append(row);
  }
}
function renderState() {
  $('server-status').classList.toggle('online', state.running);
  $('server-status').innerHTML = `<span class="tiny-dot"></span>${state.running ? 'Yerel ağda hazır' : api ? 'Bağlantı kapalı' : 'Arayüz önizlemesi'}`;
  $('sidebar-dot').classList.toggle('active', state.running);
  $('server-sidebar-status').textContent = state.running ? 'Yerel bağlantı açık' : 'Yerel bağlantı kapalı';
  $('server-toggle').innerHTML = `${icon('power')}${state.running ? 'Bağlantıyı kapat' : 'Bağlantıyı başlat'}`;
  const addresses = state.running ? state.addresses || [] : [];
  if (!addresses.some(address => address.url === selectedAddress)) selectedAddress = addresses[0]?.url || '';
  $('local-address').textContent = selectedAddress || (state.running ? 'Ağ bağlantısı bulunamadı' : 'Bağlantı başlatılınca görünecek');
  $('copy-address').disabled = !selectedAddress;
  $('address-choices').hidden = addresses.length < 2;
  const select = $('network-address'); select.replaceChildren();
  addresses.forEach(address => { const option = document.createElement('option'); option.value = address.url; option.textContent = `${address.name} · ${address.address}`; option.selected = address.url === selectedAddress; select.append(option); });
  $('device-count').textContent = String(state.viewers.filter(viewer => viewer.status !== 'pending').length);
  renderViewers($('screen-viewers')); renderViewers($('all-viewers'));
  renderFiles($('shared-files'), 'shared'); renderFiles($('received-files'), 'received');
  updateCaptureUI();
  renderDiagnostics();
}
function receiveState(next) {
  if (!next || typeof next.running !== 'boolean') return;
  state = { ...state, ...next, viewers: next.viewers || [], files: next.files || [], addresses: next.addresses || [] };
  const approved = new Set(state.viewers.filter(viewer => viewer.status === 'approved' || viewer.status === 'connected').map(viewer => viewer.id));
  for (const id of peers.keys()) if (!approved.has(id)) closePeer(id);
  if ((!state.running && (stream || captureBusy)) || (stream && sharingPublished && !state.sharing)) void stopSharing();
  if (stream && state.sharing) for (const id of approved) if (!peers.has(id)) void offerViewer(id);
  renderState();
}
function updateCaptureUI() {
  const live = Boolean(stream);
  const showPreview = live && $('preview-toggle').checked;
  const audioToggle = $('system-audio-toggle');
  if (audioToggle) audioToggle.disabled = captureBusy || live;
  const audioStatus = $('system-audio-status');
  if (audioStatus) audioStatus.textContent = systemAudioFailure ? 'Ses aktarılamadı' : systemAudioSession ? 'Sistem sesi TV’ye aktarılıyor' : audioToggle?.checked ? (captureBusy ? 'Sistem sesi hazırlanıyor…' : 'Paylaşımla birlikte açılır') : 'Yalnız görüntü paylaşılacak';
  const preview = $('screen-preview');
  preview.hidden = !showPreview;
  if (showPreview && preview.srcObject !== stream) { preview.srcObject = stream; void preview.play().catch(() => {}); }
  else if (!showPreview && preview.srcObject) { preview.pause(); preview.srcObject = null; }
  $('preview-empty').hidden = showPreview;
  $('preview-stage').classList.toggle('sharing', showPreview);
  $('preview-empty-title').textContent = live ? 'Yayın televizyonuna aktarılıyor.' : 'Büyük ekrana bir adım kaldı.';
  $('preview-empty-description').textContent = live ? 'PC önizlemesi kapalı. İstersen yukarıdan açabilirsin.' : 'Paylaşacağın ekranı veya pencereyi seç. Görüntü televizyonuna aktarılır.';
  $('stream-mode').disabled = captureBusy;
  $('codec-preference').disabled = captureBusy;
  $('mode-description').textContent = streamMode === 'motion' ? 'Video için kare hızına öncelik verir; gerekirse çözünürlük azalır.' : 'Yazıların netliğine öncelik verir; yük artarsa kare hızı azalabilir.';
  $('preview-badge').textContent = live ? `${selectedQuality}p · 30 kare/sn hedefi` : 'Paylaşım kapalı';
  $('live-indicator').hidden = !live;
  $('sharing-label').textContent = live ? 'Ekranın paylaşılıyor' : 'Paylaşmaya hazırsın';
  $('sharing-description').textContent = live ? 'Onayladığın cihazlar seçtiğin ekranı izleyebilir.' : 'Ekranı sen seçersin, paylaşımı sen bitirirsin.';
  const button = $('share-button');
  button.disabled = captureBusy;
  button.classList.toggle('danger', live); button.classList.toggle('primary', !live);
  button.innerHTML = `${icon(live ? 'stop' : 'share')}${captureBusy ? 'Hazırlanıyor…' : live ? 'Paylaşımı bitir' : 'Ekranı paylaş'}`;
  document.querySelectorAll('[data-quality]').forEach(button => { const selected = Number(button.dataset.quality) === selectedQuality; button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected)); button.disabled = captureBusy; });
}
function closePeer(id) {
  const peer = peers.get(id);
  if (!peer) return;
  peers.delete(id);
  peer.pc.onconnectionstatechange = null;
  peer.pc.onicecandidate = null;
  peer.pc.close();
  statsSampler?.clear(peer.pc);
  renderDiagnostics();
}
async function offerViewer(id) {
  if (!stream || !state.sharing || disposed || peers.has(id)) return;
  const pc = new RTCPeerConnection({ iceServers: [] });
  const negotiationId = crypto.randomUUID();
  const peer = { pc, candidates: [], negotiationId }; peers.set(id, peer);
  try {
    for (const track of stream.getTracks()) pc.addTrack(track, stream);
    if (codecPreference === 'h264') {
      const transceiver = pc.getTransceivers().find(item => item.sender.track?.kind === 'video');
      const codecs = RTCRtpReceiver.getCapabilities('video')?.codecs || [];
      if (transceiver?.setCodecPreferences && codecs.some(codec => codec.mimeType.toLowerCase() === 'video/h264')) {
        try { transceiver.setCodecPreferences([...codecs.filter(codec => codec.mimeType.toLowerCase() === 'video/h264'), ...codecs.filter(codec => codec.mimeType.toLowerCase() !== 'video/h264')]); }
        catch (error) { console.warn('H.264 tercihi uygulanamadı; otomatik seçim kullanılacak.', error); }
      }
    }
    pc.onicecandidate = event => { if (event.candidate && peers.get(id) === peer) void api.sendSignal(id, { type: 'candidate', candidate: event.candidate.toJSON(), negotiationId }).catch(error => console.warn('Ağ adayı gönderilemedi', error)); };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') toast('Bir cihazla görüntü bağlantısı kurulamadı. TV tarayıcısında yeniden bağlanmayı deneyebilirsin.', 'warning');
      renderViewers($('screen-viewers')); renderViewers($('all-viewers'));
    };
    await pc.setLocalDescription(await pc.createOffer());
    if (peers.get(id) !== peer) return;
    await configureVideoSender(pc.getSenders().find(item => item.track?.kind === 'video'));
    if (peers.get(id) !== peer) return;
    await api.sendSignal(id, { type: 'offer', sdp: pc.localDescription.sdp, negotiationId });
  } catch (error) {
    if (peers.get(id) === peer) { closePeer(id); toast(`Görüntü bağlantısı başlatılamadı: ${errorMessage(error)}`, 'error'); }
  }
}
async function handleSignal(id, payload) {
  if (!payload || !stream) return;
  if (payload.type === 'ready' || payload.type === 'renegotiate') { closePeer(id); await offerViewer(id); return; }
  const peer = peers.get(id);
  if (!peer) return;
  if (payload.negotiationId !== peer.negotiationId) return;
  if (payload.type === 'receiver-stats') {
    const report = {};
    for (const key of ['fps', 'width', 'height', 'bitrateKbps', 'decodeMs', 'droppedFrames', 'jitterBufferMs']) {
      report[key] = Number.isFinite(payload[key]) && payload[key] >= 0 && payload[key] < 1_000_000_000 ? payload[key] : null;
    }
    for (const key of ['codec', 'decoderImplementation']) report[key] = typeof payload[key] === 'string' ? payload[key].slice(0, 80) : null;
    peer.receiverStats = report; peer.receiverStatsAt = Date.now();
    renderDiagnostics();
    return;
  }
  try {
    if (payload.type === 'answer') {
      if (peer.pc.signalingState !== 'have-local-offer') return;
      await peer.pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp });
      for (const candidate of peer.candidates.splice(0)) await peer.pc.addIceCandidate(candidate);
    } else if (payload.type === 'candidate' && payload.candidate) {
      if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(payload.candidate); else peer.candidates.push(payload.candidate);
    }
  } catch (error) { console.warn('Görüntü bağlantısı mesajı işlenemedi', error); }
}
async function startSharing() {
  if (!api || captureBusy) return run(() => {});
  const generation = ++captureGeneration;
  systemAudioFailure = '';
  captureBusy = true; updateCaptureUI();
  try {
    if (!state.running) { const next = await api.startServer(); if (next) receiveState(next); }
    if (disposed || generation !== captureGeneration) return;
    if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('Bu ortam ekran paylaşımını desteklemiyor. Yansı masaüstü uygulamasını kullan.');
    const height = selectedQuality, width = height === 1080 ? 1920 : 1280;
    const captured = await navigator.mediaDevices.getDisplayMedia({ video: { width: { ideal: width, max: width }, height: { ideal: height, max: height }, frameRate: { ideal: 30, max: 30 } }, audio: false });
    if (disposed || generation !== captureGeneration) { captured.getTracks().forEach(track => track.stop()); return; }
    stream = captured;
    for (const track of stream.getVideoTracks()) {
      if ('contentHint' in track) track.contentHint = streamMode;
    }
    updateCaptureUI();
    if (disposed || generation !== captureGeneration) return;
    for (const track of stream.getVideoTracks()) track.addEventListener('ended', () => { if (stream === captured) void stopSharing(); }, { once: true });
    if ($('system-audio-toggle')?.checked) {
      try {
        if (!window.YansiSystemAudio) throw new Error('Sistem sesi bileşeni yüklenemedi.');
        const controller = new AbortController();
        systemAudioController = controller;
        const audio = await window.YansiSystemAudio.start(api, { signal: controller.signal });
        if (disposed || generation !== captureGeneration) { await audio.stop(); return; }
        systemAudioSession = audio;
        for (const track of audio.stream.getAudioTracks()) stream.addTrack(track);
      } catch (error) {
        if (generation !== captureGeneration) return;
        systemAudioFailure = errorMessage(error);
        toast(`Sistem sesi açılamadı: ${systemAudioFailure}. Görüntü paylaşımı devam ediyor.`, 'warning');
      }
    }
    if (disposed || generation !== captureGeneration) return;
    const sharingState = await api.setSharing(true);
    if (disposed || generation !== captureGeneration) { await api.setSharing(false); return; }
    if (sharingState) receiveState(sharingState);
    sharingPublished = true;
    for (const viewer of state.viewers.filter(viewer => viewer.status !== 'pending')) void offerViewer(viewer.id);
  } catch (error) {
    if (generation !== captureGeneration) return;
    if (stream) await stopSharing();
    if (error?.name !== 'NotAllowedError' && error?.name !== 'AbortError') toast(`Ekran paylaşımı başlatılamadı: ${errorMessage(error)}`, 'error');
  } finally { if (generation === captureGeneration) captureBusy = false; updateCaptureUI(); }
}
function stopSharing() {
  if (stoppingSharing) return stoppingSharing;
  captureGeneration++;
  systemAudioController?.abort();
  systemAudioController = null;
  sharingPublished = false;
  captureBusy = true;
  const previous = stream; stream = null;
  const previousAudio = systemAudioSession; systemAudioSession = null;
  previous?.getTracks().forEach(track => track.stop());
  $('screen-preview').srcObject = null;
  for (const id of [...peers.keys()]) closePeer(id);
  updateCaptureUI();
  stoppingSharing = (async () => {
    if (previousAudio) await previousAudio.stop().catch(error => console.warn('Ses yakalama kapatılamadı', error));
    if (api) { try { await api.setSharing(false); } catch (error) { console.warn('Paylaşım durumu güncellenemedi', error); } }
    renderViewers($('screen-viewers')); renderViewers($('all-viewers'));
  })().finally(() => { stoppingSharing = null; captureBusy = false; updateCaptureUI(); });
  return stoppingSharing;
}
$('share-button').addEventListener('click', () => { if (stream) void stopSharing(); else void startSharing(); });
$('preview-toggle').addEventListener('change', updateCaptureUI);
$('stream-mode').addEventListener('change', () => run(async () => {
  streamMode = $('stream-mode').value === 'detail' ? 'detail' : 'motion';
  for (const track of stream?.getVideoTracks() || []) if ('contentHint' in track) track.contentHint = streamMode;
  await Promise.all([...peers.values()].map(peer => configureVideoSender(peer.pc.getSenders().find(item => item.track?.kind === 'video'))));
  updateCaptureUI();
}));
$('codec-preference').addEventListener('change', () => run(async () => {
  codecPreference = $('codec-preference').value === 'h264' ? 'h264' : 'auto';
  const ids = [...peers.keys()];
  for (const id of ids) closePeer(id);
  if (stream && state.sharing) await Promise.all(ids.map(offerViewer));
}));
$('system-audio-toggle')?.addEventListener('change', () => { systemAudioFailure = ''; updateCaptureUI(); });

async function handleAudioError(message) {
  systemAudioFailure = message || 'Sistem sesi bağlantısı kesildi.';
  const previousAudio = systemAudioSession; systemAudioSession = null;
  if (previousAudio) {
    for (const track of previousAudio.stream.getAudioTracks()) { stream?.removeTrack(track); track.stop(); }
    await previousAudio.stop().catch(() => {});
    const ids = [...peers.keys()];
    for (const id of ids) closePeer(id);
    if (stream && state.sharing) for (const id of ids) void offerViewer(id);
  }
  updateCaptureUI();
  toast(`Ses aktarımı durdu: ${systemAudioFailure}`, 'warning');
}
document.querySelectorAll('[data-quality]').forEach(button => button.addEventListener('click', async () => {
  const quality = Number(button.dataset.quality);
  if (quality === selectedQuality || captureBusy) return;
  const previous = selectedQuality;
  selectedQuality = quality;
  try {
    if (stream) {
      captureBusy = true; updateCaptureUI();
      await stream.getVideoTracks()[0].applyConstraints({ width: { ideal: quality === 1080 ? 1920 : 1280, max: quality === 1080 ? 1920 : 1280 }, height: { ideal: quality, max: quality }, frameRate: { ideal: 30, max: 30 } });
      await Promise.all([...peers.values()].map(peer => configureVideoSender(peer.pc.getSenders().find(item => item.track?.kind === 'video'))));
    }
  } catch (error) { selectedQuality = previous; toast(`Kalite ayarı uygulanamadı: ${errorMessage(error)}`, 'error'); }
  finally { captureBusy = false; updateCaptureUI(); }
}));
$('server-toggle').addEventListener('click', () => run(async () => {
  if (state.running) { await stopSharing(); const next = await api.stopServer(); if (next) receiveState(next); }
  else { const next = await api.startServer(); if (next) receiveState(next); }
}));
$('network-address').addEventListener('change', event => { selectedAddress = event.target.value; $('local-address').textContent = selectedAddress; });
$('copy-address').addEventListener('click', () => run(async () => { if (api.copyText) await api.copyText(selectedAddress); else await navigator.clipboard.writeText(selectedAddress); toast('Bağlantı adresi kopyalandı.'); }));
async function chooseFiles() { return run(async () => { if (!state.running) { const next = await api.startServer(); if (next) receiveState(next); } await api.chooseFiles(); }); }
$('choose-files').addEventListener('click', chooseFiles);
$('file-dropzone').addEventListener('click', chooseFiles);
$('open-downloads').addEventListener('click', () => run(() => api.openDownloads()));
window.addEventListener('dragover', event => event.preventDefault());
window.addEventListener('drop', event => event.preventDefault());
const dropzone = $('file-dropzone');
dropzone.addEventListener('dragover', event => { event.preventDefault(); dropzone.classList.add('dragover'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
dropzone.addEventListener('drop', event => {
  event.preventDefault(); dropzone.classList.remove('dragover');
  const files = [...event.dataTransfer.files];
  if (!files.length) return;
  void run(async () => {
    if (!api.addDroppedFiles) { toast('Dosyaları “Dosya seç” düğmesiyle ekleyebilirsin.', 'warning'); return; }
    if (!state.running) { const next = await api.startServer(); if (next) receiveState(next); }
    await api.addDroppedFiles(files);
  });
});

let unsubscribe;
async function initialize() {
  renderState();
  if (!api) return;
  unsubscribe = api.onEvent(event => {
    if (event.type === 'state') receiveState(event.state || event.data || event);
    else if (event.type === 'signal') void handleSignal(event.viewerId, event.payload);
    else if (event.type === 'viewer-approved' && stream && state.sharing) void offerViewer(event.viewer?.id || event.viewerId);
    else if (event.type === 'viewer-disconnected') closePeer(event.viewerId);
    else if (event.type === 'viewer-request') toast('Bir cihaz bağlanmak istiyor. Cihazlar bölümünden onaylayabilirsin.');
    else if (event.type === 'file-received') toast(`${event.file?.name || 'Dosya'} bilgisayarına alındı.`);
    else if (event.type === 'stop-sharing') { void stopSharing(); if (event.reason) toast(event.reason); }
    else if (event.type === 'audio-error') void handleAudioError(event.message);
    else if (event.type === 'error') toast(event.message || 'Bir hata oluştu.', 'error');
  });
  await run(async () => receiveState(await api.getState()));
}
window.addEventListener('beforeunload', () => {
  disposed = true; unsubscribe?.();
  clearInterval(statsTimer);
  systemAudioController?.abort();
  stream?.getTracks().forEach(track => track.stop());
  void systemAudioSession?.stop();
  for (const id of [...peers.keys()]) closePeer(id);
  if (stream) void api?.setSharing(false);
});
void initialize();

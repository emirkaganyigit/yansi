(() => {
  'use strict';
  const icons = {
    monitor: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/>',
    folder: '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
    link: '<path d="m9 15 6-6m-8 8-2 2a4 4 0 0 1-3-7l4-4a4 4 0 0 1 6 0m0-1 2-2a4 4 0 0 1 7 3l-4 4a4 4 0 0 1-6 0"/>',
    fullscreen: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
    fit: '<path d="M3 8V3h5m8 0h5v5M3 16v5h5m13-5v5h-5M8 12h8m-8 0 3-3m-3 3 3 3m5-3-3-3m3 3-3 3"/>',
    power: '<path d="M12 2v10m-6-7a9 9 0 1 0 12 0"/>',
    arrows: '<path d="M12 2v20M2 12h20m-14-8 4-2 4 2M8 20l4 2 4-2M4 8l-2 4 2 4m16-8 2 4-2 4"/>',
    shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    upload: '<path d="M12 16V3m-5 5 5-5 5 5M3 15v5a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-5"/>',
    download: '<path d="M12 3v13m-5-5 5 5 5-5M3 15v5a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M5 8a8 8 0 0 1 13-3l2 2M4 17l2 2a8 8 0 0 0 13-3"/>',
    play: '<path d="m8 4 12 8-12 8V4Z"/>',
    volume: '<path d="m11 5-6 4H2v6h3l6 4V5Z"/><path d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
    muted: '<path d="m11 5-6 4H2v6h3l6 4V5Z"/><path d="m16 9 6 6m0-6-6 6"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Z"/><path d="M14 2v6h6M8 13h8m-8 4h5"/>',
  };
  function icon(name) { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.file}</svg>`; }
  document.querySelectorAll('[data-icon]').forEach(element => { element.innerHTML = icon(element.dataset.icon); });
  const $ = id => document.getElementById(id);
  let socket = null, peer = null, token = null, approved = false, pending = false;
  let videoStream = null, hasVideo = false, fill = false, sharing = false;
  let audioEnabled = false;
  let hostName = '', intentionalClose = false, rejectionMessage = '';
  let signalChain = Promise.resolve(), offerGeneration = 0, signalEpoch = 0, negotiationId = null;
  const candidateQueues = new Map(), retiredNegotiations = new Set();
  let receiverStatsTimer = null, receiverStatsPeer = null, receiverStatsGeneration = 0;
  let uploadRequest = null, uploadCanceled = false, uploadRunning = false;
  let noticeTimer;

  function notify(message, error) {
    const notice = $('notice'); notice.textContent = message; notice.classList.toggle('error', Boolean(error)); notice.hidden = false;
    clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { notice.hidden = true; }, error ? 7000 : 4500);
  }
  function setConnectionStatus(text, mode) {
    const status = $('connection-status'); status.className = `connection-status ${mode || ''}`;
    status.replaceChildren(); const dot = document.createElement('span'); dot.className = 'status-dot'; status.append(dot, document.createTextNode(text));
  }
  function setPlaceholder(title, description) {
    $('player-title').textContent = title; $('player-description').textContent = description;
  }
  function renderConnection() {
    $('disconnect-button').hidden = !socket;
    $('connect-button').disabled = pending;
    $('connect-button').hidden = approved;
    $('connect-button').innerHTML = `${icon('link')}${pending ? 'Bilgisayardan onay bekleniyor…' : 'Bilgisayara bağlan'}`;
    $('files-lock').hidden = approved; $('files-content').hidden = !approved;
    $('host-hint').textContent = hostName ? `${hostName} · Aynı yerel ağda` : 'Yerel ağ üzerinden doğrudan bağlantı.';
    $('screen-label').textContent = hostName || 'Bilgisayar ekranı';
    if (approved) {
      setConnectionStatus('Bilgisayara bağlı', 'connected');
      if (!hasVideo) setPlaceholder(sharing ? 'Görüntüye bağlanılıyor.' : 'Bağlandın. Ekranın birazdan burada.', sharing ? 'Görüntü bağlantısı hazırlanıyor. Bu sayfayı açık tut.' : 'Bilgisayarındaki Yansı uygulamasından “Ekranı paylaş” düğmesine bas.');
      $('screen-detail').textContent = hasVideo ? 'Canlı ekran · Yerel bağlantı' : sharing ? 'Görüntü bağlantısı hazırlanıyor.' : 'Bilgisayarın ekran paylaşımını başlatması bekleniyor.';
    } else if (pending) {
      setConnectionStatus('Onay bekleniyor', 'pending');
      setPlaceholder('Bilgisayarında onayla.', 'Yansı uygulamasında bu cihazın bağlantı isteğine izin ver.');
      $('screen-detail').textContent = 'Bilgisayarındaki Yansı uygulamasından bağlantı isteğini onayla.';
    } else {
      setConnectionStatus('Bağlı değil');
      $('screen-detail').textContent = 'Bağlantıyı başlatmak için “Bağlan” düğmesine bas.';
    }
  }
  function hasIncomingAudio() {
    return Boolean(videoStream?.getAudioTracks().some(track => track.readyState === 'live'));
  }
  function renderAudio() {
    const available = hasIncomingAudio();
    const enabled = available && audioEnabled;
    const button = $('audio-button');
    button.disabled = !available;
    button.innerHTML = `${icon(enabled ? 'volume' : 'muted')}${enabled ? 'Sesi kapat' : 'Sesi aç'}`;
    button.setAttribute('aria-pressed', String(enabled));
    button.title = available ? (enabled ? 'TV sesini kapat' : 'Bilgisayarın sesini TV’den dinle') : 'Bilgisayardan sistem sesi gönderilmiyor';
    button.classList.toggle('audio-active', enabled);
    $('remote-video').muted = !enabled;
  }
  function clearVideo(invalidateSignals = false, preserveAudio = false) {
    stopReceiverStats();
    if (invalidateSignals) { signalEpoch++; candidateQueues.clear(); retiredNegotiations.clear(); }
    offerGeneration++;
    if (peer) { peer.ontrack = null; peer.onicecandidate = null; peer.onconnectionstatechange = null; peer.oniceconnectionstatechange = null; peer.close(); peer = null; }
    negotiationId = null;
    const previousStream = videoStream; videoStream = null; hasVideo = false;
    previousStream?.getTracks().forEach(track => track.stop());
    if (!preserveAudio) audioEnabled = false;
    $('remote-video').srcObject = null; $('remote-video').hidden = true;
    $('player-placeholder').hidden = false; $('player').classList.remove('has-video');
    $('video-overlay').hidden = true; $('play-prompt').hidden = true;
    $('fit-button').disabled = true; $('fullscreen-button').disabled = true;
    renderAudio();
  }
  function sendSignal(payload) {
    if (socket && socket.readyState === WebSocket.OPEN && approved) socket.send(JSON.stringify({ type: 'signal', payload }));
  }
  function statsNumber(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null; }
  function statsString(value) { return typeof value === 'string' && value ? value.slice(0, 80) : null; }
  function receiverStatsSample(reports, previous) {
    let inbound = null;
    reports.forEach(report => {
      if (report.type !== 'inbound-rtp' || report.isRemote || (report.kind || report.mediaType) !== 'video') return;
      if (!inbound || (statsNumber(report.bytesReceived) ?? -1) > (statsNumber(inbound.bytesReceived) ?? -1)) inbound = report;
    });
    if (!inbound) return null;
    const sample = {
      id: inbound.id, timestamp: statsNumber(inbound.timestamp), frames: statsNumber(inbound.framesDecoded),
      bytes: statsNumber(inbound.bytesReceived), decodeTime: statsNumber(inbound.totalDecodeTime),
      dropped: statsNumber(inbound.framesDropped), jitterDelay: statsNumber(inbound.jitterBufferDelay),
      jitterCount: statsNumber(inbound.jitterBufferEmittedCount),
    };
    const elapsed = previous && previous.id === sample.id && sample.timestamp !== null && previous.timestamp !== null ? sample.timestamp - previous.timestamp : 0;
    const delta = field => elapsed > 0 && sample[field] !== null && previous[field] !== null && sample[field] >= previous[field] ? sample[field] - previous[field] : null;
    const frames = delta('frames'), bytes = delta('bytes'), decodeTime = delta('decodeTime');
    const jitterDelay = delta('jitterDelay'), jitterCount = delta('jitterCount');
    const codec = inbound.codecId ? reports.get(inbound.codecId) : null;
    return { sample, metrics: {
      fps: frames === null ? null : statsNumber(frames * 1000 / elapsed),
      width: statsNumber(inbound.frameWidth), height: statsNumber(inbound.frameHeight),
      bitrateKbps: bytes === null ? null : statsNumber(bytes * 8 / elapsed),
      decodeMs: decodeTime !== null && frames > 0 ? statsNumber(decodeTime * 1000 / frames) : null,
      droppedFrames: delta('dropped'),
      jitterBufferMs: jitterDelay !== null && jitterCount > 0 ? statsNumber(jitterDelay * 1000 / jitterCount) : null,
      codec: statsString(codec?.mimeType), decoderImplementation: statsString(inbound.decoderImplementation),
      powerEfficientDecoder: typeof inbound.powerEfficientDecoder === 'boolean' ? inbound.powerEfficientDecoder : null,
    } };
  }
  function stopReceiverStats() {
    receiverStatsGeneration++;
    clearTimeout(receiverStatsTimer); receiverStatsTimer = null; receiverStatsPeer = null;
  }
  function peerIsConnected(connection) {
    return connection.connectionState === 'connected' || (!connection.connectionState && ['connected', 'completed'].includes(connection.iceConnectionState));
  }
  function startReceiverStats(connection, currentNegotiation) {
    if (receiverStatsPeer === connection || !peerIsConnected(connection) || !videoStream?.getVideoTracks().some(track => track.readyState === 'live')) return;
    stopReceiverStats();
    receiverStatsPeer = connection;
    const generation = receiverStatsGeneration, epoch = signalEpoch, currentSocket = socket;
    let previous = null;
    const current = () => generation === receiverStatsGeneration && peer === connection && negotiationId === currentNegotiation && epoch === signalEpoch &&
      approved && sharing && socket === currentSocket && socket?.readyState === WebSocket.OPEN && peerIsConnected(connection) &&
      videoStream?.getVideoTracks().some(track => track.readyState === 'live');
    const sample = async () => {
      receiverStatsTimer = null;
      if (!current()) { if (receiverStatsPeer === connection) stopReceiverStats(); return; }
      try {
        const reports = await connection.getStats();
        if (!current()) return;
        const result = receiverStatsSample(reports, previous);
        previous = result?.sample || null;
        if (result) sendSignal({ type: 'receiver-stats', negotiationId: currentNegotiation, ...result.metrics });
      } catch { previous = null; }
      finally {
        // Schedule after completion so slow getStats calls never overlap or exceed 0.5 Hz.
        if (current()) receiverStatsTimer = setTimeout(sample, 2000);
        else if (receiverStatsPeer === connection) stopReceiverStats();
      }
    };
    receiverStatsTimer = setTimeout(sample, 2000);
  }
  async function showVideo() {
    if (!videoStream?.getVideoTracks().some(track => track.readyState === 'live')) return;
    const currentStream = videoStream;
    const video = $('remote-video');
    if (video.srcObject !== currentStream) video.srcObject = currentStream;
    renderAudio();
    video.hidden = false; hasVideo = true;
    $('player-placeholder').hidden = true; $('player').classList.add('has-video');
    $('video-overlay').hidden = false; $('fit-button').disabled = false; $('fullscreen-button').disabled = false;
    renderConnection();
    try { await video.play(); if (videoStream === currentStream) $('play-prompt').hidden = true; }
    catch { if (videoStream === currentStream) { $('play-prompt').hidden = false; $('play-button').focus(); } }
  }
  async function handleSignal(payload, epoch) {
    if (!approved || !payload || epoch !== signalEpoch) return;
    if (payload.type === 'offer') {
      if (!sharing || typeof payload.negotiationId !== 'string') return;
      // Offers may replace an old stream when the host changes quality.
      if (negotiationId) retiredNegotiations.add(negotiationId);
      const queued = candidateQueues.get(payload.negotiationId) || [];
      candidateQueues.delete(payload.negotiationId);
      clearVideo(false, true); negotiationId = payload.negotiationId;
      if (!window.RTCPeerConnection) { setPlaceholder('Bu tarayıcı canlı görüntüyü desteklemiyor.', 'Mi Box üzerinde WebRTC destekleyen bir tarayıcı kullanabilirsin. Dosya paylaşımı kullanılabilir.'); return; }
      const generation = offerGeneration;
      const connection = new RTCPeerConnection({ iceServers: [] }); peer = connection;
      const incomingStream = new MediaStream();
      videoStream = incomingStream;
      const currentNegotiation = negotiationId;
      connection.onicecandidate = event => { if (event.candidate && peer === connection) sendSignal({ type: 'candidate', candidate: event.candidate.toJSON(), negotiationId: currentNegotiation }); };
      connection.ontrack = event => {
        if (peer !== connection) return;
        // Each receiver track is added once, including streamless audio tracks.
        // The audio event can arrive before the video event during negotiation.
        if (!incomingStream.getTracks().includes(event.track)) incomingStream.addTrack(event.track);
        const refreshIncoming = () => {
          if (peer !== connection || videoStream !== incomingStream) return;
          renderAudio();
          startReceiverStats(connection, currentNegotiation);
          if (incomingStream.getVideoTracks().some(track => track.readyState === 'live')) void showVideo();
          else {
            hasVideo = false; $('remote-video').hidden = true;
            $('player-placeholder').hidden = false; $('player').classList.remove('has-video');
            $('video-overlay').hidden = true; $('play-prompt').hidden = true;
            $('fit-button').disabled = true; $('fullscreen-button').disabled = true;
            renderConnection();
          }
        };
        event.track.addEventListener('ended', refreshIncoming, { once: true });
        refreshIncoming();
      };
      connection.onconnectionstatechange = () => {
        if (peer !== connection) return;
        if (peerIsConnected(connection)) startReceiverStats(connection, currentNegotiation);
        else stopReceiverStats();
        if (connection.connectionState === 'failed') {
          clearVideo(true); renderConnection();
          setPlaceholder('Görüntü bağlantısı kurulamadı.', 'İki cihazın aynı ağda olduğundan emin ol. Bağlantıyı kesip tekrar bağlanmayı deneyebilirsin.');
          notify('Canlı görüntü bağlantısı kurulamadı.', true);
        }
      };
      connection.oniceconnectionstatechange = () => {
        if (peer !== connection || connection.connectionState) return;
        if (peerIsConnected(connection)) startReceiverStats(connection, currentNegotiation);
        else stopReceiverStats();
      };
      await connection.setRemoteDescription({ type: 'offer', sdp: payload.sdp });
      if (epoch !== signalEpoch || generation !== offerGeneration || peer !== connection) return;
      for (const candidate of queued) await connection.addIceCandidate(candidate);
      await connection.setLocalDescription(await connection.createAnswer());
      if (epoch === signalEpoch && generation === offerGeneration && peer === connection) sendSignal({ type: 'answer', sdp: connection.localDescription.sdp, negotiationId: currentNegotiation });
    } else if (payload.type === 'candidate' && payload.candidate) {
      const id = payload.negotiationId;
      if (!sharing || typeof id !== 'string' || retiredNegotiations.has(id)) return;
      if (id === negotiationId && peer && peer.remoteDescription) await peer.addIceCandidate(payload.candidate);
      else {
        if (!candidateQueues.has(id)) { if (candidateQueues.size >= 8) candidateQueues.delete(candidateQueues.keys().next().value); candidateQueues.set(id, []); }
        const queue = candidateQueues.get(id); if (queue.length < 64) queue.push(payload.candidate);
      }
    } else if (payload.type === 'stop') { sharing = false; clearVideo(true); renderConnection(); }
  }
  function deviceName() {
    const ua = navigator.userAgent;
    if (/TV|AFT|MiBOX|Mi Box|BRAVIA/i.test(ua)) return 'TV tarayıcısı';
    if (/iPhone|iPad/i.test(ua)) return 'iPhone / iPad';
    if (/Android/i.test(ua)) return 'Android tarayıcısı';
    return 'Web tarayıcısı';
  }
  function resetConnection(message) {
    token = null; approved = false; pending = false; sharing = false;
    if (uploadRequest) { uploadCanceled = true; uploadRequest.abort(); }
    clearVideo(true); renderConnection();
    $('download-list').replaceChildren();
    if (message) setPlaceholder('Bağlantı sona erdi.', message);
    else setPlaceholder('Büyük ekrana hoş geldin.', 'Bilgisayarındaki ekranı burada izlemek için bağlan. İsteği Yansı masaüstü uygulamasından onayla.');
  }
  function connect() {
    if (socket || pending) return;
    if (!window.WebSocket) { notify('Bu tarayıcı bağlantı kurmayı desteklemiyor. Güncel bir tarayıcı kullan.', true); return; }
    intentionalClose = false; rejectionMessage = ''; pending = true; renderConnection();
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/signal`); socket = ws;
    ws.onopen = () => { if (socket === ws) ws.send(JSON.stringify({ type: 'hello', name: deviceName() })); };
    ws.onmessage = event => {
      if (socket !== ws) return;
      let message; try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === 'hello') { hostName = message.hostName || hostName; sharing = Boolean(message.sharing); renderConnection(); }
      else if (message.type === 'viewer-pending') { pending = true; renderConnection(); }
      else if (message.type === 'viewer-approved') {
        signalEpoch++; approved = true; pending = false; token = message.token; sharing = Boolean(message.sharing); renderConnection();
        void loadFiles();
        if (!window.RTCPeerConnection) setPlaceholder('Bu tarayıcı canlı görüntüyü desteklemiyor.', 'WebRTC destekleyen bir tarayıcı ile tekrar dene. Dosya paylaşımı kullanılabilir.');
        // Host initiates the offer after approval; no duplicate renegotiation needed.
      } else if (message.type === 'signal') {
        const epoch = signalEpoch;
        signalChain = signalChain.then(() => socket === ws && epoch === signalEpoch ? handleSignal(message.payload, epoch) : undefined).catch(error => {
          if (epoch !== signalEpoch || socket !== ws || !approved || !sharing) return;
          console.warn('Görüntü bağlantısı işlenemedi', error); notify('Görüntü bağlantısı kurulamadı. Yeniden bağlanmayı deneyebilirsin.', true);
        });
      } else if (message.type === 'sharing-changed') {
        sharing = Boolean(message.sharing);
        if (!sharing) clearVideo(true); renderConnection();
      } else if (message.type === 'files-changed') { if (approved) renderFiles(message.files || []); }
      else if (message.type === 'viewer-rejected') { rejectionMessage = message.message || 'Bilgisayar bu bağlantıya izin vermedi.'; }
      else if (message.type === 'viewer-disconnected') { rejectionMessage = message.message || 'Bilgisayar bağlantıyı sonlandırdı.'; }
      else if (message.type === 'error') notify(message.message || message.error || 'Bir bağlantı hatası oluştu.', true);
    };
    ws.onclose = event => {
      if (socket !== ws) return;
      socket = null;
      const reason = intentionalClose ? '' : rejectionMessage || event.reason || 'Bilgisayar bağlantıyı kapatmış veya ağ bağlantısı kesilmiş olabilir. Tekrar bağlanabilirsin.';
      resetConnection(reason);
    };
    ws.onerror = () => { if (socket === ws) notify('Bilgisayara ulaşılamadı. Yerel ağ bağlantısını kontrol et.', true); };
    renderConnection();
  }
  function disconnect() {
    intentionalClose = true;
    const previous = socket; socket = null; previous?.close(1000, 'Kullanıcı bağlantıyı kesti');
    resetConnection(); $('connect-button').focus();
  }

  function humanSize(size) {
    if (!Number.isFinite(size)) return '';
    if (size < 1024) return `${size} B`;
    const units = ['KB', 'MB', 'GB', 'TB']; let value = size / 1024, unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
    return `${value.toLocaleString('tr-TR', { maximumFractionDigits: 1 })} ${units[unit]}`;
  }
  function renderFiles(files) {
    const list = $('download-list'); list.replaceChildren();
    if (!files.length) { const p = document.createElement('p'); p.className = 'empty-files'; p.textContent = 'Bilgisayardan henüz dosya paylaşılmadı.'; list.append(p); return; }
    for (const file of files) {
      const item = document.createElement('div'); item.className = 'download-item';
      const badge = document.createElement('span'); badge.className = 'download-icon'; badge.innerHTML = icon('file');
      const info = document.createElement('div'); info.className = 'download-info';
      const name = document.createElement('strong'); name.textContent = file.name;
      const size = document.createElement('span'); size.textContent = humanSize(file.size); info.append(name, size);
      const link = document.createElement('a'); link.className = 'button subtle';
      link.href = `/api/files/${encodeURIComponent(file.id)}?token=${encodeURIComponent(token)}`;
      link.download = file.name; link.referrerPolicy = 'no-referrer';
      link.innerHTML = `${icon('download')}İndir`; link.setAttribute('aria-label', `${file.name} dosyasını indir`);
      item.append(badge, info, link); list.append(item);
    }
  }
  async function loadFiles() {
    if (!token) return;
    try {
      const response = await fetch('/api/files', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Dosyalar alınamadı.');
      if (approved) renderFiles(result.files || []);
    } catch (error) { if (approved) notify(error.message || 'Dosyalar alınamadı.', true); }
  }
  function uploadFile(file, index, total) {
    return new Promise((resolve, reject) => {
      if (!token || uploadCanceled) { reject(new Error('Gönderim iptal edildi.')); return; }
      const xhr = new XMLHttpRequest(); uploadRequest = xhr;
      xhr.open('POST', `/api/uploads?name=${encodeURIComponent(file.name)}`);
      xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      $('upload-label').textContent = `${file.name}${total > 1 ? ` (${index + 1}/${total})` : ''}`;
      $('upload-progress').value = 0; $('upload-percent').textContent = 'Gönderiliyor…';
      xhr.upload.onprogress = event => { if (event.lengthComputable) { const percent = Math.round(event.loaded / event.total * 100); $('upload-progress').value = percent; $('upload-percent').textContent = percent === 100 ? 'Bilgisayara kaydediliyor…' : `%${percent}`; } };
      xhr.onload = () => {
        uploadRequest = null;
        let result; try { result = JSON.parse(xhr.responseText); } catch { result = {}; }
        if (xhr.status >= 200 && xhr.status < 300) resolve(result.file);
        else reject(new Error(result.error || 'Dosya gönderilemedi.'));
      };
      xhr.onerror = () => { uploadRequest = null; reject(new Error('Dosya gönderilirken bağlantı kesildi.')); };
      xhr.onabort = () => { uploadRequest = null; reject(new Error('Gönderim iptal edildi.')); };
      xhr.send(file);
    });
  }
  async function uploadFiles(files) {
    if (!approved || !token || uploadRunning || !files.length) return;
    uploadRunning = true; uploadCanceled = false;
    $('upload-state').hidden = false; $('select-upload').disabled = true; $('upload-result').textContent = ''; $('upload-result').classList.remove('error');
    let completed = 0;
    try {
      for (let index = 0; index < files.length; index++) { await uploadFile(files[index], index, files.length); completed++; }
      $('upload-result').textContent = `${completed} dosya bilgisayarına gönderildi.`;
      await loadFiles();
    } catch (error) {
      $('upload-result').textContent = `${completed ? `${completed} dosya gönderildi. ` : ''}${error.message || 'Dosya gönderilemedi.'}`;
      $('upload-result').classList.toggle('error', !uploadCanceled);
    } finally { uploadRunning = false; $('upload-state').hidden = true; $('select-upload').disabled = false; $('upload-input').value = ''; }
  }

  function showFiles(show) {
    $('files-panel').hidden = !show; $('files-toggle').setAttribute('aria-expanded', String(show));
    if (show) { $('files-panel').scrollIntoView({ behavior: 'smooth', block: 'start' }); $('close-files').focus({ preventScroll: true }); }
    else { $('files-toggle').focus(); }
  }
  $('connect-button').addEventListener('click', connect);
  $('disconnect-button').addEventListener('click', disconnect);
  $('files-toggle').addEventListener('click', () => showFiles($('files-panel').hidden));
  $('close-files').addEventListener('click', () => showFiles(false));
  $('refresh-files').addEventListener('click', () => void loadFiles());
  $('select-upload').addEventListener('click', () => $('upload-input').click());
  $('upload-input').addEventListener('change', event => { void uploadFiles([...event.target.files]); });
  $('cancel-upload').addEventListener('click', () => { uploadCanceled = true; uploadRequest?.abort(); });
  $('play-button').addEventListener('click', () => void showVideo());
  $('audio-button').addEventListener('click', async () => {
    if (!hasIncomingAudio()) return;
    const currentStream = videoStream;
    const enabled = !audioEnabled;
    audioEnabled = enabled; renderAudio();
    try {
      // This call stays within the user's click / TV remote OK gesture.
      await $('remote-video').play();
      if (videoStream === currentStream) $('play-prompt').hidden = true;
    } catch {
      if (videoStream !== currentStream) return;
      audioEnabled = false; renderAudio();
      notify('Ses başlatılamadı. TV tarayıcısında “Sesi aç” düğmesine tekrar bas.', true);
      if ($('remote-video').paused && hasVideo) $('play-prompt').hidden = false;
    }
  });
  $('fit-button').addEventListener('click', () => {
    fill = !fill; $('player').classList.toggle('fill', fill);
    $('fit-button').innerHTML = `${icon('fit')}${fill ? 'Ekrana sığdır' : 'Ekranı doldur'}`;
  });
  $('fullscreen-button').addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if ($('player').requestFullscreen) await $('player').requestFullscreen();
      else if ($('remote-video').webkitEnterFullscreen) $('remote-video').webkitEnterFullscreen();
      else notify('Bu tarayıcı tam ekranı desteklemiyor. TV tarayıcısının tam ekran seçeneğini kullanabilirsin.', true);
    } catch { notify('Tam ekran açılamadı. Tarayıcının tam ekran seçeneğini kullanabilirsin.', true); }
  });
  document.addEventListener('fullscreenchange', () => { $('fullscreen-button').innerHTML = `${icon('fullscreen')}${document.fullscreenElement ? 'Tam ekrandan çık' : 'Tam ekran'}`; });

  // TV remotes send arrow keys; geometric navigation also works without a mouse.
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !$('files-panel').hidden && !document.fullscreenElement) { event.preventDefault(); showFiles(false); return; }
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
    const controls = [...document.querySelectorAll('button:not(:disabled),a[href]')].filter(element => !element.closest('[hidden]') && element.getClientRects().length);
    if (!controls.length) return;
    const active = document.activeElement;
    if (!controls.includes(active)) { event.preventDefault(); controls[0].focus(); return; }
    const from = active.getBoundingClientRect(); const fromX = from.left + from.width / 2, fromY = from.top + from.height / 2;
    let best = null, bestScore = Infinity;
    for (const control of controls) {
      if (control === active) continue;
      const rect = control.getBoundingClientRect(); const dx = rect.left + rect.width / 2 - fromX, dy = rect.top + rect.height / 2 - fromY;
      let forward, cross;
      if (event.key === 'ArrowRight') { forward = dx; cross = Math.abs(dy); }
      else if (event.key === 'ArrowLeft') { forward = -dx; cross = Math.abs(dy); }
      else if (event.key === 'ArrowDown') { forward = dy; cross = Math.abs(dx); }
      else { forward = -dy; cross = Math.abs(dx); }
      if (forward <= 8) continue;
      const score = forward + cross * 2.5;
      if (score < bestScore) { bestScore = score; best = control; }
    }
    if (best) { event.preventDefault(); best.focus(); }
  });
  window.addEventListener('beforeunload', () => { stopReceiverStats(); uploadRequest?.abort(); socket?.close(); peer?.close(); });
  fetch('/api/status', { cache: 'no-store' }).then(response => response.ok ? response.json() : null).then(info => { if (info) { hostName = info.hostName || ''; renderConnection(); } }).catch(() => {});
  renderConnection();
  renderAudio();
  $('connect-button').focus({ preventScroll: true });
})();

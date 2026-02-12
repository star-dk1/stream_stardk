/* ═══════════════════════════════════════════════════════════════
   Viewer.js — PeerJS stream reception + Socket.IO chat
   FIXED: autoplay, PeerJS port, dummy stream, volume controls
   ═══════════════════════════════════════════════════════════════ */

(function () {
    'use strict';

    // ── State ──────────────────────────────────────────────────
    let socket = null;
    let peer = null;
    let peerReady = false;
    let currentCall = null;
    let viewerUsername = '';
    let isConnected = false;
    let pendingAdminPeerId = null; // store peerId if peer isn't ready yet
    let isMuted = true; // start muted for autoplay compliance

    // ── DOM ────────────────────────────────────────────────────
    const usernameModal = document.getElementById('username-modal');
    const usernameForm = document.getElementById('username-form');
    const usernameInput = document.getElementById('viewer-username');
    const remoteVideo = document.getElementById('remote-video');
    const videoOverlay = document.getElementById('video-overlay');
    const videoControls = document.getElementById('video-controls');
    const btnUnmute = document.getElementById('btn-unmute');
    const volumeSliderWrap = document.getElementById('volume-slider-wrap');
    const volumeSlider = document.getElementById('volume-slider');
    const volumeLevel = document.getElementById('volume-level');
    const btnMuteToggle = document.getElementById('btn-mute-toggle');
    const streamBadge = document.getElementById('stream-badge');
    const streamBadge2 = document.getElementById('stream-badge-2');
    const viewerCountNum = document.getElementById('viewer-count-num');
    const chatCountNum = document.getElementById('chat-count-num');
    const streamTitle = document.getElementById('stream-title');
    const chatMessages = document.getElementById('chat-messages');
    const chatInput = document.getElementById('chat-input');
    const chatSend = document.getElementById('chat-send');

    // ── Volume Controls ────────────────────────────────────────

    // Big "Activate Sound" button (shows on first stream)
    btnUnmute.addEventListener('click', () => {
        remoteVideo.muted = false;
        remoteVideo.volume = 1;
        isMuted = false;
        btnUnmute.style.display = 'none';
        volumeSliderWrap.style.display = 'flex';
        btnMuteToggle.style.display = 'inline-flex';
        btnMuteToggle.textContent = '🔊 Sonido ON';
        volumeSlider.value = 100;
        volumeLevel.textContent = '100%';
        // Try playing again after user interaction
        remoteVideo.play().catch(e => console.warn('Play after unmute:', e));
    });

    // Small mute toggle in info bar
    btnMuteToggle.addEventListener('click', () => {
        if (isMuted) {
            remoteVideo.muted = false;
            remoteVideo.volume = volumeSlider.value / 100;
            isMuted = false;
            btnMuteToggle.textContent = '🔊 Sonido ON';
            btnUnmute.style.display = 'none';
            volumeSliderWrap.style.display = 'flex';
        } else {
            remoteVideo.muted = true;
            isMuted = true;
            btnMuteToggle.textContent = '🔇 Sonido OFF';
        }
    });

    // Volume slider
    volumeSlider.addEventListener('input', () => {
        const vol = volumeSlider.value / 100;
        remoteVideo.volume = vol;
        volumeLevel.textContent = volumeSlider.value + '%';
        if (vol === 0) {
            remoteVideo.muted = true;
            isMuted = true;
            btnMuteToggle.textContent = '🔇 Sonido OFF';
        } else if (isMuted) {
            remoteVideo.muted = false;
            isMuted = false;
            btnMuteToggle.textContent = '🔊 Sonido ON';
        }
    });

    // ── Check saved username ───────────────────────────────────
    const savedUsername = localStorage.getItem('streamvibe_viewer_name');
    if (savedUsername) {
        viewerUsername = savedUsername;
        usernameModal.classList.add('hidden');
        initConnection();
    }

    // ── Username Form ──────────────────────────────────────────
    usernameForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const name = usernameInput.value.trim();
        if (name.length < 1 || name.length > 20) return;

        viewerUsername = name;
        localStorage.setItem('streamvibe_viewer_name', name);
        usernameModal.classList.add('hidden');
        initConnection();
    });

    // ── Initialize Connection ──────────────────────────────────
    function initConnection() {
        initSocket();
        initPeer();
        enableChat();
        updateChatStatus('connecting');
    }

    // ── Socket.IO ──────────────────────────────────────────────
    function initSocket() {
        socket = io({
            reconnectionAttempts: Infinity,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
        });

        socket.on('connect', () => {
            console.log('[SOCKET] Connected:', socket.id);
            isConnected = true;
            updateChatStatus('connected');
            socket.emit('join-stream', { username: viewerUsername });
        });

        socket.on('disconnect', () => {
            console.log('[SOCKET] Disconnected');
            isConnected = false;
            updateChatStatus('disconnected');
        });

        socket.on('reconnect', () => {
            console.log('[SOCKET] Reconnected');
            isConnected = true;
            updateChatStatus('connected');
            socket.emit('join-stream', { username: viewerUsername });
        });

        // Stream status on join — server sends current state immediately
        socket.on('stream-status', (data) => {
            console.log('[STREAM] Status received:', data);
            if (data.isLive && data.adminPeerId) {
                setLiveState(data.title || 'Live Stream');
                tryConnectToPeer(data.adminPeerId);
            } else {
                setOfflineState();
            }
        });

        // Stream started — admin just went live (no reload needed!)
        socket.on('stream-started', (data) => {
            console.log('[STREAM] 🔴 Started! PeerId:', data.adminPeerId);
            showToast('🔴 ¡El stream ha comenzado!', 'success');
            setLiveState(data.title || 'Live Stream');
            tryConnectToPeer(data.adminPeerId);
        });

        // Stream ended
        socket.on('stream-ended', () => {
            console.log('[STREAM] ⬛ Ended');
            showToast('⬛ El stream ha terminado', 'error');
            setOfflineState();
            if (currentCall) {
                currentCall.close();
                currentCall = null;
            }
            remoteVideo.srcObject = null;
            videoControls.style.display = 'none';
            btnMuteToggle.style.display = 'none';
        });

        // Viewer count
        socket.on('viewer-count', (count) => {
            viewerCountNum.textContent = count;
            chatCountNum.textContent = count;
        });

        // Chat history
        socket.on('chat-history', (messages) => {
            chatMessages.innerHTML = '';
            messages.forEach(addChatMessage);
        });

        // Chat message
        socket.on('chat-message', (msg) => {
            addChatMessage(msg);
        });

        // Title update
        socket.on('title-updated', (data) => {
            streamTitle.textContent = data.title;
        });
    }

    // ── PeerJS ─────────────────────────────────────────────────
    // ── PeerJS ─────────────────────────────────────────────────
    function initPeer() {
        console.log('[PEER] Initializing PeerJS...');
        updateVideoOverlay('Inicializando conexión P2P...');

        // FIXED: Don't specify port explicitly — let PeerJS use the default
        // On Render (HTTPS/443) or localhost, this auto-resolves correctly
        const peerConfig = {
            host: window.location.hostname,
            port: window.location.port ? parseInt(window.location.port) : (window.location.protocol === 'https:' ? 443 : 80),
            path: '/peerjs',
            secure: window.location.protocol === 'https:',
            debug: 1,
            config: {
                iceServers: [
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'stun:stun1.l.google.com:19302' },
                    { urls: 'stun:stun2.l.google.com:19302' },
                    { urls: 'stun:stun3.l.google.com:19302' },
                    { urls: 'stun:stun4.l.google.com:19302' },
                ],
            },
        };

        peer = new Peer(undefined, peerConfig);
        peerReady = false;

        peer.on('open', (id) => {
            console.log('[PEER] My ID:', id);
            peerReady = true;
            updateVideoOverlay('Conectado al servidor de señalización.');

            // If we received a stream-started event before peer was ready, connect now
            if (pendingAdminPeerId) {
                console.log('[PEER] Connecting to pending admin:', pendingAdminPeerId);
                connectToPeer(pendingAdminPeerId);
                pendingAdminPeerId = null;
            }
        });

        peer.on('error', (err) => {
            console.error('[PEER] Error:', err.type, err);
            peerReady = false;
            updateVideoOverlay(`Error de conexión: ${err.type}`);

            if (err.type === 'peer-unavailable') {
                console.log('[PEER] Streamer unavailable, retrying...');
                updateVideoOverlay('Buscando al streamer...');
            } else if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error' || err.type === 'negotiation-failed') {
                updateVideoOverlay('Reconectando al servidor...');
                // Hard reset for critical errors
                hardResetPeer();
            }
        });


        peer.on('disconnected', () => {
            console.log('[PEER] Disconnected, reconnecting...');
            peerReady = false;
            updateVideoOverlay('Reconectando...');
            setTimeout(() => {
                if (peer && !peer.destroyed) {
                    peer.reconnect();
                }
            }, 2000);
        });

        peer.on('close', () => {
            console.log('[PEER] Closed');
            peerReady = false;
        });
    }

    // ── Try connect (waits for peer if needed) ─────────────────
    let connectionDebounce = null;
    function tryConnectToPeer(adminPeerId) {
        if (connectionDebounce) clearTimeout(connectionDebounce);

        connectionDebounce = setTimeout(() => {
            if (peerReady) {
                connectToPeer(adminPeerId);
            } else {
                console.log('[PEER] Not ready yet, queuing connection to:', adminPeerId);
                updateVideoOverlay('Esperando conexión P2P...');
                pendingAdminPeerId = adminPeerId;
            }
        }, 500);
    }

    function hardResetPeer() {
        console.warn('[PEER] Performing HARD RESET...');
        if (peer && !peer.destroyed) {
            peer.destroy();
        }
        peer = null;
        peerReady = false;
        setTimeout(initPeer, 1000);
    }


    // ── Connect to admin peer ─────────────────────────────────
    function connectToPeer(adminPeerId) {
        if (!peer || peer.destroyed) {
            console.warn('[PEER] Destroyed, reinitializing...');
            pendingAdminPeerId = adminPeerId;
            initPeer();
            return;
        }

        if (!peerReady) {
            console.warn('[PEER] Not open, queuing...');
            pendingAdminPeerId = adminPeerId;
            return;
        }

        // Close existing call
        if (currentCall) {
            currentCall.close();
            currentCall = null;
        }

        console.log('[PEER] Calling admin:', adminPeerId);
        updateVideoOverlay('Solicitando stream de video...');

        // FIXED: Use a minimal canvas-only dummy stream (no AudioContext needed)
        // This avoids AudioContext suspension issues in browsers
        const dummyStream = createDummyStream();
        const call = peer.call(adminPeerId, dummyStream);

        if (!call) {
            console.error('[PEER] Call returned null, retrying in 3s...');
            updateVideoOverlay('Error al llamar, reintentando...');
            setTimeout(() => connectToPeer(adminPeerId), 3000);
            return;
        }

        currentCall = call;

        call.on('stream', (remoteStream) => {
            console.log('[PEER] ✅ Receiving stream!', remoteStream.id, remoteStream.getTracks().map(t => t.kind + ':' + t.readyState));

            // Prevent duplicate stream handling causing AbortError
            if (remoteVideo.srcObject && remoteVideo.srcObject.id === remoteStream.id) {
                console.log('[PEER] Recurring stream event for same ID, ignoring.');
                return;
            }

            updateVideoOverlay('¡Recibiendo video!');

            remoteVideo.srcObject = remoteStream;

            // DEBUG: Enable controls to see timeline/buffering
            remoteVideo.controls = true;

            // Video starts muted (autoplay OK)
            remoteVideo.muted = true;
            isMuted = true;

            // Debugging events
            remoteVideo.onloadedmetadata = () => {
                console.log(`[VIDEO] Metadata loaded. Size: ${remoteVideo.videoWidth}x${remoteVideo.videoHeight}`);
                showToast(`Video dim: ${remoteVideo.videoWidth}x${remoteVideo.videoHeight}`);
            };

            remoteVideo.onresize = () => {
                console.log(`[VIDEO] Resized to: ${remoteVideo.videoWidth}x${remoteVideo.videoHeight}`);
            };

            const playPromise = remoteVideo.play();
            if (playPromise !== undefined) {
                playPromise
                    .then(() => {
                        console.log('[VIDEO] Playing successfully (muted)');
                        videoOverlay.style.display = 'none';
                        videoOverlay.classList.add('hidden');

                        videoControls.style.display = 'flex';
                        btnUnmute.style.display = 'flex';
                        btnMuteToggle.style.display = 'inline-flex';
                        btnMuteToggle.textContent = '🔇 Sonido OFF';
                        volumeSliderWrap.style.display = 'none';
                    })
                    .catch(e => {
                        if (e.name === 'AbortError') {
                            console.log('[VIDEO] Play request aborted (likely new stream loaded).');
                        } else {
                            console.warn('[VIDEO] Autoplay failed:', e);
                            // Show click-to-play
                            videoOverlay.style.display = 'flex';
                            videoOverlay.classList.remove('hidden');
                            videoOverlay.innerHTML = `
                                <div class="offline-icon" style="cursor:pointer;" id="click-to-play">▶️</div>
                                <div class="offline-text">Haz clic para ver el stream</div>
                            `;
                            // Use functional handler to avoid old listener issues
                            const btn = document.getElementById('click-to-play');
                            if (btn) btn.onclick = () => {
                                remoteVideo.play();
                                videoOverlay.style.display = 'none';
                            };
                        }
                    });
            }

            // Monitor track state
            remoteStream.getTracks().forEach(track => {
                track.onended = () => {
                    console.log('[PEER] Track ended:', track.kind);
                };
            });
        });

        call.on('close', () => {
            console.log('[PEER] Call closed');
            currentCall = null;
        });

        call.on('error', (err) => {
            console.error('[PEER] Call error:', err);
            updateVideoOverlay('Error en la llamada: ' + err.type);
            currentCall = null;
            // Retry connection
            setTimeout(() => {
                fetch('/api/stream-status')
                    .then(r => r.json())
                    .then(data => {
                        if (data.isLive && data.adminPeerId) {
                            connectToPeer(data.adminPeerId);
                        }
                    })
                    .catch(() => { });
            }, 3000);
        });
    }

    // ── Create dummy stream (Canvas + Silent Audio) ────────────
    function createDummyStream() {
        // 1. Canvas Video Track (keep it black/small)
        const canvas = document.createElement('canvas');
        canvas.width = 10;
        canvas.height = 10;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, 10, 10);
        const stream = canvas.captureStream(10); // 10 FPS

        // 2. Silent Audio Track (Forces SDP to include audio m-line)
        try {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            if (AudioContext) {
                const audioCtx = new AudioContext();
                const oscillator = audioCtx.createOscillator();
                const dest = audioCtx.createMediaStreamDestination();

                oscillator.connect(dest);
                // Zero frequency or gain 0 doesn't matter much if it's dummy, 
                // but let's keep it standard. Valid track is what matters.
                oscillator.start();

                const audioTrack = dest.stream.getAudioTracks()[0];
                if (audioTrack) {
                    stream.addTrack(audioTrack);
                    console.log('[DUMMY] Added silent audio track for negotiation');
                }
            }
        } catch (e) {
            console.warn('[DUMMY] Could not create dummy audio track:', e);
        }

        return stream;
    }

    // Helper to update overlay text without replacing the whole HTML structure if possible
    function updateVideoOverlay(text) {
        // Only update the subtext part if overlay is visible
        if (!videoOverlay.classList.contains('hidden')) {
            const subtext = videoOverlay.querySelector('.offline-subtext');
            if (subtext) subtext.textContent = text;
        }
    }

    // ── Chat ───────────────────────────────────────────────────
    function enableChat() {
        chatInput.disabled = false;
        chatSend.disabled = false;
        chatInput.placeholder = 'Escribe un mensaje...';
    }

    function updateChatStatus(status) {
        if (status === 'connected') {
            chatInput.disabled = false;
            chatSend.disabled = false;
            chatInput.placeholder = 'Escribe un mensaje...';
        } else if (status === 'disconnected') {
            chatInput.placeholder = '⚠️ Reconectando...';
            // Don't disable — socket.io will reconnect
        } else if (status === 'connecting') {
            chatInput.placeholder = '🔄 Conectando al chat...';
        }
    }

    chatSend.addEventListener('click', sendMessage);
    chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    function sendMessage() {
        const text = chatInput.value.trim();
        if (!text) return;

        // Check socket connection directly (not the flag)
        if (!socket || !socket.connected) {
            showToast('⚠️ Reconectando al chat...', 'error');
            return;
        }

        socket.emit('chat-message', {
            text,
            username: viewerUsername,
            isAdmin: false,
        });

        chatInput.value = '';
        chatInput.focus();
    }

    function addChatMessage(msg) {
        // Auto-scroll only if user is near the bottom (Twitch behavior)
        const isNearBottom = chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight < 80;

        const div = document.createElement('div');
        div.className = `chat-message ${msg.type}`;

        if (msg.type === 'system') {
            div.textContent = msg.text;
        } else {
            div.innerHTML = `<span class="chat-username">${escapeHtml(msg.username)}</span><span class="chat-text">${escapeHtml(msg.text)}</span>`;
        }

        chatMessages.appendChild(div);

        // Limit DOM messages to 200 (performance like Twitch)
        while (chatMessages.children.length > 200) {
            chatMessages.removeChild(chatMessages.firstChild);
        }

        if (isNearBottom) {
            chatMessages.scrollTop = chatMessages.scrollHeight;
        }
    }

    // ── UI State ───────────────────────────────────────────────
    function setLiveState(title) {
        streamBadge.className = 'live-badge';
        streamBadge.innerHTML = '<span class="dot"></span> LIVE';
        streamBadge2.className = 'live-badge';
        streamBadge2.innerHTML = '<span class="dot"></span> LIVE';
        streamTitle.textContent = title;
    }

    function setOfflineState() {
        streamBadge.className = 'offline-badge';
        streamBadge.innerHTML = '<span>OFFLINE</span>';
        streamBadge2.className = 'offline-badge';
        streamBadge2.innerHTML = '<span>OFFLINE</span>';
        streamTitle.textContent = 'Stream Offline';
        videoOverlay.classList.remove('hidden');
        // Restore original overlay content
        videoOverlay.innerHTML = `
      <div class="offline-icon">📡</div>
      <div class="offline-text">Stream Offline</div>
      <div class="offline-subtext">Esperando a que el administrador inicie la transmisión...</div>
      <div class="spinner" style="margin-top:20px; opacity:0.3;"></div>
    `;
    }

    // ── Helpers ────────────────────────────────────────────────
    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function showToast(message, type = 'info') {
        const container = document.getElementById('toast-container');
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;
        container.appendChild(toast);
        setTimeout(() => {
            toast.style.animation = 'toastOut 0.3s ease-in forwards';
            setTimeout(() => toast.remove(), 300);
        }, 4000);
    }
})();

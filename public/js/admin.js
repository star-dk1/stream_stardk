/* ═══════════════════════════════════════════════════════════════
   Admin.js — Camera/Screen/MP4 Streaming + PeerJS + Socket.IO
   FIXED: PeerJS peer readiness, stream serving, connection handling
   ═══════════════════════════════════════════════════════════════ */

(function () {
    'use strict';

    // ── State ──────────────────────────────────────────────────
    let socket = null;
    let peer = null;
    let peerReady = false;
    let activeStream = null;
    let isStreaming = false;
    let currentSource = 'camera'; // camera | screen | video
    let activePeerCalls = new Map(); // peerId -> call
    let mp4AnimFrame = null;
    let mp4AudioCtx = null;
    let adminUsername = '';
    let ADMIN_PEER_ID = '';

    // ── DOM ────────────────────────────────────────────────────
    const loadingOverlay = document.getElementById('loading-overlay');
    const adminGreeting = document.getElementById('admin-greeting');
    const previewVideo = document.getElementById('preview-video');
    const previewPlaceholder = document.getElementById('preview-placeholder');
    const streamStatusBadge = document.getElementById('stream-status-badge');
    const viewerCountNum = document.getElementById('viewer-count-num');
    const chatCountNum = document.getElementById('chat-count-num');
    const chatMessages = document.getElementById('chat-messages');
    const chatInput = document.getElementById('chat-input');
    const chatSend = document.getElementById('chat-send');
    const statusBar = document.getElementById('status-bar');
    const btnStartStream = document.getElementById('btn-start-stream');
    const btnStopStream = document.getElementById('btn-stop-stream');
    const streamTitleInput = document.getElementById('stream-title-input');
    const logoutBtn = document.getElementById('logout-btn');

    // Source tabs
    const sourceTabs = document.querySelectorAll('.source-tab');

    // Source panels
    const panelCamera = document.getElementById('panel-camera');
    const panelScreen = document.getElementById('panel-screen');
    const panelVideo = document.getElementById('panel-video');

    // Camera
    const btnGetCamera = document.getElementById('btn-get-camera');
    const cameraSelect = document.getElementById('camera-select');

    // Screen
    const btnGetScreen = document.getElementById('btn-get-screen');

    // Video MP4
    const videoFileInput = document.getElementById('video-file-input');
    const videoFilename = document.getElementById('video-filename');
    const mp4SourceVideo = document.getElementById('mp4-source-video');
    const mp4Canvas = document.getElementById('mp4-canvas');

    // ── Auth Guard ─────────────────────────────────────────────
    (async function checkAuth() {
        const token = localStorage.getItem('streamvibe_token');
        if (!token) {
            window.location.href = '/';
            return;
        }

        try {
            const res = await fetch('/api/verify', {
                headers: { 'Authorization': `Bearer ${token}` },
            });

            if (!res.ok) {
                localStorage.removeItem('streamvibe_token');
                localStorage.removeItem('streamvibe_username');
                window.location.href = '/';
                return;
            }

            const data = await res.json();
            adminUsername = data.user.username;
            adminGreeting.textContent = `Hola, ${adminUsername} 👋`;

            // Generate a stable peer ID based on username
            ADMIN_PEER_ID = 'streamvibe-admin-' + adminUsername.toLowerCase();

            // Hide loading, init
            loadingOverlay.style.display = 'none';
            initSocket();
            initPeer();
            loadCameraDevices();
        } catch (err) {
            console.error('Auth check failed:', err);
            window.location.href = '/';
        }
    })();

    // ── Socket.IO ──────────────────────────────────────────────
    function initSocket() {
        socket = io({
            transports: ['websocket', 'polling'],
            reconnectionAttempts: Infinity,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
        });

        socket.on('connect', () => {
            console.log('[SOCKET] Admin connected:', socket.id);
            socket.emit('join-stream', { username: '🔴 ADMIN' });
            // Enable chat on connect
            chatInput.disabled = false;
            chatSend.disabled = false;
            chatInput.placeholder = 'Mensaje como ADMIN...';
        });

        socket.on('viewer-count', (count) => {
            viewerCountNum.textContent = count;
            chatCountNum.textContent = count;
        });

        socket.on('chat-history', (messages) => {
            chatMessages.innerHTML = '';
            messages.forEach(addChatMessage);
        });

        socket.on('chat-message', (msg) => {
            addChatMessage(msg);
        });

        socket.on('disconnect', () => {
            console.log('[SOCKET] Disconnected');
            chatInput.placeholder = '⚠️ Reconectando...';
        });

        socket.on('reconnect', () => {
            console.log('[SOCKET] Reconnected');
            socket.emit('join-stream', { username: '🔴 ADMIN' });
            // Re-announce stream if it was live
            if (isStreaming && ADMIN_PEER_ID) {
                socket.emit('stream-started', {
                    peerId: ADMIN_PEER_ID,
                    title: streamTitleInput.value || 'Live Stream',
                });
            }
        });
    }

    // ── PeerJS ─────────────────────────────────────────────────
    function initPeer() {
        // Destroy old peer if exists
        if (peer && !peer.destroyed) {
            peer.destroy();
        }

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

        peer = new Peer(ADMIN_PEER_ID, peerConfig);
        peerReady = false;

        peer.on('open', (id) => {
            console.log('[PEER] ✅ Admin Peer OPEN. ID:', id);
            peerReady = true;
        });

        // When a viewer calls us, answer with our active stream
        peer.on('call', (call) => {
            console.log('[PEER] 📞 Incoming call from:', call.peer);

            if (isStreaming && activeStream) {
                // Verify stream has live tracks
                const liveTracks = activeStream.getTracks().filter(t => t.readyState === 'live');
                console.log('[PEER] Answering with', liveTracks.length, 'live tracks');

                if (liveTracks.length > 0) {
                    call.answer(activeStream);
                    activePeerCalls.set(call.peer, call);

                    call.on('close', () => {
                        console.log('[PEER] Call closed:', call.peer);
                        activePeerCalls.delete(call.peer);
                    });

                    call.on('error', (err) => {
                        console.error('[PEER] Call error:', call.peer, err);
                        activePeerCalls.delete(call.peer);
                    });
                } else {
                    console.warn('[PEER] No live tracks, rejecting call');
                    call.close();
                }
            } else {
                console.log('[PEER] Not streaming, rejecting call from:', call.peer);
                // Answer with nothing so the viewer's call.on('stream') doesn't hang
                try { call.close(); } catch (e) { }
            }
        });

        peer.on('error', (err) => {
            console.error('[PEER] Error:', err.type, err);
            peerReady = false;
            if (err.type === 'unavailable-id') {
                showToast('Peer ID en uso. Reintentando con nuevo ID...', 'error');
                ADMIN_PEER_ID = 'streamvibe-admin-' + adminUsername.toLowerCase() + '-' + Date.now().toString(36);
                setTimeout(() => initPeer(), 2000);
            } else if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error') {
                setTimeout(() => initPeer(), 3000);
            }
        });

        peer.on('disconnected', () => {
            console.log('[PEER] Disconnected, reconnecting...');
            peerReady = false;
            setTimeout(() => {
                if (peer && !peer.destroyed) {
                    peer.reconnect();
                } else {
                    initPeer();
                }
            }, 2000);
        });

        peer.on('close', () => {
            console.log('[PEER] Closed');
            peerReady = false;
        });
    }

    // ── Source Tab Switching ───────────────────────────────────
    sourceTabs.forEach((tab) => {
        tab.addEventListener('click', () => {
            if (isStreaming) {
                showToast('Detén el stream antes de cambiar la fuente', 'error');
                return;
            }

            const source = tab.dataset.source;
            currentSource = source;

            // Update tabs
            sourceTabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');

            // Update panels
            panelCamera.classList.remove('active');
            panelScreen.classList.remove('active');
            panelVideo.classList.remove('active');

            if (source === 'camera') panelCamera.classList.add('active');
            if (source === 'screen') panelScreen.classList.add('active');
            if (source === 'video') panelVideo.classList.add('active');

            // Reset preview
            stopCurrentStream();
            previewPlaceholder.style.display = 'flex';
            btnStartStream.disabled = true;
        });
    });

    // ═══════════════════════════════════════════════════════════
    //  CAMERA MODE
    // ═══════════════════════════════════════════════════════════

    async function loadCameraDevices() {
        try {
            const tempStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
            tempStream.getTracks().forEach(t => t.stop());

            const devices = await navigator.mediaDevices.enumerateDevices();
            const videoDevices = devices.filter(d => d.kind === 'videoinput');

            cameraSelect.innerHTML = '<option value="">Seleccionar cámara...</option>';
            videoDevices.forEach((device, i) => {
                const option = document.createElement('option');
                option.value = device.deviceId;
                option.textContent = device.label || `Cámara ${i + 1}`;
                cameraSelect.appendChild(option);
            });
        } catch (err) {
            console.warn('Could not enumerate devices:', err);
        }
    }

    btnGetCamera.addEventListener('click', async () => {
        try {
            stopCurrentStream();

            const constraints = {
                video: cameraSelect.value
                    ? { deviceId: { exact: cameraSelect.value }, width: { ideal: 1280 }, height: { ideal: 720 } }
                    : { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
                audio: true,
            };

            activeStream = await navigator.mediaDevices.getUserMedia(constraints);
            setPreview(activeStream);
            btnStartStream.disabled = false;
            showToast('📷 Cámara activada', 'success');
        } catch (err) {
            console.error('Camera error:', err);
            showToast('Error al acceder a la cámara: ' + err.message, 'error');
        }
    });

    // ═══════════════════════════════════════════════════════════
    //  SCREEN MODE
    // ═══════════════════════════════════════════════════════════

    btnGetScreen.addEventListener('click', async () => {
        try {
            stopCurrentStream();

            activeStream = await navigator.mediaDevices.getDisplayMedia({
                video: { cursor: 'always', width: { ideal: 1920 }, height: { ideal: 1080 } },
                audio: true,
            });

            // Handle browser's native stop sharing button
            activeStream.getVideoTracks()[0].addEventListener('ended', () => {
                console.log('[SCREEN] User stopped sharing');
                if (isStreaming) {
                    stopStream();
                } else {
                    stopCurrentStream();
                    previewPlaceholder.style.display = 'flex';
                    btnStartStream.disabled = true;
                }
            });

            setPreview(activeStream);
            btnStartStream.disabled = false;
            showToast('🖥️ Pantalla compartida', 'success');
        } catch (err) {
            console.error('Screen share error:', err);
            if (err.name !== 'NotAllowedError') {
                showToast('Error al compartir pantalla: ' + err.message, 'error');
            }
        }
    });

    // ═══════════════════════════════════════════════════════════
    //  MP4 VIDEO MODE (Canvas + Web Audio API)
    // ═══════════════════════════════════════════════════════════

    videoFileInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        videoFilename.textContent = file.name;
        stopCurrentStream();

        try {
            const url = URL.createObjectURL(file);
            mp4SourceVideo.src = url;
            mp4SourceVideo.loop = true;

            await new Promise((resolve, reject) => {
                mp4SourceVideo.onloadedmetadata = resolve;
                mp4SourceVideo.onerror = reject;
            });

            // Set canvas size
            mp4Canvas.width = mp4SourceVideo.videoWidth || 1280;
            mp4Canvas.height = mp4SourceVideo.videoHeight || 720;

            await mp4SourceVideo.play();

            // ── Canvas capture for video track ──
            const ctx2d = mp4Canvas.getContext('2d');
            const canvasStream = mp4Canvas.captureStream(30); // 30 FPS

            // Draw video frames to canvas
            function drawFrame() {
                if (mp4SourceVideo.paused || mp4SourceVideo.ended) return;
                ctx2d.drawImage(mp4SourceVideo, 0, 0, mp4Canvas.width, mp4Canvas.height);
                mp4AnimFrame = requestAnimationFrame(drawFrame);
            }
            drawFrame();

            // ── Web Audio API for audio track ──
            mp4AudioCtx = new (window.AudioContext || window.webkitAudioContext)();
            const source = mp4AudioCtx.createMediaElementSource(mp4SourceVideo);
            const dest = mp4AudioCtx.createMediaStreamDestination();
            source.connect(dest);
            source.connect(mp4AudioCtx.destination); // Also hear locally

            // ── Combine video + audio into one stream ──
            const combinedStream = new MediaStream();
            canvasStream.getVideoTracks().forEach(t => combinedStream.addTrack(t));
            dest.stream.getAudioTracks().forEach(t => combinedStream.addTrack(t));

            activeStream = combinedStream;
            setPreview(activeStream);
            btnStartStream.disabled = false;
            showToast('🎬 Video cargado: ' + file.name, 'success');
        } catch (err) {
            console.error('MP4 error:', err);
            showToast('Error al cargar video: ' + err.message, 'error');
        }
    });

    // ═══════════════════════════════════════════════════════════
    //  STREAM CONTROL
    // ═══════════════════════════════════════════════════════════

    btnStartStream.addEventListener('click', startStream);
    btnStopStream.addEventListener('click', stopStream);

    function startStream() {
        if (!activeStream || isStreaming) return;

        // Verify we have live tracks
        const liveTracks = activeStream.getTracks().filter(t => t.readyState === 'live');
        if (liveTracks.length === 0) {
            showToast('Error: la fuente de video no está activa', 'error');
            return;
        }

        // Verify peer is ready
        if (!peerReady) {
            showToast('Conectando al servidor PeerJS... intenta de nuevo en unos segundos', 'error');
            return;
        }

        isStreaming = true;

        // Notify server — this triggers 'stream-started' event to all viewers
        socket.emit('stream-started', {
            peerId: ADMIN_PEER_ID,
            title: streamTitleInput.value || 'Live Stream',
        });

        // Update UI
        btnStartStream.style.display = 'none';
        btnStopStream.style.display = 'inline-flex';
        streamTitleInput.disabled = true;
        streamStatusBadge.className = 'live-badge';
        streamStatusBadge.innerHTML = '<span class="dot"></span> LIVE';
        statusBar.className = 'status-bar live';
        statusBar.innerHTML = `🔴 Transmitiendo en vivo — ${liveTracks.length} track(s) — Peer: ${ADMIN_PEER_ID}`;

        showToast('🔴 ¡Stream iniciado!', 'success');
        console.log('[STREAM] ✅ Started. PeerID:', ADMIN_PEER_ID, 'Tracks:', liveTracks.length);
    }

    function stopStream() {
        isStreaming = false;

        // Close all peer calls
        activePeerCalls.forEach((call, peerId) => {
            try { call.close(); } catch (e) { }
        });
        activePeerCalls.clear();

        // Notify server
        if (socket && socket.connected) {
            socket.emit('stream-ended');
        }

        // Stop media tracks
        stopCurrentStream();

        // Update UI
        btnStartStream.style.display = 'inline-flex';
        btnStartStream.disabled = true;
        btnStopStream.style.display = 'none';
        streamTitleInput.disabled = false;
        streamStatusBadge.className = 'offline-badge';
        streamStatusBadge.innerHTML = '<span>OFFLINE</span>';
        statusBar.className = 'status-bar offline';
        statusBar.innerHTML = '⬛ Stream offline — Selecciona una fuente y presiona Iniciar';
        previewPlaceholder.style.display = 'flex';

        showToast('⬛ Stream detenido', 'error');
        console.log('[STREAM] Stopped');
    }

    // ═══════════════════════════════════════════════════════════
    //  HELPERS
    // ═══════════════════════════════════════════════════════════

    function setPreview(stream) {
        previewVideo.srcObject = stream;
        previewPlaceholder.style.display = 'none';
    }

    function stopCurrentStream() {
        if (activeStream) {
            activeStream.getTracks().forEach(t => t.stop());
            activeStream = null;
        }

        previewVideo.srcObject = null;

        // Stop MP4 mode
        if (mp4AnimFrame) {
            cancelAnimationFrame(mp4AnimFrame);
            mp4AnimFrame = null;
        }
        if (mp4AudioCtx) {
            mp4AudioCtx.close().catch(() => { });
            mp4AudioCtx = null;
        }
        mp4SourceVideo.pause();
        mp4SourceVideo.src = '';
    }

    // ── Chat ───────────────────────────────────────────────────
    chatSend.addEventListener('click', sendAdminMessage);
    chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendAdminMessage();
        }
    });

    function sendAdminMessage() {
        const text = chatInput.value.trim();
        if (!text) return;

        // Check socket connection directly
        if (!socket || !socket.connected) {
            showToast('⚠️ Chat desconectado, reconectando...', 'error');
            return;
        }

        socket.emit('chat-message', {
            text,
            username: adminUsername,
            isAdmin: true,
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

        // Limit DOM messages to 200 (performance)
        while (chatMessages.children.length > 200) {
            chatMessages.removeChild(chatMessages.firstChild);
        }

        if (isNearBottom) {
            chatMessages.scrollTop = chatMessages.scrollHeight;
        }
    }

    // ── Stream Title ───────────────────────────────────────────
    streamTitleInput.addEventListener('change', () => {
        if (socket && socket.connected && isStreaming) {
            socket.emit('update-title', { title: streamTitleInput.value });
        }
    });

    // ── Logout ─────────────────────────────────────────────────
    logoutBtn.addEventListener('click', () => {
        if (isStreaming) {
            if (!confirm('¿Detener el stream y cerrar sesión?')) return;
            stopStream();
        }
        localStorage.removeItem('streamvibe_token');
        localStorage.removeItem('streamvibe_username');
        window.location.href = '/';
    });

    // ── Utilities ──────────────────────────────────────────────
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

    // ── Warn before leaving while streaming ────────────────────
    window.addEventListener('beforeunload', (e) => {
        if (isStreaming) {
            e.preventDefault();
            e.returnValue = '¿Seguro que quieres salir? El stream se detendrá.';
        }
    });
})();

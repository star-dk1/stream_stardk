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
    const micSelect = document.getElementById('mic-select');
    const volumeBar = document.getElementById('volume-bar');
    let volumeInterval = null;
    let audioContext = null;
    let analyser = null;
    let microphone = null;

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
            initPeer();
            loadMediaDevices();
        } catch (err) {
            console.error('Auth check failed:', err);
            window.location.href = '/';
        }
    })();

    // ── Socket.IO ──────────────────────────────────────────────
    function initSocket() {
        socket = io({
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

    // ── Helper: Replace tracks in active calls ─────────────────
    function updateActiveStreamTracks(newStream) {
        if (!newStream) return;

        const newVideoTrack = newStream.getVideoTracks()[0];
        const newAudioTrack = newStream.getAudioTracks()[0];

        activePeerCalls.forEach((call, peerId) => {
            const senders = call.peerConnection.getSenders();

            senders.forEach((sender) => {
                if (sender.track) {
                    if (sender.track.kind === 'video' && newVideoTrack) {
                        sender.replaceTrack(newVideoTrack).catch(e => console.error('Replace Video Track Error:', e));
                    }
                    if (sender.track.kind === 'audio' && newAudioTrack) {
                        sender.replaceTrack(newAudioTrack).catch(e => console.error('Replace Audio Track Error:', e));
                    }
                }
            });
        });
    }

    // ── Source Tab Switching ───────────────────────────────────
    sourceTabs.forEach((tab) => {
        // ── Source Tab Switching ───────────────────────────────────
        sourceTabs.forEach((tab) => {
            tab.addEventListener('click', () => {
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

                // If NOT streaming, reset preview to let user choose clean
                if (!isStreaming) {
                    stopCurrentStream();
                    previewPlaceholder.style.display = 'flex';
                    btnStartStream.disabled = true;
                }
                // If streaming, we leave the current stream active until they select a new one
            });
        });
    });

    // ═══════════════════════════════════════════════════════════
    //  CAMERA MODE
    // ═══════════════════════════════════════════════════════════

    async function loadMediaDevices() {
        try {
            // Request permission first to get labels
            const tempStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
            tempStream.getTracks().forEach(t => t.stop());

            const devices = await navigator.mediaDevices.enumerateDevices();

            // Cameras
            const videoDevices = devices.filter(d => d.kind === 'videoinput');
            cameraSelect.innerHTML = '<option value="">Seleccionar cámara...</option>';
            videoDevices.forEach((device, i) => {
                const option = document.createElement('option');
                option.value = device.deviceId;
                option.textContent = device.label || `Cámara ${i + 1}`;
                cameraSelect.appendChild(option);
            });

            // Microphones
            const audioDevices = devices.filter(d => d.kind === 'audioinput');
            micSelect.innerHTML = '<option value="">Seleccionar micrófono...</option>';
            audioDevices.forEach((device, i) => {
                const option = document.createElement('option');
                option.value = device.deviceId;
                option.textContent = device.label || `Micrófono ${i + 1}`;
                micSelect.appendChild(option);
            });

        } catch (err) {
            console.warn('Could not enumerate devices:', err);
        }
    }

    btnGetCamera.addEventListener('click', async () => {
        try {
            // If streaming, don't stop everything yet, just prepare new stream
            const wasStreaming = isStreaming;
            if (!wasStreaming) {
                stopCurrentStream();
            } else {
                cleanupPreviousResources();
            }

            const constraints = {
                video: cameraSelect.value
                    ? { deviceId: { exact: cameraSelect.value }, width: { ideal: 1280 }, height: { ideal: 720 } }
                    : { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
                audio: micSelect.value
                    ? { deviceId: { exact: micSelect.value } }
                    : true,
            };

            const newStream = await navigator.mediaDevices.getUserMedia(constraints);

            if (wasStreaming) {
                // Stop OLD tracks (except we just got new ones, be careful not to stop new ones)
                // Actually, stopCurrentStream stops activeStream. 
                // So we should safe-keep newStream, stop old activeStream, then assign new.
                if (activeStream) activeStream.getTracks().forEach(t => t.stop());
            }

            activeStream = newStream;
            activeStream = newStream;
            setPreview(activeStream);
            initVolumeMeter(activeStream); // Initialize visualizer
            btnStartStream.disabled = false;

            if (wasStreaming) {
                updateActiveStreamTracks(activeStream);
                showToast('📷 Cámara activada (En vivo)', 'success');
            } else {
                showToast('📷 Cámara activada', 'success');
            }
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
            const wasStreaming = isStreaming;
            if (!wasStreaming) {
                stopCurrentStream();
            } else {
                cleanupPreviousResources();
            }

            const newStream = await navigator.mediaDevices.getDisplayMedia({
                video: { cursor: 'always', width: { ideal: 1920 }, height: { ideal: 1080 } },
                audio: true,
            });

            // Handle browser's native stop sharing button
            newStream.getVideoTracks()[0].addEventListener('ended', () => {
                console.log('[SCREEN] User stopped sharing');
                if (isStreaming) {
                    stopStream();
                } else {
                    stopCurrentStream();
                    previewPlaceholder.style.display = 'flex';
                    btnStartStream.disabled = true;
                }
            });

            if (wasStreaming) {
                if (activeStream) activeStream.getTracks().forEach(t => t.stop());
            }

            activeStream = newStream;
            setPreview(activeStream);
            btnStartStream.disabled = false;

            if (wasStreaming) {
                updateActiveStreamTracks(activeStream);
                showToast('🖥️ Pantalla compartida (En vivo)', 'success');
            } else {
                showToast('🖥️ Pantalla compartida', 'success');
            }
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

        const wasStreaming = isStreaming;
        if (!wasStreaming) {
            stopCurrentStream();
        } else {
            cleanupPreviousResources();
        }
        // If streaming, we must stop the OLD stream tracks but KEEP the socket/peer connection alive
        if (wasStreaming && activeStream) {
            activeStream.getTracks().forEach(t => t.stop());
            // Note: We don't nullify activeStream yet, wait for new one
        }

        try {
            const url = URL.createObjectURL(file);
            mp4SourceVideo.src = url;
            mp4SourceVideo.loop = true;
            // Ensure volume is 1
            mp4SourceVideo.volume = 1.0;

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
                // If video element is still the same simply loop
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

            // Resume context immediately (fixes audio issues)
            if (mp4AudioCtx.state === 'suspended') {
                await mp4AudioCtx.resume();
            }

            // ── Combine video + audio into one stream ──
            const combinedStream = new MediaStream();
            canvasStream.getVideoTracks().forEach(t => combinedStream.addTrack(t));
            dest.stream.getAudioTracks().forEach(t => combinedStream.addTrack(t));

            activeStream = combinedStream;
            setPreview(activeStream);
            btnStartStream.disabled = false;

            if (wasStreaming) {
                updateActiveStreamTracks(activeStream);
                showToast('🎬 Video cargado (En vivo)', 'success');
            } else {
                showToast('🎬 Video cargado: ' + file.name, 'success');
            }
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
            // Try to re-init if stuck
            initPeer();
            return;
        }

        isStreaming = true;

        console.log(`[STREAM] Starting... PeerID: ${ADMIN_PEER_ID}`);

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

    function cleanupPreviousResources() {
        // Stop MP4 mode resources
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

        // Stop Volume Meter
        if (volumeInterval) {
            clearInterval(volumeInterval);
            volumeInterval = null;
        }
        if (audioContext) {
            audioContext.close().catch(() => { });
            audioContext = null;
        }
        volumeBar.style.width = '0%';
    }

    function stopCurrentStream() {
        if (activeStream) {
            activeStream.getTracks().forEach(t => t.stop());
            activeStream = null;
        }

        previewVideo.srcObject = null;
        cleanupPreviousResources();
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

    function initVolumeMeter(stream) {
        // Ensure AudioContext
        if (!audioContext) {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }

        // Resume if suspended
        if (audioContext.state === 'suspended') {
            audioContext.resume();
        }

        // Close old microphone stream if exists to avoid leak
        if (microphone) {
            // disconnect? usually simple GC handles it if we overwrite, but explicit disconnect is good
            // microphone.disconnect(); 
        }

        microphone = audioContext.createMediaStreamSource(stream);
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        microphone.connect(analyser);

        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);

        if (volumeInterval) clearInterval(volumeInterval);

        volumeInterval = setInterval(() => {
            analyser.getByteFrequencyData(dataArray);

            // Calculate average volume
            let sum = 0;
            for (let i = 0; i < bufferLength; i++) {
                sum += dataArray[i];
            }
            let average = sum / bufferLength;

            // Scale to 0-100%
            // Average usually 0-128 range roughly, but can be up to 255
            let level = Math.min(100, (average / 128) * 100 * 2); // Amplified a bit

            volumeBar.style.width = `${level}%`;

            // Color feedback
            if (level > 80) volumeBar.style.backgroundColor = 'red';
            else if (level > 50) volumeBar.style.backgroundColor = 'yellow';
            else volumeBar.style.backgroundColor = 'lime';

        }, 100);
    }

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

/* ═══════════════════════════════════════════════════════════════
   Viewer.js — PeerJS stream reception + Socket.IO chat
   ═══════════════════════════════════════════════════════════════ */

(function () {
    'use strict';

    // ── State ──────────────────────────────────────────────────
    let socket = null;
    let peer = null;
    let currentCall = null;
    let viewerUsername = '';
    let isConnected = false;

    // ── DOM ────────────────────────────────────────────────────
    const usernameModal = document.getElementById('username-modal');
    const usernameForm = document.getElementById('username-form');
    const usernameInput = document.getElementById('viewer-username');
    const remoteVideo = document.getElementById('remote-video');
    const videoOverlay = document.getElementById('video-overlay');
    const streamBadge = document.getElementById('stream-badge');
    const streamBadge2 = document.getElementById('stream-badge-2');
    const viewerCountNum = document.getElementById('viewer-count-num');
    const chatCountNum = document.getElementById('chat-count-num');
    const streamTitle = document.getElementById('stream-title');
    const chatMessages = document.getElementById('chat-messages');
    const chatInput = document.getElementById('chat-input');
    const chatSend = document.getElementById('chat-send');

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
    }

    // ── Socket.IO ──────────────────────────────────────────────
    function initSocket() {
        socket = io({
            transports: ['websocket', 'polling'],
            reconnectionAttempts: 10,
            reconnectionDelay: 2000,
        });

        socket.on('connect', () => {
            console.log('[SOCKET] Connected:', socket.id);
            isConnected = true;
            socket.emit('join-stream', { username: viewerUsername });
        });

        socket.on('disconnect', () => {
            console.log('[SOCKET] Disconnected');
            isConnected = false;
        });

        socket.on('reconnect', () => {
            console.log('[SOCKET] Reconnected');
            socket.emit('join-stream', { username: viewerUsername });
        });

        // Stream status on join
        socket.on('stream-status', (data) => {
            console.log('[STREAM] Status:', data);
            if (data.isLive && data.adminPeerId) {
                setLiveState(data.title || 'Live Stream');
                connectToPeer(data.adminPeerId);
            } else {
                setOfflineState();
            }
        });

        // Stream started
        socket.on('stream-started', (data) => {
            console.log('[STREAM] Started! PeerId:', data.adminPeerId);
            showToast('🔴 ¡El stream ha comenzado!', 'success');
            setLiveState(data.title || 'Live Stream');
            connectToPeer(data.adminPeerId);
        });

        // Stream ended
        socket.on('stream-ended', () => {
            console.log('[STREAM] Ended');
            showToast('⬛ El stream ha terminado', 'error');
            setOfflineState();
            if (currentCall) {
                currentCall.close();
                currentCall = null;
            }
            remoteVideo.srcObject = null;
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
    function initPeer() {
        const peerConfig = {
            host: window.location.hostname,
            port: window.location.port || (window.location.protocol === 'https:' ? 443 : 80),
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

        peer.on('open', (id) => {
            console.log('[PEER] My ID:', id);
        });

        peer.on('error', (err) => {
            console.error('[PEER] Error:', err);
            if (err.type === 'peer-unavailable') {
                showToast('El streamer no está disponible. Reintentando...', 'error');
                setTimeout(() => {
                    const statusCheck = fetch('/api/stream-status')
                        .then(r => r.json())
                        .then(data => {
                            if (data.isLive && data.adminPeerId) {
                                connectToPeer(data.adminPeerId);
                            }
                        });
                }, 3000);
            }
        });

        peer.on('disconnected', () => {
            console.log('[PEER] Disconnected, reconnecting...');
            setTimeout(() => {
                if (peer && !peer.destroyed) {
                    peer.reconnect();
                }
            }, 2000);
        });
    }

    // ── Connect to admin peer ─────────────────────────────────
    function connectToPeer(adminPeerId) {
        if (!peer || peer.destroyed) {
            console.warn('[PEER] Not ready, reinitializing...');
            initPeer();
            setTimeout(() => connectToPeer(adminPeerId), 1500);
            return;
        }

        // Close existing call
        if (currentCall) {
            currentCall.close();
            currentCall = null;
        }

        console.log('[PEER] Calling admin:', adminPeerId);

        // Create a silent dummy stream to initiate the call
        // The admin will respond with their real stream
        const dummyStream = createSilentStream();
        const call = peer.call(adminPeerId, dummyStream);

        if (!call) {
            console.error('[PEER] Call failed, retrying in 3s...');
            setTimeout(() => connectToPeer(adminPeerId), 3000);
            return;
        }

        currentCall = call;

        call.on('stream', (remoteStream) => {
            console.log('[PEER] Receiving stream!', remoteStream.getTracks());
            remoteVideo.srcObject = remoteStream;
            remoteVideo.play().catch(e => console.warn('Autoplay blocked:', e));
            videoOverlay.classList.add('hidden');
        });

        call.on('close', () => {
            console.log('[PEER] Call closed');
            currentCall = null;
        });

        call.on('error', (err) => {
            console.error('[PEER] Call error:', err);
            currentCall = null;
        });
    }

    // ── Create silent dummy stream ─────────────────────────────
    function createSilentStream() {
        const ctx = new AudioContext();
        const oscillator = ctx.createOscillator();
        const dst = ctx.createMediaStreamDestination();
        oscillator.connect(dst);
        oscillator.start();

        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        const canvasStream = canvas.captureStream(1);

        const stream = new MediaStream();
        stream.addTrack(canvasStream.getVideoTracks()[0]);
        stream.addTrack(dst.stream.getAudioTracks()[0]);

        // Stop oscillator after a moment
        setTimeout(() => oscillator.stop(), 100);

        return stream;
    }

    // ── Chat ───────────────────────────────────────────────────
    function enableChat() {
        chatInput.disabled = false;
        chatSend.disabled = false;
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
        if (!text || !socket || !isConnected) return;

        socket.emit('chat-message', {
            text,
            username: viewerUsername,
            isAdmin: false,
        });

        chatInput.value = '';
        chatInput.focus();
    }

    function addChatMessage(msg) {
        const div = document.createElement('div');
        div.className = `chat-message ${msg.type}`;

        if (msg.type === 'system') {
            div.textContent = msg.text;
        } else {
            div.innerHTML = `<span class="chat-username">${escapeHtml(msg.username)}</span><span class="chat-text">${escapeHtml(msg.text)}</span>`;
        }

        chatMessages.appendChild(div);
        chatMessages.scrollTop = chatMessages.scrollHeight;
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

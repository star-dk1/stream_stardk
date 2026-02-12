require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { ExpressPeerServer } = require('peer');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const cors = require('cors');

// ─── Config ────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'fallback_dev_secret_change_me';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'streamadmin2024';

// ─── App Setup ─────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);

// ─── Middleware ─────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── PeerJS Server ─────────────────────────────────────────────
const peerServer = ExpressPeerServer(server, {
    debug: true,
    path: '/',
    allow_discovery: false,
});
app.use('/peerjs', peerServer);

// ─── In-Memory Store ───────────────────────────────────────────
const admins = new Map(); // username -> { id, username, passwordHash }
let streamState = {
    isLive: false,
    adminPeerId: null,
    startedAt: null,
    title: 'Live Stream',
};
const connectedViewers = new Map(); // socketId -> { username, joinedAt }
const chatHistory = []; // last 50 messages
const MAX_CHAT_HISTORY = 50;

// ─── Auth Middleware ───────────────────────────────────────────
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Token requerido' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Token inválido o expirado' });
        req.user = user;
        next();
    });
}

// ─── Auth Routes ───────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
    try {
        const { username, password, adminSecret } = req.body;

        if (!username || !password || !adminSecret) {
            return res.status(400).json({ error: 'Todos los campos son requeridos' });
        }

        if (adminSecret !== ADMIN_SECRET) {
            return res.status(403).json({ error: 'Código de administrador incorrecto' });
        }

        if (username.length < 3 || username.length > 20) {
            return res.status(400).json({ error: 'El usuario debe tener entre 3 y 20 caracteres' });
        }

        if (password.length < 6) {
            return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
        }

        if (admins.has(username.toLowerCase())) {
            return res.status(409).json({ error: 'El usuario ya existe' });
        }

        const salt = await bcrypt.genSalt(12);
        const passwordHash = await bcrypt.hash(password, salt);
        const id = uuidv4();

        admins.set(username.toLowerCase(), { id, username, passwordHash });

        const token = jwt.sign(
            { id, username, role: 'admin' },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        console.log(`[AUTH] Admin registrado: ${username}`);
        res.status(201).json({ token, username });
    } catch (err) {
        console.error('[AUTH] Error en registro:', err);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({ error: 'Usuario y contraseña son requeridos' });
        }

        const admin = admins.get(username.toLowerCase());
        if (!admin) {
            return res.status(401).json({ error: 'Credenciales inválidas' });
        }

        const validPassword = await bcrypt.compare(password, admin.passwordHash);
        if (!validPassword) {
            return res.status(401).json({ error: 'Credenciales inválidas' });
        }

        const token = jwt.sign(
            { id: admin.id, username: admin.username, role: 'admin' },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        console.log(`[AUTH] Admin login: ${username}`);
        res.json({ token, username: admin.username });
    } catch (err) {
        console.error('[AUTH] Error en login:', err);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

app.get('/api/verify', authenticateToken, (req, res) => {
    res.json({ valid: true, user: req.user });
});

app.get('/api/stream-status', (req, res) => {
    res.json({
        isLive: streamState.isLive,
        adminPeerId: streamState.adminPeerId,
        startedAt: streamState.startedAt,
        title: streamState.title,
        viewerCount: connectedViewers.size,
    });
});

// ─── Socket.IO ─────────────────────────────────────────────────
const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST'],
    },
    pingTimeout: 60000,
    pingInterval: 25000,
});

io.on('connection', (socket) => {
    console.log(`[SOCKET] Conectado: ${socket.id}`);

    // ── Viewer joins ──
    socket.on('join-stream', (data) => {
        const username = data?.username || `Viewer_${socket.id.slice(0, 5)}`;
        connectedViewers.set(socket.id, {
            username,
            joinedAt: new Date().toISOString(),
        });

        console.log(`[STREAM] Viewer unido: ${username} (${connectedViewers.size} total)`);

        // Send current stream state
        socket.emit('stream-status', {
            isLive: streamState.isLive,
            adminPeerId: streamState.adminPeerId,
            title: streamState.title,
        });

        // Send chat history
        socket.emit('chat-history', chatHistory);

        // Broadcast updated viewer count
        io.emit('viewer-count', connectedViewers.size);

        // Notify chat
        const joinMsg = {
            id: uuidv4(),
            type: 'system',
            text: `${username} se unió al stream`,
            timestamp: new Date().toISOString(),
        };
        addChatMessage(joinMsg);
        io.emit('chat-message', joinMsg);
    });

    // ── Chat message ──
    socket.on('chat-message', (data) => {
        const viewer = connectedViewers.get(socket.id);
        const message = {
            id: uuidv4(),
            type: data.isAdmin ? 'admin' : 'user',
            username: data.isAdmin ? '🔴 ADMIN' : (viewer?.username || data.username || 'Anónimo'),
            text: sanitizeMessage(data.text),
            timestamp: new Date().toISOString(),
        };

        if (message.text.length > 0 && message.text.length <= 500) {
            addChatMessage(message);
            io.emit('chat-message', message);
        }
    });

    // ── Admin: Start stream ──
    socket.on('stream-started', (data) => {
        streamState = {
            isLive: true,
            adminPeerId: data.peerId,
            startedAt: new Date().toISOString(),
            title: data.title || 'Live Stream',
        };

        console.log(`[STREAM] 🔴 LIVE - PeerId: ${data.peerId}`);
        io.emit('stream-started', {
            adminPeerId: data.peerId,
            title: streamState.title,
        });

        const sysMsg = {
            id: uuidv4(),
            type: 'system',
            text: '🔴 ¡El stream ha comenzado!',
            timestamp: new Date().toISOString(),
        };
        addChatMessage(sysMsg);
        io.emit('chat-message', sysMsg);
    });

    // ── Admin: Stop stream ──
    socket.on('stream-ended', () => {
        streamState = {
            isLive: false,
            adminPeerId: null,
            startedAt: null,
            title: 'Live Stream',
        };

        console.log('[STREAM] ⬛ Stream terminado');
        io.emit('stream-ended');

        const sysMsg = {
            id: uuidv4(),
            type: 'system',
            text: '⬛ El stream ha terminado',
            timestamp: new Date().toISOString(),
        };
        addChatMessage(sysMsg);
        io.emit('chat-message', sysMsg);
    });

    // ── Admin: Update stream title ──
    socket.on('update-title', (data) => {
        if (data.title) {
            streamState.title = data.title;
            io.emit('title-updated', { title: data.title });
        }
    });

    // ── Disconnect ──
    socket.on('disconnect', () => {
        const viewer = connectedViewers.get(socket.id);
        if (viewer) {
            connectedViewers.delete(socket.id);
            console.log(`[SOCKET] Viewer desconectado: ${viewer.username} (${connectedViewers.size} total)`);

            io.emit('viewer-count', connectedViewers.size);

            const leaveMsg = {
                id: uuidv4(),
                type: 'system',
                text: `${viewer.username} salió del stream`,
                timestamp: new Date().toISOString(),
            };
            addChatMessage(leaveMsg);
            io.emit('chat-message', leaveMsg);
        }
    });
});

// ─── Helpers ───────────────────────────────────────────────────
function addChatMessage(msg) {
    chatHistory.push(msg);
    if (chatHistory.length > MAX_CHAT_HISTORY) {
        chatHistory.shift();
    }
}

function sanitizeMessage(text) {
    if (typeof text !== 'string') return '';
    return text
        .trim()
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .slice(0, 500);
}

// ─── SPA Fallback Routes ───────────────────────────────────────
app.get('/viewer', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'viewer.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ─── Start Server ──────────────────────────────────────────────
server.listen(PORT, () => {
    console.log('');
    console.log('╔══════════════════════════════════════════════╗');
    console.log('║    🎬 Live Streaming Platform - Running!     ║');
    console.log('╠══════════════════════════════════════════════╣');
    console.log(`║  🌐 http://localhost:${PORT}                   ║`);
    console.log(`║  📺 http://localhost:${PORT}/viewer             ║`);
    console.log(`║  🔧 http://localhost:${PORT}/admin              ║`);
    console.log(`║  🔗 PeerJS: /peerjs                          ║`);
    console.log('╚══════════════════════════════════════════════╝');
    console.log('');
});

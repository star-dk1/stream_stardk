# 🎬 StreamVibe — Live Streaming Platform

Plataforma de transmisión en vivo con video P2P usando WebRTC/PeerJS, chat en tiempo real con Socket.IO, y panel de admin con autenticación JWT.

## ✨ Características

- 📷 **Streaming de Cámara** — Transmite desde tu webcam
- 🖥️ **Compartir Pantalla** — Comparte tu escritorio o ventana
- 🎬 **Video MP4** — Transmite archivos de video usando Canvas + Web Audio API
- 💬 **Chat en Vivo** — Comunicación en tiempo real via Socket.IO
- 👥 **Contador de Viewers** — Seguimiento de audiencia en vivo
- 🔐 **Autenticación JWT** — Panel admin protegido con tokens
- 🎨 **Diseño Glassmorphism** — CSS puro, fuente Inter, modo oscuro premium

## 🚀 Deploy en Render

### Opción 1: Blueprint automático

1. Sube el código a un repositorio en GitHub
2. Ve a [Render Dashboard](https://dashboard.render.com)
3. Click en **"New" → "Blueprint"**
4. Conecta tu repositorio de GitHub
5. Render detectará el `render.yaml` y configurará todo automáticamente

### Opción 2: Manual

1. Ve a [Render Dashboard](https://dashboard.render.com)
2. Click en **"New" → "Web Service"**
3. Conecta tu repositorio de GitHub
4. Configura:
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
5. En **Environment Variables**, agrega:

| Variable | Valor | Descripción |
|----------|-------|-------------|
| `JWT_SECRET` | *(genera un string largo aleatorio)* | Clave secreta para firmar tokens JWT |
| `ADMIN_SECRET` | *(tu código secreto)* | Código que necesitas para registrar cuentas admin |
| `NODE_ENV` | `production` | Entorno de ejecución |

> ⚠️ **IMPORTANTE**: Render provee HTTPS automáticamente, lo cual es **necesario** para que WebRTC, `getUserMedia` y `getDisplayMedia` funcionen correctamente.

## 🔧 Desarrollo Local

```bash
# Clonar e instalar
git clone <tu-repo>
cd tv
npm install

# Configurar variables de entorno
# Edita el archivo .env con tus valores

# Iniciar servidor
npm start
```

El servidor estará en:
- 🌐 http://localhost:3000 — Login/Register
- 📺 http://localhost:3000/viewer.html — Página de espectador
- 🔧 http://localhost:3000/admin.html — Panel de administración

## 📋 Configuración de Variables en Render

En el panel de Render, ve a tu servicio → **Environment**:

1. **`JWT_SECRET`**: Click en "Generate" para crear un valor aleatorio seguro
2. **`ADMIN_SECRET`**: Define tu propio código secreto (lo necesitarás para registrarte como admin)
3. **`NODE_ENV`**: Establece como `production`

## 🔑 Primer Uso

1. Abre la URL de tu app en Render
2. Haz click en **"Registrarse"**
3. Ingresa usuario, contraseña y tu **ADMIN_SECRET**
4. Serás redirigido al panel de admin
5. Selecciona una fuente (Cámara/Pantalla/Video)
6. Click en **"Iniciar Stream"**
7. Comparte la URL `/viewer.html` con tu audiencia

## 🏗️ Arquitectura

```
Browser (Admin)  ←→  PeerJS Server  ←→  Browser (Viewer)
      ↕                                       ↕
   Socket.IO  ←→  Node.js Server  ←→  Socket.IO
                    (Express)
```

- **WebRTC P2P**: El video va directo del admin al viewer sin pasar por el servidor
- **Socket.IO**: Solo señalización, chat y estado del stream
- **PeerJS Server**: Facilita la conexión inicial WebRTC

## 📁 Estructura

```
tv/
├── server.js           # Express + Socket.IO + PeerJS
├── package.json
├── render.yaml         # Render Blueprint
├── .env                # Variables de entorno (local)
├── .gitignore
└── public/
    ├── index.html      # Landing / Login
    ├── viewer.html     # Página de espectador
    ├── admin.html      # Panel de admin
    ├── css/
    │   └── style.css   # Glassmorphism Design System
    └── js/
        ├── auth.js     # Login/Register + LocalStorage
        ├── viewer.js   # PeerJS receive + Chat
        └── admin.js    # Streaming + WebRTC + Chat
```

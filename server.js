#!/usr/bin/env node
/**
 * Cipher P2P Messenger Server
 * Минималистичный сервер мессенджера (как Telegram/WhatsApp)
 * 
 * Функции:
 * - Маршрутизация сообщений между пользователями
 * - Хранение сообщений для офлайн пользователей
 * - Синхронизация статуса онлайн/офлайн
 */

const WebSocket = require('ws');
const http = require('http');
const https = require('https');
const fs = require('fs');

const PORT = process.env.PORT || 9000;
const USE_HTTPS = process.env.HTTPS === '1' || process.env.USE_WSS === '1';

// ==================== STORAGE ====================
const users = new Map(); // username -> {ws, nick, avatar, lastSeen}
const messageQueue = new Map(); // username -> [{from, to, content, ts}, ...]

// ==================== SERVER ====================
let app;

if (USE_HTTPS && fs.existsSync('cert.pem') && fs.existsSync('key.pem')) {
  // HTTPS режим (для WSS)
  app = https.createServer({
    cert: fs.readFileSync('cert.pem'),
    key: fs.readFileSync('key.pem')
  }, (req, res) => {
    res.writeHead(200, {'Content-Type': 'text/plain'});
    res.end(`Cipher Messenger Server\n${users.size} users connected`);
  });
} else {
  // HTTP режим (локально)
  app = http.createServer((req, res) => {
    res.writeHead(200, {'Content-Type': 'text/plain'});
    res.end(`Cipher Messenger Server\n${users.size} users connected`);
  });
}

const wss = new WebSocket.Server({server: app});

wss.on('connection', (ws) => {
  let username = null;
  let isAlive = true;

  ws.on('pong', () => {
    isAlive = true;
  });

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);
      await handleMessage(ws, msg, (username_) => username = username_);
    } catch (err) {
      console.error('Message error:', err.message);
    }
  });

  ws.on('close', () => {
    if (username) {
      const user = users.get(username);
      if (user && user.ws === ws) {
        users.delete(username);
        broadcast({type: 'user-offline', data: username});
        console.log(`✗ ${username} disconnected`);
      }
    }
  });

  ws.on('error', (err) => {
    console.error('WS error:', err.message);
  });
});

// Heartbeat
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// ==================== MESSAGE HANDLERS ====================
async function handleMessage(ws, msg, setUsername) {
  const {type, data, username} = msg;

  switch(type) {
    case 'auth':
      handleAuth(ws, data, setUsername);
      break;
    case 'message':
      handleSendMessage(username, data);
      break;
    case 'profile-update':
      handleProfileUpdate(username, data);
      break;
  }
}

function handleAuth(ws, data, setUsername) {
  const {username, nick, avatar} = data;
  
  if (!username || username.length < 3) {
    ws.send(JSON.stringify({type: 'error', error: 'Invalid username'}));
    return;
  }

  // Удаляем старое соединение
  if (users.has(username)) {
    const old = users.get(username);
    if (old.ws && old.ws.readyState === WebSocket.OPEN) {
      old.ws.close();
    }
  }

  const user = {
    ws,
    username,
    nick: nick || username,
    avatar: avatar || '',
    lastSeen: Date.now()
  };

  users.set(username, user);
  setUsername(username);

  console.log(`✓ ${username} connected (${users.size} total)`);

  // Отправляем список онлайн пользователей
  const onlineUsers = Array.from(users.values()).map(u => ({
    username: u.username,
    nick: u.nick,
    avatar: u.avatar
  }));

  // Отправляем сохранённые сообщения
  if (messageQueue.has(username)) {
    const pending = messageQueue.get(username);
    pending.forEach(msg => {
      ws.send(JSON.stringify({type: 'message', data: msg}));
    });
    messageQueue.delete(username);
    console.log(`  📨 Доставлено ${pending.length} сообщений для ${username}`);
  }

  ws.send(JSON.stringify({type: 'auth-ok', users: onlineUsers}));

  // Уведомляем всех о новом пользователе
  broadcast({type: 'user-online', data: {username, nick: user.nick, avatar: user.avatar}});
}

function handleSendMessage(from, data) {
  const {to, content, ts} = data;
  const message = {from, to, content, ts};

  const toUser = users.get(to);
  
  if (toUser && toUser.ws.readyState === WebSocket.OPEN) {
    // Пользователь онлайн - отправляем сразу
    toUser.ws.send(JSON.stringify({type: 'message', data: message}));
  } else {
    // Пользователь офлайн - сохраняем в очередь
    if (!messageQueue.has(to)) {
      messageQueue.set(to, []);
    }
    messageQueue.get(to).push(message);
    console.log(`  ⏸️  Сообщение от ${from} → ${to} в очереди (${messageQueue.get(to).length} ожидают)`);
  }
}

function handleProfileUpdate(username, data) {
  const user = users.get(username);
  if (!user) return;

  if (data.nick) user.nick = data.nick;
  if (data.avatar) user.avatar = data.avatar;

  // Уведомляем всех об обновлении профиля
  broadcast({
    type: 'user-profile',
    data: {username, nick: user.nick, avatar: user.avatar}
  });
}

// ==================== BROADCAST ====================
function broadcast(msg, excludeUser = null) {
  const data = JSON.stringify(msg);
  for (const [username, user] of users) {
    if (excludeUser && username === excludeUser) continue;
    if (user.ws.readyState === WebSocket.OPEN) {
      user.ws.send(data);
    }
  }
}

// ==================== STATS ====================
setInterval(() => {
  console.log(`[${new Date().toLocaleTimeString()}] 👥 Пользователей: ${users.size}, 📋 В очереди: ${messageQueue.size}`);
}, 30000);

// ==================== GRACEFUL SHUTDOWN ====================
process.on('SIGINT', () => {
  console.log('\n👋 Выключение сервера...');
  wss.clients.forEach(ws => ws.close());
  app.close(() => {
    console.log('✅ Сервер остановлен');
    process.exit(0);
  });
});

// ==================== START ====================
app.listen(PORT, () => {
  const proto = USE_HTTPS ? 'wss' : 'ws';
  const localIP = getLocalIP();
  
  const showHttpsWarning = USE_HTTPS && !(fs.existsSync('cert.pem') && fs.existsSync('key.pem'));
  
  console.log(`
╔═══════════════════════════════════════════════════╗
║       Cipher Messenger Server v2.0                ║
║═══════════════════════════════════════════════════║
║ 🚀 Запущен на порту: ${PORT}${' '.repeat(26 - String(PORT).length)}║
║ 🌐 Локально: ${proto}://localhost:${PORT}${' '.repeat(22 - String(PORT).length)}║
║ 📱 В сети:   ${proto}://${localIP}:${PORT}${' '.repeat(22 - String(localIP).length - String(PORT).length)}║
║ 🌍 GitHub:   ${proto}://YOUR-SERVER-DOMAIN${' '.repeat(10)}║
║                                                   ║
║ Готово к подключению...${' '.repeat(18)}║
╚═══════════════════════════════════════════════════╝
${showHttpsWarning ? '\n⚠️  WSS требует HTTPS сертификатов (cert.pem, key.pem)\n' : ''}
  `);
});

function getLocalIP() {
  const {networkInterfaces} = require('os');
  const interfaces = networkInterfaces();
  
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

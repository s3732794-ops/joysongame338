const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// База данных в памяти сервера
const registeredUsers = {}; // email -> { email, username, customCharacters: [] }
let globalPlayerCounter = 1;
const reservedEmojis = new Set(['👷', '🦈', '👨', '🔫', '🏹']);
const activeServers = {};
let serverAutoIndex = 1;

io.on('connection', (socket) => {
  const playerNum = String(globalPlayerCounter++).padStart(4, '0');
  socket.username = `Игрок ${playerNum}`;
  socket.userEmail = null;
  socket.currentRoom = null;

  socket.emit('init_player', {
    username: socket.username,
    reservedEmojis: Array.from(reservedEmojis)
  });

  // Авторизация по почте (простая и моментальная)
  socket.on('auth_login', (email) => {
    if (!email || !email.includes('@')) return;
    const cleanEmail = email.trim().toLowerCase();
    const uname = cleanEmail.split('@')[0]; // Ник как часть до знака @ (например, s3732794)

    if (!registeredUsers[cleanEmail]) {
      registeredUsers[cleanEmail] = {
        email: cleanEmail,
        username: uname,
        customCharacters: []
      };
    }

    socket.userEmail = cleanEmail;
    socket.username = registeredUsers[cleanEmail].username;

    socket.emit('auth_success', {
      username: socket.username,
      email: cleanEmail,
      customCharacters: registeredUsers[cleanEmail].customCharacters
    });
  });

  // Изменение никнейма
  socket.on('change_username', (newName) => {
    if (newName && newName.trim().length > 0) {
      socket.username = newName.trim().slice(0, 20);
      if (socket.userEmail && registeredUsers[socket.userEmail]) {
        registeredUsers[socket.userEmail].username = socket.username;
      }
      socket.emit('username_updated', socket.username);
    }
  });

  // Создание персонажа
  socket.on('create_character', (charData) => {
    if (reservedEmojis.has(charData.emoji)) {
      return socket.emit('char_error', 'Этот эмодзи уже занят стандартным персонажем!');
    }
    reservedEmojis.add(charData.emoji);

    if (socket.userEmail && registeredUsers[socket.userEmail]) {
      registeredUsers[socket.userEmail].customCharacters.push(charData);
    }

    io.emit('new_global_character', charData);
    socket.emit('char_created_success', charData);
  });

  socket.on('get_servers', () => sendServerList(socket));

  socket.on('create_room', ({ name, maxPlayers }) => {
    const roomId = 'room_' + Date.now();
    const roomName = name || `server ${String(serverAutoIndex++).padStart(4, '0')}`;
    const limit = Math.min(Math.max(parseInt(maxPlayers) || 10, 2), 50);

    activeServers[roomId] = { id: roomId, name: roomName, maxPlayers: limit, players: {}, blocks: [] };
    joinRoom(socket, roomId);
  });

  socket.on('quick_search', () => {
    let foundRoomId = Object.keys(activeServers).find(id => {
      const room = activeServers[id];
      return Object.keys(room.players).length < room.maxPlayers;
    });

    if (!foundRoomId) {
      foundRoomId = 'room_' + Date.now();
      const roomName = `server ${String(serverAutoIndex++).padStart(4, '0')}`;
      activeServers[foundRoomId] = { id: foundRoomId, name: roomName, maxPlayers: 50, players: {}, blocks: [] };
    }
    joinRoom(socket, foundRoomId);
  });

  socket.on('join_room', (roomId) => {
    if (activeServers[roomId]) joinRoom(socket, roomId);
    else socket.emit('error_msg', 'Сервер не найден');
  });

  socket.on('player_update', (data) => {
    const room = activeServers[socket.currentRoom];
    if (room && room.players[socket.id]) {
      Object.assign(room.players[socket.id], data);
      socket.to(socket.currentRoom).emit('player_moved', { id: socket.id, ...data });
    }
  });

  socket.on('spawn_block', (block) => {
    const room = activeServers[socket.currentRoom];
    if (room) {
      room.blocks.push(block);
      io.to(socket.currentRoom).emit('block_spawned', block);
    }
  });

  socket.on('block_damage', ({ blockIndex, damage }) => {
    const room = activeServers[socket.currentRoom];
    if (room && room.blocks[blockIndex]) {
      room.blocks[blockIndex].hp -= damage;
      if (room.blocks[blockIndex].hp <= 0) room.blocks.splice(blockIndex, 1);
      io.to(socket.currentRoom).emit('sync_blocks', room.blocks);
    }
  });

  socket.on('disconnect', () => leaveCurrentRoom(socket));
});

function joinRoom(socket, roomId) {
  leaveCurrentRoom(socket);
  const room = activeServers[roomId];
  if (!room) return;
  if (Object.keys(room.players).length >= room.maxPlayers) return socket.emit('error_msg', 'Сервер полон!');

  socket.join(roomId);
  socket.currentRoom = roomId;
  room.players[socket.id] = { id: socket.id, username: socket.username, x: 0, y: 0, char: null };

  socket.emit('joined_room_success', { roomId: room.id, roomName: room.name, blocks: room.blocks, players: room.players });
  socket.to(roomId).emit('player_joined', { id: socket.id, username: socket.username, x: 0, y: 0 });
  io.emit('server_list_updated');
}

function leaveCurrentRoom(socket) {
  if (socket.currentRoom && activeServers[socket.currentRoom]) {
    const room = activeServers[socket.currentRoom];
    delete room.players[socket.id];
    socket.to(socket.currentRoom).emit('player_left', socket.id);
    if (Object.keys(room.players).length === 0) delete activeServers[socket.currentRoom];
    socket.leave(socket.currentRoom);
    socket.currentRoom = null;
    io.emit('server_list_updated');
  }
}

function sendServerList(socket) {
  const list = Object.values(activeServers).map(r => ({
    id: r.id, name: r.name, currentPlayers: Object.keys(r.players).length, maxPlayers: r.maxPlayers
  })).slice(0, 12);
  socket.emit('server_list', list);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));
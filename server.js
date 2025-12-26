const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server, {
    cors: { origin: "*" } // Allow connections from your Firebase app
});

app.use(express.static('public'));

// --- GAME STATE ---
// We now support multiple rooms!
const rooms = {
    'room_us': { id: 'room_us', region: 'US Central', players: {}, votes: {}, isMeeting: false, walls: [] },
    'room_asia': { id: 'room_asia', region: 'Asia East', players: {}, votes: {}, isMeeting: false, walls: [] },
    'room_eu': { id: 'room_eu', region: 'Europe', players: {}, votes: {}, isMeeting: false, walls: [] },
};

// Standard Map Layout (Same for all rooms for now)
const defaultWalls = [
    { x: 200, y: 100, w: 20, h: 400 },
    { x: 600, y: 100, w: 20, h: 400 },
    { x: 200, y: 100, w: 420, h: 20 },
    { x: 200, y: 500, w: 150, h: 20 },
    { x: 450, y: 500, w: 170, h: 20 }, 
    { x: 380, y: 250, w: 60, h: 60 },  
];
Object.values(rooms).forEach(r => r.walls = defaultWalls);

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // 1. Send Room List to Client immediately
  socket.emit('roomListUpdate', getRoomList());

  // 2. Client wants to JOIN a specific room
  socket.on('joinRoom', ({ roomId, userData }) => {
      const room = rooms[roomId];
      if (!room) return;

      socket.join(roomId);
      
      // Initialize Player in that room
      room.players[socket.id] = {
        x: Math.floor(Math.random() * 700) + 50,
        y: Math.floor(Math.random() * 500) + 50,
        playerId: socket.id,
        role: 'INNOCENT', 
        name: userData.name || "Player", 
        skin: userData.skin || "bear",
        isDead: false,
        direction: 1
      };

      // Assign Roles (Simple logic)
      const pCount = Object.keys(room.players).length;
      if (pCount === 2) room.players[socket.id].role = 'WOLF';
      if (pCount === 1) room.players[socket.id].role = 'FARMER';

      // Send Game State to just this room
      io.to(roomId).emit('currentPlayers', room.players);
      socket.emit('mapData', room.walls);
      
      // Update global lobby list for everyone else (player count changed)
      io.emit('roomListUpdate', getRoomList());
  });

  // 3. Movement
  socket.on('playerMovement', ({ roomId, x, y }) => {
      const room = rooms[roomId];
      if (room && room.players[socket.id] && !room.isMeeting && !room.players[socket.id].isDead) {
          const p = room.players[socket.id];
          p.x = x; p.y = y;
          socket.to(roomId).emit('playerMoved', p);
      }
  });

  // 4. Kill
  socket.on('killPlayer', ({ roomId, targetId }) => {
      const room = rooms[roomId];
      if (room && room.players[socket.id]?.role === 'WOLF') {
          room.players[targetId].isDead = true;
          io.to(roomId).emit('playerDied', { victimId: targetId });
      }
  });

  // 5. Meetings
  socket.on('reportBody', ({ roomId }) => {
      const room = rooms[roomId];
      if (room && !room.isMeeting) {
          room.isMeeting = true;
          room.votes = {};
          io.to(roomId).emit('meetingStarted');
      }
  });

  // 6. Disconnect
  socket.on('disconnect', () => {
      // Find which room they were in
      Object.values(rooms).forEach(room => {
          if (room.players[socket.id]) {
              delete room.players[socket.id];
              io.to(room.id).emit('userDisconnected', socket.id);
          }
      });
      io.emit('roomListUpdate', getRoomList());
  });
});

function getRoomList() {
    return Object.values(rooms).map(r => ({
        id: r.id,
        region: r.region,
        playerCount: Object.keys(r.players).length,
        maxPlayers: 12,
        previewSkins: Object.values(r.players).map(p => p.skin).slice(0, 5) // Send first 5 avatars for preview
    }));
}

server.listen(3000, () => {
  console.log('Multi-room Server running on 3000');
});
const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");

// 1. ALLOW CONNECTION FROM YOUR GAME
const io = new Server(server, {
    cors: {
        origin: [
            "https://igs-pet.web.app",      // Your Game
            "https://igs-pet.firebaseapp.com",
            "http://localhost:5000",        // Local testing
            "http://127.0.0.1:5500"
        ],
        methods: ["GET", "POST"]
    }
});

app.use(express.static('public'));

// --- GAME STATE ---
const rooms = {
    'room_us': { id: 'room_us', region: 'US Central', players: {}, votes: {}, isMeeting: false, walls: [] },
    'room_asia': { id: 'room_asia', region: 'Asia East', players: {}, votes: {}, isMeeting: false, walls: [] },
    'room_eu': { id: 'room_eu', region: 'Europe', players: {}, votes: {}, isMeeting: false, walls: [] },
};

// --- MAP WITH PROPS (Trees, Barn, Hay) ---
const defaultWalls = [
    // Borders
    { x: 0, y: 0, w: 800, h: 20, type: 'fence' },
    { x: 0, y: 580, w: 800, h: 20, type: 'fence' },
    { x: 0, y: 0, w: 20, h: 600, type: 'fence' },
    { x: 780, y: 0, w: 20, h: 600, type: 'fence' },

    // The Red Barn (Center)
    { x: 300, y: 200, w: 200, h: 150, type: 'barn' },

    // Forest (Top Left)
    { x: 60, y: 60, w: 60, h: 60, type: 'tree' },
    { x: 140, y: 50, w: 60, h: 60, type: 'tree' },
    { x: 50, y: 140, w: 60, h: 60, type: 'tree' },

    // Hay Bales (Bottom Right)
    { x: 600, y: 450, w: 50, h: 50, type: 'hay' },
    { x: 660, y: 450, w: 50, h: 50, type: 'hay' },
    { x: 630, y: 510, w: 50, h: 50, type: 'hay' },
    
    // Pond (Bottom Left)
    { x: 150, y: 450, w: 100, h: 80, type: 'water' }
];
Object.values(rooms).forEach(r => r.walls = defaultWalls);

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  socket.emit('roomListUpdate', getRoomList());

  // JOIN
  socket.on('joinRoom', ({ roomId, userData }) => {
      const room = rooms[roomId];
      if (!room) return;

      socket.join(roomId);
      
      // Init Player
      room.players[socket.id] = {
        x: Math.floor(Math.random() * 600) + 100,
        y: Math.floor(Math.random() * 400) + 100,
        playerId: socket.id,
        role: 'INNOCENT',
        name: userData.name || "Player", 
        skin: userData.skin || "bear",
        isDead: false,
      };

      // Assign Roles (Simple Logic: 2nd player is Wolf)
      const pCount = Object.keys(room.players).length;
      if (pCount === 1) room.players[socket.id].role = 'FARMER';
      if (pCount === 2) room.players[socket.id].role = 'WOLF';

      io.to(roomId).emit('currentPlayers', room.players);
      socket.emit('mapData', room.walls);
      io.emit('roomListUpdate', getRoomList());
  });

  // MOVE
  socket.on('playerMovement', ({ roomId, x, y }) => {
      const room = rooms[roomId];
      if (room && room.players[socket.id] && !room.isMeeting && !room.players[socket.id].isDead) {
          const p = room.players[socket.id];
          p.x = x; p.y = y;
          socket.to(roomId).emit('playerMoved', p);
      }
  });

  // KILL
  socket.on('killPlayer', ({ roomId, targetId }) => {
      const room = rooms[roomId];
      // Verify killer is actually a Wolf
      if (room && room.players[socket.id]?.role === 'WOLF') {
          if (room.players[targetId]) {
              room.players[targetId].isDead = true;
              io.to(roomId).emit('playerDied', { victimId: targetId });
              checkWinCondition(room);
          }
      }
  });

  // REPORT / MEETING
  socket.on('reportBody', ({ roomId }) => {
      const room = rooms[roomId];
      if (room && !room.isMeeting) {
          room.isMeeting = true;
          room.votes = {};
          io.to(roomId).emit('meetingStarted');
          setTimeout(() => { if (room.isMeeting) endMeeting(room); }, 45000); // 45s timer
      }
  });

  // VOTE
  socket.on('castVote', (targetId) => {
      let room = null;
      Object.values(rooms).forEach(r => { if(r.players[socket.id]) room = r; });

      if (room && room.isMeeting && !room.players[socket.id].isDead) {
          room.votes[socket.id] = targetId;
          const livingCount = Object.values(room.players).filter(p => !p.isDead).length;
          if (Object.keys(room.votes).length >= livingCount) endMeeting(room);
      }
  });

  // DISCONNECT
  socket.on('disconnect', () => {
      Object.values(rooms).forEach(room => {
          if (room.players[socket.id]) {
              delete room.players[socket.id];
              io.to(room.id).emit('userDisconnected', socket.id);
              checkWinCondition(room);
          }
      });
      io.emit('roomListUpdate', getRoomList());
  });
});

// --- LOGIC HELPERS ---
function endMeeting(room) {
    if (!room.isMeeting) return;
    let tallies = {};
    let maxVotes = 0;
    let ejectedId = null;
    let tie = false;

    Object.values(room.votes).forEach(target => {
        tallies[target] = (tallies[target] || 0) + 1;
        if (tallies[target] > maxVotes) { maxVotes = tallies[target]; ejectedId = target; tie = false; } 
        else if (tallies[target] === maxVotes) { tie = true; }
    });

    if (ejectedId && !tie && room.players[ejectedId]) {
        room.players[ejectedId].isDead = true;
        io.to(room.id).emit('playerDied', { victimId: ejectedId });
    }

    io.to(room.id).emit('meetingEnded', { ejectedId: tie ? null : ejectedId });
    room.isMeeting = false;
    room.votes = {};
    checkWinCondition(room);
}

function checkWinCondition(room) {
    const players = Object.values(room.players);
    const wolves = players.filter(p => p.role === 'WOLF' && !p.isDead);
    const farmers = players.filter(p => p.role !== 'WOLF' && !p.isDead);

    if (wolves.length === 0 && players.length > 0) {
        io.to(room.id).emit('gameOver', { winner: 'FARMERS' });
        resetRoom(room);
    } else if (wolves.length >= farmers.length && players.length > 0) {
        io.to(room.id).emit('gameOver', { winner: 'WOLF' });
        resetRoom(room);
    }
}

function resetRoom(room) {
    setTimeout(() => {
        const ids = Object.keys(room.players);
        ids.forEach(id => {
            room.players[id].isDead = false;
            room.players[id].role = 'INNOCENT';
            room.players[id].x = Math.floor(Math.random() * 600) + 100;
            room.players[id].y = Math.floor(Math.random() * 400) + 100;
        });

        if (ids.length > 0) {
            const wolfId = ids[Math.floor(Math.random() * ids.length)];
            room.players[wolfId].role = 'WOLF';
            if (ids.length > 1) {
                let farmerId = ids[Math.floor(Math.random() * ids.length)];
                while(farmerId === wolfId) farmerId = ids[Math.floor(Math.random() * ids.length)];
                room.players[farmerId].role = 'FARMER';
            }
        }
        room.isMeeting = false;
        room.votes = {};
        io.to(room.id).emit('currentPlayers', room.players);
        io.to(room.id).emit('gameReset');
    }, 5000);
}

function getRoomList() {
    return Object.values(rooms).map(r => ({
        id: r.id, region: r.region, playerCount: Object.keys(r.players).length, maxPlayers: 12,
        previewSkins: Object.values(r.players).map(p => p.skin).slice(0, 5)
    }));
}

server.listen(3000, () => console.log('Barnyard Server Ready 3000'));

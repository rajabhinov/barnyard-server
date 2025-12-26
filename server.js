const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");

// ALLOW FIREBASE & LOCALHOST
const io = new Server(server, {
    cors: {
        origin: [
            "https://igs-pet.web.app",
            "https://igs-pet.firebaseapp.com",
            "http://localhost:3000",
            "http://127.0.0.1:5500"
        ],
        methods: ["GET", "POST"]
    }
});

app.use(express.static('public'));

// --- CONFIG ---
const MAP_WIDTH = 1600;
const MAP_HEIGHT = 800;

// --- GAME STATE ---
const rooms = {
    'room_us': { id: 'room_us', region: 'US Central', players: {}, votes: {}, isMeeting: false, walls: [], tasks: [], taskProgress: 0 },
    'room_asia': { id: 'room_asia', region: 'Asia East', players: {}, votes: {}, isMeeting: false, walls: [], tasks: [], taskProgress: 0 },
    'room_eu': { id: 'room_eu', region: 'Europe', players: {}, votes: {}, isMeeting: false, walls: [], tasks: [], taskProgress: 0 },
};

// --- MAP GENERATION ---
const defaultWalls = [
    // 1. BOUNDARIES
    { x: 0, y: 0, w: MAP_WIDTH, h: 20, type: 'fence' },
    { x: 0, y: MAP_HEIGHT-20, w: MAP_WIDTH, h: 20, type: 'fence' },
    { x: 0, y: 0, w: 20, h: MAP_HEIGHT, type: 'fence' },
    { x: MAP_WIDTH-20, y: 0, w: 20, h: MAP_HEIGHT, type: 'fence' },

    // 2. FARM ZONE
    { x: 300, y: 200, w: 200, h: 150, type: 'barn' },
    { x: 100, y: 100, w: 60, h: 60, type: 'tree' },
    { x: 100, y: 500, w: 100, h: 80, type: 'water' },

    // 3. ICE ZONE
    { x: 1000, y: 100, w: 80, h: 80, type: 'ice_rock' },
    { x: 1300, y: 250, w: 80, h: 80, type: 'ice_rock' },

    // 4. VOLCANO ZONE
    { x: 1100, y: 550, w: 120, h: 120, type: 'lava_pit' },
];

const taskLocations = [
    { id: 't1', x: 400, y: 300 }, { id: 't2', x: 150, y: 500 },
    { id: 't3', x: 1050, y: 150 }, { id: 't4', x: 1200, y: 600 }
];

Object.values(rooms).forEach(r => { r.walls = defaultWalls; r.tasks = taskLocations; });

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  socket.emit('roomListUpdate', getRoomList());

  // JOIN
  socket.on('joinRoom', ({ roomId, userData }) => {
      const room = rooms[roomId];
      if (!room) return;
      socket.join(roomId);
      
      room.players[socket.id] = {
        x: 400, y: 400, playerId: socket.id, role: 'INNOCENT',
        name: userData.name || "Player", skin: userData.skin || "bear", isDead: false
      };

      const pCount = Object.keys(room.players).length;
      if (pCount === 1) room.players[socket.id].role = 'FARMER';
      if (pCount === 2) room.players[socket.id].role = 'WOLF';

      io.to(roomId).emit('currentPlayers', room.players);
      socket.emit('mapData', { walls: room.walls, tasks: room.tasks });
      socket.emit('taskUpdate', room.taskProgress);
      io.emit('roomListUpdate', getRoomList());
  });

  // MOVEMENT
  socket.on('playerMovement', ({ roomId, x, y }) => {
      const room = rooms[roomId];
      if (room && room.players[socket.id] && !room.players[socket.id].isDead) {
          room.players[socket.id].x = x; room.players[socket.id].y = y;
          socket.to(roomId).emit('playerMoved', room.players[socket.id]);
      }
  });

  // KILL
  socket.on('killPlayer', ({ roomId, targetId }) => {
      const room = rooms[roomId];
      if (room && room.players[socket.id]?.role === 'WOLF') {
          room.players[targetId].isDead = true;
          io.to(roomId).emit('playerDied', { victimId: targetId });
          checkWinCondition(room);
      }
  });

  // TASK
  socket.on('completeTask', ({ roomId }) => {
      const room = rooms[roomId];
      if (room && room.players[socket.id]?.role !== 'WOLF') {
          room.taskProgress = Math.min(100, room.taskProgress + 10);
          io.to(roomId).emit('taskUpdate', room.taskProgress);
          if (room.taskProgress >= 100) {
              io.to(roomId).emit('gameOver', { winner: 'FARMERS' });
              resetRoom(room);
          }
      }
  });

  // MEETING
  socket.on('reportBody', ({ roomId }) => {
      const room = rooms[roomId];
      if (room && !room.isMeeting) {
          room.isMeeting = true; room.votes = {};
          io.to(roomId).emit('meetingStarted');
      }
  });

  // VOTE
  socket.on('castVote', (targetId) => {
      let room = null;
      Object.values(rooms).forEach(r => { if(r.players[socket.id]) room = r; });
      if (room && room.isMeeting && !room.players[socket.id].isDead) {
          room.votes[socket.id] = targetId;
          const living = Object.values(room.players).filter(p => !p.isDead).length;
          if (Object.keys(room.votes).length >= living) endMeeting(room);
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

// HELPERS
function endMeeting(room) {
    if (!room.isMeeting) return;
    let tallies = {}, max = 0, ejected = null;
    Object.values(room.votes).forEach(t => {
        tallies[t] = (tallies[t]||0)+1;
        if(tallies[t] > max) { max = tallies[t]; ejected = t; }
    });
    if (ejected && room.players[ejected]) {
        room.players[ejected].isDead = true;
        io.to(room.id).emit('playerDied', { victimId: ejected });
    }
    io.to(room.id).emit('meetingEnded', { ejectedId: ejected });
    room.isMeeting = false; room.votes = {};
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
        Object.values(room.players).forEach(p => { p.isDead = false; p.role = 'INNOCENT'; p.x=400; p.y=400; });
        room.taskProgress = 0; room.isMeeting = false; room.votes = {};
        const ids = Object.keys(room.players);
        if(ids.length > 0) room.players[ids[Math.floor(Math.random()*ids.length)]].role = 'WOLF';
        
        io.to(room.id).emit('currentPlayers', room.players);
        io.to(room.id).emit('taskUpdate', 0);
        io.to(room.id).emit('gameReset');
    }, 5000);
}

function getRoomList() {
    return Object.values(rooms).map(r => ({
        id: r.id, region: r.region, playerCount: Object.keys(r.players).length, maxPlayers: 12,
        previewSkins: Object.values(r.players).map(p => p.skin).slice(0, 5)
    }));
}

server.listen(3000);

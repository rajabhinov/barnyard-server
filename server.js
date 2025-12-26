const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");

const io = new Server(server, {
    cors: {
        origin: [
            "https://igs-pet.web.app",
            "https://igs-pet.firebaseapp.com",
            "http://localhost:3000"
        ],
        methods: ["GET", "POST"]
    }
});

app.use(express.static('public'));

// --- CONFIG ---
const MAP_WIDTH = 1600;
const MAP_HEIGHT = 800;
const TOTAL_TASKS_TO_WIN = 10;

// --- GAME STATE ---
const rooms = {
    'room_us': { id: 'room_us', region: 'US', players: {}, votes: {}, isMeeting: false, walls: [], tasks: [], taskProgress: 0 },
    'room_asia': { id: 'room_asia', region: 'Asia', players: {}, votes: {}, isMeeting: false, walls: [], tasks: [], taskProgress: 0 },
    'room_eu': { id: 'room_eu', region: 'EU', players: {}, votes: {}, isMeeting: false, walls: [], tasks: [], taskProgress: 0 },
};

// --- MAP GENERATION ---
const defaultWalls = [
    // 1. BOUNDARIES (The Big Box)
    { x: 0, y: 0, w: MAP_WIDTH, h: 20, type: 'fence' },
    { x: 0, y: MAP_HEIGHT-20, w: MAP_WIDTH, h: 20, type: 'fence' },
    { x: 0, y: 0, w: 20, h: MAP_HEIGHT, type: 'fence' },
    { x: MAP_WIDTH-20, y: 0, w: 20, h: MAP_HEIGHT, type: 'fence' },

    // 2. FARM ZONE (Left Side: 0-800)
    { x: 300, y: 200, w: 200, h: 150, type: 'barn' },
    { x: 100, y: 100, w: 60, h: 60, type: 'tree' },
    { x: 100, y: 500, w: 100, h: 80, type: 'water' },

    // 3. ICE ZONE (Top Right: 800-1600, 0-400)
    { x: 1000, y: 100, w: 80, h: 80, type: 'ice_rock' },
    { x: 1300, y: 250, w: 80, h: 80, type: 'ice_rock' },
    { x: 1100, y: 50, w: 80, h: 80, type: 'ice_rock' },

    // 4. VOLCANO ZONE (Bottom Right: 800-1600, 400-800)
    { x: 1100, y: 550, w: 120, h: 120, type: 'lava_pit' },
    { x: 1400, y: 600, w: 80, h: 80, type: 'lava_pit' },
];

// Define Task Locations
const taskLocations = [
    { id: 't1', x: 400, y: 300, name: 'Fix Wiring (Barn)' },
    { id: 't2', x: 150, y: 500, name: 'Clean Water' },
    { id: 't3', x: 1050, y: 150, name: 'Melt Ice' },
    { id: 't4', x: 1400, y: 100, name: 'Shovel Snow' },
    { id: 't5', x: 1200, y: 600, name: 'Cool Lava' },
    { id: 't6', x: 1500, y: 700, name: 'Analyze Magma' }
];

Object.values(rooms).forEach(r => {
    r.walls = defaultWalls;
    r.tasks = taskLocations; // All rooms get these tasks
});

io.on('connection', (socket) => {
  // Join logic same as before...
  socket.on('joinRoom', ({ roomId, userData }) => {
      const room = rooms[roomId];
      if (!room) return;
      socket.join(roomId);
      room.players[socket.id] = {
        x: 400, y: 400, // Spawn in middle
        playerId: socket.id, role: 'INNOCENT', name: userData.name || "Player", skin: userData.skin || "bear", isDead: false
      };
      
      const pCount = Object.keys(room.players).length;
      if (pCount === 1) room.players[socket.id].role = 'FARMER';
      if (pCount === 2) room.players[socket.id].role = 'WOLF';

      io.to(roomId).emit('currentPlayers', room.players);
      socket.emit('mapData', { walls: room.walls, tasks: room.tasks });
      socket.emit('taskUpdate', room.taskProgress); // Send current progress
  });

  socket.on('playerMovement', ({ roomId, x, y }) => {
      const room = rooms[roomId];
      if (room && room.players[socket.id] && !room.players[socket.id].isDead) {
          room.players[socket.id].x = x; room.players[socket.id].y = y;
          socket.to(roomId).emit('playerMoved', room.players[socket.id]);
      }
  });

  socket.on('killPlayer', ({ roomId, targetId }) => {
      const room = rooms[roomId];
      if (room && room.players[socket.id]?.role === 'WOLF') {
          room.players[targetId].isDead = true;
          io.to(roomId).emit('playerDied', { victimId: targetId });
          checkWinCondition(room);
      }
  });

  // --- NEW: TASK COMPLETION ---
  socket.on('completeTask', ({ roomId }) => {
      const room = rooms[roomId];
      if (room && room.players[socket.id]?.role !== 'WOLF' && !room.players[socket.id].isDead) {
          room.taskProgress += 10; // 10% per task
          io.to(roomId).emit('taskUpdate', room.taskProgress);
          
          if (room.taskProgress >= 100) {
              io.to(roomId).emit('gameOver', { winner: 'FARMERS' });
              resetRoom(room);
          }
      }
  });

  socket.on('reportBody', ({ roomId }) => {
      const room = rooms[roomId];
      if (room && !room.isMeeting) {
          room.isMeeting = true; room.votes = {};
          io.to(roomId).emit('meetingStarted');
      }
  });

  socket.on('castVote', (targetId) => {
      // (Keep existing voting logic from previous step here)
      // For brevity, assuming standard voting logic...
      // If vote ejects Wolf -> Farmers win
  });

  socket.on('disconnect', () => {
      // (Keep existing disconnect logic)
  });
});

function checkWinCondition(room) {
    const players = Object.values(room.players);
    const wolves = players.filter(p => p.role === 'WOLF' && !p.isDead);
    const farmers = players.filter(p => p.role !== 'WOLF' && !p.isDead);

    if (wolves.length === 0) {
        io.to(room.id).emit('gameOver', { winner: 'FARMERS' });
        resetRoom(room);
    } else if (wolves.length >= farmers.length) {
        io.to(room.id).emit('gameOver', { winner: 'WOLF' });
        resetRoom(room);
    }
}

function resetRoom(room) {
    setTimeout(() => {
        // Reset players...
        Object.values(room.players).forEach(p => { p.isDead = false; p.role = 'INNOCENT'; p.x=400; p.y=400; });
        room.taskProgress = 0; // Reset tasks
        room.isMeeting = false;
        
        // Re-assign roles...
        const ids = Object.keys(room.players);
        if(ids.length > 1) room.players[ids[Math.floor(Math.random()*ids.length)]].role = 'WOLF';

        io.to(room.id).emit('currentPlayers', room.players);
        io.to(room.id).emit('taskUpdate', 0);
        io.to(room.id).emit('gameReset');
    }, 5000);
}

server.listen(3000);

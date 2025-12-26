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

// --- GAME STATE ---
const rooms = {
    'room_us': { id: 'room_us', region: 'US', players: {}, items: [], decorations: [], taskProgress: 0, walls: [] },
    'room_asia': { id: 'room_asia', region: 'Asia', players: {}, items: [], decorations: [], taskProgress: 0, walls: [] },
    'room_eu': { id: 'room_eu', region: 'EU', players: {}, items: [], decorations: [], taskProgress: 0, walls: [] },
};

// --- MAP GENERATION ---
const defaultWalls = [
    // BOUNDARIES
    { x: 0, y: 0, w: MAP_WIDTH, h: 20, type: 'fence' },
    { x: 0, y: MAP_HEIGHT-20, w: MAP_WIDTH, h: 20, type: 'fence' },
    { x: 0, y: 0, w: 20, h: MAP_HEIGHT, type: 'fence' },
    { x: MAP_WIDTH-20, y: 0, w: 20, h: MAP_HEIGHT, type: 'fence' },

    // BUILDINGS & PROPS (Solid Objects)
    { x: 650, y: 300, w: 300, h: 200, type: 'barn' }, 
    { x: 100, y: 100, w: 60, h: 60, type: 'tree' },
    
    // WATER (Bottom Left)
    { x: 50, y: 500, w: 250, h: 150, type: 'water' },

    // ICE ZONE (Top Right)
    { x: 1100, y: 50, w: 100, h: 100, type: 'cave' }, 
    { x: 1300, y: 250, w: 80, h: 80, type: 'ice_rock' },

    // VOLCANO ZONE (Bottom Right)
    { x: 1100, y: 550, w: 100, h: 100, type: 'cave (1)' }, // Using cave (1) for volcano
    { x: 1400, y: 600, w: 120, h: 120, type: 'lava_pit' },
];

// DECORATIONS (Walk-through objects like Grass)
const generateDecorations = () => {
    let decos = [];
    // Scatter 50 random grass tufts in the Farm Zone (0-800 x, 0-800 y)
    for(let i=0; i<50; i++) {
        const id = Math.floor(Math.random() * 9) + 1; // 1 to 9
        decos.push({
            x: Math.random() * 750,
            y: Math.random() * 750,
            w: 40, h: 40,
            type: `grass (${id})` // Matches your filename format
        });
    }
    return decos;
};

// ITEMS TO SPAWN
const initialItems = [
    { id: 'bag1', type: 'bag', x: 200, y: 200 },        
    { id: 'bag2', type: 'bag', x: 300, y: 150 },
    { id: 'ice1', type: 'ice-box', x: 1150, y: 150 },   
    { id: 'ice2', type: 'ice-box', x: 1250, y: 100 },
    { id: 'stone1', type: 'stone', x: 1200, y: 650 },   
    { id: 'stone2', type: 'stone', x: 1300, y: 600 },
    { id: 'fish1', type: 'fish', x: 150, y: 550 },
    { id: 'fish2', type: 'fish', x: 100, y: 600 }
];

Object.values(rooms).forEach(r => { 
    r.walls = defaultWalls; 
    r.decorations = generateDecorations();
    r.items = JSON.parse(JSON.stringify(initialItems)); 
});

io.on('connection', (socket) => {
  socket.emit('roomListUpdate', getRoomList());

  socket.on('joinRoom', ({ roomId, userData }) => {
      const room = rooms[roomId];
      if (!room) return;
      socket.join(roomId);
      
      room.players[socket.id] = {
        x: 700, y: 400, playerId: socket.id, role: 'INNOCENT',
        name: userData.name || "Player", skin: userData.skin || "bear", 
        isDead: false, carrying: null 
      };

      const pCount = Object.keys(room.players).length;
      if (pCount === 1) room.players[socket.id].role = 'FARMER';
      if (pCount === 2) room.players[socket.id].role = 'WOLF';

      io.to(roomId).emit('currentPlayers', room.players);
      socket.emit('mapData', { walls: room.walls, decorations: room.decorations });
      io.to(roomId).emit('itemsUpdate', room.items);
      socket.emit('taskUpdate', room.taskProgress);
      io.emit('roomListUpdate', getRoomList());
  });

  socket.on('playerMovement', ({ roomId, x, y }) => {
      const room = rooms[roomId];
      if (room && room.players[socket.id] && !room.players[socket.id].isDead) {
          room.players[socket.id].x = x; room.players[socket.id].y = y;
          socket.to(roomId).emit('playerMoved', room.players[socket.id]);
      }
  });

  socket.on('pickupItem', ({ roomId, itemId }) => {
      const room = rooms[roomId];
      const player = room.players[socket.id];
      if (!room || !player || player.isDead || player.carrying) return;

      const idx = room.items.findIndex(i => i.id === itemId);
      if (idx !== -1) {
          const item = room.items[idx];
          const dist = Math.sqrt((player.x - item.x)**2 + (player.y - item.y)**2);
          if (dist < 100) {
              player.carrying = item.type; 
              room.items.splice(idx, 1); 
              io.to(roomId).emit('currentPlayers', room.players);
              io.to(roomId).emit('itemsUpdate', room.items);
          }
      }
  });

  socket.on('deliverItem', ({ roomId }) => {
      const room = rooms[roomId];
      const player = room.players[socket.id];
      if (!room || !player || !player.carrying) return;

      const dist = Math.sqrt((player.x - 800)**2 + (player.y - 400)**2); // Barn center approx
      if (dist < 250) {
          const type = player.carrying;
          player.carrying = null;
          room.taskProgress += 10;
          setTimeout(() => spawnItem(room, type), 5000);
          io.to(roomId).emit('currentPlayers', room.players);
          io.to(roomId).emit('taskUpdate', room.taskProgress);
          if (room.taskProgress >= 100) {
              io.to(roomId).emit('gameOver', { winner: 'FARMERS' });
              resetRoom(room);
          }
      }
  });

  socket.on('killPlayer', ({ roomId, targetId }) => {
      const room = rooms[roomId];
      if (room && room.players[socket.id]?.role === 'WOLF') {
          room.players[targetId].isDead = true;
          room.players[targetId].carrying = null; 
          io.to(roomId).emit('playerDied', { victimId: targetId });
          io.to(roomId).emit('currentPlayers', room.players);
          checkWinCondition(room);
      }
  });

  socket.on('disconnect', () => { /* Same as before */ 
      Object.values(rooms).forEach(room => {
          if (room.players[socket.id]) {
              delete room.players[socket.id];
              io.to(room.id).emit('userDisconnected', socket.id);
              checkWinCondition(room);
          }
      });
  });
});

function spawnItem(room, type) {
    let x = 400, y = 400;
    if(type === 'bag') { x = 100 + Math.random()*200; y = 100 + Math.random()*200; }
    if(type === 'ice-box') { x = 1100 + Math.random()*300; y = 50 + Math.random()*200; }
    if(type === 'stone') { x = 1100 + Math.random()*300; y = 500 + Math.random()*200; }
    if(type === 'fish') { x = 50 + Math.random()*150; y = 500 + Math.random()*150; }
    room.items.push({ id: Date.now().toString(), type: type, x: x, y: y });
    io.to(room.id).emit('itemsUpdate', room.items);
}

function checkWinCondition(room) { /* Same as before */ 
    const wolves = Object.values(room.players).filter(p => p.role === 'WOLF' && !p.isDead);
    const farmers = Object.values(room.players).filter(p => p.role !== 'WOLF' && !p.isDead);
    if(wolves.length === 0) { io.to(room.id).emit('gameOver', { winner: 'FARMERS' }); resetRoom(room); }
    else if(wolves.length >= farmers.length && farmers.length > 0) { io.to(room.id).emit('gameOver', { winner: 'WOLF' }); resetRoom(room); }
}

function resetRoom(room) { /* Same as before */
    setTimeout(() => {
        Object.values(room.players).forEach(p => { p.isDead = false; p.role = 'INNOCENT'; p.carrying=null; p.x=700; p.y=400; });
        room.items = JSON.parse(JSON.stringify(initialItems));
        room.taskProgress = 0;
        const ids = Object.keys(room.players);
        if(ids.length > 0) room.players[ids[Math.floor(Math.random()*ids.length)]].role = 'WOLF';
        io.to(room.id).emit('gameReset');
    }, 5000);
}
function getRoomList() { return Object.values(rooms).map(r => ({ id: r.id, region: r.region, playerCount: Object.keys(r.players).length })); }

server.listen(3000);

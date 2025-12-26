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

// --- GAME CONFIG ---
const ZONES = {
    FARM: 'farm',
    ICE: 'ice',
    VOLCANO: 'volcano',
    DESERT: 'desert'
};

// --- DATA STRUCTURES ---
// We now categorize everything by ZONE so we only render what's in the current room
const worldData = {
    [ZONES.FARM]: { walls: [], decorations: [], doors: [] },
    [ZONES.ICE]: { walls: [], decorations: [], doors: [] },
    [ZONES.VOLCANO]: { walls: [], decorations: [], doors: [] },
    [ZONES.DESERT]: { walls: [], decorations: [], doors: [] }
};

// --- MAP GENERATION ---

// 1. FARM (Hub)
worldData[ZONES.FARM].walls = [
    { x: 0, y: 0, w: 800, h: 20, type: 'fence' }, // Bounds
    { x: 0, y: 780, w: 800, h: 20, type: 'fence' },
    { x: 0, y: 0, w: 20, h: 800, type: 'fence' },
    { x: 780, y: 0, w: 20, h: 800, type: 'fence' },
    { x: 300, y: 300, w: 200, h: 150, type: 'barn' }, // Center Barn
    { x: 100, y: 100, w: 60, h: 60, type: 'tree' },
    { x: 600, y: 100, w: 60, h: 60, type: 'tree' }
];
// Doors from Farm to others
worldData[ZONES.FARM].doors = [
    { x: 400, y: 20, w: 60, h: 60, target: ZONES.ICE, tx: 400, ty: 700 },      // Top -> Ice
    { x: 400, y: 720, w: 60, h: 60, target: ZONES.VOLCANO, tx: 400, ty: 100 }, // Bottom -> Volcano
    { x: 20, y: 400, w: 60, h: 60, target: ZONES.DESERT, tx: 700, ty: 400 }    // Left -> Desert
];

// 2. ICE (North)
worldData[ZONES.ICE].walls = [
    { x: 0, y: 0, w: 800, h: 20, type: 'ice_rock' },
    { x: 0, y: 780, w: 800, h: 20, type: 'ice_rock' },
    { x: 0, y: 0, w: 20, h: 800, type: 'ice_rock' },
    { x: 780, y: 0, w: 20, h: 800, type: 'ice_rock' },
    { x: 200, y: 200, w: 100, h: 100, type: 'cave' },
    { x: 600, y: 300, w: 80, h: 80, type: 'ice_rock' }
];
worldData[ZONES.ICE].doors = [
    { x: 400, y: 720, w: 60, h: 60, target: ZONES.FARM, tx: 400, ty: 100 } // Back to Farm
];

// 3. VOLCANO (South)
worldData[ZONES.VOLCANO].walls = [
    { x: 0, y: 0, w: 800, h: 20, type: 'cave (1)' },
    { x: 0, y: 780, w: 800, h: 20, type: 'cave (1)' },
    { x: 0, y: 0, w: 20, h: 800, type: 'cave (1)' },
    { x: 780, y: 0, w: 20, h: 800, type: 'cave (1)' },
    { x: 300, y: 300, w: 120, h: 120, type: 'lava_pit' }
];
worldData[ZONES.VOLCANO].doors = [
    { x: 400, y: 20, w: 60, h: 60, target: ZONES.FARM, tx: 400, ty: 700 } // Back to Farm
];

// 4. DESERT (West) - NEW!
worldData[ZONES.DESERT].walls = [
    { x: 0, y: 0, w: 800, h: 20, type: 'mount' },
    { x: 0, y: 780, w: 800, h: 20, type: 'mount' },
    { x: 0, y: 0, w: 20, h: 800, type: 'mount' },
    { x: 780, y: 0, w: 20, h: 800, type: 'mount' },
    { x: 200, y: 200, w: 60, h: 80, type: 'cactus' },
    { x: 600, y: 500, w: 60, h: 80, type: 'cactus (1)' },
    { x: 100, y: 600, w: 100, h: 80, type: 'mount' }
];
worldData[ZONES.DESERT].doors = [
    { x: 720, y: 400, w: 60, h: 60, target: ZONES.FARM, tx: 100, ty: 400 } // Back to Farm
];
worldData[ZONES.DESERT].decorations = [
    { x: 500, y: 200, w: 80, h: 80, type: 'camel' }, // Decoration
    { x: 300, y: 600, w: 50, h: 50, type: 'yucca' }
];

// --- ITEMS ---
const initialItems = [
    { id: 'bag1', type: 'bag', x: 200, y: 200, zone: ZONES.FARM },
    { id: 'ice1', type: 'ice-box', x: 250, y: 250, zone: ZONES.ICE },
    { id: 'stone1', type: 'stone', x: 500, y: 500, zone: ZONES.VOLCANO },
    { id: 'yucca1', type: 'yucca', x: 400, y: 400, zone: ZONES.DESERT } // Desert Item
];

// --- ROOM STATE ---
const rooms = {
    'room_us': { id: 'room_us', region: 'US', players: {}, items: [], taskProgress: 0 },
    'room_asia': { id: 'room_asia', region: 'Asia', players: {}, items: [], taskProgress: 0 },
    'room_eu': { id: 'room_eu', region: 'EU', players: {}, items: [], taskProgress: 0 },
};

Object.values(rooms).forEach(r => { r.items = JSON.parse(JSON.stringify(initialItems)); });

io.on('connection', (socket) => {
  socket.emit('roomListUpdate', getRoomList());

  socket.on('joinRoom', ({ roomId, userData }) => {
      const room = rooms[roomId];
      if (!room) return;
      socket.join(roomId);
      
      room.players[socket.id] = {
        x: 400, y: 500, // Spawn at Farm
        playerId: socket.id, 
        role: 'INNOCENT',
        name: userData.name || "Player", 
        skin: userData.skin || "bear", 
        isDead: false, 
        carrying: null,
        zone: ZONES.FARM // START IN FARM
      };

      const pCount = Object.keys(room.players).length;
      if (pCount === 1) room.players[socket.id].role = 'FARMER';
      if (pCount === 2) room.players[socket.id].role = 'WOLF';

      // Send Static World Data Once
      socket.emit('worldData', worldData);
      
      // Update Loop
      io.to(roomId).emit('currentPlayers', room.players);
      io.to(roomId).emit('itemsUpdate', room.items);
      socket.emit('taskUpdate', room.taskProgress);
      io.emit('roomListUpdate', getRoomList());
  });

  socket.on('playerMovement', ({ roomId, x, y, zone }) => {
      const room = rooms[roomId];
      if (room && room.players[socket.id]) {
          const p = room.players[socket.id];
          p.x = x; p.y = y;
          
          // HANDLE ZONE CHANGE (Door Logic)
          if (zone && p.zone !== zone) {
              p.zone = zone;
          }
          
          socket.to(roomId).emit('playerMoved', p);
      }
  });

  // PICKUP
  socket.on('pickupItem', ({ roomId, itemId }) => {
      const room = rooms[roomId];
      const player = room.players[socket.id];
      if (!room || !player || player.carrying) return;

      const idx = room.items.findIndex(i => i.id === itemId);
      if (idx !== -1) {
          const item = room.items[idx];
          // Must be in same zone
          if (item.zone === player.zone) {
              const dist = Math.sqrt((player.x - item.x)**2 + (player.y - item.y)**2);
              if (dist < 100) {
                  player.carrying = item.type;
                  room.items.splice(idx, 1);
                  io.to(roomId).emit('currentPlayers', room.players);
                  io.to(roomId).emit('itemsUpdate', room.items);
              }
          }
      }
  });

  // DELIVER (Only in Farm Zone near Barn)
  socket.on('deliverItem', ({ roomId }) => {
      const room = rooms[roomId];
      const player = room.players[socket.id];
      if (!room || !player || !player.carrying) return;

      if (player.zone === ZONES.FARM) {
          const dist = Math.sqrt((player.x - 400)**2 + (player.y - 375)**2); // Barn center
          if (dist < 200) {
              const type = player.carrying;
              player.carrying = null;
              room.taskProgress += 10;
              
              // Respawn logic
              setTimeout(() => {
                  let newItem = { id: Date.now().toString(), type: type, x: 400, y: 400, zone: ZONES.FARM };
                  if (type === 'ice-box') { newItem.zone = ZONES.ICE; newItem.x = 250; newItem.y = 250; }
                  if (type === 'stone') { newItem.zone = ZONES.VOLCANO; newItem.x = 500; newItem.y = 500; }
                  if (type === 'yucca') { newItem.zone = ZONES.DESERT; newItem.x = 400; newItem.y = 400; }
                  room.items.push(newItem);
                  io.to(room.id).emit('itemsUpdate', room.items);
              }, 5000);

              io.to(roomId).emit('currentPlayers', room.players);
              io.to(roomId).emit('taskUpdate', room.taskProgress);
              
              if (room.taskProgress >= 100) {
                  io.to(roomId).emit('gameOver', { winner: 'FARMERS' });
                  resetRoom(room);
              }
          }
      }
  });

  // KILL
  socket.on('killPlayer', ({ roomId, targetId }) => {
      const room = rooms[roomId];
      const killer = room.players[socket.id];
      const victim = room.players[targetId];
      // Must be in same zone
      if (killer && victim && killer.role === 'WOLF' && killer.zone === victim.zone) {
          victim.isDead = true;
          victim.carrying = null;
          io.to(roomId).emit('playerDied', { victimId: targetId });
          io.to(roomId).emit('currentPlayers', room.players);
          checkWinCondition(room);
      }
  });

  socket.on('disconnect', () => {
      Object.values(rooms).forEach(room => {
          if (room.players[socket.id]) {
              delete room.players[socket.id];
              io.to(room.id).emit('userDisconnected', socket.id);
              checkWinCondition(room);
          }
      });
  });
});

function checkWinCondition(room) { /* Same as before */ 
    const wolves = Object.values(room.players).filter(p => p.role === 'WOLF' && !p.isDead);
    const farmers = Object.values(room.players).filter(p => p.role !== 'WOLF' && !p.isDead);
    if(wolves.length === 0) { io.to(room.id).emit('gameOver', { winner: 'FARMERS' }); resetRoom(room); }
    else if(wolves.length >= farmers.length && farmers.length > 0) { io.to(room.id).emit('gameOver', { winner: 'WOLF' }); resetRoom(room); }
}

function resetRoom(room) {
    setTimeout(() => {
        Object.values(room.players).forEach(p => { p.isDead = false; p.role = 'INNOCENT'; p.carrying=null; p.x=400; p.y=500; p.zone='farm'; });
        room.items = JSON.parse(JSON.stringify(initialItems));
        room.taskProgress = 0;
        const ids = Object.keys(room.players);
        if(ids.length > 0) room.players[ids[Math.floor(Math.random()*ids.length)]].role = 'WOLF';
        io.to(room.id).emit('gameReset');
        io.to(room.id).emit('currentPlayers', room.players);
        io.to(room.id).emit('itemsUpdate', room.items);
    }, 5000);
}

function getRoomList() { return Object.values(rooms).map(r => ({ id: r.id, region: r.region, playerCount: Object.keys(r.players).length })); }

server.listen(3000);

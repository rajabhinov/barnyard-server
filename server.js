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
    methods: ["GET", "POST"],
    credentials: true
  }
});

app.use(express.static('public'));

/* ===================== CONSTANTS ===================== */
const ZONES = { FARM:'farm', ICE:'ice', VOLCANO:'volcano', DESERT:'desert' };
const MAP_SIZE = 800;
const KILL_COOLDOWN = 20000;
const EMERGENCY_LIMIT = 1;
const AFK_LIMIT = 120000;
const TRAP_RESET_TIME = 20000;

/* ===================== XP & RANK ===================== */
const RANKS = [
  { name:'Bronze', min:0 },
  { name:'Silver', min:500 },
  { name:'Gold', min:1500 },
  { name:'Platinum', min:3000 },
  { name:'Diamond', min:6000 }
];

const XP = {
  WIN:200,
  LOSE:50,
  TASK:25,
  KILL:100,
  SURVIVE:75
};

const getRank = xp =>
  [...RANKS].reverse().find(r => xp >= r.min).name;

/* ===================== UPDATED WORLD DATA ===================== */
const worldData = {
  farm: {
    walls: [{ x: 300, y: 300, w: 200, h: 150, type: 'barn' }],
    // Doors act as teleporters between zones
    doors: [
        { x: 380, y: 440, w: 40, h: 10, target: 'ice', tx: 400, ty: 100 },
        { x: 10, y: 400, w: 10, h: 40, target: 'desert', tx: 750, ty: 400 }
    ],
    decorations: [
      { x: 100, y: 150, type: 'tree', w: 80, h: 80 },
      { x: 600, y: 120, type: 'grass', w: 40, h: 30 },
      { x: 150, y: 550, type: 'bush', w: 50, h: 50 },
      { x: 500, y: 650, type: 'tree', w: 80, h: 80 },
      { x: 400, y: 350, type: 'task_station', w: 60, h: 60 } // Visual for task room
    ],
    trapDoors: [
      { id: 'td1', x: 350, y: 350, w: 60, h: 60, active: true },
      { id: 'td2', x: 500, y: 200, w: 60, h: 60, active: true }
    ]
  },
  ice: { 
    walls: [], 
    doors: [{ x: 380, y: 20, w: 40, h: 10, target: 'farm', tx: 400, ty: 400 }], 
    decorations: [
      { x: 200, y: 200, type: 'snow_pine', w: 70, h: 90 },
      { x: 500, y: 400, type: 'ice_rock', w: 60, h: 40 }
    ],
    trapDoors: [] 
  },
  volcano: { walls: [], doors: [], decorations: [{ x: 400, y: 400, type: 'lava_rock', w: 60, h: 60 }], trapDoors: [] },
  desert: { walls: [], doors: [], decorations: [{ x: 300, y: 300, type: 'cactus', w: 40, h: 60 }], trapDoors: [] }
};
/* ===================== ITEMS ===================== */
const initialItems = [
  { id:'bag1',type:'bag',x:200,y:200,zone:'farm' },
  { id:'ice1',type:'ice-box',x:250,y:250,zone:'ice' },
  { id:'stone1',type:'stone',x:500,y:500,zone:'volcano' },
  { id:'yucca1',type:'yucca',x:400,y:400,zone:'desert' }
];

/* ===================== ROOMS ===================== */
const rooms = {
  room_us:{
    id:'room_us',
    region:'US',
    players:{},
    items: JSON.parse(JSON.stringify(initialItems)),
    taskProgress:0,
    isMeeting:false,
    votes:{},
    bodies:[],
    footprints:[],
    replay:[]
  }
};

/* ===================== REPLAY LOGGER ===================== */
function logReplay(room, type, data) {
  room.replay.push({
    t: Date.now(),
    type,
    data
  });
  if (room.replay.length > 5000) room.replay.shift();
}

/* ===================== SOCKET.IO ===================== */
io.on('connection', socket => {

  socket.emit('roomListUpdate', getRoomList());

  socket.on('joinRoom', ({ roomId, userData }) => {
    const room = rooms[roomId];
    if (!room) return;

    socket.join(roomId);

    room.players[socket.id] = {
      id: socket.id,
      name: userData.name,
      skin: userData.skin,
      x:400,y:500,
      zone:'farm',
      role:'INNOCENT',
      isDead:false,
      carrying:false,
      xp:0,
      rank:'Bronze',
      lastKillTime:0,
      lastActive:Date.now()
    };

    assignWolf(room);

    socket.emit('worldData', worldData);
    io.to(roomId).emit('currentPlayers', room.players);
    io.to(roomId).emit('itemsUpdate', room.items);
  });

/* ===================== MOVEMENT ===================== */
socket.on('playerMovement', ({ roomId, x, y, zone }) => {
  const room = rooms[roomId];
  const p = room?.players[socket.id];
  if (!p || p.isDead) return;

  p.x=x; p.y=y; p.zone=zone;
  p.lastActive=Date.now();

  room.footprints.push({x,y,zone,by:p.id,time:Date.now()});
  logReplay(room,'MOVE',{id:p.id,x,y,zone});

  socket.to(roomId).emit('playerMoved', p);
});
  /* ===================== GHOST CHAT ===================== */
socket.on('ghostMessage', ({ roomId, text }) => {
  const room = rooms[roomId];
  const p = room?.players[socket.id];
  // Only allow dead players to use ghost chat
  if (p && p.isDead) {
    io.to(roomId).emit('ghostMessage', `${p.name}: ${text}`);
  }
});

/* ===================== NEW ROLE ACTIONS ===================== */
// Sheriff Kill Logic
socket.on('sheriffKill', ({ roomId, targetId }) => {
  const room = rooms[roomId];
  const sheriff = room.players[socket.id];
  const victim = room.players[targetId];

  if (sheriff?.role === 'SHERIFF' && !sheriff.isDead) {
    victim.isDead = true;
    // If Sheriff kills an Innocent, Sheriff dies too (Classic mechanic)
    if (victim.role !== 'WOLF') {
      sheriff.isDead = true;
      io.to(roomId).emit('playerDied', { victimId: sheriff.id });
    }
    io.to(roomId).emit('playerDied', { victimId: victim.id });
    checkWinCondition(room);
  }
});

// Medic Revive Logic
socket.on('revivePlayer', ({ roomId, targetId }) => {
  const room = rooms[roomId];
  const medic = room.players[socket.id];
  const victim = room.players[targetId];

  if (medic?.role === 'MEDIC' && !medic.isDead && victim?.isDead) {
    victim.isDead = false;
    io.to(roomId).emit('currentPlayers', room.players); // Refresh state
  }
});

/* ===================== KILL ===================== */
socket.on('killPlayer', ({ roomId, targetId }) => {
  const room = rooms[roomId];
  const killer = room.players[socket.id];
  const victim = room.players[targetId];
  if (!killer || !victim) return;
  if (killer.role!=='WOLF'||killer.isDead||victim.isDead) return;
  if (Date.now()-killer.lastKillTime<KILL_COOLDOWN) return;

  killer.lastKillTime=Date.now();
  victim.isDead=true;

  room.bodies.push({x:victim.x,y:victim.y,zone:victim.zone});
  logReplay(room,'KILL',{killer:killer.id,victim:victim.id});

  io.to(roomId).emit('playerDied',{victimId:victim.id});
  checkWinCondition(room);
});

/* ===================== BODY REPORT ===================== */
socket.on('reportBody', ({ roomId }) => {
  const room = rooms[roomId];
  if (!room || room.isMeeting) return;

  room.isMeeting = true;
  logReplay(room,'REPORT',{by:socket.id});

  io.to(roomId).emit('meetingStarted', room.players);
});

/* ===================== TRAP DOORS ===================== */
socket.on('triggerTrapDoor', ({ roomId, trapId }) => {
  const room = rooms[roomId];
  const wolf = room.players[socket.id];
  if (!room || !wolf || wolf.role !== 'WOLF') return;

  const zone = wolf.zone;
  const trap = worldData[zone].trapDoors.find(t => t.id === trapId);
  if (!trap || !trap.active) return;

  Object.values(room.players).forEach(p => {
    if (
      !p.isDead &&
      p.zone === zone &&
      Math.abs(p.x - trap.x) < 40 &&
      Math.abs(p.y - trap.y) < 40
    ) {
      p.isDead = true;
      room.bodies.push({x:p.x,y:p.y,zone});
      logReplay(room,'TRAP',{victim:p.id,trapId});
      io.to(roomId).emit('playerDied',{victimId:p.id,reason:'TRAP'});
    }
  });

  trap.active = false;
  setTimeout(() => trap.active = true, TRAP_RESET_TIME);

  checkWinCondition(room);
});

/* ===================== VOTING ===================== */
socket.on('votePlayer', ({ roomId, targetId }) => {
  const room = rooms[roomId];
  if (!room || room.votes[socket.id]) return;

  room.votes[socket.id]=true;
  room.votes[targetId]=(room.votes[targetId]||0)+1;
  logReplay(room,'VOTE',{from:socket.id,to:targetId});

  io.to(roomId).emit('voteUpdate', room.votes);
});

/* ===================== DISCONNECT ===================== */
socket.on('disconnect', () => {
  Object.values(rooms).forEach(room => {
    delete room.players[socket.id];
    io.to(room.id).emit('currentPlayers', room.players);
  });
});

});

/* ===================== HELPERS ===================== */
function assignWolf(room){
  const ids = Object.keys(room.players);
  if(ids.length>=2 && !ids.some(i=>room.players[i].role==='WOLF')){
    room.players[ids[Math.floor(Math.random()*ids.length)]].role='WOLF';
  }
}

function checkWinCondition(room){
  const wolves=Object.values(room.players).filter(p=>p.role==='WOLF'&&!p.isDead);
  const farmers=Object.values(room.players).filter(p=>p.role!=='WOLF'&&!p.isDead);

  if(wolves.length===0) endGame(room,'FARMERS');
  else if(wolves.length>=farmers.length && farmers.length>0) endGame(room,'WOLF');
}

function endGame(room,winner){
  logReplay(room,'GAME_END',{winner});

  io.to(room.id).emit('gameOver',{
    winner,
    replay: room.replay
  });

  setTimeout(()=>resetRoom(room),5000);
}

function resetRoom(room){
  room.items=JSON.parse(JSON.stringify(initialItems));
  room.votes={};
  room.bodies=[];
  room.footprints=[];
  room.isMeeting=false;
  room.replay=[];

  Object.values(room.players).forEach(p=>{
    p.isDead=false;
    p.role='INNOCENT';
    p.x=400;p.y=500;p.zone='farm';
  });

  assignWolf(room);
  io.to(room.id).emit('currentPlayers',room.players);
}

function getRoomList(){
  return Object.values(rooms).map(r=>({
    id:r.id,
    region:r.region,
    players:Object.keys(r.players).length
  }));
}

/* ===================== AFK ===================== */
setInterval(()=>{
  Object.values(rooms).forEach(room=>{
    Object.entries(room.players).forEach(([id,p])=>{
      if(Date.now()-p.lastActive>AFK_LIMIT){
        delete room.players[id];
        io.to(room.id).emit('playerAFK',id);
      }
    });
  });
},30000);

/* ===================== START ===================== */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log("🔥 Game Server running on port", PORT)
);



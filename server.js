/*********************************************************
 * INDICER PET MULTIPLAYER GAME SERVER
 * FINAL SINGLE FILE (ALL FEATURES)
 *********************************************************/

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

/* =====================================================
   CONSTANTS
===================================================== */
const ZONES = { FARM:'farm', ICE:'ice', VOLCANO:'volcano', DESERT:'desert' };
const MAP_SIZE = 800;
const KILL_COOLDOWN = 20000;
const EMERGENCY_LIMIT = 1;
const AFK_LIMIT = 120000;

/* ================= XP & RANK ================= */
const RANKS = [
  { name:'Bronze', min:0 },
  { name:'Silver', min:500 },
  { name:'Gold', min:1500 },
  { name:'Platinum', min:3000 },
  { name:'Diamond', min:6000 }
];
const XP = { WIN:200, LOSE:50, TASK:25, KILL:100, SURVIVE:75 };

function getRank(xp){
  return [...RANKS].reverse().find(r => xp >= r.min).name;
}

/* =====================================================
   WORLD DATA
===================================================== */
const worldData = {
  farm:{ walls:[], doors:[], decorations:[] },
  ice:{ walls:[], doors:[], decorations:[] },
  volcano:{ walls:[], doors:[], decorations:[] },
  desert:{ walls:[], doors:[], decorations:[] }
};

/* FARM */
worldData.farm.walls.push({x:300,y:300,w:200,h:150,type:'barn'});
worldData.farm.doors = [
  {x:370,y:20,w:60,h:60,target:'ice',tx:400,ty:700},
  {x:370,y:720,w:60,h:60,target:'volcano',tx:400,ty:100},
  {x:20,y:370,w:60,h:60,target:'desert',tx:700,ty:400}
];
for(let i=0;i<40;i++){
  worldData.farm.decorations.push({
    x:Math.random()*700+50,
    y:Math.random()*700+50,
    w:30,h:20,
    type:`grass (${Math.floor(Math.random()*9)+1})`
  });
}

/* ICE */
worldData.ice.walls.push({x:200,y:200,w:100,h:100,type:'cave'});
worldData.ice.doors.push({x:370,y:720,w:60,h:60,target:'farm',tx:400,ty:100});

/* VOLCANO */
worldData.volcano.walls.push({x:300,y:300,w:120,h:120,type:'lava_pit'});
worldData.volcano.doors.push({x:370,y:20,w:60,h:60,target:'farm',tx:400,ty:700});

/* DESERT */
worldData.desert.walls.push({x:200,y:200,w:60,h:80,type:'cactus'});
worldData.desert.doors.push({x:720,y:370,w:60,h:60,target:'farm',tx:100,ty:400});
worldData.desert.decorations.push({x:300,y:500,w:80,h:80,type:'camel'});

/* =====================================================
   ITEMS
===================================================== */
const initialItems = [
  {id:'bag1',type:'bag',x:200,y:200,zone:'farm'},
  {id:'ice1',type:'ice-box',x:250,y:250,zone:'ice'},
  {id:'stone1',type:'stone',x:500,y:500,zone:'volcano'},
  {id:'yucca1',type:'yucca',x:400,y:400,zone:'desert'}
];

/* =====================================================
   ROOMS
===================================================== */
const rooms = {
  room_us:{ id:'room_us', region:'US', players:{}, items:[], taskProgress:0, isMeeting:false, votes:{} }
};
rooms.room_us.items = JSON.parse(JSON.stringify(initialItems));

/* =====================================================
   BOTS
===================================================== */
function createBot(id){
  return {
    isBot:true,
    playerId:id,
    name:`Bot_${id.slice(-3)}`,
    x:Math.random()*600+100,
    y:Math.random()*600+100,
    role:'INNOCENT',
    isDead:false,
    carrying:null,
    zone:'farm',
    lastKillTime:0,
    xp:0,
    rank:'Bronze',
    lastActive:Date.now()
  };
}

function ensureBots(room, min=6){
  while(Object.keys(room.players).length < min){
    const id='bot_'+Math.random().toString(36).slice(2);
    room.players[id]=createBot(id);
  }
}

/* =====================================================
   SOCKET.IO
===================================================== */
io.on('connection', socket => {

  socket.emit('roomListUpdate', getRoomList());

  socket.on('joinRoom', ({roomId,userData})=>{
    const room=rooms[roomId];
    if(!room) return;
    socket.join(roomId);

    room.players[socket.id]={
      playerId:socket.id,
      name:userData?.name||'Player',
      skin:userData?.skin||'bear',
      x:400,y:500,
      role:'INNOCENT',
      isDead:false,
      carrying:null,
      zone:'farm',
      lastKillTime:0,
      emergenciesUsed:0,
      xp:0,
      rank:'Bronze',
      lastActive:Date.now()
    };

    ensureBots(room);

    const ids=Object.keys(room.players);
    if(ids.length>=2){
      room.players[ids[Math.floor(Math.random()*ids.length)]].role='WOLF';
    }

    socket.emit('worldData', worldData);
    io.to(roomId).emit('currentPlayers', room.players);
    io.to(roomId).emit('itemsUpdate', room.items);
    socket.emit('taskUpdate', room.taskProgress);
  });

  socket.on('playerMovement', ({roomId,x,y,zone})=>{
    const r=rooms[roomId];
    const p=r?.players[socket.id];
    if(!p) return;
    p.x=x; p.y=y; p.zone=zone; p.lastActive=Date.now();
    socket.to(roomId).emit('playerMoved', p);
  });

  socket.on('pickupItem', ({roomId,itemId})=>{
    const r=rooms[roomId];
    const p=r?.players[socket.id];
    if(!p||p.carrying) return;
    const idx=r.items.findIndex(i=>i.id===itemId && i.zone===p.zone);
    if(idx!==-1){
      p.carrying=r.items[idx].type;
      r.items.splice(idx,1);
      io.to(roomId).emit('itemsUpdate', r.items);
      io.to(roomId).emit('currentPlayers', r.players);
    }
  });

  socket.on('deliverItem', ({roomId})=>{
    const r=rooms[roomId];
    const p=r?.players[socket.id];
    if(!p||!p.carrying||p.zone!=='farm') return;
    p.carrying=null;
    p.xp+=XP.TASK;
    p.rank=getRank(p.xp);
    r.taskProgress+=10;
    io.to(roomId).emit('taskUpdate', r.taskProgress);
    io.to(roomId).emit('xpUpdate', r.players);
    if(r.taskProgress>=100){
      io.to(roomId).emit('gameOver',{winner:'FARMERS'});
      resetRoom(r);
    }
  });

  socket.on('killPlayer', ({roomId,targetId})=>{
    const r=rooms[roomId];
    const killer=r?.players[socket.id];
    const victim=r?.players[targetId];
    const now=Date.now();
    if(!killer||!victim||killer.role!=='WOLF'||killer.isDead||victim.isDead) return;
    if(now-killer.lastKillTime < KILL_COOLDOWN) return;
    killer.lastKillTime=now;
    victim.isDead=true;
    killer.xp+=XP.KILL;
    killer.rank=getRank(killer.xp);
    io.to(roomId).emit('playerDied',{victimId:targetId});
    io.to(roomId).emit('xpUpdate', r.players);
    checkWinCondition(r);
  });

  socket.on('emergencyMeeting', ({roomId})=>{
    const r=rooms[roomId];
    const p=r?.players[socket.id];
    if(!p||p.isDead||p.emergenciesUsed>=EMERGENCY_LIMIT) return;
    p.emergenciesUsed++;
    r.isMeeting=true;
    Object.values(r.players).forEach(pl=>{
      if(!pl.isDead){ pl.x=400; pl.y=500; pl.zone='farm'; }
    });
    io.to(roomId).emit('meetingStarted', r.players);
  });

  socket.on('votePlayer', ({roomId,targetId})=>{
    const r=rooms[roomId];
    if(!r||r.votes[socket.id]) return;
    r.votes[targetId]=(r.votes[targetId]||0)+1;
    r.votes[socket.id]=true;
    io.to(roomId).emit('voteUpdate', r.votes);
  });

  socket.on('disconnect', ()=>{
    Object.values(rooms).forEach(r=>{
      if(r.players[socket.id]){
        delete r.players[socket.id];
        io.to(r.id).emit('userDisconnected', socket.id);
      }
    });
  });
});

/* =====================================================
   GAME HELPERS
===================================================== */
function checkWinCondition(room){
  const wolves=Object.values(room.players).filter(p=>p.role==='WOLF'&&!p.isDead);
  const farmers=Object.values(room.players).filter(p=>p.role!=='WOLF'&&!p.isDead);
  if(wolves.length===0){
    io.to(room.id).emit('gameOver',{winner:'FARMERS'});
    resetRoom(room);
  }else if(wolves.length>=farmers.length && farmers.length>0){
    io.to(room.id).emit('gameOver',{winner:'WOLF'});
    resetRoom(room);
  }
}

function resetRoom(room){
  setTimeout(()=>{
    room.items=JSON.parse(JSON.stringify(initialItems));
    room.taskProgress=0;
    Object.values(room.players).forEach(p=>{
      p.isDead=false;
      p.role='INNOCENT';
      p.x=400;p.y=500;p.zone='farm';
    });
    const ids=Object.keys(room.players);
    if(ids.length) room.players[ids[Math.floor(Math.random()*ids.length)]].role='WOLF';
    io.to(room.id).emit('gameReset');
  },5000);
}

function getRoomList(){
  return Object.values(rooms).map(r=>({
    id:r.id,
    region:r.region,
    players:Object.keys(r.players).length
  }));
}

/* =====================================================
   ANTI AFK
===================================================== */
setInterval(()=>{
  Object.values(rooms).forEach(r=>{
    Object.entries(r.players).forEach(([id,p])=>{
      if(!p.isBot && Date.now()-p.lastActive > AFK_LIMIT){
        delete r.players[id];
        io.to(r.id).emit('playerAFK', id);
      }
    });
  });
},30000);

/* =====================================================
   BOT BRAIN
===================================================== */
setInterval(()=>{
  Object.values(rooms).forEach(r=>{
    Object.values(r.players).forEach(b=>{
      if(!b.isBot||b.isDead||r.isMeeting) return;
      b.x+=Math.random()*10-5;
      b.y+=Math.random()*10-5;
      b.x=Math.max(40,Math.min(760,b.x));
      b.y=Math.max(40,Math.min(760,b.y));
      if(b.role==='WOLF' && Date.now()-b.lastKillTime>KILL_COOLDOWN){
        const victims=Object.values(r.players).filter(p=>!p.isDead&&!p.isBot);
        if(victims.length){
          const v=victims[Math.floor(Math.random()*victims.length)];
          v.isDead=true;
          b.lastKillTime=Date.now();
          io.to(r.id).emit('playerDied',{victimId:v.playerId});
        }
      }
    });
    io.to(r.id).emit('currentPlayers', r.players);
  });
},1000);

/* =====================================================
   START SERVER
===================================================== */
server.listen(3000, ()=>console.log("🔥 Game Server running on port 3000"));

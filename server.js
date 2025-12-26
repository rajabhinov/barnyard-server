const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");

// ALLOW FIREBASE TO CONNECT (CORS)
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

// --- GAME STATE ---
const rooms = {
    'room_us': { id: 'room_us', region: 'US Central', players: {}, votes: {}, isMeeting: false, walls: [] },
    'room_asia': { id: 'room_asia', region: 'Asia East', players: {}, votes: {}, isMeeting: false, walls: [] },
    'room_eu': { id: 'room_eu', region: 'Europe', players: {}, votes: {}, isMeeting: false, walls: [] },
};

// Map Layout
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
  socket.emit('roomListUpdate', getRoomList());

  // 1. JOIN ROOM
  socket.on('joinRoom', ({ roomId, userData }) => {
      const room = rooms[roomId];
      if (!room) return;

      socket.join(roomId);
      
      room.players[socket.id] = {
        x: Math.floor(Math.random() * 700) + 50,
        y: Math.floor(Math.random() * 500) + 50,
        playerId: socket.id,
        role: 'INNOCENT', // Default
        name: userData.name || "Player", 
        skin: userData.skin || "bear",
        isDead: false,
        direction: 1
      };

      // Assign Roles: 1st = Farmer, 2nd = Wolf
      const pCount = Object.keys(room.players).length;
      if (pCount === 1) room.players[socket.id].role = 'FARMER';
      if (pCount === 2) room.players[socket.id].role = 'WOLF';

      io.to(roomId).emit('currentPlayers', room.players);
      socket.emit('mapData', room.walls);
      io.emit('roomListUpdate', getRoomList());
  });

  // 2. MOVEMENT
  socket.on('playerMovement', ({ roomId, x, y }) => {
      const room = rooms[roomId];
      if (room && room.players[socket.id] && !room.isMeeting && !room.players[socket.id].isDead) {
          const p = room.players[socket.id];
          p.x = x; p.y = y;
          socket.to(roomId).emit('playerMoved', p);
      }
  });

  // 3. KILL PLAYER
  socket.on('killPlayer', ({ roomId, targetId }) => {
      const room = rooms[roomId];
      if (room && room.players[socket.id]?.role === 'WOLF') {
          room.players[targetId].isDead = true;
          io.to(roomId).emit('playerDied', { victimId: targetId });
          checkWinCondition(room); // Did Wolf just win?
      }
  });

  // 4. REPORT BODY (Start Meeting)
  socket.on('reportBody', ({ roomId }) => {
      const room = rooms[roomId];
      if (room && !room.isMeeting) {
          room.isMeeting = true;
          room.votes = {};
          io.to(roomId).emit('meetingStarted');
          
          // Force end meeting after 45 seconds if voting takes too long
          setTimeout(() => {
              if (room.isMeeting) endMeeting(room);
          }, 45000);
      }
  });

  // 5. CAST VOTE
  socket.on('castVote', (targetId) => {
      // Find which room this player is in
      let room = null;
      Object.values(rooms).forEach(r => { if(r.players[socket.id]) room = r; });

      if (room && room.isMeeting && !room.players[socket.id].isDead) {
          room.votes[socket.id] = targetId;
          
          // Check if everyone has voted
          const livingCount = Object.values(room.players).filter(p => !p.isDead).length;
          const voteCount = Object.keys(room.votes).length;
          
          // If everyone voted, end immediately
          if (voteCount >= livingCount) {
              endMeeting(room);
          }
      }
  });

  // 6. DISCONNECT
  socket.on('disconnect', () => {
      Object.values(rooms).forEach(room => {
          if (room.players[socket.id]) {
              delete room.players[socket.id];
              io.to(room.id).emit('userDisconnected', socket.id);
              checkWinCondition(room); // Did the Wolf quit?
          }
      });
      io.emit('roomListUpdate', getRoomList());
  });
});

// --- HELPER FUNCTIONS ---

function endMeeting(room) {
    if (!room.isMeeting) return;

    // 1. Tally Votes
    let tallies = {};
    let maxVotes = 0;
    let ejectedId = null;
    let tie = false;

    Object.values(room.votes).forEach(target => {
        tallies[target] = (tallies[target] || 0) + 1;
        if (tallies[target] > maxVotes) {
            maxVotes = tallies[target];
            ejectedId = target;
            tie = false;
        } else if (tallies[target] === maxVotes) {
            tie = true;
        }
    });

    // 2. Eject Logic
    if (ejectedId && !tie && room.players[ejectedId]) {
        room.players[ejectedId].isDead = true;
        io.to(room.id).emit('playerDied', { victimId: ejectedId }); // Show them dying
    }

    // 3. Close Meeting UI
    io.to(room.id).emit('meetingEnded', { ejectedId: tie ? null : ejectedId });
    room.isMeeting = false;
    room.votes = {};

    // 4. Check if game ended
    checkWinCondition(room);
}

function checkWinCondition(room) {
    const players = Object.values(room.players);
    const wolves = players.filter(p => p.role === 'WOLF' && !p.isDead);
    const farmers = players.filter(p => p.role !== 'WOLF' && !p.isDead);

    // WIN CONDITION 1: No Wolves Left
    if (wolves.length === 0 && players.length > 0) {
        io.to(room.id).emit('gameOver', { winner: 'FARMERS' });
        resetRoom(room);
        return;
    }
    
    // WIN CONDITION 2: Wolves Outnumber/Equal Farmers
    if (wolves.length >= farmers.length && players.length > 0) {
        io.to(room.id).emit('gameOver', { winner: 'WOLF' });
        resetRoom(room);
        return;
    }
}

function resetRoom(room) {
    console.log(`Resetting room ${room.id}...`);
    setTimeout(() => {
        // Reset all players
        const ids = Object.keys(room.players);
        ids.forEach(id => {
            room.players[id].isDead = false;
            room.players[id].role = 'INNOCENT'; // Reset roles
            room.players[id].x = Math.floor(Math.random() * 700) + 50;
            room.players[id].y = Math.floor(Math.random() * 500) + 50;
        });

        // Re-assign roles randomly
        if (ids.length > 0) {
            // Pick random wolf
            const wolfId = ids[Math.floor(Math.random() * ids.length)];
            room.players[wolfId].role = 'WOLF';
            
            // Pick random farmer (if more than 1 player)
            if (ids.length > 1) {
                let farmerId = ids[Math.floor(Math.random() * ids.length)];
                while(farmerId === wolfId) farmerId = ids[Math.floor(Math.random() * ids.length)];
                room.players[farmerId].role = 'FARMER';
            }
        }

        room.isMeeting = false;
        room.votes = {};

        // Send fresh state
        io.to(room.id).emit('currentPlayers', room.players);
        io.to(room.id).emit('gameReset');
        
    }, 5000); // 5 second delay to show "Victory" screen
}

function getRoomList() {
    return Object.values(rooms).map(r => ({
        id: r.id,
        region: r.region,
        playerCount: Object.keys(r.players).length,
        maxPlayers: 12,
        previewSkins: Object.values(r.players).map(p => p.skin).slice(0, 5)
    }));
}

server.listen(3000, () => {
  console.log('Barnyard Server running on 3000');
});

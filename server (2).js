const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Ultra-fast WebSocket configuration (zero polling overhead)
const io = new Server(server, {
  cors: { origin: "*" },
  transports: ['websocket', 'polling'],
  pingInterval: 5000,
  pingTimeout: 4000,
  perMessageDeflate: false
});

app.use(express.static(__dirname));
app.get('/ping', (req, res) => res.send('pong'));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const SUITS = ['spades', 'hearts', 'clubs', 'diamonds'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const RANK_VAL = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7,
  '8': 8, '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14
};

const rooms = new Map();

function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ suit, rank, id: `${rank}_${suit}` });
    }
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function getRoom(code) {
  if (!rooms.has(code)) {
    rooms.set(code, {
      code,
      seats: [null, null, null, null], // 0 & 2 = Team A, 1 & 3 = Team B
      status: 'lobby', // lobby, shuffling, trump, playing, finished
      deck: [],
      hands: [[], [], [], []],
      trump: null,
      trumpSelector: 0,
      turn: 0,
      trick: [], // [{ seat, card }]
      leadSuit: null,
      pendingTricks: [], // Double Sir consecutive tricks pile
      lastWinner: null,
      lastTeam: null,
      scores: { A: 0, B: 0 },
      chat: []
    });
  }
  return rooms.get(code);
}

function broadcastRoom(room) {
  for (let s = 0; s < 4; s++) {
    const p = room.seats[s];
    if (p && p.socketId) {
      io.to(p.socketId).emit('state', serializeForSeat(room, s));
    }
  }
  // Also broadcast to any unassigned sockets in room
  io.to(room.code).emit('lobby_update', {
    code: room.code,
    status: room.status,
    seats: room.seats.map((p, idx) => p ? { seat: idx, name: p.name, isBot: !!p.isBot, online: p.online !== false } : null)
  });
}

function serializeForSeat(room, seat) {
  return {
    code: room.code,
    mySeat: seat,
    status: room.status,
    seats: room.seats.map((p, idx) => p ? {
      seat: idx,
      name: p.name,
      isBot: !!p.isBot,
      online: p.online !== false,
      cardCount: room.hands[idx] ? room.hands[idx].length : 0
    } : null),
    hand: room.hands[seat] || [],
    trump: room.trump,
    trumpSelector: room.trumpSelector,
    turn: room.turn,
    trick: room.trick,
    leadSuit: room.leadSuit,
    pendingCount: room.pendingTricks.length,
    lastWinner: room.lastWinner,
    lastTeam: room.lastTeam,
    scores: room.scores
  };
}

function startNewRound(room) {
  room.status = 'shuffling';
  room.deck = createDeck();
  room.hands = [[], [], [], []];
  room.trump = null;
  room.trick = [];
  room.leadSuit = null;
  room.pendingTricks = [];
  room.lastWinner = null;
  room.lastTeam = null;
  room.scores = { A: 0, B: 0 };

  // Deal first 5 cards to each player
  for (let i = 0; i < 5; i++) {
    for (let s = 0; s < 4; s++) {
      room.hands[s].push(room.deck.pop());
    }
  }
  room.turn = room.trumpSelector;
  broadcastRoom(room);

  // Fast 750ms shuffle transition
  setTimeout(() => {
    if (room.status !== 'shuffling') return;
    room.status = 'trump';
    broadcastRoom(room);
    triggerBotIfNeeded(room);
  }, 750);
}

function selectTrump(room, seat, suit) {
  if (room.status !== 'trump' || room.trumpSelector !== seat) return;
  if (!SUITS.includes(suit)) return;
  room.trump = suit;

  // Deal remaining 8 cards to each player
  for (let i = 0; i < 8; i++) {
    for (let s = 0; s < 4; s++) {
      room.hands[s].push(room.deck.pop());
    }
  }
  room.status = 'playing';
  room.turn = seat;
  broadcastRoom(room);
  triggerBotIfNeeded(room);
}

function isValidMove(hand, card, leadSuit) {
  if (!leadSuit) return true;
  const hasLead = hand.some(c => c.suit === leadSuit);
  if (hasLead) return card.suit === leadSuit;
  return true;
}

function determineTrickWinner(trick, leadSuit, trump) {
  let best = trick[0];
  for (let i = 1; i < trick.length; i++) {
    const curr = trick[i];
    const bestIsTrump = best.card.suit === trump;
    const currIsTrump = curr.card.suit === trump;
    if (currIsTrump && !bestIsTrump) {
      best = curr;
    } else if (currIsTrump && bestIsTrump) {
      if (RANK_VAL[curr.card.rank] > RANK_VAL[best.card.rank]) best = curr;
    } else if (!currIsTrump && !bestIsTrump && curr.card.suit === leadSuit) {
      if (RANK_VAL[curr.card.rank] > RANK_VAL[best.card.rank]) best = curr;
    }
  }
  return best.seat;
}

function playCard(room, seat, cardId) {
  if (room.status !== 'playing' || room.turn !== seat) return;
  if (room.trick.length >= 4) return;

  const hand = room.hands[seat];
  const idx = hand.findIndex(c => c.id === cardId);
  if (idx === -1) return;

  const card = hand[idx];
  if (!isValidMove(hand, card, room.leadSuit)) return;

  hand.splice(idx, 1);
  if (room.trick.length === 0) room.leadSuit = card.suit;
  room.trick.push({ seat, card });

  if (room.trick.length < 4) {
    room.turn = (seat + 1) % 4;
    broadcastRoom(room);
    triggerBotIfNeeded(room);
  } else {
    // Trick complete - evaluate immediately
    const winner = determineTrickWinner(room.trick, room.leadSuit, room.trump);
    const winnerTeam = (winner === 0 || winner === 2) ? 'A' : 'B';

    room.pendingTricks.push({ trick: [...room.trick], winner, team: winnerTeam });

    // Double Sir rule: 2 consecutive tricks by same team captures the pile!
    if (room.lastTeam === winnerTeam && room.pendingTricks.length >= 2) {
      room.scores[winnerTeam] += room.pendingTricks.length;
      room.pendingTricks = [];
      room.lastTeam = null;
    } else {
      room.lastTeam = winnerTeam;
    }

    room.lastWinner = winner;
    room.turn = -1; // Lock turn briefly during 750ms trick display
    broadcastRoom(room);

    setTimeout(() => {
      if (room.status !== 'playing') return;
      room.trick = [];
      room.leadSuit = null;

      // Check if all 13 cards played
      if (room.hands[0].length === 0) {
        if (room.pendingTricks.length > 0) {
          room.scores[winnerTeam] += room.pendingTricks.length;
          room.pendingTricks = [];
        }
        room.status = 'finished';
        room.trumpSelector = (room.trumpSelector + 1) % 4;
        broadcastRoom(room);
      } else {
        room.turn = winner;
        broadcastRoom(room);
        triggerBotIfNeeded(room);
      }
    }, 750);
  }
}

function triggerBotIfNeeded(room) {
  if (room.status !== 'trump' && room.status !== 'playing') return;
  const seat = room.turn;
  if (seat < 0 || seat > 3) return;
  const player = room.seats[seat];
  if (!player || !player.isBot) return;

  setTimeout(() => {
    if (room.turn !== seat) return;
    if (room.status === 'trump') {
      const counts = { spades: 0, hearts: 0, clubs: 0, diamonds: 0 };
      room.hands[seat].forEach(c => counts[c.suit] += RANK_VAL[c.rank]);
      const bestSuit = Object.keys(counts).reduce((a, b) => counts[a] > counts[b] ? a : b);
      selectTrump(room, seat, bestSuit);
    } else if (room.status === 'playing') {
      const hand = room.hands[seat];
      const valid = hand.filter(c => isValidMove(hand, c, room.leadSuit));
      if (valid.length > 0) {
        // Smart quick bot move
        valid.sort((a, b) => RANK_VAL[b.rank] - RANK_VAL[a.rank]);
        const chosen = room.trick.length === 0 ? valid[0] : valid[valid.length - 1];
        playCard(room, seat, chosen.id);
      }
    }
  }, 350);
}

io.on('connection', (socket) => {
  // Latency ping responder
  socket.on('latency_ping', (cb) => {
    if (typeof cb === 'function') cb();
  });

  socket.on('join_room', ({ code, name, seat }) => {
    const cleanCode = (code || 'RANG1').trim().toUpperCase();
    const cleanName = (name || 'Player').trim().slice(0, 16);
    const room = getRoom(cleanCode);
    socket.join(cleanCode);
    socket.data.roomCode = cleanCode;
    socket.data.name = cleanName;

    // Reconnect check by name if already seated
    let existingSeat = room.seats.findIndex(p => p && !p.isBot && p.name.toLowerCase() === cleanName.toLowerCase());
    if (existingSeat !== -1) {
      room.seats[existingSeat].socketId = socket.id;
      room.seats[existingSeat].online = true;
      socket.data.seat = existingSeat;
      broadcastRoom(room);
      return;
    }

    // Specific seat or first open seat
    let targetSeat = (typeof seat === 'number' && seat >= 0 && seat <= 3 && !room.seats[seat])
      ? seat
      : room.seats.findIndex(s => s === null);

    if (targetSeat !== -1) {
      room.seats[targetSeat] = { name: cleanName, socketId: socket.id, isBot: false, online: true };
      socket.data.seat = targetSeat;
    }
    broadcastRoom(room);
  });

  socket.on('take_seat', ({ seat }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.status !== 'lobby') return;
    if (seat < 0 || seat > 3) return;
    if (room.seats[seat] && !room.seats[seat].isBot) return;

    // Remove from old seat if any
    const old = room.seats.findIndex(p => p && p.socketId === socket.id);
    if (old !== -1) room.seats[old] = null;

    room.seats[seat] = { name: socket.data.name || 'Player', socketId: socket.id, isBot: false, online: true };
    socket.data.seat = seat;
    broadcastRoom(room);
  });

  socket.on('fill_bots', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.status !== 'lobby') return;
    const botNames = ['Bot Ali', 'Bot Sara', 'Bot Bilal', 'Bot Zain'];
    for (let i = 0; i < 4; i++) {
      if (!room.seats[i]) {
        room.seats[i] = { name: botNames[i], socketId: null, isBot: true, online: true };
      }
    }
    broadcastRoom(room);
  });

  socket.on('start_game', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const botNames = ['Bot Ali', 'Bot Sara', 'Bot Bilal', 'Bot Zain'];
    for (let i = 0; i < 4; i++) {
      if (!room.seats[i]) {
        room.seats[i] = { name: botNames[i], socketId: null, isBot: true, online: true };
      }
    }
    startNewRound(room);
  });

  socket.on('choose_trump', (suit) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const seat = room.seats.findIndex(p => p && p.socketId === socket.id);
    if (seat !== -1) selectTrump(room, seat, suit);
  });

  socket.on('play_card', (cardId) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const seat = room.seats.findIndex(p => p && p.socketId === socket.id);
    if (seat !== -1) playCard(room, seat, cardId);
  });

  socket.on('chat_msg', (text) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !text) return;
    io.to(room.code).emit('chat_msg', {
      sender: socket.data.name || 'Player',
      text: String(text).slice(0, 120)
    });
  });

  // WebRTC Voice Signaling
  socket.on('voice_signal', ({ toSeat, signal }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const fromSeat = room.seats.findIndex(p => p && p.socketId === socket.id);
    const target = room.seats[toSeat];
    if (fromSeat !== -1 && target && target.socketId) {
      io.to(target.socketId).emit('voice_signal', { fromSeat, signal });
    }
  });

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const seat = room.seats.findIndex(p => p && p.socketId === socket.id);
    if (seat !== -1) {
      room.seats[seat].online = false;
      broadcastRoom(room);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Ultra-Fast Rang Club server running on port ${PORT}`);
});

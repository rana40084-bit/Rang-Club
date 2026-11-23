const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  transports: ['websocket', 'polling'],
  pingInterval: 5000,
  pingTimeout: 10000
});

app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const SUITS = ['spades', 'hearts', 'diamonds', 'clubs'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const RANK_VALUES = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8,
  '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14
};

const rooms = {};

function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ suit, rank, value: RANK_VALUES[rank], id: `${rank}_${suit}` });
    }
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function getRoomStateForPlayer(room, playerIndex) {
  return {
    roomId: room.id,
    phase: room.phase,
    trumpSuit: room.trumpSuit,
    turn: room.turn,
    trumpCaller: room.trumpCaller,
    dealer: room.dealer,
    mySeat: playerIndex,
    players: room.players.map((p, idx) => ({
      seat: idx,
      name: p.name,
      avatar: p.avatar,
      isBot: p.isBot,
      team: idx % 2 === 0 ? 'A' : 'B',
      cardCount: p.hand.length
    })),
    hand: room.players[playerIndex] ? room.players[playerIndex].hand : [],
    tableCards: room.tableCards,
    tricksWon: room.tricksWon,
    consecutiveTricks: room.consecutiveTricks,
    sirs: room.sirs,
    completedSirsLog: room.completedSirsLog,
    lastTrickWinner: room.lastTrickWinner
  };
}

function broadcastRoom(room) {
  room.players.forEach((p, idx) => {
    if (!p.isBot && p.socketId) {
      io.to(p.socketId).emit('gameState', getRoomStateForPlayer(room, idx));
    }
  });
}

function startNewRound(room) {
  room.deck = createDeck();
  room.tableCards = [];
  room.tricksWon = { A: 0, B: 0 };
  room.consecutiveTricks = { team: null, count: 0 };
  room.lastTrickWinner = null;
  room.trumpSuit = null;
  room.phase = 'DEALING_5';

  // Deal 5 cards first for Trump selection
  for (let i = 0; i < 4; i++) {
    room.players[i].hand = room.deck.slice(i * 5, (i + 1) * 5);
  }

  room.trumpCaller = (room.dealer + 1) % 4;
  room.turn = room.trumpCaller;
  room.phase = 'SELECT_TRUMP';

  room.players.forEach((p, idx) => {
    if (!p.isBot && p.socketId) {
      io.to(p.socketId).emit('animateShuffleAndDeal', {
        stage: 'first5',
        state: getRoomStateForPlayer(room, idx)
      });
    }
  });

  if (room.players[room.trumpCaller].isBot) {
    setTimeout(() => botSelectTrump(room), 1800);
  }
}

function botSelectTrump(room) {
  if (room.phase !== 'SELECT_TRUMP') return;
  const bot = room.players[room.trumpCaller];
  const counts = { spades: 0, hearts: 0, diamonds: 0, clubs: 0 };
  bot.hand.forEach(c => { counts[c.suit] += c.value; });
  let bestSuit = 'spades';
  let maxVal = -1;
  for (const s of SUITS) {
    if (counts[s] > maxVal) {
      maxVal = counts[s];
      bestSuit = s;
    }
  }
  applyTrumpAndDealRest(room, bestSuit);
}

function applyTrumpAndDealRest(room, suit) {
  room.trumpSuit = suit;
  // Deal remaining 8 cards to each player
  for (let i = 0; i < 4; i++) {
    const extra = room.deck.slice(20 + i * 8, 20 + (i + 1) * 8);
    room.players[i].hand = room.players[i].hand.concat(extra);
    sortHand(room.players[i].hand);
  }
  room.phase = 'PLAYING';
  room.turn = room.trumpCaller;

  room.players.forEach((p, idx) => {
    if (!p.isBot && p.socketId) {
      io.to(p.socketId).emit('animateShuffleAndDeal', {
        stage: 'remaining8',
        state: getRoomStateForPlayer(room, idx)
      });
    }
  });

  triggerBotIfNeeded(room);
}

function sortHand(hand) {
  const suitOrder = { spades: 0, hearts: 1, clubs: 2, diamonds: 3 };
  hand.sort((a, b) => {
    if (suitOrder[a.suit] !== suitOrder[b.suit]) {
      return suitOrder[a.suit] - suitOrder[b.suit];
    }
    return b.value - a.value;
  });
}

function isValidMove(hand, card, tableCards) {
  if (tableCards.length === 0) return true;
  const leadSuit = tableCards[0].card.suit;
  const hasLeadSuit = hand.some(c => c.suit === leadSuit);
  if (hasLeadSuit) {
    return card.suit === leadSuit;
  }
  return true;
}

function evaluateTrick(tableCards, trumpSuit) {
  const leadSuit = tableCards[0].card.suit;
  let winningEntry = tableCards[0];

  for (let i = 1; i < tableCards.length; i++) {
    const current = tableCards[i];
    const winCard = winningEntry.card;
    const curCard = current.card;

    if (curCard.suit === trumpSuit && winCard.suit !== trumpSuit) {
      winningEntry = current;
    } else if (curCard.suit === winCard.suit && curCard.value > winCard.value) {
      winningEntry = current;
    }
  }
  return winningEntry.seat;
}

function playCard(room, seat, cardId) {
  if (room.phase !== 'PLAYING' || room.turn !== seat) return;
  const player = room.players[seat];
  const cardIndex = player.hand.findIndex(c => c.id === cardId);
  if (cardIndex === -1) return;

  const card = player.hand[cardIndex];
  if (!isValidMove(player.hand, card, room.tableCards)) return;

  player.hand.splice(cardIndex, 1);
  room.tableCards.push({ seat, card });

  if (room.tableCards.length < 4) {
    room.turn = (room.turn + 1) % 4;
    broadcastRoom(room);
    triggerBotIfNeeded(room);
  } else {
    broadcastRoom(room);
    setTimeout(() => resolveTrick(room), 750);
  }
}

function resolveTrick(room) {
  const winnerSeat = evaluateTrick(room.tableCards, room.trumpSuit);
  const winningTeam = winnerSeat % 2 === 0 ? 'A' : 'B';
  room.tricksWon[winningTeam]++;
  room.lastTrickWinner = winnerSeat;

  // Check consecutive tricks for "Sir" (2 consecutive tricks = 1 Sir)
  if (room.consecutiveTricks.team === winningTeam) {
    room.consecutiveTricks.count++;
    if (room.consecutiveTricks.count >= 2) {
      room.sirs[winningTeam]++;
      const winnerPlayer = room.players[winnerSeat];
      room.completedSirsLog.unshift({
        id: Date.now() + Math.random(),
        team: winningTeam,
        playerName: winnerPlayer.name,
        avatar: winnerPlayer.avatar,
        tricksCount: room.tricksWon[winningTeam],
        sirNumber: room.sirs[winningTeam]
      });
      room.consecutiveTricks = { team: null, count: 0 };
      io.to(room.id).emit('sirCompleted', room.completedSirsLog[0]);
    }
  } else {
    room.consecutiveTricks = { team: winningTeam, count: 1 };
  }

  room.tableCards = [];
  room.turn = winnerSeat;

  // Check if round finished (13 tricks)
  if (room.tricksWon.A + room.tricksWon.B >= 13) {
    room.phase = 'ROUND_OVER';
    broadcastRoom(room);
    setTimeout(() => {
      room.dealer = (room.dealer + 1) % 4;
      startNewRound(room);
    }, 2500);
  } else {
    broadcastRoom(room);
    triggerBotIfNeeded(room);
  }
}

function triggerBotIfNeeded(room) {
  if (room.phase !== 'PLAYING') return;
  const currentPlayer = room.players[room.turn];
  if (!currentPlayer || !currentPlayer.isBot) return;

  setTimeout(() => {
    if (room.phase !== 'PLAYING' || room.turn !== currentPlayer.seat) return;
    const validCards = currentPlayer.hand.filter(c => isValidMove(currentPlayer.hand, c, room.tableCards));
    if (validCards.length === 0) return;

    // Simple smart bot logic
    validCards.sort((a, b) => b.value - a.value);
    let chosen = validCards[validCards.length - 1];
    if (room.tableCards.length === 0) {
      chosen = validCards[0];
    } else {
      const currentWinner = evaluateTrick(room.tableCards, room.trumpSuit);
      const partnerSeat = (currentPlayer.seat + 2) % 4;
      if (currentWinner !== partnerSeat) {
        for (const c of validCards) {
          const sim = [...room.tableCards, { seat: currentPlayer.seat, card: c }];
          if (evaluateTrick(sim, room.trumpSuit) === currentPlayer.seat) {
            chosen = c;
            break;
          }
        }
      }
    }
    playCard(room, currentPlayer.seat, chosen.id);
  }, 350);
}

io.on('connection', (socket) => {
  socket.on('pingCheck', (cb) => {
    if (typeof cb === 'function') cb();
  });

  socket.on('joinRoom', ({ roomId, playerName, avatar, fillBots }) => {
    const cleanRoomId = (roomId || 'RANG1').trim().toUpperCase();
    if (!rooms[cleanRoomId]) {
      rooms[cleanRoomId] = {
        id: cleanRoomId,
        phase: 'WAITING',
        players: [],
        deck: [],
        trumpSuit: null,
        turn: 0,
        dealer: 0,
        trumpCaller: 1,
        tableCards: [],
        tricksWon: { A: 0, B: 0 },
        consecutiveTricks: { team: null, count: 0 },
        sirs: { A: 0, B: 0 },
        completedSirsLog: [],
        lastTrickWinner: null
      };
    }

    const room = rooms[cleanRoomId];

    // Check reconnect by name
    const existingIdx = room.players.findIndex(p => !p.isBot && p.name === playerName);
    if (existingIdx !== -1) {
      room.players[existingIdx].socketId = socket.id;
      if (avatar) room.players[existingIdx].avatar = avatar;
      socket.join(cleanRoomId);
      socket.roomId = cleanRoomId;
      socket.seat = existingIdx;
      broadcastRoom(room);
      return;
    }

    if (room.players.length >= 4) {
      socket.emit('errorMsg', 'Room full hai! Koi aur room code likhein.');
      return;
    }

    const seat = room.players.length;
    room.players.push({
      seat,
      socketId: socket.id,
      name: playerName || `Player ${seat + 1}`,
      avatar: avatar || '👑',
      isBot: false,
      hand: []
    });

    socket.join(cleanRoomId);
    socket.roomId = cleanRoomId;
    socket.seat = seat;

    if (fillBots) {
      const botNames = ['Ustad Ali', 'Malik Jani', 'Raja Khan', 'Sheraz'];
      const botAvatars = ['🦁', '🦅', '😎', '🎩'];
      while (room.players.length < 4) {
        const bSeat = room.players.length;
        room.players.push({
          seat: bSeat,
          socketId: null,
          name: botNames[bSeat % botNames.length],
          avatar: botAvatars[bSeat % botAvatars.length],
          isBot: true,
          hand: []
        });
      }
    }

    if (room.players.length === 4) {
      startNewRound(room);
    } else {
      broadcastRoom(room);
    }
  });

  socket.on('addBotsAndStart', () => {
    const room = rooms[socket.roomId];
    if (!room || room.phase !== 'WAITING') return;
    const botNames = ['Ustad Ali', 'Malik Jani', 'Raja Khan', 'Sheraz'];
    const botAvatars = ['🦁', '🦅', '😎', '🎩'];
    while (room.players.length < 4) {
      const bSeat = room.players.length;
      room.players.push({
        seat: bSeat,
        socketId: null,
        name: botNames[bSeat % botNames.length],
        avatar: botAvatars[bSeat % botAvatars.length],
        isBot: true,
        hand: []
      });
    }
    startNewRound(room);
  });

  socket.on('selectTrump', (suit) => {
    const room = rooms[socket.roomId];
    if (!room || room.phase !== 'SELECT_TRUMP' || room.trumpCaller !== socket.seat) return;
    if (!SUITS.includes(suit)) return;
    applyTrumpAndDealRest(room, suit);
  });

  socket.on('playCard', (cardId) => {
    const room = rooms[socket.roomId];
    if (!room) return;
    playCard(room, socket.seat, cardId);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Rang Club Ultra-Fast Server running on port ${PORT}`);
});

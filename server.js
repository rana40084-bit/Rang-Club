const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    transports: ['websocket', 'polling'],
    cors: { origin: "*" }
});

app.use(express.static(path.join(__dirname)));

const rooms = {};
const SUITS = ['♠', '♥', '♦', '♣'];
const VALUES = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const VALUE_RANK = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14 };

const BOT_POOL = [
    { name: '🦁 Sher Khan', avatar: '🦁' },
    { name: '🦅 Shaheen', avatar: '🦅' },
    { name: '🎩 Nawab', avatar: '🎩' },
    { name: '🔥 Sultan', avatar: '🔥' },
    { name: '👑 Badshah', avatar: '👑' },
    { name: '😎 Sikandar', avatar: '😎' },
    { name: '🐅 Cheetah', avatar: '🐅' },
    { name: '⚡ Bijli', avatar: '⚡' }
];

function createDeck() {
    let deck = [];
    for (let s of SUITS) {
        for (let v of VALUES) {
            deck.push({ suit: s, value: v, rank: VALUE_RANK[v] });
        }
    }
    return deck.sort(() => Math.random() - 0.5);
}

function getRoomState(roomId) {
    const room = rooms[roomId];
    if (!room) return null;
    return {
        roomId: room.id,
        players: room.players.map(p => ({
            id: p.id,
            name: p.name,
            avatar: p.avatar,
            isBot: p.isBot,
            seat: p.seat,
            team: p.seat % 2 === 0 ? 'A' : 'B',
            cardCount: p.hand.length
        })),
        status: room.status,
        trump: room.trump,
        trumpTeam: room.trumpTeam,
        turn: room.turn,
        tableCards: room.tableCards,
        scores: room.scores,
        consecutiveWins: room.consecutiveWins,
        completedSirs: room.completedSirs,
        trumpCaller: room.trumpCaller
    };
}

function startNewRound(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    room.deck = createDeck();
    room.status = 'dealing';
    room.trump = null;
    room.trumpTeam = null;
    room.tableCards = [];
    room.consecutiveWins = { team: null, count: 0 };
    room.turn = room.dealer % 4;
    room.trumpCaller = room.turn;

    room.players.forEach((p, idx) => {
        p.hand = room.deck.slice(idx * 5, (idx + 1) * 5);
    });

    io.to(roomId).emit('roundStarted', {
        state: getRoomState(roomId),
        dealPhase: 1
    });

    room.players.forEach(p => {
        if (!p.isBot) {
            io.to(p.id).emit('yourHand', p.hand);
        }
    });

    setTimeout(() => {
        if (!rooms[roomId]) return;
        room.status = 'selecting_trump';
        io.to(roomId).emit('updateState', getRoomState(roomId));
        checkBotAction(roomId);
    }, 2200);
}

function dealRemainingCards(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    room.players.forEach((p, idx) => {
        const extra = room.deck.slice(20 + idx * 8, 20 + (idx + 1) * 8);
        p.hand = p.hand.concat(extra);
    });

    room.status = 'playing';
    io.to(roomId).emit('secondDeal', { state: getRoomState(roomId) });

    room.players.forEach(p => {
        if (!p.isBot) {
            io.to(p.id).emit('yourHand', p.hand);
        }
    });

    setTimeout(() => {
        checkBotAction(roomId);
    }, 1800);
}

function checkBotAction(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    const currentPlayer = room.players[room.turn];
    if (!currentPlayer || !currentPlayer.isBot) return;

    setTimeout(() => {
        if (!rooms[roomId]) return;
        if (room.status === 'selecting_trump') {
            const randomSuit = SUITS[Math.floor(Math.random() * SUITS.length)];
            room.trump = randomSuit;
            room.trumpTeam = room.turn % 2 === 0 ? 'A' : 'B';
            dealRemainingCards(roomId);
        } else if (room.status === 'playing') {
            const leadSuit = room.tableCards.length > 0 ? room.tableCards[0].card.suit : null;
            let validCards = currentPlayer.hand;
            if (leadSuit) {
                const sameSuit = currentPlayer.hand.filter(c => c.suit === leadSuit);
                if (sameSuit.length > 0) validCards = sameSuit;
            }
            const chosenCard = validCards[Math.floor(Math.random() * validCards.length)];
            if (chosenCard) {
                handlePlayCard(roomId, currentPlayer.id, chosenCard);
            }
        }
    }, 350);
}

function evaluateTrick(room) {
    let winningPlay = room.tableCards[0];

    for (let play of room.tableCards) {
        const c = play.card;
        const w = winningPlay.card;
        if (c.suit === room.trump && w.suit !== room.trump) {
            winningPlay = play;
        } else if (c.suit === w.suit && c.rank > w.rank) {
            winningPlay = play;
        }
    }
    return winningPlay;
}

function handlePlayCard(roomId, playerId, card) {
    const room = rooms[roomId];
    if (!room || room.status !== 'playing') return;

    const pIndex = room.players.findIndex(p => p.id === playerId);
    if (pIndex !== room.turn) return;

    const player = room.players[pIndex];
    const cardIdx = player.hand.findIndex(c => c.suit === card.suit && c.value === card.value);
    if (cardIdx === -1) return;

    if (room.tableCards.length > 0) {
        const leadSuit = room.tableCards[0].card.suit;
        const hasLeadSuit = player.hand.some(c => c.suit === leadSuit);
        if (hasLeadSuit && card.suit !== leadSuit) return;
    }

    player.hand.splice(cardIdx, 1);
    room.tableCards.push({ seat: player.seat, name: player.name, card });

    if (!player.isBot) {
        io.to(player.id).emit('yourHand', player.hand);
    }

    if (room.tableCards.length < 4) {
        room.turn = (room.turn + 1) % 4;
        io.to(roomId).emit('cardPlayed', { state: getRoomState(roomId), lastPlay: { seat: player.seat, card } });
        checkBotAction(roomId);
    } else {
        room.status = 'trick_stay';
        io.to(roomId).emit('cardPlayed', { state: getRoomState(roomId), lastPlay: { seat: player.seat, card } });
        
        // 4 pattay pooray hone par 2.2 seconds ka stay taake sab dekh sakein
        setTimeout(() => {
            if (!rooms[roomId]) return;
            const winner = evaluateTrick(room);
            const winnerPlayer = room.players[winner.seat];
            const winningTeam = winner.seat % 2 === 0 ? 'A' : 'B';

            room.scores[winningTeam]++;

            if (room.consecutiveWins.team === winningTeam) {
                room.consecutiveWins.count++;
                if (room.consecutiveWins.count >= 2) {
                    room.completedSirs.unshift({
                        team: winningTeam,
                        playerName: winnerPlayer.name,
                        avatar: winnerPlayer.avatar,
                        handsCount: room.scores[winningTeam],
                        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                    });
                    room.consecutiveWins = { team: null, count: 0 };
                    io.to(roomId).emit('sirCompleted', room.completedSirs);
                }
            } else {
                room.consecutiveWins = { team: winningTeam, count: 1 };
            }

            room.tableCards = [];
            room.turn = winner.seat;

            if (room.players[0].hand.length === 0) {
                const winnerTeam = room.scores.A > room.scores.B ? 'A' : 'B';
                const loserTeam = winnerTeam === 'A' ? 'B' : 'A';
                const isCoat = room.scores[loserTeam] === 0;
                const isRangCoat = isCoat && (room.trumpTeam === loserTeam);

                room.dealer = (room.dealer + 1) % 4;
                io.to(roomId).emit('roundOver', {
                    winnerTeam,
                    loserTeam,
                    scores: room.scores,
                    isCoat,
                    isRangCoat
                });

                room.scores = { A: 0, B: 0 };
                const nextDelay = isCoat ? 5200 : 2500;
                setTimeout(() => startNewRound(roomId), nextDelay);
            } else {
                room.status = 'playing';
                io.to(roomId).emit('trickWon', { winnerSeat: winner.seat, state: getRoomState(roomId) });
                checkBotAction(roomId);
            }
        }, 2200);
    }
}

io.on('connection', (socket) => {
    socket.on('pingCheck', (cb) => {
        if (typeof cb === 'function') cb();
    });

    socket.on('joinRoom', ({ roomId, name, avatar }) => {
        roomId = (roomId || 'RANG1').toUpperCase();
        
        // Agar room mein sirf bots hain ya purana room hai to fresh room banayein
        if (rooms[roomId] && rooms[roomId].players.every(p => p.isBot)) {
            delete rooms[roomId];
        }

        socket.join(roomId);

        if (!rooms[roomId]) {
            rooms[roomId] = {
                id: roomId,
                players: [],
                status: 'waiting',
                deck: [],
                trump: null,
                trumpTeam: null,
                turn: 0,
                dealer: 0,
                tableCards: [],
                scores: { A: 0, B: 0 },
                consecutiveWins: { team: null, count: 0 },
                completedSirs: []
            };
        }

        const room = rooms[roomId];
        // Agar koi bot seat par hai to usay replace karein
        const botIdx = room.players.findIndex(p => p.isBot);
        if (room.players.length < 4 && !room.players.some(p => p.id === socket.id)) {
            const seat = room.players.length;
            room.players.push({
                id: socket.id,
                name: name || `Player ${seat + 1}`,
                avatar: avatar || '👑',
                isBot: false,
                seat,
                hand: []
            });
        } else if (botIdx !== -1 && !room.players.some(p => p.id === socket.id)) {
            room.players[botIdx] = {
                ...room.players[botIdx],
                id: socket.id,
                name: name || `Player ${botIdx + 1}`,
                avatar: avatar || '👑',
                isBot: false
            };
            io.to(socket.id).emit('yourHand', room.players[botIdx].hand);
        }

        io.to(roomId).emit('updateState', getRoomState(roomId));
    });

    socket.on('startWithBots', (roomId) => {
        roomId = (roomId || 'RANG1').toUpperCase();
        const room = rooms[roomId];
        if (!room) return;

        const shuffledBots = [...BOT_POOL].sort(() => Math.random() - 0.5);
        let bIdx = 0;
        while (room.players.length < 4) {
            const seat = room.players.length;
            const bot = shuffledBots[bIdx++ % shuffledBots.length];
            room.players.push({
                id: 'BOT_' + seat + '_' + Date.now() + '_' + Math.random(),
                name: bot.name,
                avatar: bot.avatar,
                isBot: true,
                seat,
                hand: []
            });
        }
        startNewRound(roomId);
    });

    socket.on('selectTrump', ({ roomId, suit }) => {
        const room = rooms[roomId];
        if (!room || room.status !== 'selecting_trump') return;
        const p = room.players[room.turn];
        if (p && p.id === socket.id) {
            room.trump = suit;
            room.trumpTeam = room.turn % 2 === 0 ? 'A' : 'B';
            dealRemainingCards(roomId);
        }
    });

    socket.on('playCard', ({ roomId, card }) => {
        handlePlayCard(roomId, socket.id, card);
    });

    socket.on('chatMessage', ({ roomId, name, text }) => {
        if (!roomId || !text) return;
        io.to(roomId.toUpperCase()).emit('chatMessage', {
            senderId: socket.id,
            name,
            text,
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        });
    });

    socket.on('voiceData', ({ roomId, audio }) => {
        if (!roomId || !audio) return;
        socket.to(roomId.toUpperCase()).emit('voiceData', { senderId: socket.id, audio });
    });

    socket.on('disconnect', () => {
        for (let rId in rooms) {
            const room = rooms[rId];
            const idx = room.players.findIndex(p => p.id === socket.id);
            if (idx !== -1) {
                if (room.status === 'waiting') {
                    room.players.splice(idx, 1);
                    room.players.forEach((p, i) => p.seat = i);
                } else {
                    room.players[idx].isBot = true;
                    room.players[idx].name += ' (Bot)';
                    checkBotAction(rId);
                }
                if (room.players.every(p => p.isBot)) {
                    delete rooms[rId];
                } else {
                    io.to(rId).emit('updateState', getRoomState(rId));
                }
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Rang Club Server running on port ${PORT}`));

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const rooms = {};
const SUITS = ['♠', '♥', '♦', '♣'];
const VALUES = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

function createDeck() {
    let deck = [];
    for (let s of SUITS) {
        for (let i = 0; i < VALUES.length; i++) deck.push({ suit: s, value: VALUES[i], rank: i + 2 });
    }
    return deck.sort(() => Math.random() - 0.5);
}

io.on('connection', (socket) => {
    socket.on('joinRoom', ({ roomCode, playerName }) => {
        if (!rooms[roomCode]) {
            rooms[roomCode] = {
                players: [], deck: [], trump: null, turn: 0,
                tableCards: [], leadSuit: null, pendingSirs: 0,
                lastWinnerTeam: null, scores: { teamA: 0, teamB: 0 }
            };
        }
        const room = rooms[roomCode];
        if (room.players.length >= 4) {
            socket.emit('errorMsg', 'Room full hai! Sirf 4 players khel sakte hain.');
            return;
        }
        const playerIndex = room.players.length;
        const team = playerIndex % 2 === 0 ? 'Team A' : 'Team B';
        room.players.push({ id: socket.id, name: playerName, index: playerIndex, team, hand: [] });
        socket.join(roomCode);
        socket.roomCode = roomCode;
        socket.playerIndex = playerIndex;

        io.to(roomCode).emit('updatePlayers', room.players);
        if (room.players.length === 4) startGame(roomCode);
    });

    function startGame(roomCode) {
        const room = rooms[roomCode];
        room.deck = createDeck();
        room.scores = { teamA: 0, teamB: 0 };
        room.pendingSirs = 0; room.lastWinnerTeam = null;
        room.trump = null; room.turn = 0; room.tableCards = [];
        room.players.forEach((p, idx) => {
            p.hand = room.deck.slice(idx * 5, (idx + 1) * 5);
            io.to(p.id).emit('dealCards', { hand: p.hand, phase: 'selectTrump', isTrumpSelector: idx === 0 });
        });
        io.to(roomCode).emit('gameStatus', `${room.players.name} Rang (Trump) select karega...`);
    }

    socket.on('selectTrump', (suit) => {
        const room = rooms[socket.roomCode];
        if (!room || socket.playerIndex !== 0) return;
        room.trump = suit;
        room.players.forEach((p, idx) => {
            p.hand = p.hand.concat(room.deck.slice(20 + idx * 8, 20 + (idx + 1) * 8));
            io.to(p.id).emit('dealCards', { hand: p.hand, phase: 'playing', trump: suit });
        });
        io.to(socket.roomCode).emit('trumpSelected', suit);
        io.to(socket.roomCode).emit('turnUpdate', room.turn);
    });

    socket.on('playCard', (cardIndex) => {
        const room = rooms[socket.roomCode];
        if (!room || socket.playerIndex !== room.turn) return;
        const player = room.players[socket.playerIndex];
        const card = player.hand[cardIndex];
        if (!card) return;

        if (room.tableCards.length > 0) {
            const hasLead = player.hand.some(c => c.suit === room.leadSuit);
            if (hasLead && card.suit !== room.leadSuit) {
                socket.emit('errorMsg', `Aap ko ${room.leadSuit} chalna hoga!`);
                return;
            }
        } else {
            room.leadSuit = card.suit;
        }

        player.hand.splice(cardIndex, 1);
        room.tableCards.push({ playerIndex: socket.playerIndex, playerName: player.name, card });
        io.to(player.id).emit('updateHand', player.hand);
        io.to(socket.roomCode).emit('cardPlayed', room.tableCards);

        if (room.tableCards.length < 4) {
            room.turn = (room.turn + 1) % 4;
            io.to(socket.roomCode).emit('turnUpdate', room.turn);
        } else {
            setTimeout(() => evaluateTrick(socket.roomCode), 1400);
        }
    });

    function evaluateTrick(roomCode) {
        const room = rooms[roomCode];
        if (!room) return;
        let win = room.tableCards;
        for (let i = 1; i < room.tableCards.length; i++) {
            const cur = room.tableCards[i];
            if (cur.card.suit === room.trump && win.card.suit !== room.trump) win = cur;
            else if (cur.card.suit === win.card.suit && cur.card.rank > win.card.rank) win = cur;
        }
        const winTeam = win.playerIndex % 2 === 0 ? 'Team A' : 'Team B';
        room.pendingSirs += 1;

        if (room.lastWinnerTeam === winTeam) {
            if (winTeam === 'Team A') room.scores.teamA += room.pendingSirs;
            else room.scores.teamB += room.pendingSirs;
            io.to(roomCode).emit('gameStatus', `${winTeam} ne Double Sir kar liya! (+${room.pendingSirs})`);
            room.pendingSirs = 0; room.lastWinnerTeam = null;
        } else {
            room.lastWinnerTeam = winTeam;
            io.to(roomCode).emit('gameStatus', `${win.playerName} ne haath jeeta (Pending: ${room.pendingSirs})`);
        }
        room.tableCards = []; room.leadSuit = null; room.turn = win.playerIndex;
        io.to(roomCode).emit('trickEnded', { scores: room.scores, pendingSirs: room.pendingSirs });

        if (room.players.hand.length === 0) {
            const champ = room.scores.teamA > room.scores.teamB ? 'Team A' : 'Team B';
            io.to(roomCode).emit('gameOver', `Game Khatam! ${champ} Jeet Gayi!`);
        }
    }

    socket.on('chatMessage', (msg) => {
        const room = rooms[socket.roomCode];
        if (!room) return;
        io.to(socket.roomCode).emit('chatMessage', { sender: room.players[socket.playerIndex].name, text: msg });
    });

    socket.on('voiceSignal', (data) => {
        io.to(data.to).emit('voiceSignal', { from: socket.id, signal: data.signal });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Running on ${PORT}`));

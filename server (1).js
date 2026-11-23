const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    transports: ['polling', 'websocket']
});

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const rooms = {};
const SUITS = ['♠', '♥', '♦', '♣'];
const VALUES = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

function createDeck() {
    let deck = [];
    for (let s of SUITS) {
        for (let i = 0; i < VALUES.length; i++) {
            deck.push({ suit: s, value: VALUES[i], rank: i + 2 });
        }
    }
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

io.on('connection', (socket) => {
    socket.on('joinRoom', ({ roomCode, playerName }) => {
        if (!rooms[roomCode]) {
            rooms[roomCode] = {
                players: [],
                deck: [],
                trump: null,
                turn: 0,
                dealer: 0,
                tableCards: [],
                leadSuit: null,
                pendingSirs: 0,
                lastWinnerTeam: null,
                scores: { teamA: 0, teamB: 0 },
                started: false
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

        if (room.players.length === 4) {
            setTimeout(() => startGame(roomCode), 1000);
        }
    });

    function startGame(roomCode) {
        const room = rooms[roomCode];
        if (!room || room.players.length < 4) return;
        room.started = true;
        room.deck = createDeck();
        room.scores = { teamA: 0, teamB: 0 };
        room.pendingSirs = 0;
        room.lastWinnerTeam = null;
        room.trump = null;
        room.tableCards = [];
        room.leadSuit = null;
        room.turn = room.dealer;

        io.to(roomCode).emit('shufflingStart', { dealerName: room.players[room.dealer].name });

        setTimeout(() => {
            if (!rooms[roomCode]) return;
            room.players.forEach((p, idx) => {
                p.hand = room.deck.slice(idx * 5, (idx + 1) * 5);
                io.to(p.id).emit('dealCards', {
                    hand: p.hand,
                    phase: 'selectTrump',
                    isTrumpSelector: idx === room.dealer,
                    players: room.players
                });
            });
            io.to(roomCode).emit('gameStatus', `${room.players[room.dealer].name} Rang (Trump) select kar raha hai...`);
        }, 2200);
    }

    socket.on('selectTrump', (suit) => {
        const room = rooms[socket.roomCode];
        if (!room || socket.playerIndex !== room.dealer) return;
        room.trump = suit;
        room.players.forEach((p, idx) => {
            const extraCards = room.deck.slice(20 + idx * 8, 20 + (idx + 1) * 8);
            p.hand = p.hand.concat(extraCards);
            io.to(p.id).emit('dealCards', {
                hand: p.hand,
                phase: 'playing',
                trump: suit,
                players: room.players
            });
        });
        io.to(socket.roomCode).emit('trumpSelected', suit);
        io.to(socket.roomCode).emit('turnUpdate', { turn: room.turn, playerName: room.players[room.turn].name });
    });

    socket.on('playCard', (cardIndex) => {
        const room = rooms[socket.roomCode];
        if (!room || !room.trump || socket.playerIndex !== room.turn) return;
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
        room.tableCards.push({ playerIndex: socket.playerIndex, playerName: player.name, team: player.team, card });
        io.to(player.id).emit('updateHand', player.hand);
        io.to(socket.roomCode).emit('cardPlayed', room.tableCards);

        if (room.tableCards.length < 4) {
            room.turn = (room.turn + 1) % 4;
            io.to(socket.roomCode).emit('turnUpdate', { turn: room.turn, playerName: room.players[room.turn].name });
        } else {
            setTimeout(() => evaluateTrick(socket.roomCode), 1500);
        }
    });

    function evaluateTrick(roomCode) {
        const room = rooms[roomCode];
        if (!room) return;
        let win = room.tableCards[0];
        for (let i = 1; i < room.tableCards.length; i++) {
            const cur = room.tableCards[i];
            if (cur.card.suit === room.trump && win.card.suit !== room.trump) win = cur;
            else if (cur.card.suit === win.card.suit && cur.card.rank > win.card.rank) win = cur;
        }

        const winTeam = win.playerIndex % 2 === 0 ? 'Team A' : 'Team B';
        room.pendingSirs += 1;
        let doubleSirScored = false;

        if (room.lastWinnerTeam === winTeam) {
            if (winTeam === 'Team A') room.scores.teamA += room.pendingSirs;
            else room.scores.teamB += room.pendingSirs;
            io.to(roomCode).emit('gameStatus', `🔥 ${winTeam} ne Double Sir kar liya! (+${room.pendingSirs} Sirs)`);
            room.pendingSirs = 0;
            room.lastWinnerTeam = null;
            doubleSirScored = true;
        } else {
            room.lastWinnerTeam = winTeam;
            io.to(roomCode).emit('gameStatus', `${win.playerName} (${winTeam}) ne haath jeeta! Pending: ${room.pendingSirs}`);
        }

        room.tableCards = [];
        room.leadSuit = null;
        room.turn = win.playerIndex;
        io.to(roomCode).emit('trickEnded', {
            scores: room.scores,
            pendingSirs: room.pendingSirs,
            doubleSirScored,
            nextTurn: room.turn,
            nextPlayerName: room.players[room.turn].name
        });

        if (room.players[0].hand.length === 0) {
            const champ = room.scores.teamA > room.scores.teamB ? 'Team A' : 'Team B';
            io.to(roomCode).emit('gameOver', {
                winner: champ,
                scoreA: room.scores.teamA,
                scoreB: room.scores.teamB
            });
        }
    }

    socket.on('requestRematch', () => {
        const room = rooms[socket.roomCode];
        if (!room || room.players.length < 4) return;
        room.dealer = (room.dealer + 1) % 4;
        startGame(socket.roomCode);
    });

    socket.on('chatMessage', (msg) => {
        const room = rooms[socket.roomCode];
        if (!room) return;
        const p = room.players[socket.playerIndex];
        io.to(socket.roomCode).emit('chatMessage', { sender: p.name, team: p.team, text: msg });
    });

    socket.on('voiceSignal', (data) => {
        io.to(data.to).emit('voiceSignal', { from: socket.id, signal: data.signal });
    });

    socket.on('disconnect', () => {
        if (socket.roomCode && rooms[socket.roomCode]) {
            const room = rooms[socket.roomCode];
            room.players = room.players.filter(p => p.id !== socket.id);
            if (room.players.length === 0) {
                delete rooms[socket.roomCode];
            } else {
                io.to(socket.roomCode).emit('playerLeft', 'Koi player game chor gaya hai.');
                delete rooms[socket.roomCode];
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Rang Club Pro running on ${PORT}`));

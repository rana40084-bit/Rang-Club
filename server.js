const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, 'public')));

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
    return deck.sort(() => Math.random() - 0.5);
}

io.on('connection', (socket) => {
    socket.on('joinRoom', ({ roomCode, playerName }) => {
        if (!rooms[roomCode]) {
            rooms[roomCode] = {
                players: [],
                deck: [],
                trump: null,
                turn: 0,
                tableCards: [],
                leadSuit: null,
                pendingSirs: 0,
                lastWinnerTeam: null,
                scores: { teamA: 0, teamB: 0 } // Team A: 0 & 2, Team B: 1 & 3
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
            startGame(roomCode);
        }
    });

    function startGame(roomCode) {
        const room = rooms[roomCode];
        room.deck = createDeck();
        room.scores = { teamA: 0, teamB: 0 };
        room.pendingSirs = 0;
        room.lastWinnerTeam = null;
        room.trump = null;
        room.turn = 0;

        // Pehle 5 cards har player ko dein
        room.players.forEach((p, idx) => {
            p.hand = room.deck.slice(idx * 5, (idx + 1) * 5);
            io.to(p.id).emit('dealCards', { hand: p.hand, phase: 'selectTrump', isTrumpSelector: idx === 0 });
        });
        io.to(roomCode).emit('gameStatus', `${room.players[0].name} Rang (Trump) select karega...`);
    }

    socket.on('selectTrump', (suit) => {
        const room = rooms[socket.roomCode];
        if (!room || socket.playerIndex !== 0) return;

        room.trump = suit;
        // Baqi 8 cards (4 + 4) har player ko dein
        room.players.forEach((p, idx) => {
            const extraCards = room.deck.slice(20 + idx * 8, 20 + (idx + 1) * 8);
            p.hand = p.hand.concat(extraCards);
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

        // Suit follow check
        if (room.tableCards.length > 0) {
            const hasLeadSuit = player.hand.some(c => c.suit === room.leadSuit);
            if (hasLeadSuit && card.suit !== room.leadSuit) {
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
            setTimeout(() => evaluateTrick(socket.roomCode), 1500);
        }
    });

    function evaluateTrick(roomCode) {
        const room = rooms[roomCode];
        if (!room) return;

        let winningPlay = room.tableCards[0];
        for (let i = 1; i < room.tableCards.length; i++) {
            const current = room.tableCards[i];
            const isCurrentTrump = current.card.suit === room.trump;
            const isWinningTrump = winningPlay.card.suit === room.trump;

            if (isCurrentTrump && !isWinningTrump) {
                winningPlay = current;
            } else if (current.card.suit === winningPlay.card.suit && current.card.rank > winningPlay.card.rank) {
                winningPlay = current;
            }
        }

        const winnerTeam = winningPlay.playerIndex % 2 === 0 ? 'Team A' : 'Team B';
        room.pendingSirs += 1;

        // DOUBLE SIR LOGIC: Lagatar 2 haath jeetne par score milta hai
        if (room.lastWinnerTeam === winnerTeam) {
            if (winnerTeam === 'Team A') room.scores.teamA += room.pendingSirs;
            else room.scores.teamB += room.pendingSirs;
            io.to(roomCode).emit('gameStatus', `${winnerTeam} ne Double Sir kar liya! (+${room.pendingSirs} Sirs)`);
            room.pendingSirs = 0;
            room.lastWinnerTeam = null;
        } else {
            room.lastWinnerTeam = winnerTeam;
            io.to(roomCode).emit('gameStatus', `${winningPlay.playerName} (${winnerTeam}) ne haath jeeta. Pending Sirs: ${room.pendingSirs}`);
        }

        room.tableCards = [];
        room.leadSuit = null;
        room.turn = winningPlay.playerIndex;

        io.to(roomCode).emit('trickEnded', { scores: room.scores, pendingSirs: room.pendingSirs, nextTurn: room.turn });

        if (room.players[0].hand.length === 0) {
            const finalWinner = room.scores.teamA > room.scores.teamB ? 'Team A' : 'Team B';
            io.to(roomCode).emit('gameOver', `Game Khatam! ${finalWinner} Jeet Gayi!`);
        }
    }

    // Text Chat
    socket.on('chatMessage', (msg) => {
        const room = rooms[socket.roomCode];
        if (!room) return;
        const player = room.players[socket.playerIndex];
        io.to(socket.roomCode).emit('chatMessage', { sender: player.name, text: msg });
    });

    // WebRTC Voice Chat Signaling
    socket.on('voiceSignal', (data) => {
        io.to(data.to).emit('voiceSignal', { from: socket.id, signal: data.signal });
    });

    socket.on('disconnect', () => {
        if (socket.roomCode && rooms[socket.roomCode]) {
            delete rooms[socket.roomCode];
            io.to(socket.roomCode).emit('errorMsg', 'Koi player game chor gaya. Room reset ho gaya hai.');
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Rang Club server running on port ${PORT}`));

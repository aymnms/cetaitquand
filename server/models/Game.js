const RoomManager = require("./RoomManager");

class Game {
    constructor(io) {
        this.io = io;
        this.roomManager = new RoomManager();
        this.timers = new Map();
    }

    joinGame(socket, playerName, indexAvatar, roomCode) {
        if (!roomCode) {
            this.roomManager.cleanEmptyRooms();
            roomCode = this.roomManager.createRoom();
        }

        const room = this.roomManager.getRoom(roomCode);
        if (!room) {
            socket.emit("message", "Une erreur s'est produite lors de la connexion à la room.", "error");
            return;
        }
        if (room.players.size >= 10) {
            console.log("LIMITE");
            socket.emit("message", "La limite de joueur pour cette room a été atteinte.", "error");
            return;
        }
        if (room.players.has(playerName)) {
            console.log("DEJA PRIS");
            socket.emit("message", "Ce surnom est déjà utilisé.", "error");
            return;
        }
        if (playerName.length > 16) {
            console.log("TROP LONG");
            socket.emit("message", "Ce surnom contient trop de caractère.", "error");
            return;
        }
        room.addPlayer(socket.id, playerName, indexAvatar);
        socket.join(roomCode);

        console.log(`${playerName} a rejoint la salle ${roomCode}`);
        socket.emit("message", `Vous avez rejoint la salle ${roomCode}`, "success");
        this.io.to(roomCode).emit("message", `${playerName} a rejoint la salle`, "info");
        this.io.to(roomCode).emit("roomJoined", roomCode, [...room.players.values()], room.host);
    }

    async nextRound(roomCode) {
        const room = this.roomManager.getRoom(roomCode);
        if (!room) return;

        const winners = room.getWinners();
        if (winners.length) { // FIN DE GAME
            this.io.to(roomCode).emit("gameEnded", { logs: room.logs });
            this.io.socketsLeave(roomCode);
            this.io.in(roomCode).disconnectSockets(true);
            this.roomManager.deleteRoom(roomCode);
        } else {
            const question = await room.changeQuestion();
            if (!question) {
                console.log(`Aucune question disponible pour la salle ${roomCode}`);
                this.io.to(roomCode).emit("message", "Impossible de charger une question. Réessayez.", "error");
                return;
            }
            this.startTimer(roomCode);
            this.io.to(roomCode).emit("gameStarted", room.currentQuestion);
        }
    }
    
    submitAnswer(roomCode, playerName, answer) {
        const room = this.roomManager.getRoom(roomCode);
        if (!room) {
            socket.emit("message", "La salle n'existe pas !", "error");
            return;
        }
        room.submitAnswer(playerName, answer);
        
        if (room.allAnswersReceived()) { // check si tt players ont envoyé réponses
            this.endRound(roomCode);
        }
    }
    
    startTimer(roomCode) {
        let timeLeft = process.env.TIMER;
        const room = this.roomManager.getRoom(roomCode);
        
        this.io.to(room.code).emit("timerUpdate", timeLeft);
        console.log(`⏳ Timer ${room.code}: ${timeLeft} sec`);
        
        this.timers.set(roomCode, setInterval(() => {
            timeLeft--;
            this.io.to(room.code).emit("timerUpdate", timeLeft);
            console.log(`⏳ Timer ${room.code}: ${timeLeft} sec`);

            if (timeLeft == 0) {
                this.io.to(roomCode).emit("askAnswers");
            } else if (timeLeft <= -5) {
                this.stopTimer(roomCode);
                this.endRound(roomCode);
                timeLeft = process.env.TIMER;
            }
        }, 1000));
    }

    stopTimer(roomCode) {
        if (this.timers.has(roomCode)) {
            clearInterval(this.timers.get(roomCode));
            this.timers.delete(roomCode);
            console.log(`⏹ Timer arrêté pour la salle ${roomCode}`);
        }
    }

    endRound(roomCode) {
        this.stopTimer(roomCode);

        const room = this.roomManager.getRoom(roomCode);
        if (!room) return;

        const question = room.currentQuestion;

        let log = {
            question,
            answers: Object.fromEntries(room.currentAnswers),
            closestPlayers: [],
            perfectWinners: []
        }

        let minDiff = Infinity;
        room.currentAnswers.forEach((answer, player) => {
            if (isNaN(answer) || answer === "") return;
            let diff = Math.abs(answer - log.question.year);

            if (diff < minDiff) {
                minDiff = diff;
                log.closestPlayers = [player];
            } else if (diff === minDiff) {
                log.closestPlayers.push(player);
            }

            if (answer === log.question.year) {
                log.perfectWinners.push(player);
            }
        });

        room.addLog(log);
        room.resetAnswers();

        if (log.perfectWinners.length) {
            log.perfectWinners.forEach(winner => room.players.get(winner).addPoints(3));
        } else {
            log.closestPlayers.forEach(winner => room.players.get(winner).addPoints(1));
        }

        this.io.to(roomCode).emit("roundResult", {
            solution: question.year,
            explanation: `${log.question.explanation}`,
            scores: room.getScores(),
            answers: log.answers,
            playersWon: log.perfectWinners.length ? log.perfectWinners : log.closestPlayers
        });
    }

    leave(socket) {

        for (let [roomCode, room] of this.roomManager.rooms.entries()) {
            const playerName = room.removePlayer(socket.id);
            if (playerName) {
                console.log(`❌ ${playerName} s'est déconnecté de la salle ${roomCode}`);
                this.io.to(roomCode).emit("playerDisconnected", playerName, room.host);

                // Expulser le joueur de la room WebSocket
                socket.leave(roomCode);

                // Vérifier si la room est vide
                if (room.players.size === 0) {
                    console.log(`🗑️ Room ${roomCode} supprimée (dernier joueur parti).`);

                    // Expulser tous les sockets de la room avant suppression
                    this.io.socketsLeave(roomCode);

                    // Supprimer la room de la mémoire
                    this.roomManager.deleteRoom(roomCode);
                }
                return;
            }
        }
        
    }

    disconnect(socket) {
        this.leave(socket);
        // Forcer la fermeture de la connexion WebSocket du joueur
        socket.disconnect(true);
        console.log("Un joueur s'est déconnecté sans être dans une room.");
    }
}

module.exports = Game;
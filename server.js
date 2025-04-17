import WebSocket, { WebSocketServer } from "ws";

const wss = new WebSocketServer({ port: process.env.PORT || 8080 });

/**
 * @typedef {Object} Client
 * @property {WebSocket} ws - The WebSocket connection.
 * @property {string} id - The unique identifier for the project.
 * @property {'player' | 'remote'} type -  The instance type (e.g., "player" or "remote").
 * @property {string} instance - The application instance.
 * @property {boolean} [mainInstance] - Optional. Indicates if this is the main instance.
 */

/**
 * @type {Map<string, Client[]>} clients - Map of Clients, keyed by an identifier.
 */
const clients = new Map();

wss.on("connection", function connection(ws) {
  ws.on("message", function incoming(message) {
    if (message.toString() === "ping") {
      ws.send("pong");
      return;
    }

    const data = JSON.parse(message);
    const { id, type, action, payload } = data;

    console.log("websocket-action", type, action);

    // Initialize client data if not already present
    if (!clients.has(id)) {
      clients.set(id, []);
    }

    const clientList = clients.get(id);

    // Add the new connection to the list of clients for this id
    if (action === "register") {
      if (
        type === "player" &&
        clientList.filter((client) => client.type === "player").length === 0
      ) {
        clientList.push({ ws, type, instance: payload, mainInstance: true });
      } else {
        clientList.push({ ws, type, instance: payload });
      }
    }

    if (action === "switch-presenter") {
      clientList.map((client) => {
        if (client.ws === ws) {
          client.mainInstance = true;
        } else {
          delete client.mainInstance;
        }
      });
    }

    // Broadcast the message to all connected clients (including the sender)
    const broadcastMessage = (message) => {
      const connectedRemotesCount = clientList.filter(
        (client) => client.type === "remote"
      ).length;
      const connectedPlayersCount = clientList.filter(
        (client) => client.type === "player"
      ).length;
      const mainPlayerId = clientList.find(
        (client) => client.type === "player" && client.mainInstance
      )?.instance;
      clientList.forEach((client) => {
        if (client.ws.readyState === WebSocket.OPEN) {
          client.ws.send(
            JSON.stringify({
              ...message,
              mainInstance: client.mainInstance,
              mainPlayerId,
              connectedRemotesCount,
              connectedPlayersCount,
            })
          );
        }
      });
    };

    broadcastMessage(data);
  });

  ws.on("close", function close() {
    clients.forEach((clientList, id) => {
      // find the client that disconnected
      const diconnectedClient = clientList.find((client) => client.ws === ws);

      // Remove the client from the list
      clients.set(
        id,
        clientList.filter((client) => client.ws !== ws)
      );

      // check if client was main player that disconnected
      const itWasMainPlayer =
        diconnectedClient &&
        diconnectedClient.type === "player" &&
        diconnectedClient.mainInstance;

      // if it was main player, broadcast that main player has disconnected
      const otherClients = clients.get(id);
      if (itWasMainPlayer) {
        otherClients.forEach((client) => {
          if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(
              JSON.stringify({
                type: "player",
                action: "player-disconnect",
              })
            );
          }
        });
      }

      // refresh remote count
      const connectedRemotesCount = otherClients.filter(
        (client) => client.type === "remote"
      ).length;

      otherClients.forEach((client) => {
        if (client.ws.readyState === WebSocket.OPEN) {
          client.ws.send(
            JSON.stringify({
              connectedRemotesCount,
            })
          );
        }
      });

      // If no more clients for this id, delete the entry
      if (clients.get(id).length === 0) {
        clients.delete(id);
      }
    });
  });
});

console.log("WebSocket server running on ws://localhost:8080");

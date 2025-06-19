import url from "url";
import WebSocket, { WebSocketServer } from "ws";

const wss = new WebSocketServer({ port: process.env.PORT || 8080 });

/**
 * @type {Map<string, {player:WebSocket,remotes:Map<string, WebSocket>,standbyPlayers:Map<string, WebSocket>}>}
 */
const projects = new Map();

const SPECIAL_BROADCAST_ACTIONS = [
  "request_app_state",
  // Add more special actions here as needed
];

class Utils {
  static getProject(project_id) {
    if (!projects.has(project_id)) {
      projects.set(project_id, {
        player: null,
        remotes: new Map(),
        standbyPlayers: new Map(), // extra players waiting
      });
    }
    return projects.get(project_id);
  }

  static send(ws, action, data = {}) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ action, ...data }));
    }
  }
}

wss.on("connection", function connection(webSocket, request) {
  const { project_id, device_id, type } = url.parse(request.url, true).query;

  const project = Utils.getProject(project_id);

  webSocket.project_id = project_id;
  webSocket.device_id = device_id;
  webSocket.type = type;

  if (type === "player") {
    if (project.player) {
      // Queue this player
      project.standbyPlayers.set(device_id, webSocket);
      Utils.send(webSocket, "player_demoted", {});
    } else {
      project.player = webSocket;
      Utils.send(webSocket, "player_connected");
      // Notify remotes
      project.remotes.forEach((remote) =>
        Utils.send(remote, "player_available")
      );
      project.standbyPlayers.forEach((standby) => {
        Utils.send(standby, "new_player_connected");
      });
    }
  } else {
    // Add remote
    project.remotes.set(device_id, webSocket);
    Utils.send(
      webSocket,
      project.player ? "player_available" : "no_player_connected"
    );
  }
  // Notify current player of remote count
  if (project.player) {
    Utils.send(project.player, "remote_count", {
      count: project.remotes.size,
    });
  }

  //

  //

  webSocket.on("message", function incoming(message) {
    if (message.toString() === "ping") {
      webSocket.send("pong");
      return;
    }

    const data = JSON.parse(message);
    const { id, type, action, payload } = data;

    if (action === "switch-presenter") {
      // If this player is in standby, promote them
      if (project.standbyPlayers.has(webSocket.device_id)) {
        const oldPlayer = project.player;

        // Demote current player (if still connected)
        if (oldPlayer && oldPlayer.readyState === WebSocket.OPEN) {
          project.standbyPlayers.set(oldPlayer.device_id, oldPlayer);
          Utils.send(oldPlayer, "player_demoted");
        }

        // Promote new player
        project.standbyPlayers.delete(webSocket.device_id);
        project.player = webSocket;
        Utils.send(webSocket, "player_promoted");

        // Notify remotes
        project.remotes.forEach((remote) =>
          Utils.send(remote, "player_available")
        );
      }
    }

    // Broadcast the message to all connected clients (including the sender)
    function broadcast(data = {}) {
      // Allow special actions from any player

      // Only allow:
      // - main player (project.player)
      // - remotes
      // - standby players, but only for SPECIAL_BROADCAST_ACTIONS
      const isMainPlayer =
        project.player === webSocket && webSocket.type === "player";
      const isRemote = webSocket.type === "remote";
      const isStandbyPlayer =
        project.standbyPlayers.has(webSocket.device_id) &&
        webSocket.type === "player";
      const isSpecialAction = SPECIAL_BROADCAST_ACTIONS.includes(data.action);

      if (
        !project ||
        (!isMainPlayer && !isRemote && !(isStandbyPlayer && isSpecialAction))
      ) {
        return;
      }

      const message = JSON.stringify(data);

      // Send to current player
      if (project.player && project.player.readyState === WebSocket.OPEN) {
        project.player.send(message);
      }

      // Send to all remotes
      for (const remote of project.remotes.values()) {
        if (remote.readyState === WebSocket.OPEN) {
          remote.send(message);
        }
      }

      // Send to standby players too (optional)
      for (const standby of project.standbyPlayers.values()) {
        if (standby.readyState === WebSocket.OPEN) {
          standby.send(message);
        }
      }
    }
    broadcast({ ...data, device_id: webSocket.device_id });
  });

  webSocket.on("close", function close() {
    if (webSocket.type === "player") {
      if (project.player === webSocket) {
        project.player = null;

        // Notify all remotes that no player is connected
        project.remotes.forEach((remote) =>
          Utils.send(remote, "no_player_connected")
        );

        // Also notify all standby players (in case their UI is waiting)
        project.standbyPlayers.forEach((standby) =>
          Utils.send(standby, "no_player_connected")
        );
      } else {
        project.standbyPlayers.delete(webSocket.device_id);
      }
    } else {
      // Remote disconnected
      project.remotes.delete(webSocket.device_id);

      // Update remote count for active player
      if (project.player) {
        Utils.send(project.player, "remote_count", {
          count: project.remotes.size,
        });
      }
    }
  });
});

console.log("WebSocket server running on ws://localhost:8080");

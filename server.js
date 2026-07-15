import url from "url";
import WebSocket, { WebSocketServer } from "ws";

const wss = new WebSocketServer({ port: process.env.PORT || 8080 });

/**
 * @type {Map<string, {player:WebSocket,remotes:Map<string, WebSocket>,standbyPlayers:Map<string, WebSocket>,trialStart:number|null,trialTimeRemaining:number,trialExpired:boolean,timer:any,lastActiveTime:number|null}>}
 */
const projects = new Map();

const SPECIAL_BROADCAST_ACTIONS = [
  "request_app_state",
  // Add more special actions here as needed
];

const TRIAL_DURATION = process.env.TRIAL_DURATION ? parseInt(process.env.TRIAL_DURATION) : 1800000;

function broadcastTrialStatus(project) {
  const statusMsg = JSON.stringify({
    action: "trial-status",
    trialStart: project.trialStart,
    trialTimeRemaining: project.trialTimeRemaining,
    trialExpired: project.trialExpired,
    trialDuration: TRIAL_DURATION,
  });
  if (project.player && project.player.readyState === WebSocket.OPEN) {
    project.player.send(statusMsg);
  }
  project.remotes.forEach((remote) => {
    if (remote.readyState === WebSocket.OPEN) {
      remote.send(statusMsg);
    }
  });
  project.standbyPlayers.forEach((standby) => {
    if (standby.readyState === WebSocket.OPEN) {
      standby.send(statusMsg);
    }
  });
}

function sendRemoteCount(project) {
  if (project.player && project.player.readyState === WebSocket.OPEN) {
    project.player.send(
      JSON.stringify({
        action: "remote_count",
        count: project.remotes.size,
        trialStart: project.trialStart,
        trialTimeRemaining: project.trialTimeRemaining,
        trialExpired: project.trialExpired,
        trialDuration: TRIAL_DURATION,
      }),
    );
  }
}

function updateTrialTicking(project, project_id) {
  if (project.trialExpired) return;
  if (!project.trialStart) return;

  const shouldTick = project.remotes.size > 0 && project.player;

  if (shouldTick) {
    if (!project.timer) {
      project.lastActiveTime = Date.now();
      project.timer = setInterval(() => {
        const now = Date.now();
        const elapsed = now - project.lastActiveTime;
        project.lastActiveTime = now;

        project.trialTimeRemaining -= elapsed;
        if (project.trialTimeRemaining <= 0) {
          project.trialTimeRemaining = 0;
          project.trialExpired = true;
          clearInterval(project.timer);
          project.timer = null;

          const expireMsg = JSON.stringify({ action: "trial-expired" });
          if (project.player && project.player.readyState === WebSocket.OPEN) {
            project.player.send(expireMsg);
          }
          project.remotes.forEach((remote) => {
            if (remote.readyState === WebSocket.OPEN) {
              remote.send(expireMsg);
            }
          });
          project.standbyPlayers.forEach((standby) => {
            if (standby.readyState === WebSocket.OPEN) {
              standby.send(expireMsg);
            }
          });

          if (typeof fetch !== "undefined") {
            const headers = { "Content-Type": "application/json" };
            if (project.token) {
              headers["Authorization"] = `Bearer ${project.token}`;
            }
            headers["X-Internal-Key"] =
              process.env.INTERNAL_SERVICE_KEY ||
              "3abbb02beb3f2d1be93ea55b11620cf3f884b10c84521dd86ba7d05a707724eb";
            fetch(
              `${process.env.BACKEND_API_URL || "http://localhost:8080"}/api/projects/${project_id}/expire`,
              {
                method: "POST",
                headers: headers,
              },
            )
              .then(async (response) => {
                if (!response.ok) {
                  const text = await response.text();
                  console.error("Failed to expire trial:", text);
                  throw text;
                }
                const data = await response.json();
                console.log("Trial expired successfully:", data);
              })
              .catch((e) => {
                console.log("Failed to expire trial:", e);
              });
          }
        } else {
          broadcastTrialStatus(project);
          sendRemoteCount(project);
        }
      }, 1000);
    }
  } else {
    if (project.timer) {
      const elapsed = Date.now() - project.lastActiveTime;
      project.trialTimeRemaining -= Math.max(0, elapsed);
      if (project.trialTimeRemaining < 0) project.trialTimeRemaining = 0;
      clearInterval(project.timer);
      project.timer = null;
      broadcastTrialStatus(project);
      sendRemoteCount(project);
    }
  }
}

class Utils {
  static getProject(project_id) {
    if (!projects.has(project_id)) {
      projects.set(project_id, {
        player: null,
        remotes: new Map(),
        standbyPlayers: new Map(), // extra players waiting
        trialStart: null,
        trialTimeRemaining: TRIAL_DURATION,
        trialExpired: false,
        timer: null,
        lastActiveTime: null,
        token: null,
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
  const { project_id, device_id, type, trialUsed, token } = url.parse(request.url, true).query;

  const project = Utils.getProject(project_id);

  webSocket.project_id = project_id;
  webSocket.device_id = device_id;
  webSocket.type = type;

  // Seed trial state from backend database (player only)
  if (type === "player") {
    if (token) {
      project.token = token;
    }
    if (trialUsed === "true") {
      project.trialExpired = true;
      project.trialTimeRemaining = 0;
    } else if (trialUsed === "false") {
      project.trialExpired = false;
      project.trialTimeRemaining = TRIAL_DURATION;
      project.trialStart = null;
    }
  }

  if (type === "player") {
    if (project.player) {
      // Queue this player
      project.standbyPlayers.set(device_id, webSocket);
      Utils.send(webSocket, "player_demoted", {});
    } else {
      project.player = webSocket;
      Utils.send(webSocket, "player_connected");
      // Notify remotes
      project.remotes.forEach((remote) => Utils.send(remote, "player_available"));
      project.standbyPlayers.forEach((standby) => {
        Utils.send(standby, "new_player_connected");
      });
    }
  } else {
    // Add remote
    project.remotes.set(device_id, webSocket);
    Utils.send(webSocket, project.player ? "player_available" : "no_player_connected");
  }

  // Notify current player of remote count and trial state
  sendRemoteCount(project);

  // Send current trial status to the connecting websocket
  Utils.send(webSocket, "trial-status", {
    trialStart: project.trialStart,
    trialTimeRemaining: project.trialTimeRemaining,
    trialExpired: project.trialExpired,
    trialDuration: TRIAL_DURATION,
  });

  updateTrialTicking(project, project_id);

  webSocket.on("message", function incoming(message) {
    if (message.toString() === "ping") {
      webSocket.send("pong");
      return;
    }

    const data = JSON.parse(message);
    const { id, type, action, payload } = data;

    if (action === "start-trial") {
      if (!project.trialStart) {
        project.trialStart = Date.now();
        project.trialTimeRemaining = TRIAL_DURATION;
        project.trialExpired = false;

        updateTrialTicking(project, project_id);
        sendRemoteCount(project);
        broadcastTrialStatus(project);
      }
      return;
    }

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
        project.remotes.forEach((remote) => Utils.send(remote, "player_available"));
      }
    }

    // Broadcast the message to all connected clients (including the sender)
    function broadcast(data = {}) {
      // Allow special actions from any player

      // Only allow:
      // - main player (project.player)
      // - remotes
      // - standby players, but only for SPECIAL_BROADCAST_ACTIONS
      const isMainPlayer = project.player === webSocket && webSocket.type === "player";
      const isRemote = webSocket.type === "remote";
      const isStandbyPlayer =
        project.standbyPlayers.has(webSocket.device_id) && webSocket.type === "player";
      const isSpecialAction = SPECIAL_BROADCAST_ACTIONS.includes(data.action);

      if (!project || (!isMainPlayer && !isRemote && !(isStandbyPlayer && isSpecialAction))) {
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
        project.remotes.forEach((remote) => Utils.send(remote, "no_player_connected"));

        // Also notify all standby players (in case their UI is waiting)
        project.standbyPlayers.forEach((standby) => Utils.send(standby, "no_player_connected"));
      } else {
        project.standbyPlayers.delete(webSocket.device_id);
      }
    } else {
      // Remote disconnected
      project.remotes.delete(webSocket.device_id);

      // Update remote count for active player
      sendRemoteCount(project);
    }
    updateTrialTicking(project, project_id);
  });
});

console.log("WebSocket server running on ws://localhost:8080");

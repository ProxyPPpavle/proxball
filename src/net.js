import Peer from 'peerjs';

let peer = null;
let conn = null;
let connections = {};

export const initNetwork = ({ playerName, isHost, targetPeerId, onMsg, password }) => {
  return new Promise((resolve, reject) => {
    peer = new Peer({
      config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }
    });

    peer.on('open', id => {
      if (isHost) {
        peer.on('connection', c => {
          connections[c.peer] = c;
          c.on('open', () => {
            // FIX: Use c.metadata.playerName instead of local playerName!
            const guestName = c.metadata?.playerName || 'Guest';
            if (onMsg) onMsg({ type: 'guest-joined', playerName: guestName }, c.peer);
          });
          c.on('data', data => {
            if (onMsg) onMsg(data, c.peer);
          });
          c.on('close', () => {
            delete connections[c.peer];
            if (onMsg) onMsg({ type: 'player-left', id: c.peer });
          });
        });
        resolve(id);
      } else {
        conn = peer.connect(targetPeerId, {
          metadata: { playerName, password } // Sending our name
        });
        conn.on('open', () => resolve(id));
        conn.on('data', data => {
          if (onMsg) onMsg(data, conn.peer);
        });
        conn.on('close', () => {
          if (onMsg) onMsg({ type: 'player-left', id: targetPeerId });
        });
        conn.on('error', err => reject(err));
      }
    });
    peer.on('error', err => reject(err));
  });
};

export const sendMessage = (msg, targetId) => {
  if (targetId && connections[targetId]) {
    connections[targetId].send(msg);
  } else if (conn) {
    conn.send(msg);
  } else {
    Object.values(connections).forEach(c => c.send(msg));
  }
};

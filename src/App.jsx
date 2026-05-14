import React, { useState, useEffect, useRef } from 'react';
import Peer from 'peerjs';
import { initNetwork, sendMessage } from './net.js';
import { initGame, pauseGame, resumeGame, handleRemoteInput, stopGame, removePlayer, syncPlayers } from './game.js';
import { Users, Plus, Play, Shield, Settings, LogOut, ChevronRight, Trophy, Clock, Activity, Hash, Lock, X } from 'lucide-react';

export default function App() {
  const [screen, setScreen] = useState('landing');
  const [playerName, setPlayerName] = useState(sessionStorage.getItem('proxball_name') || 'Player' + Math.floor(Math.random() * 999));
  const [roomName, setRoomName] = useState('My Stadium');
  const [password, setPassword] = useState('');
  const [timeLimit, setTimeLimit] = useState(3);
  const [scoreLimit, setScoreLimit] = useState(5);
  const [dashEnabled, setDashEnabled] = useState(true);
  const [chargedKickEnabled, setChargedKickEnabled] = useState(true);
  const [staminaEnabled, setStaminaEnabled] = useState(true);

  const matchSettingsRef = useRef({
    timeLimit: 3,
    scoreLimit: 5,
    dashEnabled: true,
    chargedKickEnabled: true,
    staminaEnabled: true
  });
  
  const [rooms, setRooms] = useState({});
  const [selectedRoom, setSelectedRoom] = useState(null);
  const [manualId, setManualId] = useState('');
  const [isHost, setIsHost] = useState(false);
  const [peerId, setPeerId] = useState(null);
  const [targetId, setTargetId] = useState(null); // To show the stadium code to guests
  const [isPaused, setIsPaused] = useState(false);
  
  const [players, setPlayers] = useState({});
  const playersRef = useRef({});
  const peerIdRef = useRef(peerId);
  const screenRef = useRef(screen);
  const [selectedPlayerId, setSelectedPlayerId] = useState(null);

  useEffect(() => { peerIdRef.current = peerId; }, [peerId]);
  useEffect(() => { screenRef.current = screen; }, [screen]);
  useEffect(() => { playersRef.current = players; }, [players]);

  const [isGoalHappening, setIsGoalHappening] = useState(false);
  const [isGameOver, setIsGameOver] = useState(false);
  const [isKicked, setIsKicked] = useState(false);
  const [scorerName, setScorerName] = useState("");
  const [scorerTeam, setScorerTeam] = useState("");
  const canvasRef = useRef(null);
  const resumeTimeoutRef = useRef(null);

  useEffect(() => { sessionStorage.setItem('proxball_name', playerName); }, [playerName]);

  useEffect(() => {
    matchSettingsRef.current = {
      timeLimit,
      scoreLimit,
      dashEnabled,
      chargedKickEnabled,
      staminaEnabled
    };
  }, [timeLimit, scoreLimit, dashEnabled, chargedKickEnabled, staminaEnabled]);

  useEffect(() => {
    const onGoalUi = (e) => {
      const d = e.detail || {};
      if (typeof d.celebration === 'boolean') setIsGoalHappening(d.celebration);
      if (d.scorer != null) setScorerName(String(d.scorer));
      if (d.team != null) setScorerTeam(String(d.team));
      if (d.isOwnGoal != null) setIsOwnGoal(!!d.isOwnGoal);
      if (d.isGameOver != null) setIsGameOver(!!d.isGameOver);
      
      if (d.type === 'end-game-ui') {
        stopGame();
        setScreen('lobby');
        setIsPaused(false);
        setIsGoalHappening(false);
        setIsGameOver(false);
      }
    };
    window.addEventListener('proxball-goal-ui', onGoalUi);
    return () => window.removeEventListener('proxball-goal-ui', onGoalUi);
  }, []);

  // GLOBAL DISCOVERY SYSTEM (P2P Hub)
  useEffect(() => {
    let hubConn = null;
    let localHub = null;
    const HUB_ID = 'PB-GLOBAL-LOBBY-HUB-v1';

    const startDiscovery = async () => {
      const p = new Peer(HUB_ID, { config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] } });
      
      p.on('open', () => {
        // I am the HUB!
        localHub = p;
        const globalRooms = {};
        
        // Hub's own update loop
        const hubInterval = setInterval(() => {
          if (isHost && peerId) {
            globalRooms[peerId] = { id: peerId, roomName, hostName: playerName, playerCount: Object.keys(playersRef.current).length, lastUpdate: Date.now() };
          }
          // Cleanup old rooms
          const now = Date.now();
          Object.keys(globalRooms).forEach(id => { if (now - globalRooms[id].lastUpdate > 15000) delete globalRooms[id]; });
          setRooms({ ...globalRooms });
        }, 3000);

        p.on('connection', c => {
          c.on('data', data => {
            if (data.type === 'register-room') {
              globalRooms[c.peer] = { ...data.room, lastUpdate: Date.now() };
            } else if (data.type === 'get-rooms') {
              c.send({ type: 'rooms-list', rooms: globalRooms });
            }
          });
        });
        return () => clearInterval(hubInterval);
      });

      p.on('error', (err) => {
        if (err.type === 'unavailable-id') {
          // Hub already exists, connect as client
          const clientPeer = new Peer({ config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] } });
          clientPeer.on('open', () => {
            const conn = clientPeer.connect(HUB_ID);
            hubConn = conn;
            const interval = setInterval(() => {
              if (conn.open) {
                conn.send({ type: 'get-rooms' });
                if (isHost && peerId) {
                  conn.send({ type: 'register-room', room: { id: peerId, roomName, hostName: playerName, playerCount: Object.keys(playersRef.current).length } });
                }
              }
            }, 3000);
            conn.on('data', data => {
              if (data.type === 'rooms-list') setRooms(data.rooms);
            });
            return () => clearInterval(interval);
          });
        }
      });
    };

    startDiscovery();
  }, [isHost, peerId, playerName, roomName]);

  const handleNetworkMessage = (msg, senderPeerId) => {
    if (msg.type === 'guest-joined') {
      setPlayers(prev => {
        const next = { ...prev, [senderPeerId]: { name: msg.playerName || 'Guest', team: 'bench' } };
        sendMessage({ type: 'lobby-update', players: next, settings: { ...matchSettingsRef.current } });
        if (screenRef.current === 'game') {
          import('./game.js').then(m => m.addPlayer(senderPeerId, { name: msg.playerName || 'Guest', team: 'bench' }));
          // If match is already running, tell the new guest to start their engine
          if (!isPaused) sendMessage({ type: 'pause', val: false }, senderPeerId);
        }
        return next;
      });
    } else if (msg.type === 'player-left') {
      setPlayers(prev => {
        const next = { ...prev };
        delete next[msg.id];
        if (isHost) sendMessage({ type: 'lobby-update', players: next, settings: { ...matchSettingsRef.current } });
        return next;
      });
      if (screenRef.current === 'game') removePlayer(msg.id);
    } else if (msg.type === 'lobby-update') {
      setPlayers(msg.players);
      if (screenRef.current === 'game') syncPlayers(msg.players);
      if (msg.settings) {
        if (msg.settings.timeLimit != null) setTimeLimit(msg.settings.timeLimit);
        if (msg.settings.scoreLimit != null) setScoreLimit(msg.settings.scoreLimit);
        if (typeof msg.settings.dashEnabled === 'boolean') setDashEnabled(msg.settings.dashEnabled);
        if (typeof msg.settings.chargedKickEnabled === 'boolean') setChargedKickEnabled(msg.settings.chargedKickEnabled);
        if (typeof msg.settings.staminaEnabled === 'boolean') setStaminaEnabled(msg.settings.staminaEnabled);
      }
    } else if (msg.type === 'start-game') {
      setScreen('game');
      setTimeout(() => initGame({ 
        canvas: canvasRef.current,
        playerName, team: msg.players[peerId]?.team || 'bench', 
        settings: msg.settings, peerId, allPlayers: msg.players, isHost: false 
      }), 150);
    } else if (msg.type === 'end-game') {
      stopGame();
      setScreen('lobby');
      setIsPaused(false);
      setIsGoalHappening(false);
      setIsGameOver(false);
    } else if (msg.type === 'game-over') {
      setIsGoalHappening(true);
      setIsGameOver(true);
      if (msg.winner) setScorerName(msg.winner);
      if (msg.team) setScorerTeam(msg.team);
    } else if (msg.type === 'kick-player') {
      if (msg.id === peerIdRef.current) {
        setIsKicked(true);
        stopGame();
        setTimeout(() => {
          setScreen('landing');
          setIsKicked(false);
          window.location.reload();
        }, 3000);
      }
    } else if (msg.type === 'pos' || msg.type === 'kick' || msg.type === 'ball-sync') {
      handleRemoteInput(msg);
    } else if (msg.type === 'score') {
      handleRemoteInput(msg);
      setIsGoalHappening(msg.celebration);
      if (msg.scorer) setScorerName(msg.scorer);
      if (msg.team) setScorerTeam(msg.team);
      if (msg.isOwnGoal !== undefined) setIsOwnGoal(msg.isOwnGoal);
    } else if (msg.type === 'pause') {
      setIsPaused(msg.val);
      if (msg.val) {
        pauseGame();
        setScreen('lobby');
      } else {
        if (screenRef.current !== 'game') {
          // Late joiner or resuming while in lobby
          setScreen('game');
          if (resumeTimeoutRef.current) clearTimeout(resumeTimeoutRef.current);
          resumeTimeoutRef.current = setTimeout(() => {
            if (!canvasRef.current) return;
            const pid = peerIdRef.current;
            initGame({ 
              canvas: canvasRef.current,
              playerName, team: playersRef.current[pid]?.team || 'bench', 
              settings: matchSettingsRef.current, peerId: pid, allPlayers: playersRef.current, isHost: false 
            });
            resumeTimeoutRef.current = null;
          }, 300);
        } else {
          resumeGame();
          setScreen('game');
        }
      }
    }
  };

  const handleCreateFinal = async () => {
    try {
      const id = await initNetwork({ playerName, isHost: true, password, onMsg: handleNetworkMessage });
      setPeerId(id);
      peerIdRef.current = id;
      setIsHost(true);
      setPlayers({ [id]: { name: playerName, team: 'red' } });
      setScreen('lobby');
    } catch (err) { alert(err.message); }
  };

  const handleJoin = async () => {
    let targetId = selectedRoom || manualId.trim().toUpperCase();
    if (!targetId) return;
    if (!targetId.startsWith('PB-')) targetId = 'PB-' + targetId;
    
    setIsHost(false);
    try {
      const id = await initNetwork({ playerName, isHost: false, targetPeerId: targetId, onMsg: handleNetworkMessage });
      setTargetId(targetId);
      setPeerId(id);
      peerIdRef.current = id; // IMMEDIATE SYNC to prevent movement lockout
      setScreen('lobby');
    } catch (err) { alert("Stadium not found! Check the code."); }
  };

  const handleMoveToTeam = (team) => {
    if (!isHost || !selectedPlayerId) return;
    setPlayers(prev => {
      const next = { ...prev };
      if (next[selectedPlayerId]) {
        next[selectedPlayerId].team = team;
        if (screenRef.current === 'game') syncPlayers(next);
        sendMessage({ type: 'lobby-update', players: next, settings: { ...matchSettingsRef.current } });
      }
      return next;
    });
    setSelectedPlayerId(null);
  };

  const handleKickPlayer = (id) => {
    if (!isHost || id === peerIdRef.current) return;
    sendMessage({ type: 'kick-player', id });
    setPlayers(prev => {
      const next = { ...prev };
      delete next[id];
      sendMessage({ type: 'lobby-update', players: next, settings: { ...matchSettingsRef.current } });
      return next;
    });
    // Always try to remove from physics engine if it's running
    removePlayer(id);
    setSelectedPlayerId(null);
  };
  
  const handleExitGame = () => {
    if (window.confirm("Are you sure you want to exit?")) {
      stopGame();
      setScreen('landing');
      // PeerJS connection will close on page refresh/navigate anyway, 
      // but we could explicitly disconnect here if we had the peer object.
      window.location.reload(); 
    }
  };

  const handleStartMatch = () => {
    sendMessage({ type: 'start-game', players: playersRef.current, settings: { timeLimit, scoreLimit, dashEnabled, chargedKickEnabled, staminaEnabled } });
    setScreen('game');
    setTimeout(() => {
      initGame({ 
        canvas: canvasRef.current,
        playerName, team: playersRef.current[peerId]?.team || 'red', 
        settings: { timeLimit, scoreLimit, dashEnabled, chargedKickEnabled, staminaEnabled }, peerId, allPlayers: playersRef.current, isHost: true 
      });
    }, 150);
  };

  const togglePause = () => {
    const next = !isPaused;
    if (!next && isHost) {
      // Re-sync everyone's state right before resuming
      sendMessage({ type: 'lobby-update', players: playersRef.current, settings: matchSettingsRef.current });
      syncPlayers(playersRef.current);
    }
    setIsPaused(next);
    sendMessage({ type: 'pause', val: next });
    if (next) {
      pauseGame();
      setScreen('lobby');
    } else {
      resumeGame();
      setScreen('game');
    }
  };

  const handleEndGame = () => {
    sendMessage({ type: 'end-game' });
    stopGame();
    setScreen('lobby');
    setIsPaused(false);
  };

  const [isOwnGoal, setIsOwnGoal] = useState(false);

  return (
    <div className={`app-container ${screen === 'game' ? 'game-mode' : ''}`}>
      {screen === 'landing' && (
        <div className="panel">
          <h1>PROXBALL</h1>
          <div className="input-group">
            <label style={{textAlign:'left'}}>NICKNAME</label>
            <input value={playerName} onChange={(e) => setPlayerName(e.target.value)} placeholder="Enter your name..." />
          </div>
          
          <div className="server-list">
            <div className="server-header" style={{justifyContent:'center', position:'relative'}}>
              <span style={{display:'flex', alignItems:'center', gap:'5px'}}><Activity size={12} style={{marginRight:'6px', verticalAlign:'middle'}} /> LIVE MATCHES</span>
            </div>
            {Object.values(rooms).length === 0 ? (
              <div className="server-item empty" style={{padding: '40px 20px'}}>
                <Clock size={32} className="spinning" style={{opacity: 0.3}} />
                <div style={{marginTop: '15px', opacity: 0.5, fontWeight: '700', letterSpacing: '1px'}}>SEARCHING STADIUMS...</div>
              </div>
            ) : (
              Object.values(rooms).map(room => (
                <div 
                  key={room.id} 
                  className={`server-item ${selectedRoom === room.id ? 'selected' : ''}`} 
                  onClick={() => setSelectedRoom(room.id)}
                >
                  <Shield size={20} strokeWidth={2.5} color={selectedRoom === room.id ? '#050a05' : 'var(--accent)'} />
                  <div style={{flex: 1}}>
                    <div style={{fontSize: '15px', fontWeight: '800'}}>{room.roomName.toUpperCase()}</div>
                    <div style={{fontSize: '11px', opacity: 0.6, fontWeight: '600'}}>HOST: {room.hostName.toUpperCase()}</div>
                  </div>
                  <div style={{display: 'flex', alignItems: 'center', gap: '10px'}}>
                    {room.hasPassword && <Lock size={12} opacity={0.6} />}
                    <div style={{fontSize: '12px', fontWeight: '800', opacity: 0.8}}>{room.playerCount || 1}/12</div>
                    <ChevronRight size={18} opacity={0.4} />
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="input-group" style={{marginTop: '10px'}}>
            <label style={{textAlign:'left', fontSize: '10px', opacity: 0.6}}>OR JOIN MANUALLY BY ID</label>
            <input 
              value={manualId} 
              onChange={(e) => setManualId(e.target.value)} 
              placeholder="Paste Stadium ID here..." 
              style={{fontSize: '12px', padding: '8px 12px'}}
            />
          </div>
          
          <div className="button-group">
            <button className="btn-secondary" onClick={() => setScreen('setup')}>
              <Plus size={18} />
              HOST
            </button>
            <button className="btn-primary" disabled={!selectedRoom && !manualId.trim()} onClick={handleJoin}>
              <Play size={18} />
              ENTER MATCH
            </button>
          </div>
        </div>
      )}

      {screen === 'setup' && (
        <div className="panel">
          <h2>STADIUM CONFIG</h2>
          <div className="input-group">
            <label>STADIUM NAME</label>
            <input value={roomName} onChange={(e) => setRoomName(e.target.value)} placeholder="Champion's Arena..." />
          </div>
          <div className="input-group">
            <label>PASSWORD (OPTIONAL)</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Keep it secret..." />
          </div>
          <div className="button-group">
            <button className="btn-secondary" onClick={() => setScreen('landing')}>BACK</button>
            <button className="btn-primary" onClick={handleCreateFinal}>CREATE</button>
          </div>
        </div>
      )}


      {screen === 'lobby' && (
        <div className="lobby-view">
          <div style={{textAlign:'center', marginBottom: '15px', background: 'rgba(255,255,255,0.05)', padding: '15px', borderRadius: '12px', border: '1px dashed rgba(255,255,255,0.2)'}}>
            <div style={{fontSize: '10px', opacity: 0.5, letterSpacing: '2px', marginBottom: '5px'}}>STADIUM CODE (SHARE THIS)</div>
            <div style={{fontSize: '32px', fontWeight: '900', color: 'var(--accent)', cursor: 'pointer', letterSpacing: '8px'}} 
                 onClick={() => { 
                   const code = isHost ? peerId.replace('PB-','') : (targetId ? targetId.replace('PB-','') : '---');
                   navigator.clipboard.writeText(code); 
                   alert("Code Copied!"); 
                 }}>
              {isHost ? (peerId ? peerId.replace('PB-','') : '---') : (targetId ? targetId.replace('PB-','') : '---')}
            </div>
          </div>
          <div className="teams-grid">
            {['red', 'bench', 'blue'].map(t => (
              <div key={t} className={`team-card ${t}`} onClick={() => handleMoveToTeam(t)}>
                <div className="team-header">
                  {t === 'red' && <Shield size={20} fill="var(--red)" color="var(--red)" />}
                  {t === 'blue' && <Shield size={20} fill="var(--blue)" color="var(--blue)" />}
                  {t === 'bench' && <Users size={20} color="var(--text-dim)" />}
                  {t.toUpperCase()}
                </div>
                <div className="player-list">
                  {Object.keys(players).filter(id => players[id].team === t).map(id => (
                    <div key={id} 
                         className={`player-row ${selectedPlayerId === id ? 'selected' : ''}`} 
                         onClick={(e) => { e.stopPropagation(); if(isHost) setSelectedPlayerId(id); }}>
                      <span style={{display: 'flex', alignItems: 'center', gap: '8px', flex: 1, minWidth: 0}}>
                        <span style={{whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'}}>
                          {players[id].name.toUpperCase()}
                        </span>
                        {id === peerId && <span className="player-tag">YOU</span>}
                      </span>
                      {isHost && id !== peerId && (
                        <button className="btn-kick-small" onClick={(e) => { e.stopPropagation(); handleKickPlayer(id); }} title="Kick Player">
                          <X size={12} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="settings-bar">
            <div className="settings-bar-left">
            <div style={{display: 'flex', gap: '24px', alignItems: 'center', flexWrap: 'wrap'}}>
              <div style={{display: 'flex', alignItems: 'center', gap: '10px'}}>
                <Trophy size={18} color="#166534" />
                {isHost ? (
                  <input type="number" value={scoreLimit} onChange={(e) => {
                    const val = parseInt(e.target.value);
                    setScoreLimit(val);
                    sendMessage({ type: 'lobby-update', players, settings: { timeLimit, scoreLimit: val, dashEnabled, chargedKickEnabled, staminaEnabled } });
                  }} style={{width: '60px', padding: '6px'}} />
                ) : (
                  <span style={{fontWeight: '800'}}>{scoreLimit} GOALS</span>
                )}
              </div>
              <div style={{display: 'flex', alignItems: 'center', gap: '10px'}}>
                <Clock size={18} color="#166534" />
                {isHost ? (
                  <input type="number" value={timeLimit} onChange={(e) => {
                    const val = parseInt(e.target.value);
                    setTimeLimit(val);
                    sendMessage({ type: 'lobby-update', players, settings: { timeLimit: val, scoreLimit, dashEnabled, chargedKickEnabled, staminaEnabled } });
                  }} style={{width: '60px', padding: '6px'}} />
                ) : (
                  <span style={{fontWeight: '800'}}>{timeLimit} MINS</span>
                )}
              </div>
            </div>
            <div className="lobby-match-options">
              <label className="lobby-check">
                <input type="checkbox" checked={dashEnabled} disabled={!isHost} onChange={(e) => { const v = e.target.checked; setDashEnabled(v); if (isHost) sendMessage({ type: 'lobby-update', players, settings: { timeLimit, scoreLimit, dashEnabled: v, chargedKickEnabled, staminaEnabled } }); }} />
                <span>DASH (Q)</span>
              </label>
              <label className="lobby-check">
                <input type="checkbox" checked={chargedKickEnabled} disabled={!isHost} onChange={(e) => { const v = e.target.checked; setChargedKickEnabled(v); if (isHost) sendMessage({ type: 'lobby-update', players, settings: { timeLimit, scoreLimit, dashEnabled, chargedKickEnabled: v, staminaEnabled } }); }} />
                <span>CHARGED SHOT (SPACE)</span>
              </label>
              <label className="lobby-check">
                <input type="checkbox" checked={staminaEnabled} disabled={!isHost} onChange={(e) => { const v = e.target.checked; setStaminaEnabled(v); if (isHost) sendMessage({ type: 'lobby-update', players, settings: { timeLimit, scoreLimit, dashEnabled, chargedKickEnabled, staminaEnabled: v } }); }} />
                <span>SPRINT (E)</span>
              </label>
            </div>
            </div>
            
            <div style={{display: 'flex', gap: '16px'}}>
              {isHost ? (
                <>
                  {isPaused ? (
                    <button className="btn-primary" style={{width: 'auto', minWidth: '180px', background: '#d97706'}} onClick={togglePause}>
                      <Play size={18} />
                      RESUME
                    </button>
                  ) : (
                    <button className="btn-primary" style={{width: 'auto', minWidth: '180px'}} onClick={handleStartMatch}>
                      <Play size={18} />
                      KICK OFF!
                    </button>
                  )}
                </>
              ) : (
                <div className="waiting-msg" style={{color: 'var(--text-dim)', fontWeight: '800', display: 'flex', alignItems: 'center', gap: '10px'}}>
                  <Clock size={18} className="spinning" />
                  WAITING...
                </div>
              )}
              <button className="btn-secondary" style={{width: 'auto', padding: '16px'}} onClick={() => window.location.reload()}>
                <LogOut size={18} />
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="game-screen" style={{display: screen === 'game' ? 'flex' : 'none'}}>
          <canvas id="gameCanvas" ref={canvasRef} />
          
          <div id="scoreboard">
            <span id="score-red" style={{color:'var(--accent-red)'}}>0</span>
            <span className="score-divider">VS</span>
            <span id="score-blue" style={{color:'var(--accent-blue)'}}>0</span>
          </div>
          <div id="match-timer" style={{ position: 'absolute', top: '85px', left: '50%', transform: 'translateX(-50%)', color: 'rgba(255,255,255,0.8)', fontSize: '20px', fontWeight: '800', textShadow: '0 2px 4px rgba(0,0,0,0.5)', zIndex: 10 }}>0:00</div>
          
          {isHost ? (
            <button className="btn-top-right pause-btn" onClick={togglePause}>
              <Settings size={16} /> MENU
            </button>
          ) : (
            <button className="btn-top-right exit-btn-top" onClick={handleExitGame}>
              <LogOut size={16} /> EXIT
            </button>
          )}

          {isKicked && (
            <div className="goal-overlay" style={{zIndex: 10000}}>
              <div className="goal-text">
                <div style={{color: '#ff4b4b', fontSize: '10rem'}}>KICKED</div>
              </div>
            </div>
          )}

          {isGoalHappening && (
            <div className="goal-overlay" key="goal-celebration">
              <div className="goal-text">
                <div style={{fontSize: '4.5rem', opacity: 0.9, marginBottom: '-10px', color: scorerTeam === 'red' ? '#ff4b4b' : (scorerTeam === 'blue' ? '#3b82f6' : '#fff')}}>{scorerName.toUpperCase()}</div>
                <div style={{color: '#fff', fontSize: '10rem'}}>
                  {isGameOver ? 'WINS THE MATCH!' : (isOwnGoal ? 'IS DUMB!' : 'SCORED!')}
                </div>
              </div>
            </div>
          )}

          {isPaused && screen === 'game' && (
            <div className="game-menu-overlay">
              <div className="menu-panel">
                <h2>PAUSED</h2>
                <div className="button-group">
                  <button className="btn-primary" onClick={togglePause}>RESUME</button>
                  <button className="btn-secondary btn-danger" onClick={handleEndGame}>QUIT</button>
                </div>
              </div>
            </div>
          )}
        </div>
    </div>
  );
}



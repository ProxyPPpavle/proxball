import Matter from 'matter-js';
import { sendMessage } from './net.js';

function notifyGoalUi(detail) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('proxball-goal-ui', { detail }));
}

let engine, render, runner;
let ball;
let players = {};
let localPlayerId = null;
let localPlayerName = "";
let keys = {};
let keyHandlers = null;
let lastMoveDir = { x: 1, y: 0 };
let lastDashTime = 0;
let dashRequested = false;
let score = { red: 0, blue: 0 };
let amIHost = false;
let isGoalHappening = false;
let lastKickerName = "";

const BALL_RADIUS = 12;
const PLAYER_RADIUS = 25;
const PITCH_WIDTH = 1180;
const PITCH_HEIGHT = 640;
/** Goal mouth height on Y (touchlines stay aligned). */
const GOAL_SIZE = 178;
/** Net depth along X into margin — shallow so goals are not “wide boxes”. */
const GOAL_DEPTH = 52;
const POST_RADIUS = 10;
const PITCH_OFFSET_X = 96;
const PITCH_OFFSET_Y = 68;
const CENTER_CIRCLE_R = Math.round(Math.min(PITCH_WIDTH, PITCH_HEIGHT) * 0.145);
const STRIPE_WIDTH = 88;
const DASH_COOLDOWN_MS = 850;
const DASH_SPEED_ADD = 3;
const DASH_MAX_SPEED = 9.5;
const KICK_CHARGE_MS_FULL = 1000;
const KICK_FORCE_MIN = 3.4;
const KICK_FORCE_MAX = 13;
const KICK_REACH = PLAYER_RADIUS + BALL_RADIUS + 16;
const INSTANT_KICK_CHARGE = 0.28;
const gameStaminaEnabled = true;
const gameChargedKickEnabled = false; // User didn't ask for charged kick, just instant + visual
const gameDashEnabled = false;

let renderFrameId = null;
let kickChargeMs = 0;
let localKickCharge01 = 0;

export function initGame({ canvas, playerName, team, settings, peerId, allPlayers, isHost }) {
  stopGame(); // Ensure clean state
  if (!canvas) return; 
  const gameDashEnabled = settings?.dashEnabled !== false;
  const gameChargedKickEnabled = settings?.chargedKickEnabled !== false;
  const gameStaminaEnabled = settings?.staminaEnabled !== false;
  const totalWidth = PITCH_WIDTH + PITCH_OFFSET_X * 2;
  const totalHeight = PITCH_HEIGHT + PITCH_OFFSET_Y * 2;
  
  canvas.width = totalWidth;
  canvas.height = totalHeight;

  localPlayerId = peerId;
  localPlayerName = playerName;
  amIHost = isHost;
  players = {};
  isGoalHappening = false;
  kickChargeMs = 0;
  localKickCharge01 = 0;

  engine = Matter.Engine.create();
  engine.world.gravity.y = 0;

  render = Matter.Render.create({
    canvas: canvas,
    engine: engine,
    options: { 
      width: totalWidth, height: totalHeight, 
      wireframes: false, 
      background: 'transparent' 
    }
  });

  // Borders: inner face flush with white stroke (pitch rectangle), so ball/player edge can sit on the line
  const wallOptions = { isStatic: true, restitution: 0.6, render: { visible: false } };
  const borderThickness = 60;

  Matter.World.add(engine.world, [
    Matter.Bodies.rectangle(totalWidth/2, PITCH_OFFSET_Y - borderThickness/2, PITCH_WIDTH + borderThickness * 2, borderThickness, wallOptions),
    Matter.Bodies.rectangle(totalWidth/2, PITCH_OFFSET_Y + PITCH_HEIGHT + borderThickness/2, PITCH_WIDTH + borderThickness * 2, borderThickness, wallOptions),
    Matter.Bodies.rectangle(PITCH_OFFSET_X - borderThickness/2, PITCH_OFFSET_Y + (PITCH_HEIGHT - GOAL_SIZE) / 4, borderThickness, (PITCH_HEIGHT - GOAL_SIZE) / 2, wallOptions),
    Matter.Bodies.rectangle(PITCH_OFFSET_X - borderThickness/2, PITCH_OFFSET_Y + PITCH_HEIGHT - (PITCH_HEIGHT - GOAL_SIZE) / 4, borderThickness, (PITCH_HEIGHT - GOAL_SIZE) / 2, wallOptions),
    Matter.Bodies.rectangle(PITCH_OFFSET_X + PITCH_WIDTH + borderThickness/2, PITCH_OFFSET_Y + (PITCH_HEIGHT - GOAL_SIZE) / 4, borderThickness, (PITCH_HEIGHT - GOAL_SIZE) / 2, wallOptions),
    Matter.Bodies.rectangle(PITCH_OFFSET_X + PITCH_WIDTH + borderThickness/2, PITCH_OFFSET_Y + PITCH_HEIGHT - (PITCH_HEIGHT - GOAL_SIZE) / 4, borderThickness, (PITCH_HEIGHT - GOAL_SIZE) / 2, wallOptions),

    Matter.Bodies.rectangle(PITCH_OFFSET_X - GOAL_DEPTH - 7, PITCH_OFFSET_Y + PITCH_HEIGHT / 2, 14, GOAL_SIZE, wallOptions),
    Matter.Bodies.rectangle(PITCH_OFFSET_X + PITCH_WIDTH + GOAL_DEPTH + 7, PITCH_OFFSET_Y + PITCH_HEIGHT / 2, 14, GOAL_SIZE, wallOptions),
    Matter.Bodies.rectangle(PITCH_OFFSET_X - GOAL_DEPTH / 2, PITCH_OFFSET_Y + PITCH_HEIGHT / 2 - GOAL_SIZE / 2, GOAL_DEPTH, 10, wallOptions),
    Matter.Bodies.rectangle(PITCH_OFFSET_X - GOAL_DEPTH / 2, PITCH_OFFSET_Y + PITCH_HEIGHT / 2 + GOAL_SIZE / 2, GOAL_DEPTH, 10, wallOptions),
    Matter.Bodies.rectangle(PITCH_OFFSET_X + PITCH_WIDTH + GOAL_DEPTH / 2, PITCH_OFFSET_Y + PITCH_HEIGHT / 2 - GOAL_SIZE / 2, GOAL_DEPTH, 10, wallOptions),
    Matter.Bodies.rectangle(PITCH_OFFSET_X + PITCH_WIDTH + GOAL_DEPTH / 2, PITCH_OFFSET_Y + PITCH_HEIGHT / 2 + GOAL_SIZE / 2, GOAL_DEPTH, 10, wallOptions)
  ]);

  // Posts
  const postOptions = { isStatic: true, restitution: 0.2, render: { fillStyle: '#ffffff', strokeStyle: '#000', lineWidth: 2 } };
  const posts = [
    Matter.Bodies.circle(PITCH_OFFSET_X, PITCH_OFFSET_Y + PITCH_HEIGHT/2 - GOAL_SIZE/2, POST_RADIUS, postOptions),
    Matter.Bodies.circle(PITCH_OFFSET_X, PITCH_OFFSET_Y + PITCH_HEIGHT/2 + GOAL_SIZE/2, POST_RADIUS, postOptions),
    Matter.Bodies.circle(PITCH_OFFSET_X + PITCH_WIDTH, PITCH_OFFSET_Y + PITCH_HEIGHT/2 - GOAL_SIZE/2, POST_RADIUS, postOptions),
    Matter.Bodies.circle(PITCH_OFFSET_X + PITCH_WIDTH, PITCH_OFFSET_Y + PITCH_HEIGHT/2 + GOAL_SIZE/2, POST_RADIUS, postOptions)
  ];
  Matter.World.add(engine.world, posts);

  const sensorW = GOAL_DEPTH + 26;
  const goalRedSensor = Matter.Bodies.rectangle(PITCH_OFFSET_X - sensorW / 2, PITCH_OFFSET_Y + PITCH_HEIGHT / 2, sensorW, GOAL_SIZE - 18, { isStatic: true, isSensor: true, render: { visible: false } });
  const goalBlueSensor = Matter.Bodies.rectangle(PITCH_OFFSET_X + PITCH_WIDTH + sensorW / 2, PITCH_OFFSET_Y + PITCH_HEIGHT / 2, sensorW, GOAL_SIZE - 18, { isStatic: true, isSensor: true, render: { visible: false } });
  Matter.World.add(engine.world, [goalRedSensor, goalBlueSensor]);

  ball = Matter.Bodies.circle(totalWidth/2, totalHeight/2, BALL_RADIUS, {
    restitution: 0.8, frictionAir: 0.012, mass: 1,
    render: { fillStyle: '#ffffff', strokeStyle: '#000', lineWidth: 2 }
  });
  Matter.World.add(engine.world, ball);

  Object.keys(allPlayers).forEach(id => {
    const info = allPlayers[id];
    if (info.team === 'bench') return;
    const spawnIn = Math.round(PITCH_WIDTH * 0.22);
    const spawnX = info.team === 'red' ? PITCH_OFFSET_X + spawnIn : PITCH_OFFSET_X + PITCH_WIDTH - spawnIn;
    const pBody = Matter.Bodies.circle(spawnX, totalHeight/2, PLAYER_RADIUS, {
      frictionAir: 0.05,
      mass: 12, restitution: 0,
      render: { 
        fillStyle: info.team === 'red' ? '#ff4b4b' : '#3b82f6', 
        strokeStyle: '#ffffff', 
        lineWidth: 3, 
        originalColor: info.team === 'red' ? '#ff4b4b' : '#3b82f6' 
      }
    });
    players[id] = { body: pBody, name: info.name, team: info.team, targetPos: null, boost: 100 };
    Matter.World.add(engine.world, pBody);
  });

  function paintScene() {
    const ctx = render.context;
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    ctx.clearRect(0, 0, totalWidth, totalHeight);

    ctx.save();
    ctx.beginPath();
    ctx.rect(PITCH_OFFSET_X, PITCH_OFFSET_Y, PITCH_WIDTH, PITCH_HEIGHT);
    ctx.clip();
    ctx.fillStyle = '#567d46';
    ctx.fillRect(PITCH_OFFSET_X, PITCH_OFFSET_Y, PITCH_WIDTH, PITCH_HEIGHT);
    ctx.fillStyle = '#456438';
    const stripeWidth = STRIPE_WIDTH;
    for (let i = PITCH_OFFSET_X; i < PITCH_OFFSET_X + PITCH_WIDTH; i += stripeWidth * 2) {
      ctx.fillRect(i, PITCH_OFFSET_Y, stripeWidth, PITCH_HEIGHT);
    }
    ctx.restore();

    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 4;
    ctx.strokeRect(PITCH_OFFSET_X, PITCH_OFFSET_Y, PITCH_WIDTH, PITCH_HEIGHT);
    ctx.beginPath();
    ctx.arc(totalWidth / 2, totalHeight / 2, CENTER_CIRCLE_R, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(totalWidth / 2, PITCH_OFFSET_Y);
    ctx.lineTo(totalWidth / 2, PITCH_OFFSET_Y + PITCH_HEIGHT);
    ctx.stroke();

    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.fillRect(PITCH_OFFSET_X - GOAL_DEPTH, PITCH_OFFSET_Y + PITCH_HEIGHT / 2 - GOAL_SIZE / 2, GOAL_DEPTH, GOAL_SIZE);
    ctx.strokeRect(PITCH_OFFSET_X - GOAL_DEPTH, PITCH_OFFSET_Y + PITCH_HEIGHT / 2 - GOAL_SIZE / 2, GOAL_DEPTH, GOAL_SIZE);
    ctx.fillRect(PITCH_OFFSET_X + PITCH_WIDTH, PITCH_OFFSET_Y + PITCH_HEIGHT / 2 - GOAL_SIZE / 2, GOAL_DEPTH, GOAL_SIZE);
    ctx.strokeRect(PITCH_OFFSET_X + PITCH_WIDTH, PITCH_OFFSET_Y + PITCH_HEIGHT / 2 - GOAL_SIZE / 2, GOAL_DEPTH, GOAL_SIZE);

    Matter.Render.bodies(render, Matter.Composite.allBodies(engine.world), ctx);

    // Names and BOOST BARS
    ctx.font = 'bold 13px Inter'; ctx.textAlign = 'center';
    Object.keys(players).forEach(id => {
      const p = players[id];
      const { x, y } = p.body.position;
      ctx.fillStyle = p.team === 'red' ? '#ff4b4b' : '#3b82f6';
      const nameY = Math.max(20, y - PLAYER_RADIUS - 15);
      ctx.fillText(p.name.toUpperCase(), x, nameY);

      // Boost Bar (Premium Look)
      const barW = 44;
      const barH = 5;
      const bx = x - barW/2;
      const by = nameY - 18;
      
      // Shadow/BG
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(bx, by, barW, barH);
      
      // Progress
      if (p.boost > 0) {
        ctx.fillStyle = '#3b82f6';
        ctx.fillRect(bx, by, barW * (p.boost/100), barH);
      }
      
      // Border
      ctx.strokeStyle = 'rgba(255,255,255,0.2)';
      ctx.lineWidth = 1;
      ctx.strokeRect(bx, by, barW, barH);
    });

    const lpLocal = players[localPlayerId];
    if (lpLocal && gameChargedKickEnabled && localKickCharge01 > 0.02) {
      const { x, y } = lpLocal.body.position;
      const t = localKickCharge01;
      ctx.save();
      ctx.fillStyle = `rgba(255,255,255,${0.2 + t * 0.75})`;
      ctx.beginPath();
      ctx.arc(x, y, PLAYER_RADIUS * (0.12 + t * 0.88), 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
    }

    ctx.restore();
  }

  function frameLoop() {
    if (!render || !engine) {
      renderFrameId = null;
      return;
    }
    paintScene();
    renderFrameId = requestAnimationFrame(frameLoop);
  }

  renderFrameId = requestAnimationFrame(frameLoop);
  runner = Matter.Runner.create();
  Matter.Runner.run(runner, engine);

  lastMoveDir = { x: 1, y: 0 };
  lastDashTime = 0;
  dashRequested = false;
  const onKeyDown = (e) => {
    if (e.code === 'Space') e.preventDefault();
    keys[e.code] = true;
    if (e.code === 'KeyQ' && !e.repeat && gameDashEnabled) dashRequested = true;
    if (e.code === 'Space' && !e.repeat) kickChargeMs = 0;
  };
  const onKeyUp = (e) => {
    keys[e.code] = false;
    if (e.code === 'Space') {
      e.preventDefault();
      handleKick();
    }
  };
  keyHandlers = { onKeyDown, onKeyUp };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  function handleKick() {
    if (isGoalHappening) return;
    const lp = players[localPlayerId];
    if (!lp) return;
    
    // Visual flash ALWAYS happens
    lp.body.render.fillStyle = '#fff';
    setTimeout(() => { if(players[localPlayerId]) players[localPlayerId].body.render.fillStyle = players[localPlayerId].body.render.originalColor; }, 100);
    sendMessage({ type: 'kick-visual', id: localPlayerId });

    const dist = Matter.Vector.magnitude(Matter.Vector.sub(ball.position, lp.body.position));
    if (dist >= KICK_REACH) {
      kickChargeMs = 0;
      localKickCharge01 = 0;
      return;
    }
    const charge01 = gameChargedKickEnabled
      ? Math.min(1, kickChargeMs / KICK_CHARGE_MS_FULL)
      : INSTANT_KICK_CHARGE;
    const dir = Matter.Vector.normalise(Matter.Vector.sub(ball.position, lp.body.position));
    const force = KICK_FORCE_MIN + charge01 * (KICK_FORCE_MAX - KICK_FORCE_MIN);
    Matter.Body.setVelocity(ball, Matter.Vector.mult(dir, force));
    lastKickerName = lp.name;
    sendMessage({ type: 'kick', id: localPlayerId, dir, force, kickerName: lp.name });
    
    kickChargeMs = 0;
    localKickCharge01 = 0;
  }

  Matter.Events.on(engine, 'beforeUpdate', () => {
    const lp = players[localPlayerId];

    if (isGoalHappening) {
      kickChargeMs = 0;
      localKickCharge01 = 0;
    } else if (gameChargedKickEnabled && lp && keys['Space']) {
      const dist = Matter.Vector.magnitude(Matter.Vector.sub(ball.position, lp.body.position));
      if (dist < KICK_REACH) {
        const dt = engine.timing.lastDelta ?? 16.67;
        kickChargeMs += dt;
        if (kickChargeMs > KICK_CHARGE_MS_FULL) kickChargeMs = KICK_CHARGE_MS_FULL;
        localKickCharge01 = Math.min(1, kickChargeMs / KICK_CHARGE_MS_FULL);
      } else {
        localKickCharge01 = 0;
      }
    } else {
      localKickCharge01 = 0;
    }

    if (lp) {
      let f = 0.0035;
      
      // BOOST Logic
      if (gameStaminaEnabled && keys['KeyE'] && lp.boost > 0) {
        f *= 1.2; 
        lp.boost = Math.max(0, lp.boost - 1.2); 
      } else {
        lp.boost = Math.min(100, lp.boost + 0.3); 
      }

      let moveX = 0, moveY = 0;
      if (keys['KeyW']) moveY -= 1;
      if (keys['KeyS']) moveY += 1;
      if (keys['KeyA']) moveX -= 1;
      if (keys['KeyD']) moveX += 1;

      if (moveX !== 0 || moveY !== 0) {
        const mag = Math.sqrt(moveX * moveX + moveY * moveY);
        lastMoveDir = { x: moveX / mag, y: moveY / mag };
        Matter.Body.applyForce(lp.body, lp.body.position, { 
          x: (moveX / mag) * f, 
          y: (moveY / mag) * f 
        });
      }

      if (gameDashEnabled && dashRequested) {
        dashRequested = false;
        if (!isGoalHappening) {
          const now = Date.now();
          if (now - lastDashTime >= DASH_COOLDOWN_MS) {
            let dx = lastMoveDir.x;
            let dy = lastMoveDir.y;
            const v = lp.body.velocity;
            const vlen = Math.hypot(v.x, v.y);
            if (vlen > 0.35) {
              dx = v.x / vlen;
              dy = v.y / vlen;
            } else if (dx === 0 && dy === 0) {
              dx = 1;
              dy = 0;
            }
            let nvx = lp.body.velocity.x + dx * DASH_SPEED_ADD;
            let nvy = lp.body.velocity.y + dy * DASH_SPEED_ADD;
            const sp = Math.hypot(nvx, nvy);
            if (sp > DASH_MAX_SPEED) {
              nvx = (nvx / sp) * DASH_MAX_SPEED;
              nvy = (nvy / sp) * DASH_MAX_SPEED;
            }
            Matter.Body.setVelocity(lp.body, { x: nvx, y: nvy });
            lastDashTime = now;
          }
        }
      }

      sendMessage({ type: 'pos', id: localPlayerId, pos: lp.body.position, vel: lp.body.velocity, boost: lp.boost });
    }
    
    Object.keys(players).forEach(id => {
      if (id !== localPlayerId && players[id].targetPos) {
        const p = players[id];
        const lerpFactor = 0.35;
        const newX = p.body.position.x + (p.targetPos.x - p.body.position.x) * lerpFactor;
        const newY = p.body.position.y + (p.targetPos.y - p.body.position.y) * lerpFactor;
        Matter.Body.setPosition(p.body, { x: newX, y: newY });
      }
    });

    if (amIHost) {
      if (Matter.Collision.collides(ball, goalRedSensor)) { handleGoal('blue'); }
      else if (Matter.Collision.collides(ball, goalBlueSensor)) { handleGoal('red'); }
      sendMessage({ type: 'ball-sync', pos: ball.position, vel: ball.velocity });
    }
  });
}

function handleGoal(team) {
  if (isGoalHappening) return;
  isGoalHappening = true;
  score[team]++;
  sendMessage({ type: 'score', score, celebration: true, scorer: lastKickerName || "SOMEONE", team: team });
  updateScoreboardUI(score);
  notifyGoalUi({ celebration: true, scorer: lastKickerName || 'SOMEONE', team });
  setTimeout(() => {
    isGoalHappening = false;
    resetMatch();
  }, 5000); // 5 SECOND DELAY FOR SMOOTH CELEBRATION
}

function updateScoreboardUI(s) {
  const r = document.getElementById('score-red');
  const b = document.getElementById('score-blue');
  if (r) r.innerText = s.red;
  if (b) b.innerText = s.blue;
}

function resetMatch() {
  const totalWidth = PITCH_WIDTH + PITCH_OFFSET_X * 2;
  const totalHeight = PITCH_HEIGHT + PITCH_OFFSET_Y * 2;
  Matter.Body.setPosition(ball, { x: totalWidth/2, y: totalHeight/2 });
  Matter.Body.setVelocity(ball, { x: 0, y: 0 });
  Object.keys(players).forEach(id => {
    const p = players[id];
    const spawnIn = Math.round(PITCH_WIDTH * 0.22);
    const sx = p.team === 'red' ? PITCH_OFFSET_X + spawnIn : PITCH_OFFSET_X + PITCH_WIDTH - spawnIn;
    Matter.Body.setPosition(p.body, { x: sx, y: totalHeight/2 });
    Matter.Body.setVelocity(p.body, { x: 0, y: 0 });
  });
  if (amIHost) {
    sendMessage({ type: 'score', score, celebration: false });
    notifyGoalUi({ celebration: false });
  }
}

export function pauseGame() { if (runner) Matter.Runner.stop(runner); }
export function resumeGame() { if (runner) Matter.Runner.run(runner, engine); }

export function stopGame() {
  if (renderFrameId != null) {
    cancelAnimationFrame(renderFrameId);
    renderFrameId = null;
  }
  if (keyHandlers) {
    window.removeEventListener('keydown', keyHandlers.onKeyDown);
    window.removeEventListener('keyup', keyHandlers.onKeyUp);
    keyHandlers = null;
  }
  if (runner) { Matter.Runner.stop(runner); runner = null; }
  if (render) { 
    Matter.Render.stop(render); 
    render = null;
  }
  if (engine) { Matter.Engine.clear(engine); engine = null; }
  players = {};
  keys = {};
  kickChargeMs = 0;
  localKickCharge01 = 0;
}

export function removePlayer(id) {
  if (players[id] && engine) { Matter.World.remove(engine.world, players[id].body); delete players[id]; }
}

export function handleRemoteInput(msg) {
  if (!engine) return;
  if (msg.type === 'pos' && players[msg.id]) {
    players[msg.id].targetPos = msg.pos;
    if (msg.boost !== undefined) players[msg.id].boost = msg.boost;
    Matter.Body.setVelocity(players[msg.id].body, msg.vel);
  } else if (msg.type === 'kick-visual') {
    if (players[msg.id]) {
      players[msg.id].body.render.fillStyle = '#fff';
      setTimeout(() => { if(players[msg.id]) players[msg.id].body.render.fillStyle = players[msg.id].body.render.originalColor; }, 100);
    }
  } else if (msg.type === 'ball-sync') {
    Matter.Body.setPosition(ball, msg.pos);
    Matter.Body.setVelocity(ball, msg.vel);
  } else if (msg.type === 'kick') {
    if (players[msg.id]) {
      players[msg.id].body.render.fillStyle = '#fff';
      setTimeout(() => { if(players[msg.id]) players[msg.id].body.render.fillStyle = players[msg.id].body.render.originalColor; }, 100);
      if (msg.kickerName) lastKickerName = msg.kickerName;
      if (amIHost && msg.dir && msg.force) {
        Matter.Body.setVelocity(ball, Matter.Vector.mult(msg.dir, msg.force));
      }
    }
  } else if (msg.type === 'score') {
    score = msg.score;
    isGoalHappening = msg.celebration;
    updateScoreboardUI(score);
  }
}

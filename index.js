const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const pool = require('./db');
const path = require('path');
const WebSocket = require('ws');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms)); 
require('dotenv').config();

// ✅ Environment Variables Validation
const requiredEnvVars = [
  'PORT', 'DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_DATABASE',
  'MQTT_HOST', 'MQTT_USERNAME', 'MQTT_PASSWORD'
];

const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingVars.length > 0) {
  console.error('❌ Missing required environment variables:', missingVars.join(', '));
  console.error('Please check your .env file');
  process.exit(1);
}

const mqtt = require('mqtt');  

// ✅ เชื่อมต่อกับ MQTT Server
const mqttClient = mqtt.connect(`mqtt://${process.env.MQTT_HOST}`, {
  username: process.env.MQTT_USERNAME,
  password: process.env.MQTT_PASSWORD
});




const app = express();

// ✅ Security headers
app.use((req, res, next) => {
  res.header('X-Content-Type-Options', 'nosniff');
  res.header('X-Frame-Options', 'DENY');
  res.header('X-XSS-Protection', '1; mode=block');
  res.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.use(cors());
app.use(express.json({ limit: '10mb' })); // ✅ Limit payload size
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ✅ Simple rate limiting (relaxed settings)
const requestCounts = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const MAX_REQUESTS = 300; // max requests per window (increased from 100)

app.use((req, res, next) => {
  const clientIP = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  
  if (!requestCounts.has(clientIP)) {
    requestCounts.set(clientIP, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
  } else {
    const clientData = requestCounts.get(clientIP);
    if (now > clientData.resetTime) {
      requestCounts.set(clientIP, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    } else {
      clientData.count++;
      if (clientData.count > MAX_REQUESTS) {
        return res.status(429).json({ error: 'ส่งคำขอมากเกินไป กรุณารอสักครู่' });
      }
    }
  }
  next();
});

// ✅ Serve frontend files
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ✅ Health Check API
app.get('/api/health', async (req, res) => {
  try {
    const dbCheck = await pool.query('SELECT 1');
    const mqttStatus = mqttClient.connected ? 'connected' : 'disconnected';
    
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      database: 'connected',
      mqtt: mqttStatus,
      websocket_clients: clients.size,
      uptime: process.uptime()
    });
  } catch (err) {
    console.error('❌ Health check failed:', err.message);
    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: err.message
    });
  }
});


// ✅ Logging Activity Function
async function logActivity({ userId, activity, action_type, category = null, station = null, floor = null, slot = null, veg_type = null, description = null }) {
  try {
    await pool.query(`
      INSERT INTO logs (user_id, activity, action_type, category, station, floor, slot, veg_type, description)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [userId, activity, action_type, category, station, floor, slot, veg_type, description]);

    console.log("📘 Log saved:", activity);
  } catch (err) {
    console.error("❌ Logging failed:", err.message);
  }
}

// ✅ LOGIN
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  
  // ✅ Input validation
  if (!username || !password) {
    return res.status(400).json({ error: 'กรุณากรอกชื่อผู้ใช้และรหัสผ่าน' });
  }
  
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'ข้อมูลไม่ถูกต้อง' });
  }
  console.log("\uD83D\uDD10 login request", username);

  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    const user = result.rows[0];

    if (!user) {
      return res.status(400).json({ error: 'ชื่อผู้ใช้ไม่ถูกต้อง' });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: 'รหัสผ่านไม่ถูกต้อง' });
    }

    console.log("✅ Login success for:", user.username);

 await logActivity({
  userId: user.id,
  activity: 'เข้าสู่ระบบ',
  action_type: 'login',
  category: 'เข้าสู่ระบบ',
  description: 'ผู้ใช้เข้าสู่ระบบ'  // ✅ สำคัญมาก
});



    res.json({
      id: user.id,
      username: user.username,
      role: user.role,
      created_at: user.created_at
    });
  } catch (err) {
    console.error('❌ Login Error:', err.message);
    res.status(500).send('Server error');
  }
});

// ✅✅✅ [แก้ไขใหม่ทั้งหมด] TRAY INBOUND API ⚙️
app.post('/api/tray/inbound', async (req, res) => {
  const { 
    username, station, floor, slot, veg_type, quantity, 
    batch_id, seeding_date, notes, tray_id: existing_tray_id 
  } = req.body;
  
  
  const created_at = new Date();

  try {
    // 1. ตรวจสอบผู้ใช้
    const userRes = await pool.query(`SELECT id FROM users WHERE username = $1`, [username]);
    const userId = userRes.rows[0]?.id;
    if (!userId) {
      return res.status(404).json({ error: 'ไม่พบผู้ใช้งานนี้' });
    }

    // 2. ตรวจสอบว่าช่องที่เลือก ว่าง จริงหรือไม่
    const slotCheckRes = await pool.query(
      `SELECT status FROM tray_inventory WHERE floor = $1 AND slot = $2`,
      [floor, slot]
    );

    if (slotCheckRes.rows.length > 0) {
      const trayInSlot = slotCheckRes.rows[0];
      if (trayInSlot.status === 'on_shelf' || trayInSlot.status === 'IN_STORAGE') {
        return res.status(409).json({ error: `ช่อง ${slot} บนชั้น ${floor} มีถาดวางอยู่แล้ว` });
      }
    }
    
    // 3. สร้าง Tray ID
    const isReturning = !!existing_tray_id;
    // ✅ [แก้ไข] เรียกใช้ฟังก์ชันสร้าง ID แบบใหม่เมื่อไม่ใช่การส่งถาดกลับ
    const tray_id = isReturning ? existing_tray_id : await generateNextTrayId();
    
    // 4. บันทึก Log กิจกรรม
    const description = isReturning 
        ? `ส่งถาด ${veg_type} (ID: ${tray_id}) กลับเข้าคลังที่ชั้น ${floor}/${slot}`
        : `วางถาดใหม่ ${veg_type} (ID: ${tray_id}) ที่ชั้น ${floor}/${slot}`;
    
    await logActivity({ 
        userId, activity: description, action_type: 'tray_inbound', category: 'วางถาด',
        station, floor, slot, veg_type, description: notes || description 
    });
    
    // 5. บันทึกประวัติการกระทำ
    await pool.query(
      `INSERT INTO tray_history (tray_id, action_type, floor, slot, veg_type, username, station_id, created_at)
       VALUES ($1, 'inbound', $2, $3, $4, $5, $6, $7)`,
      [tray_id, floor, slot, veg_type, username, station, created_at]
    );

    // 6. สร้าง Task ใหม่ใน Task Monitor พร้อมข้อมูลทั้งหมด
    // ✅ [แก้ไข] เพิ่มคอลัมน์สำหรับข้อมูลถาดทั้งหมด เพื่อความสมบูรณ์ของข้อมูล
    await pool.query(
      `INSERT INTO task_monitor (
          tray_id, action_type, floor, slot, station_id, status, username, created_at,
          veg_type, plant_quantity, batch_id, seeding_date, notes
       )
       VALUES ($1, 'inbound', $2, $3, $4, 'pending', $5, $6, $7, $8, $9, $10, $11)`,
       [
           tray_id, floor, slot, station, username, created_at,
           veg_type, quantity, batch_id, seeding_date, notes
       ]
    );

    // 7. Trigger Flow การทำงานของ Automation (เหมือนเดิม)
    const stationId = parseInt(station);
    const state = stationStates[stationId];
    if (state.flowState === 'idle') {
      state.targetFloor = parseInt(floor);
      state.targetSlot = parseInt(slot);
      state.taskType = 'inbound';
      state.trayId = tray_id;
      state.isReturning = isReturning;
      
      // ส่งข้อมูลถาดทั้งหมดเข้า State Machine
      state.vegType = veg_type;
      state.username = username;
      state.plantQuantity = quantity;
      state.batchId = batch_id;
      state.seedingDate = seeding_date;
      state.notes = notes;
 state.stationId = stationId;
      state.flowState = 'inbound_start_lift_tray';
      console.log(`[Trigger] 🚀 เริ่ม flow INBOUND (${isReturning ? 'ส่งกลับ' : 'สร้างใหม่'}) → ชั้น ${floor}, ช่อง ${slot}`);
      handleFlow(stationId);
      return res.json({ message: "รับคำสั่งเรียบร้อย เริ่มดำเนินการ" });
    } else {
      return res.status(409).json({ error: `ระบบกำลังทำงานอื่นอยู่ (${state.flowState})` });
    }
  } catch (err) {
    console.error('❌ Inbound Tray Error:', err.message);
    return res.status(500).send('Server error');
  }
});
app.post('/api/tray/outbound', async (req, res) => {
  const { username, station, floor, slot, reason, destination } = req.body;
  const created_at = new Date();

  try {
    const userRes = await pool.query(`SELECT id FROM users WHERE username = $1`, [username]);
    const userId = userRes.rows[0]?.id;
    if (!userId) return res.status(404).json({ error: 'ไม่พบผู้ใช้งานนี้' });
    
    // 1. ดึงข้อมูลทั้งหมดของถาดจาก inventory
    const trayInfoRes = await pool.query('SELECT * FROM tray_inventory WHERE floor = $1 AND slot = $2', [floor, slot]);
    if (trayInfoRes.rows.length === 0) {
      return res.status(404).json({ error: 'ไม่พบถาดในตำแหน่งที่ระบุ' });
    }
    const trayData = trayInfoRes.rows[0];

    // 2. บันทึก Log ให้ครบถ้วน
    const description = `นำถาด ${trayData.veg_type} (ID: ${trayData.tray_id}) ออกจากชั้น ${floor}/${slot} (เหตุผล: ${reason})`;
    await logActivity({
        userId, activity: description, action_type: 'tray_outbound', category: 'นำถาดออก',
        station, floor, slot, veg_type: trayData.veg_type,
        description: `เหตุผล: ${reason}, ปลายทาง: ${destination || '-'}`
    });

    // 3. บันทึกลง tray_history
    await pool.query(
      `INSERT INTO tray_history (tray_id, action_type, floor, slot, veg_type, username, station_id, created_at)
       VALUES ($1, 'outbound', $2, $3, $4, $5, $6, $7)`,
      [trayData.tray_id, floor, slot, trayData.veg_type, username, station, created_at]
    );
    
    // 4. สร้าง Task ใหม่พร้อม "คัดลอกข้อมูลถาดทั้งหมด" และ "เพิ่ม reason"
    await pool.query(
      `INSERT INTO task_monitor (
          tray_id, action_type, floor, slot, station_id, status, username, created_at,
          veg_type, plant_quantity, batch_id, seeding_date, notes, reason
       )
       VALUES ($1, 'outbound', $2, $3, $4, 'pending', $5, $6, $7, $8, $9, $10, $11, $12)`,
       [
           trayData.tray_id, floor, slot, station, username, created_at,
           trayData.veg_type, trayData.plant_quantity, trayData.batch_id, trayData.seeding_date, trayData.notes,
           reason // ส่งค่า reason ที่รับมาจาก req.body เข้าไป
       ]
    );
    
    // 5. Trigger Flow (เหมือนเดิม)
    const stationId = parseInt(station);
    const state = stationStates[stationId];
    if (state.flowState === 'idle') {
      state.targetFloor = parseInt(floor);
      state.targetSlot = parseInt(slot);
      state.taskType = 'outbound';
      state.trayId = trayData.tray_id;
      state.flowState = 'start';
       state.stationId = stationId;
      handleFlow(stationId);
      res.json({ message: "รับคำสั่งนำถาดออกเรียบร้อย" });
    } else {
      res.status(409).json({ error: `ระบบกำลังทำงานอื่นอยู่` });
    }
  } catch (err) {
    console.error('❌ Outbound Tray Error:', err.message);
    res.status(500).send('Server error');
  }
});


app.post('/api/workstation/complete', async (req, res) => {
    const { tray_id, station_id } = req.body;
    try {
        // 1. อัปเดต task เดิมให้เป็น success (เหมือน dispose)
        await pool.query(
            `UPDATE task_monitor SET status = 'success', completed_at = NOW() WHERE station_id = $1 AND status = 'at_workstation'`,
            [station_id]
        );

        // 2. รีเซ็ต Flow State กลับเป็น idle (เหมือน dispose)
        if (stationStates[station_id]) {
            stationStates[station_id].flowState = 'idle';
        }

        console.log(`✅ [Workstation] Completed task for tray ${tray_id} without deleting from inventory.`);
        res.json({ message: 'เคลียร์งานที่ Workstation สำเร็จ' });
    } catch (err) {
        console.error('❌ Complete Workstation Task Error:', err.message);
        res.status(500).json({ error: 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์' });
    }
});

// ✅✅✅ [เพิ่มใหม่] ฟังก์ชันสำหรับสร้าง TRAY ID แบบเรียงลำดับ (T-001, T-002, ...) ⚙️
async function generateNextTrayId() {
  try {
    // 1. ค้นหาเลข ID สูงสุดจากตาราง tray_inventory
    const result = await pool.query(`
      SELECT MAX(CAST(SUBSTRING(tray_id FROM 'T-([0-9]+)') AS INTEGER)) as max_id
      FROM tray_inventory
      WHERE tray_id ~ '^T-[0-9]+$'
    `);

    // 2. ถ้ายังไม่มีถาดในระบบ (หรือไม่มี ID รูปแบบนี้) ให้เริ่มที่ 1, ถ้ามีแล้วให้เอาเลขสูงสุดมาบวก 1
    const nextIdNumber = (result.rows[0]?.max_id || 0) + 1;

    // 3. นำตัวเลขมาจัดรูปแบบให้มี 0 นำหน้าเสมอ (เช่น 1 -> "001", 12 -> "012")
    const formattedId = `T-${String(nextIdNumber).padStart(3, '0')}`;
    
    console.log(`✅ Generated New Tray ID: ${formattedId}`);
    return formattedId;

  } catch (err) {
    console.error("❌ เกิดข้อผิดพลาดในการสร้าง Tray ID:", err);
    // กรณีฉุกเฉิน ให้กลับไปใช้ ID แบบเดิมเพื่อไม่ให้ระบบล่ม
    return `T-ERR-${Date.now().toString(36).toUpperCase()}`;
  }
}
app.post('/api/lift/move', async (req, res) => {
  const { userId, fromFloor, toFloor, station } = req.body;
  const description = `สั่งลิฟต์จากชั้น ${fromFloor} ไป ${toFloor}`;

 const topic = `automation/station${station}/lift/command`;  // ✅ ให้ตรงกับ ESP32
  const payload = JSON.stringify({
    action: "moveTo",
    floor: toFloor
  });

  try {
    mqttClient.publish(topic, payload);  // ✅ ส่งคำสั่ง MQTT
    console.log("📤 MQTT >>", topic, payload);

    await logActivity({
      userId,
      activity: description,
      action_type: 'lift',
      category: 'ลิฟต์',
      station,
      floor: toFloor
    });

    res.json({ message: "ลิฟต์กำลังเคลื่อนที่" });
  } catch (err) {
    console.error('❌ Lift Error:', err.message);
    res.status(500).send('Server error');
  }
});

app.post('/api/lift/jog', (req, res) => {
  const { userId, station, action } = req.body;
  const topic = `automation/station${station}/lift/command`;
  const payload = JSON.stringify({ action }); // "jogUp" หรือ "jogDown"

  try {
    mqttClient.publish(topic, payload);
    console.log("📤 MQTT Jog >>", topic, payload);

    logActivity({
      userId,
      activity: `สั่ง Jog ${action}`,
      action_type: 'lift',
      category: 'ลิฟต์',
      station
    });

    res.json({ message: `Jog ${action} sent` });
  } catch (err) {
    console.error("❌ Jog Error:", err.message);
    res.status(500).send("Server error");
  }
});
app.post('/api/lift/stop', (req, res) => {
  const { userId, station } = req.body;
  const topic = `automation/station${station}/lift/command`;
  const payload = JSON.stringify({ action: "stop" });

  try {
    mqttClient.publish(topic, payload);
    console.log("📤 MQTT STOP >>", topic);

    logActivity({
      userId,
      activity: `สั่ง STOP ลิฟต์`,
      action_type: 'lift',
      category: 'ลิฟต์',
      station
    });

    res.json({ message: "STOP command sent" });
  } catch (err) {
    console.error("❌ Stop Error:", err.message);
    res.status(500).send("Server error");
  }
});
app.post('/api/lift/emergency', (req, res) => {
  const { userId, station } = req.body;
  const topic = `automation/station${station}/lift/command`;
  const payload = JSON.stringify({ action: "emergency" });

  try {
    mqttClient.publish(topic, payload);
    console.log("📤 MQTT EMERGENCY >>", topic);

    logActivity({
      userId,
      activity: `ส่ง Emergency ไปยังลิฟต์`,
      action_type: 'lift',
      category: 'ลิฟต์',
      station
    });

    res.json({ message: "EMERGENCY sent" });
  } catch (err) {
    console.error("❌ Emergency Error:", err.message);
    res.status(500).send("Server error");
  }
});
// ✅ REST API ดึงสถานะลิฟต์แบบครบ พร้อม recovery
app.get('/api/lift/status', async (req, res) => {
  const station = parseInt(req.query.station) || 1;

  try {
    const result = await pool.query(
      `SELECT floor, moving, emergency, recovery,
              position_step AS step,
              "from" AS from,
              "to" AS to
       FROM lift_status
       WHERE station = $1
       LIMIT 1`,
      [station]
    );

    if (result.rows.length === 0) {
      return res.json({
        floor: 1,
        moving: false,
        emergency: false,
        recovery: false,
        step: 0,
        from: 1,
        to: 1
      });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error("❌ Lift Status Error:", err.message);
    res.status(500).send("Server error");
  }
});






// ✅ AGV
app.post('/api/agv/move', async (req, res) => {
  const { userId, from, to } = req.body;
  const description = `สั่ง AGV วิ่งจาก ${from} ไป ${to}`;

  try {
   await logActivity({
  userId,
  activity: description,
  action_type: 'agv',  // ✅ ต้องเพิ่ม
  category: 'AGV',
  station: to
});


    res.json({ message: "AGV กำลังวิ่ง" });
  } catch (err) {
    console.error('❌ AGV Error:', err.message);
    res.status(500).send('Server error');
  }
});

// ✅ GET LOGS
app.get('/api/logs', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT logs.*, users.username 
      FROM logs 
      LEFT JOIN users ON logs.user_id = users.id 
      ORDER BY logs.timestamp DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error("❌ Fetch logs error:", err.message);
    res.status(500).json({ error: "ไม่สามารถดึงข้อมูล logs ได้" });
  }
});

// ✅ START SERVER with WebSocket
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server is running at http://0.0.0.0:${PORT}`);
  
  // ✅ Initialize cameras on server start
  initializeCameras();
});

// ✅ WebSocket Server for real-time updates
const wss = new WebSocket.Server({ server });
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log('🔗 New WebSocket client connected. Total clients:', clients.size);
  
  // ✅ Heartbeat to detect dead connections
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });
  
  ws.on('close', () => {
    clients.delete(ws);
    console.log('❌ WebSocket client disconnected. Total clients:', clients.size);
  });
  
  ws.on('error', (error) => {
    console.error('❌ WebSocket error:', error);
    clients.delete(ws);
  });
});

// ✅ Cleanup dead connections every 30 seconds
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      clients.delete(ws);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// ✅ Graceful shutdown
const activeTimers = [heartbeatInterval];

// ✅ เรียกใช้ scheduler และเพิ่ม timer ใน activeTimers
function initializeScheduler() {
  const schedulerInterval = setInterval(async () => {
    try {
      for (let floor = 1; floor <= 5; floor++) {
        // Scheduler logic here
      }
    } catch (err) {
      console.error('❌ Scheduler Error:', err.message);
    }
  }, 60000); // ทุก 1 นาที
  
  activeTimers.push(schedulerInterval);
  return schedulerInterval;
}

process.on('SIGTERM', () => {
  console.log('🔄 SIGTERM received, shutting down gracefully...');
  gracefulShutdown();
});

process.on('SIGINT', () => {
  console.log('🔄 SIGINT received, shutting down gracefully...');
  gracefulShutdown();
});

function gracefulShutdown() {
  // Clear all timers
  activeTimers.forEach(timer => clearInterval(timer));
  
  // Clear sensor debounce timers
  Object.values(stationStates).forEach(state => {
    if (state.sensorDebounceTimer) {
      clearTimeout(state.sensorDebounceTimer);
    }
  });
  
  // Close WebSocket connections
  wss.clients.forEach(ws => ws.close());
  
  // Close MQTT connection
  if (mqttClient) {
    mqttClient.end();
  }
  
  // Close HTTP server
  server.close(() => {
    console.log('✅ HTTP server closed.');
    process.exit(0);
  });
}

// ✅ Broadcast function to send data to all connected clients
function broadcastToClients(type, data) {
  const message = JSON.stringify({ type, data });
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// ✅ POST /api/log - สำหรับให้ฝั่งหน้าเว็บส่ง Log ได้ตรง
// ✅ POST /api/log - สำหรับให้ frontend ส่ง log มา
app.post('/api/log', async (req, res) => {
  const {
    username,
    activity,
    action_type,
    category,
    station,
    floor,
    slot,
    veg_type,
    description
  } = req.body;

  console.log("📥 Logging from Frontend:", req.body);

  if (!username || !activity || !category || !action_type) {
    return res.status(400).json({ error: 'ข้อมูลไม่ครบ' });
  }

  try {
    // ✅ หาผู้ใช้
    const userResult = await pool.query(
      "SELECT id FROM users WHERE username = $1",
      [username]
    );
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: "ไม่พบผู้ใช้นี้" });
    }

    const userId = userResult.rows[0].id;

    // ✅ ป้องกัน "" ส่งเข้าฐานข้อมูล (จะ error)
    const parsedStation = station === "" ? null : station;
    const parsedFloor = floor === "" ? null : parseInt(floor);
    const parsedSlot = slot === "" ? null : parseInt(slot);
    const parsedVegType = veg_type === "" ? null : veg_type;

    // ✅ ถ้าไม่ได้ส่ง description มาเลย ใช้ activity แทน
    const parsedDescription = (!description || description === "") ? activity : description;

    // ✅ insert
    await pool.query(
      `INSERT INTO logs (user_id, activity, action_type, category, station, floor, slot, veg_type, description)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [userId, activity, action_type, category, parsedStation, parsedFloor, parsedSlot, parsedVegType, parsedDescription]
    );

    res.json({ message: "Log saved" });
  } catch (err) {
    console.error("❌ POST /api/log error:", err.message);
    res.status(500).json({ error: "ไม่สามารถบันทึก log ได้" });
  }
});

app.get('/api/tray-inventory', async (req, res) => {
  const stationId = req.query.station || '1'; 
  try {
    const result = await pool.query(
      'SELECT * FROM tray_inventory WHERE station_id = $1 ORDER BY floor, slot', 
      [stationId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(`Error fetching tray inventory for station ${stationId}:`, err.message); // เพิ่ม Log
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tray-inventory', async (req, res) => {
  const { tray_id, veg_type, floor, slot, username } = req.body; // ✅ เพิ่ม username
  try {
    await pool.query(`
      INSERT INTO tray_inventory (tray_id, veg_type, floor, slot, username)
      VALUES ($1, $2, $3, $4, $5)
    `, [tray_id, veg_type, floor, slot, username]); // ✅ เพิ่ม username เป็น $5
    res.status(201).json({ message: 'Tray placed successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


app.delete('/api/tray-inventory/:tray_id', async (req, res) => {
  const tray_id = req.params.tray_id;
  try {
    await pool.query(`DELETE FROM tray_inventory WHERE tray_id = $1`, [tray_id]);
    res.json({ message: 'Tray removed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function loadTrayInventory() {
  try {
    const res = await fetch('/api/tray-inventory');
    const data = await res.json();
    
    trayInventory = {}; // ต้องมี
    data.forEach(tray => {
      const key = `${tray.floor}-${tray.slot}`;  // ต้องตรงกับคลิก
      trayInventory[key] = tray;
    });

    renderTrayGrid(); // อย่าลืมเรียกฟังก์ชันนี้เพื่อแสดงผล
  } catch (err) {
    console.error("โหลด tray inventory ล้มเหลว", err);
  }
}


// ในไฟล์ index.js

// ✅ [เพิ่มใหม่] API สำหรับแก้ไขข้อมูลถาด
app.put('/api/tray-inventory/:tray_id', async (req, res) => {
  const { tray_id } = req.params;
  // รับข้อมูลที่อาจมีการแก้ไข
  const { veg_type, plant_quantity, batch_id, seeding_date, notes } = req.body;

  try {
    const result = await pool.query(
      `UPDATE tray_inventory 
       SET 
         veg_type = $1, 
         plant_quantity = $2, 
         batch_id = $3, 
         seeding_date = $4, 
         notes = $5
       WHERE tray_id = $6
       RETURNING *`,
      [veg_type, plant_quantity, batch_id, seeding_date, notes, tray_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'ไม่พบถาดนี้' });
    }

    res.json({ message: 'อัปเดตข้อมูลถาดสำเร็จ', tray: result.rows[0] });
  } catch (err) {
    console.error('❌ Update Tray Error:', err.message);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์' });
  }
});







app.get('/api/stats/summary', async (req, res) => {
  try {
    const station = parseInt(req.query.station);
    if (!station) return res.status(400).json({ error: "Missing station ID" });

    const inboundRes = await pool.query(`
      SELECT COUNT(*) FROM tray_history
      WHERE action_type = 'inbound' AND station_id = $1
    `, [station]);

    const outboundRes = await pool.query(`
      SELECT COUNT(*) FROM tray_history
      WHERE action_type = 'outbound' AND station_id = $1
    `, [station]);

    res.json({
      inbound: parseInt(inboundRes.rows[0].count),
      outbound: parseInt(outboundRes.rows[0].count)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ Overview API สำหรับหน้า overview
app.get('/api/overview', async (req, res) => {
  try {
    const station = parseInt(req.query.station) || 1;
    
    // รวมข้อมูลทั้งหมดที่ overview ต้องการ
    const [summaryRes, weeklyRes] = await Promise.all([
      pool.query(`
        SELECT COUNT(*) as total,
          COUNT(CASE WHEN action_type = 'inbound' THEN 1 END) as inbound,
          COUNT(CASE WHEN action_type = 'outbound' THEN 1 END) as outbound
        FROM tray_history WHERE station_id = $1
      `, [station]),
      
      pool.query(`
        SELECT DATE(created_at) as date,
          COUNT(CASE WHEN action_type = 'inbound' THEN 1 END) as inbound,
          COUNT(CASE WHEN action_type = 'outbound' THEN 1 END) as outbound
        FROM tray_history 
        WHERE station_id = $1 AND created_at >= NOW() - INTERVAL '7 days'
        GROUP BY DATE(created_at)
        ORDER BY date DESC
      `, [station])
    ]);

    const summary = summaryRes.rows[0];
    res.json({
      summary: {
        total: parseInt(summary.total),
        inbound: parseInt(summary.inbound),
        outbound: parseInt(summary.outbound)
      },
      weekly: weeklyRes.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ Summary Cards API
app.get('/api/overview/summary-cards', async (req, res) => {
  try {
    const station = parseInt(req.query.station) || 1;
    
    const result = await pool.query(`
      SELECT 
        COUNT(*) as total_trays,
        COUNT(CASE WHEN action_type = 'inbound' THEN 1 END) as inbound_today,
        COUNT(CASE WHEN action_type = 'outbound' THEN 1 END) as outbound_today,
        COUNT(DISTINCT CASE WHEN created_at >= CURRENT_DATE THEN tray_id END) as active_trays
      FROM tray_history 
      WHERE station_id = $1 AND created_at >= CURRENT_DATE
    `, [station]);

    const stats = result.rows[0];
    res.json({
      total_trays: parseInt(stats.total_trays),
      inbound_today: parseInt(stats.inbound_today),
      outbound_today: parseInt(stats.outbound_today),
      active_trays: parseInt(stats.active_trays)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


app.get('/api/stats/weekly', async (req, res) => {
  try {
    const station = parseInt(req.query.station);
    if (!station) return res.status(400).json({ error: "Missing station ID" });

    const result = await pool.query(`
      SELECT 
        TO_CHAR(created_at::date, 'DD/MM') AS date,
        SUM(CASE WHEN action_type = 'inbound' THEN 1 ELSE 0 END) AS inbound,
        SUM(CASE WHEN action_type = 'outbound' THEN 1 ELSE 0 END) AS outbound
      FROM tray_history
      WHERE created_at >= NOW() - INTERVAL '7 days'
        AND station_id = $1
      GROUP BY date
      ORDER BY MIN(created_at)
    `, [station]);

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ API สำหรับดึงข้อมูลตามชั่วโมง (24 ชั่วโมงย้อนหลัง)
app.get('/api/stats/hourly', async (req, res) => {
  try {
    const station = parseInt(req.query.station);
    if (!station) return res.status(400).json({ error: "Missing station ID" });

    const hourlyData = await pool.query(`
      SELECT 
        EXTRACT(HOUR FROM created_at) as hour,
        COUNT(CASE WHEN action_type = 'inbound' THEN 1 END) as inbound,
        COUNT(CASE WHEN action_type = 'outbound' THEN 1 END) as outbound
      FROM tray_history 
      WHERE station_id = $1 
        AND created_at >= NOW() - INTERVAL '24 hours'
      GROUP BY EXTRACT(HOUR FROM created_at)
      ORDER BY hour
    `, [station]);

    // สร้างข้อมูล 24 ชั่วโมง (เติม 0 สำหรับชั่วโมงที่ไม่มีข้อมูล)
    const hours = Array.from({length: 24}, (_, i) => i);
    const result = hours.map(hour => {
      const found = hourlyData.rows.find(row => parseInt(row.hour) === hour);
      return {
        hour: hour,
        inbound: found ? parseInt(found.inbound) : 0,
        outbound: found ? parseInt(found.outbound) : 0
      };
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ [เพิ่มใหม่] API สำหรับดึงข้อมูลกราฟย้อนหลัง 30 วัน
app.get('/api/stats/monthly', async (req, res) => {
  try {
    const station = parseInt(req.query.station);
    if (!station) return res.status(400).json({ error: "Missing station ID" });

    const result = await pool.query(`
      SELECT 
        TO_CHAR(created_at::date, 'DD/MM') AS date,
        SUM(CASE WHEN action_type = 'inbound' THEN 1 ELSE 0 END) AS inbound,
        SUM(CASE WHEN action_type = 'outbound' THEN 1 ELSE 0 END) AS outbound
      FROM tray_history
      WHERE created_at >= NOW() - INTERVAL '30 days' -- ✨ จุดสำคัญ: เปลี่ยนจาก 7 เป็น 30 days
        AND station_id = $1
      GROUP BY date
      ORDER BY MIN(created_at)
    `, [station]);

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stats/hourly', async (req, res) => {
  try {
    const station = parseInt(req.query.station);
    if (!station) return res.status(400).json({ error: "Missing station ID" });

    const result = await pool.query(`
      SELECT 
        EXTRACT(HOUR FROM created_at) AS hour,
        SUM(CASE WHEN action_type = 'inbound' THEN 1 ELSE 0 END) AS inbound,
        SUM(CASE WHEN action_type = 'outbound' THEN 1 ELSE 0 END) AS outbound
      FROM tray_history
      WHERE created_at::date = CURRENT_DATE
        AND station_id = $1
      GROUP BY hour
      ORDER BY hour
    `, [station]);

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ สร้างตารางสำหรับระบบแผนการปลูกและใบงาน
const initializeTables = async () => {
  try {
    // ✅ ตาราง planting_plans - เก็บข้อมูลแผนการปลูกจากภายนอก
    await pool.query(`
      CREATE TABLE IF NOT EXISTS planting_plans (
        id SERIAL PRIMARY KEY,
        external_plan_id VARCHAR(50),
        vegetable_name VARCHAR(100) NOT NULL,
        level INTEGER NOT NULL,
        planting_date DATE NOT NULL,
        harvest_date DATE NOT NULL,
        plant_count INTEGER NOT NULL,
        variety VARCHAR(100),
        batch_number VARCHAR(50),
        source_system VARCHAR(100),
        received_at TIMESTAMP DEFAULT NOW(),
        status VARCHAR(20) DEFAULT 'received',
        notes TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // ✅ ตาราง work_orders - ใบงานที่สร้างจากแผนการปลูก
    await pool.query(`
      CREATE TABLE IF NOT EXISTS work_orders (
        id SERIAL PRIMARY KEY,
        planting_plan_id INTEGER REFERENCES planting_plans(id),
        work_order_number VARCHAR(50) UNIQUE,
        task_type VARCHAR(50) NOT NULL,
        vegetable_name VARCHAR(100) NOT NULL,
        level INTEGER NOT NULL,
        target_date DATE NOT NULL,
        plant_count INTEGER NOT NULL,
        assigned_to VARCHAR(100),
        priority VARCHAR(20) DEFAULT 'normal',
        status VARCHAR(20) DEFAULT 'pending',
        progress INTEGER DEFAULT 0,
        actual_count INTEGER,
        completed_at TIMESTAMP,
        notes TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // ✅ ตาราง work_order_tasks - รายละเอียดงานย่อย
    await pool.query(`
      CREATE TABLE IF NOT EXISTS work_order_tasks (
        id SERIAL PRIMARY KEY,
        work_order_id INTEGER REFERENCES work_orders(id),
        task_name VARCHAR(100) NOT NULL,
        description TEXT,
        sequence_order INTEGER,
        estimated_duration INTEGER,
        actual_duration INTEGER,
        status VARCHAR(20) DEFAULT 'pending',
        assigned_to VARCHAR(100),
        completed_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    console.log('✅ Database tables initialized successfully');
  } catch (err) {
    console.error('❌ Error initializing tables:', err.message);
  }
};

// เรียกใช้ฟังก์ชันสร้างตาราง
initializeTables();

// ✅ API endpoint สำหรับรับข้อมูลแผนการปลูกจากภายนอก
app.post('/api/planting-plan', async (req, res) => {
  try {
    const { vegetable_name, level, planting_date, harvest_date, plant_count, variety, batch_number, source_system, external_plan_id } = req.body;
    
    // ✅ Validate ข้อมูลที่จำเป็น
    if (!vegetable_name || !level || !planting_date || !harvest_date || !plant_count) {
      return res.status(400).json({ 
        error: 'Missing required fields: vegetable_name, level, planting_date, harvest_date, plant_count' 
      });
    }

    // ✅ บันทึกข้อมูลแผนการปลูก
    const planResult = await pool.query(`
      INSERT INTO planting_plans (
        external_plan_id, vegetable_name, level, planting_date, harvest_date, 
        plant_count, variety, batch_number, source_system, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'received')
      RETURNING *
    `, [external_plan_id, vegetable_name, level, planting_date, harvest_date, plant_count, variety, batch_number, source_system]);

    const plan = planResult.rows[0];

    // ✅ สร้างใบงานอัตโนมัติ
    const workOrderNumber = `WO-${Date.now()}-${plan.id}`;
    
    // สร้างใบงานปลูก
    const plantingOrder = await pool.query(`
      INSERT INTO work_orders (
        planting_plan_id, work_order_number, task_type, vegetable_name, 
        level, target_date, plant_count, priority, status
      ) VALUES ($1, $2, 'planting', $3, $4, $5, $6, 'high', 'pending')
      RETURNING *
    `, [plan.id, `${workOrderNumber}-PLANT`, vegetable_name, level, planting_date, plant_count]);

    // สร้างใบงานเก็บเกี่ยว
    const harvestOrder = await pool.query(`
      INSERT INTO work_orders (
        planting_plan_id, work_order_number, task_type, vegetable_name, 
        level, target_date, plant_count, priority, status
      ) VALUES ($1, $2, 'harvest', $3, $4, $5, $6, 'normal', 'pending')
      RETURNING *
    `, [plan.id, `${workOrderNumber}-HARVEST`, vegetable_name, level, harvest_date, plant_count]);

    console.log(`✅ Created planting plan and work orders for ${vegetable_name} on level ${level}`);
    
    res.json({
      success: true,
      message: 'Planting plan received and work orders created',
      planting_plan: plan,
      work_orders: [plantingOrder.rows[0], harvestOrder.rows[0]]
    });

  } catch (err) {
    console.error('❌ Error processing planting plan:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ✅ API endpoint สำหรับดึงรายการแผนการปลูก
app.get('/api/planting-plans', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM planting_plans 
      ORDER BY created_at DESC
    `);
    
    res.json({
      success: true,
      planting_plans: result.rows
    });
  } catch (err) {
    console.error('❌ Error fetching planting plans:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ✅ API endpoint สำหรับดึงรายการใบงาน
app.get('/api/work-orders', async (req, res) => {
  try {
    const { status, task_type } = req.query;
    let query = `
      SELECT wo.*, pp.variety, pp.batch_number 
      FROM work_orders wo
      LEFT JOIN planting_plans pp ON wo.planting_plan_id = pp.id
      WHERE 1=1
    `;
    const params = [];
    
    if (status) {
      params.push(status);
      query += ` AND wo.status = $${params.length}`;
    }
    
    if (task_type) {
      params.push(task_type);
      query += ` AND wo.task_type = $${params.length}`;
    }
    
    query += ` ORDER BY wo.created_at DESC`;
    
    const result = await pool.query(query, params);
    
    res.json({
      success: true,
      work_orders: result.rows
    });
  } catch (err) {
    console.error('❌ Error fetching work orders:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ✅ API endpoint สำหรับอัพเดทสถานะใบงาน
app.put('/api/work-orders/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, progress, actual_count, assigned_to, notes } = req.body;
    
    if (!['pending', 'in_progress', 'completed', 'cancelled'].includes(status)) {
      return res.status(400).json({ 
        error: 'Invalid status. Must be: pending, in_progress, completed, cancelled' 
      });
    }

    const updateFields = ['status = $2', 'updated_at = NOW()'];
    const params = [id, status];
    let paramIndex = 2;

    if (progress !== undefined) {
      updateFields.push(`progress = $${++paramIndex}`);
      params.push(progress);
    }

    if (actual_count !== undefined) {
      updateFields.push(`actual_count = $${++paramIndex}`);
      params.push(actual_count);
    }

    if (assigned_to) {
      updateFields.push(`assigned_to = $${++paramIndex}`);
      params.push(assigned_to);
    }

    if (notes) {
      updateFields.push(`notes = $${++paramIndex}`);
      params.push(notes);
    }

    if (status === 'completed') {
      updateFields.push('completed_at = NOW()');
    }

    const result = await pool.query(`
      UPDATE work_orders 
      SET ${updateFields.join(', ')}
      WHERE id = $1 
      RETURNING *
    `, params);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Work order not found' });
    }

    res.json({
      success: true,
      message: 'Work order updated successfully',
      work_order: result.rows[0]
    });
  } catch (err) {
    console.error('❌ Error updating work order:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const stationStates = {
  1: {
    flowState: 'idle',
    latestLiftStatus: {},
    latestAgvStatus: {},
    latestAgvSensorStatus: {},
    trayActionDone: false,
    targetFloor: null,
    targetSlot: null,
    taskType: null, // 'inbound' หรือ 'outbound'
    sensorDebounceTimer: null // สำหรับ debounce sensor updates
  }
};

// =================================================================
// 🔵 MQTT Client Setup
// =================================================================
// MQTT Connect Event
mqttClient.on('connect', () => {
  console.log("✅ MQTT Connected (Backend)");

  // ✅ Subscribe Topic ของ Lift, AGV, และ Tray
  mqttClient.subscribe("automation/station1/lift/status");
  mqttClient.subscribe('automation/station1/agv/status');
  mqttClient.subscribe("automation/station1/lift/tray_action_done");
  mqttClient.subscribe("automation/station1/agv/sensors");
});

// MQTT Message Handler (รวม Logic ของ Lift, AGV, และ Tray)
mqttClient.on('message', async (topic, message) => {
  const msg = message.toString();
  const stationId = 1; // รองรับสถานีเดียว (station 1) ในระบบปัจจุบัน
  const state = stationStates[stationId];
  if (!state) return; // ป้องกันข้อผิดพลาดหากไม่มี state

// ✅ [เพิ่มใหม่] Logic สำหรับรับข้อมูลเซ็นเซอร์ AGV พร้อม Debounce
  if (topic === 'automation/station1/agv/sensors') {
    try {
      const payload = JSON.parse(msg);
      
      // ✅ เช็คว่าข้อมูลเปลี่ยนแปลงหรือไม่ก่อนส่ง
      const currentSensorData = JSON.stringify(payload);
      const previousSensorData = JSON.stringify(state.latestAgvSensorStatus || {});
      
      if (currentSensorData !== previousSensorData) {
        // Clear existing debounce timer
        if (state.sensorDebounceTimer) {
          clearTimeout(state.sensorDebounceTimer);
        }
        
        // Set debounce timer (300ms)
        state.sensorDebounceTimer = setTimeout(() => {
          // เก็บสถานะล่าสุดไว้ใน state object
          state.latestAgvSensorStatus = payload;
          
          // ✅ ส่งข้อมูล sensor เฉพาะตอนที่เปลี่ยนแปลงผ่าน WebSocket
          broadcastToClients('sensor_update', payload);
          console.log('📡 Sensor data changed (debounced), broadcasted to', clients.size, 'clients');
          
          // Clear timer reference
          state.sensorDebounceTimer = null;
        }, 300); // 300ms debounce delay
      }
    } catch (err) {
      console.error('❌ Failed to parse AGV sensor MQTT payload:', err.message);
    }
  }
  // 🔽 Logic สำหรับ Lift Status
  if (topic === "automation/station1/lift/status") {
    try {
      const payload = JSON.parse(msg);
      const floor = parseInt(payload.floor) || 1;
      const moving = !!payload.moving;
      const emergency = !!payload.emergency;
      const recovery = !!payload.recovery;
      const step = parseInt(payload.step) || 0;

      state.latestLiftStatus = payload;

      await pool.query(`
        INSERT INTO lift_status (station, floor, moving, emergency, recovery, step, updated_at)
        VALUES (1, $1, $2, $3, $4, $5, NOW())
        ON CONFLICT (station) DO UPDATE
        SET floor = EXCLUDED.floor,
            moving = EXCLUDED.moving,
            emergency = EXCLUDED.emergency,
            recovery = EXCLUDED.recovery,
            step = EXCLUDED.step,
            updated_at = EXCLUDED.updated_at
      `, [floor, moving, emergency, recovery, step]);

      console.log("✅ [DB] Updated lift_status → Floor:", floor, "| Step:", step, "| Moving:", moving, "| EM:", emergency, "| Recovery:", recovery);
      handleFlow(stationId);

    } catch (err) {
      console.error("❌ Failed to update lift_status:", err.message);
      console.error("🔸 Raw message:", msg);
    }
  }

  // 🔽 Logic สำหรับ AGV Status
  if (topic === 'automation/station1/agv/status') {
    try {
      const payload = JSON.parse(msg);
      state.latestAgvStatus = payload; // เก็บสถานะล่าสุด
      console.log('[MQTT] 📡 รับ AGV Status:', payload.status);

      // ✅ [แก้ไข] ลบ Logic การอัปเดต DB ออกจากส่วนนี้ แล้วเรียก handleFlow อย่างเดียว
      handleFlow(stationId);

    } catch (err) {
      console.error('❌ Failed to parse AGV status MQTT payload:', err.message);
    }
  }

  // 🔽 Logic เมื่อถาดทำงานเสร็จ
  if (topic === "automation/station1/lift/tray_action_done") {
    state.trayActionDone = true;
    console.log("[Tray] ✅ ถาดทำงานเสร็จแล้ว");
    handleFlow(stationId);
  }
});


// =================================================================
// ⚙️ API Endpoints
// =================================================================

// ✅ GET Task Monitor (เฉพาะงานที่ยังไม่จบ)
// ในไฟล์ index.js (ประมาณบรรทัด 879)

app.get('/api/task-monitor', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT tray_id, action_type, floor, slot, station_id, status, created_at, completed_at, username
      FROM task_monitor
      WHERE status IN ('pending', 'working', 'error', 'at_workstation') -- ✅ เพิ่ม 'at_workstation' ที่นี่
      ORDER BY created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Error loading task monitor:', err.message);
    res.status(500).send('Server error');
  }
});

// ✅ แก้ไข API ให้กรองตาม Station
app.get('/api/task/history', async (req, res) => {
  try {
    const station = req.query.station; // รับ station parameter
    
    let query = `
      SELECT tray_id, action_type, floor, slot, station_id, status, created_at, completed_at, username
      FROM task_monitor
      WHERE status = 'success'
    `;
    
    let params = [];
    
    // ถ้ามี station parameter ให้กรองตาม station
    if (station) {
      query += ` AND station_id = $1`;
      params.push(parseInt(station));
    }
    
    query += ` ORDER BY completed_at DESC`;
    
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error("❌ Fetch task history error:", err.message);
    res.status(500).json({ error: "ไม่สามารถดึงข้อมูล Task History ได้" });
  }
});

// ✅ [แก้ไข] API สำหรับดึงประวัติของถาด (เปลี่ยน Subquery ไปใช้ tray_history เพื่อความแม่นยำ)
app.get('/api/tray/history/:tray_id', async (req, res) => {
  const { tray_id } = req.params;
  try {
    const result = await pool.query(
      `SELECT 
         tm.*, 
         to_char(tm.created_at, 'DD/MM/YYYY HH24:MI:SS') as "timestamp_th",
         (SELECT MIN(created_at) FROM tray_history WHERE tray_id = tm.tray_id AND action_type = 'inbound') as "birth_time"
       FROM task_monitor tm
       WHERE tm.tray_id = $1 
       ORDER BY tm.created_at DESC`,
      [tray_id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(`Error fetching history for tray ${tray_id}:`, err.message);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดในการดึงข้อมูลประวัติ' });
  }
});





// ✅ [Final Version] GET AGV's current status
// ส่งสถานะจาก Flow การทำงานหลัก (flowState) เพื่อการแสดงผลที่แม่นยำที่สุด
app.get('/api/agv/status', (req, res) => {
  const stationId = 1;
  const state = stationStates[stationId];
  
  if (!state) {
    return res.json({ status: 'unknown' });
  }

  let displayStatus;

  // ถ้า Flow กำลังทำงานอยู่ ให้ใช้สถานะของ Flow เป็นหลัก
  if (state.flowState && state.flowState !== 'idle') {
    // ผนวก targetSlot เข้ากับสถานะ เพื่อการแสดงผลที่ชัดเจน
    if ((state.flowState === 'wait_agv_at_slot' || state.flowState === 'start') && state.targetSlot) {
      displayStatus = `agv_moving_to_slot_${state.targetSlot}`;
    } else {
      displayStatus = state.flowState;
    }
  } else {
    // ถ้า Flow ว่าง (idle) ให้ใช้สถานะล่าสุดจากตัว AGV
    displayStatus = state.latestAgvStatus?.status || 'idle';
  }
  
  res.json({ status: displayStatus });
});
// =================================================================
// 🔄 Automation Flow Control
// =================================================================

// ✅ [เพิ่ม] ฟังก์ชันสำหรับอัปเดต Task Monitor โดยเฉพาะ
async function updateTaskStatus(newStatus, stationId) {
    try {
        let result;
        if (newStatus === 'working') {
            // อัปเดตงานที่ 'pending' อยู่ให้เป็น 'working'
            result = await pool.query(
                `UPDATE task_monitor SET status = 'working' WHERE station_id = $1 AND status = 'pending'`,
                [stationId]
            );
        } else if (newStatus === 'success') {
            // อัปเดตงานที่ 'working' อยู่ให้เป็น 'success'
            result = await pool.query(
                `UPDATE task_monitor SET status = 'success', completed_at = NOW() WHERE station_id = $1 AND status = 'working'`,
                [stationId]
            );
             } else if (newStatus === 'at_workstation') { // ✅ เพิ่มเงื่อนไขนี้
            result = await pool.query(
                `UPDATE task_monitor SET status = 'at_workstation' WHERE station_id = $1 AND status = 'working'`,
                [stationId]
            );
        } else if (newStatus === 'error') {
            // อัปเดตงานที่กำลังทำอยู่ ('pending' หรือ 'working') ให้เป็น 'error'
            result = await pool.query(
                `UPDATE task_monitor SET status = 'error' WHERE station_id = $1 AND status IN ('pending', 'working')`,
                [stationId]
            );
        }

        if (result && result.rowCount > 0) {
            console.log(`✅ [DB] Task Monitor for Station ${stationId} updated to -> ${newStatus.toUpperCase()}`);
        }
    } catch (err) {
        console.error(`❌ Failed to update task_monitor to ${newStatus}:`, err.message);
    }
}


function logState(stationId, msg) {
  console.log(`\x1b[36m[Flow] Station ${stationId} → ${msg}\x1b[0m`);
}
// ในไฟล์ index.js

async function handleFlow(stationId) {
  const state = stationStates[stationId];
  if (!state) return;

  const lift = state.latestLiftStatus;
  const agv = state.latestAgvStatus;

  if (agv?.status === 'error') {
      logState(stationId, `[ERROR] AGV ส่งสถานะผิดพลาด! ทำการหยุด Flow และอัปเดต Task`);
      await updateTaskStatus('error', stationId);
      state.flowState = 'idle';
      return;
  }
  
  if (state.flowState === 'start' || state.flowState === 'inbound_start_lift_tray') {
      await updateTaskStatus('working', stationId);
  }
  
  if (state.flowState === 'idle') return;

  const getGoToSlotCommand = (slot) => slot > 0 ? `go_slot${slot}` : null;

  switch (state.flowState) {
    case 'inbound_start_lift_tray':
      logState(stationId, `[INBOUND] เริ่มต้น → สั่ง AGV ยกถาดขึ้น (pickup_tray)`);
      mqttClient.publish(`automation/station1/tray/command`, JSON.stringify({ command: 'pickup_tray' }));
      state.flowState = 'inbound_wait_for_tray_lift';
      break;

    case 'inbound_wait_for_tray_lift':
      if (state.trayActionDone) {
        logState(stationId, `[INBOUND] ยกถาดสำเร็จ → รอ 0.5 วินาที`);
        await delay(500);
        state.trayActionDone = false;
        logState(stationId, `[INBOUND] เริ่มเคลื่อนที่`);
        if (state.targetFloor === 2) {
          logState(stationId, 'ชั้น 2 → ไม่ใช้ลิฟต์ → ไป slot ทันที');
          mqttClient.publish(`automation/station1/agv/command`, JSON.stringify({ command: getGoToSlotCommand(state.targetSlot) }));
          state.flowState = 'wait_agv_at_slot';
        } else {
          logState(stationId, 'ชั้น ≠ 2 → ต้องใช้ลิฟต์ → เริ่มต้น AGV ไป lift');
          mqttClient.publish(`automation/station1/agv/command`, JSON.stringify({ command: 'go_lift' }));
          state.flowState = 'wait_agv_at_lift';
        }
      }
      break;

    case 'start':
      logState(stationId, `[OUTBOUND] เริ่มต้น → เริ่มเคลื่อนที่ไป Slot`);
      if (state.targetFloor === 2) {
        mqttClient.publish(`automation/station1/agv/command`, JSON.stringify({ command: getGoToSlotCommand(state.targetSlot) }));
        state.flowState = 'wait_agv_at_slot';
      } else {
        mqttClient.publish(`automation/station1/agv/command`, JSON.stringify({ command: 'go_lift' }));
        state.flowState = 'wait_agv_at_lift';
      }
      break;

    case 'wait_agv_at_lift':
      if (agv?.location === 'at_lift') {
        logState(stationId, 'AGV ถึง Lift → รอ 0.5 วินาทีเพื่อความเสถียร');
        await delay(500);
        logState(stationId, 'AGV ถึง Lift → ยกลิฟต์ขึ้นชั้นเป้าหมาย');
        mqttClient.publish(`automation/station1/lift/command`, JSON.stringify({ action: 'moveTo', floor: state.targetFloor }));
        state.flowState = 'lift_moving_up';
      }
      break;

    case 'lift_moving_up':
      if (!lift?.moving && lift?.floor === state.targetFloor) {
        logState(stationId, `Lift ถึงชั้น ${state.targetFloor} → รอ 0.5 วินาที`);
        await delay(500);
        logState(stationId, `Lift ถึงชั้น ${state.targetFloor} → AGV ไปยัง slot`);
        mqttClient.publish(`automation/station1/agv/command`, JSON.stringify({ command: getGoToSlotCommand(state.targetSlot) }));
        state.flowState = 'wait_agv_at_slot';
      }
      break;

    case 'wait_agv_at_slot':
      if (agv?.location === 'at_slot') {
        logState(stationId, `AGV ถึงช่องแล้ว → รอ 0.5 วินาทีเพื่อความเสถียร`);
        await delay(500);
        const trayCommand = (state.taskType === 'inbound') ? 'place_tray' : 'pickup_tray';
        logState(stationId, `AGV ถึงช่องแล้ว → สั่ง ${trayCommand}`);
        mqttClient.publish(`automation/station1/tray/command`, JSON.stringify({ command: trayCommand }));
        state.flowState = 'wait_tray_action_done';
      }
      break;

case 'wait_tray_action_done':
  if (state.trayActionDone) {
    logState(stationId, 'ทำงานกับถาดเสร็จ → อัปเดตฐานข้อมูล Inventory ทันที!');

    try {
      if (state.taskType === 'inbound') {
        
        if (state.isReturning) {
          // UPDATE สำหรับถาดที่ส่งกลับ
          await pool.query(
            `UPDATE tray_inventory 
             SET 
               floor = $1, slot = $2, status = 'on_shelf', 
               veg_type = $3, plant_quantity = $4, batch_id = $5, 
               seeding_date = $6, notes = $7, username = $8,
               station_id = $9  -- ✅ [แก้ไข] เพิ่ม station_id
             WHERE tray_id = $10`, // ✅ [แก้ไข] พารามิเตอร์เป็น $10
            [
              state.targetFloor, state.targetSlot, state.vegType,
              state.plantQuantity, state.batchId, state.seedingDate,
              state.notes, state.username, state.stationId, // ✅ [แก้ไข] เพิ่ม state.stationId
              state.trayId
            ]
          );
          console.log(`✅ [DB IMMEDIATE] Inbound: Updated tray ${state.trayId} to new location (age preserved).`);

        } else {
          // INSERT สำหรับถาดใหม่
        await pool.query(
  `INSERT INTO tray_inventory (tray_id, veg_type, floor, slot, username, time_in, plant_quantity, batch_id, seeding_date, notes, status, station_id) 
   VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7, $8, $9, 'on_shelf', $10)`,
  [
    state.trayId, state.vegType, state.targetFloor, state.targetSlot,
    state.username, state.plantQuantity, state.batchId,
    state.seedingDate, state.notes, state.stationId // ✅ เพิ่ม state.stationId
  ]
);
          console.log(`✅ [DB IMMEDIATE] Inbound: Added new tray ${state.trayId}.`);
        }

      } else if (state.taskType === 'outbound') {
        // อัปเดตสถานะถาดเป็น AT_WORKSTATION หลังจาก RGV หยิบสำเร็จ
        await pool.query(
            `UPDATE tray_inventory SET status = 'AT_WORKSTATION' WHERE tray_id = $1`,
            [state.trayId]
        );
        console.log(`[Status Update] Tray ${state.trayId} status changed to AT_WORKSTATION.`);
        console.log(`✅ [Flow] Outbound: หยิบถาดออกจากชั้นสำเร็จ เตรียมเดินทางกลับ`);
      }
      
    } catch (dbError) {
      console.error("❌ [DB IMMEDIATE] Error during DB operation:", dbError.message);
    }

    // --- ส่วนที่เหลือของโค้ดใน case นี้ยังคงเหมือนเดิม ---
    await delay(500);
    logState(stationId, 'ฐานข้อมูลอัปเดตแล้ว → เตรียมเดินทางกลับ');
    state.trayActionDone = false; 

    if (state.targetFloor === 2) {
      logState(stationId, 'ชั้น 2 → AGV กลับบ้านเลย');
      mqttClient.publish(`automation/station1/agv/command`, JSON.stringify({ command: 'go_home' }));
      state.flowState = 'wait_agv_home';
    } else {
      logState(stationId, 'ชั้น ≠ 2 → AGV กลับไปที่ lift');
      mqttClient.publish(`automation/station1/agv/command`, JSON.stringify({ command: 'go_lift' }));
      state.flowState = 'wait_agv_return_to_lift';
    }
  }
  break;

    case 'wait_agv_return_to_lift':
      if (agv?.location === 'at_lift') {
        logState(stationId, 'AGV กลับถึง Lift → รอ 0.5 วินาที');
        await delay(500);
        logState(stationId, 'AGV กลับถึง Lift → สั่งลิฟต์ลงชั้น 2');
        mqttClient.publish(`automation/station1/lift/command`, JSON.stringify({ action: 'moveTo', floor: 2 }));
        state.flowState = 'lift_moving_down';
      }
      break;

    case 'lift_moving_down':
      if (!lift?.moving && lift?.floor === 2) {
        logState(stationId, 'Lift ลงถึงชั้น 2 → รอ 0.5 วินาที');
        await delay(500);
        logState(stationId, 'Lift ลงถึงชั้น 2 → AGV กลับบ้าน');
        mqttClient.publish(`automation/station1/agv/command`, JSON.stringify({ command: 'go_home' }));
        state.flowState = 'wait_agv_home';
      }
      break;

    case 'wait_agv_home':
      if (agv?.location === 'home' || agv?.location === 'at_home') {
        logState(stationId, 'AGV ถึงบ้านแล้ว → รอ 0.5 วินาที');
        await delay(500);
        if (state.taskType === 'outbound') {
          logState(stationId, '[OUTBOUND] AGV ถึงบ้านแล้ว → สั่งวางถาด (place_tray)');
          mqttClient.publish(`automation/station1/tray/command`, JSON.stringify({ command: 'place_tray' }));
          state.flowState = 'outbound_wait_for_final_place';
        } else {
          logState(stationId, '[INBOUND] AGV กลับถึงบ้านแล้ว → Flow เสร็จสมบูรณ์');
          state.flowState = 'done';
          await handleFlow(stationId);
        }
      }
      break;

    // ใน handleFlow, case 'outbound_wait_for_final_place'
case 'outbound_wait_for_final_place':
  if (state.trayActionDone) {
    logState(stationId, '[OUTBOUND] วางถาดที่ Home สำเร็จ');
    state.trayActionDone = false; // รีเซ็ตธง

    // ❌ เดิม: state.flowState = 'done';
    // ✅ ใหม่: เปลี่ยนสถานะของ Task และ Flow
    logState(stationId, '[WORKSTATION] เปลี่ยนสถานะเป็น "รอที่ Workstation"');
    await updateTaskStatus('at_workstation', stationId); // อัปเดต Task ใน DB

    // Reset state ของ flow แต่ "ไม่ต้อง" เปลี่ยนเป็น idle
    // เพื่อให้ระบบรู้ว่ามีงานค้างอยู่ที่ Workstation
    state.taskType = null;
    state.targetFloor = null;
    state.targetSlot = null;
    // ... ไม่ต้องรีเซ็ต state.flowState

    // ไม่ต้องเรียก handleFlow(stationId) ต่อ ปล่อยให้ flow ค้างไว้ที่นี่
  }
  break;
    case 'done':
      // ❌ ลบการอัปเดตฐานข้อมูล Inventory ออกจากตรงนี้
      logState(stationId, 'Flow เสร็จสมบูรณ์ → อัปเดต Task และรีเซ็ตสถานะเป็น Idle');
      await updateTaskStatus('success', stationId);

      // Reset state variables
      state.flowState = 'idle';
      state.taskType = null;
      state.targetFloor = null;
      state.targetSlot = null;
      state.vegType = null;
      state.username = null;
      state.trayId = null;
      break;
  }
}




// ✅ [เพิ่มใหม่] API สำหรับเช็คว่ามีถาดรออยู่ที่ Workstation หรือไม่
app.get('/api/workstation/current', async (req, res) => {
    const { station } = req.query;
    try {
        // เพิ่ม reason เข้าไปใน SELECT statement
        const result = await pool.query(
            `SELECT 
                tray_id, floor, slot, station_id,
                veg_type, plant_quantity, batch_id, seeding_date, notes,
                reason
             FROM task_monitor
             WHERE station_id = $1 AND status = 'at_workstation'
             LIMIT 1`,
            [station || 1]
        );
        res.json(result.rows[0] || null);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


app.post('/api/workstation/dispose', async (req, res) => {
    const { tray_id, station_id } = req.body;
    try {
        // ✅ 1. [เพิ่มคำสั่งนี้] ลบถาดออกจาก inventory
        await pool.query(
            `DELETE FROM tray_inventory WHERE tray_id = $1`,
            [tray_id]
        );
        console.log(`🗑️ [Workstation] Deleted tray ${tray_id} from inventory.`);

        // 2. อัปเดต task เดิมให้เป็น success (โค้ดเดิม)
        await pool.query(
            `UPDATE task_monitor SET status = 'success', completed_at = NOW() WHERE station_id = $1 AND status = 'at_workstation'`,
            [station_id]
        );

        // 3. รีเซ็ต Flow State กลับเป็น idle (โค้ดเดิม)
        if (stationStates[station_id]) {
            stationStates[station_id].flowState = 'idle';
        }

        res.json({ message: 'ดำเนินการเสร็จสิ้น' });
    } catch (err) {
        console.error('❌ Dispose Tray Error:', err.message); // Log error
        res.status(500).json({ error: err.message });
    }
});

// หมายเหตุ: API สำหรับ "ส่งกลับเข้าคลัง" จะซับซ้อนกว่า โดยจะต้องรับตำแหน่งใหม่
// และสร้าง Task Inbound ใหม่ คุณสามารถเพิ่มส่วนนี้ในภายหลังได้

















// ✅ เก็บกล้องที่ register เข้ามา
let cameras = {};

// ✅ Auto-register cameras on server start
function initializeCameras() {
  // Register default cameras
  const defaultCameras = [
    { camera_id: 'CAM001', ip: '127.0.0.1' },
    { camera_id: 'CAM002', ip: '127.0.0.1' }
  ];
  
  defaultCameras.forEach(({ camera_id, ip }) => {
    cameras[camera_id] = { ip, registered_at: new Date() };
    console.log(`📸 Auto-registered Camera: ${camera_id} → ${ip}`);
  });
}

// ✅ รับ register กล้อง
app.post('/api/camera/register', (req, res) => {
  const { camera_id, ip } = req.body;
  if (!camera_id || !ip) {
    return res.status(400).json({ error: "camera_id และ ip ต้องไม่ว่าง" });
  }

  cameras[camera_id] = { ip, registered_at: new Date() };
  console.log(`📸 Camera Registered: ${camera_id} → ${ip}`);
  res.json({ message: "Camera registered" });
});

// ✅ ดูรายการกล้องที่ register ไว้
app.get('/api/camera/list', (req, res) => {
  res.json({
    cameras: cameras,
    total: Object.keys(cameras).length
  });
});

// ✅ ดึง stream กล้อง → stream pass-through แบบ raw 100%
const net = require('net');
const { URL } = require('url');

app.get('/api/camera/stream/:camera_id', (req, res) => {
  const camera_id = req.params.camera_id;
  const camera = cameras[camera_id];

  if (!camera) {
    console.error('❌ Camera not found:', camera_id);
    return res.status(404).send('Camera not found');
  }

  const targetUrl = `http://${camera.ip}/stream`;
  console.log(`📡 Proxy streaming camera: ${camera_id} → ${targetUrl}`);

  const url = new URL(targetUrl);
  const socket = net.connect(url.port || 80, url.hostname, () => {
    socket.write(`GET ${url.pathname} HTTP/1.1\r\n`);
    socket.write(`Host: ${url.hostname}\r\n`);
    socket.write(`Connection: close\r\n`);  // ✅ ให้แน่ใจว่าปิดหลังจบ stream
    socket.write(`\r\n`);
  });

  let headerParsed = false;
  let headerBuffer = Buffer.alloc(0);

  socket.on('data', (chunk) => {
    if (!headerParsed) {
      headerBuffer = Buffer.concat([headerBuffer, chunk]);
      const headerEnd = headerBuffer.indexOf('\r\n\r\n');
      if (headerEnd !== -1) {
        const headers = headerBuffer.slice(0, headerEnd).toString();
        const body = headerBuffer.slice(headerEnd + 4);

        // ✅ ดึง Content-Type จาก header จริง
        let contentType = 'multipart/x-mixed-replace; boundary=frame';
        const match = headers.match(/Content-Type:\s*(.+)/i);
        if (match) {
          contentType = match[1].replace('--boundarydonotcross', 'frame').trim();
        }

        res.writeHead(200, { 'Content-Type': contentType });
        res.write(body);
        headerParsed = true;
      }
    } else {
      res.write(chunk);
    }
  });

  socket.on('end', () => {
    console.log(`✅ Stream ended: ${camera_id}`);
    res.end();
  });

  socket.on('error', (err) => {
    console.error(`❌ Camera ${camera_id} connection error:`, err.message);
    if (!res.headersSent) {
      res.status(500).json({ 
        error: 'Camera connection failed', 
        camera_id: camera_id,
        target_url: targetUrl,
        message: err.message
      });
    } else {
      res.end();
    }
  });

  // ✅ กรณี client กดปิด tab ให้ terminate socket ทันที
  req.on('close', () => {
    console.log(`⚠️ Client closed connection: ${camera_id}`);
    socket.destroy();
  });
});
// ✅ MANUAL AGV COMMAND (ปรับใหม่ให้ยิงตรง agv/command)
app.post('/api/agv/manual', (req, res) => {
  const { userId, station, command } = req.body;

  // เปลี่ยน topic ไปยิงตรง AGV Command
  const topic = `automation/station${station}/agv/command`;

  // payload ส่งเป็น JSON { command: "xxx" }
  const payload = JSON.stringify({ command });

  try {
    mqttClient.publish(topic, payload);
    console.log("📤 MQTT AGV Manual >>", topic, payload);
    res.json({ message: "AGV Manual command sent" });
  } catch (err) {
    console.error("❌ AGV Manual Error:", err.message);
    res.status(500).send("Server error");
  }
});

app.post('/api/tray/manual', (req, res) => {
  const { userId, station, command } = req.body;
  const topic = `automation/station${station}/tray/command`;
  const payload = JSON.stringify({ command });

  try {
    mqttClient.publish(topic, payload);
    console.log("📤 MQTT Tray Manual >>", topic, payload);
    res.json({ message: "Tray Manual command sent" });
  } catch (err) {
    console.error("❌ Tray Manual Error:", err.message);
    res.status(500).send("Server error");
  }
});


// ✅ [เพิ่มใหม่] API สำหรับ Summary Cards ในหน้า Overview
app.get('/api/overview/summary-cards', async (req, res) => {
  try {
    const stationId = req.query.station || '1';

    // 1. Inbound/Outbound วันนี้
    const todayStatsRes = await pool.query(
      `SELECT
         SUM(CASE WHEN action_type = 'inbound' THEN 1 ELSE 0 END) as today_inbound,
         SUM(CASE WHEN action_type = 'outbound' THEN 1 ELSE 0 END) as today_outbound
       FROM tray_history
       WHERE station_id = $1 AND created_at >= CURRENT_DATE`,
      [stationId]
    );

    // 2. จำนวนถาดในคลังทั้งหมด
    const totalTraysRes = await pool.query(
      `SELECT COUNT(*) FROM tray_inventory WHERE station_id = $1 AND status = 'on_shelf'`,
      [stationId]
    );
    
    // 3. % งานที่ตรงเวลา (ตัวอย่าง สมมติว่าตรงเวลา 100%)
    const onTimePercentage = 100;

    res.json({
      today_inbound: parseInt(todayStatsRes.rows[0].today_inbound) || 0,
      today_outbound: parseInt(todayStatsRes.rows[0].today_outbound) || 0,
      total_trays: parseInt(totalTraysRes.rows[0].count) || 0,
      ontime_percentage: onTimePercentage 
    });

  } catch (err) {
    console.error("❌ Error fetching summary cards data:", err.message);
    res.status(500).json({ error: 'Server error' });
  }
});


app.get('/api/overview/summary-cards', async (req, res) => {
  try {
    const station = parseInt(req.query.station) || 1;
    const today = new Date().toISOString().split('T')[0];
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    
    // ข้อมูลวันนี้
    const todayResult = await pool.query(`
      SELECT 
        SUM(CASE WHEN action_type = 'inbound' THEN 1 ELSE 0 END) as inbound,
        SUM(CASE WHEN action_type = 'outbound' THEN 1 ELSE 0 END) as outbound
      FROM tray_history 
      WHERE station_id = $1 AND DATE(created_at) = $2
    `, [station, today]);
    
    // ข้อมูลเมื่อวาน
    const yesterdayResult = await pool.query(`
      SELECT 
        SUM(CASE WHEN action_type = 'inbound' THEN 1 ELSE 0 END) as inbound,
        SUM(CASE WHEN action_type = 'outbound' THEN 1 ELSE 0 END) as outbound
      FROM tray_history 
      WHERE station_id = $1 AND DATE(created_at) = $2
    `, [station, yesterday]);

    // จำนวนถาดในคลัง
    const trayResult = await pool.query(`
      SELECT COUNT(*) as total FROM tray_inventory WHERE station_id = $1
    `, [station]);

    // งานที่สำเร็จวันนี้
    const taskResult = await pool.query(`
      SELECT 
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success,
        COUNT(*) as total
      FROM task_monitor 
      WHERE station_id = $1 AND DATE(created_at) = $2
    `, [station, today]);

    const today_inbound = parseInt(todayResult.rows[0].inbound) || 0;
    const today_outbound = parseInt(todayResult.rows[0].outbound) || 0;
    const yesterday_inbound = parseInt(yesterdayResult.rows[0].inbound) || 0;
    const yesterday_outbound = parseInt(yesterdayResult.rows[0].outbound) || 0;
    const total_trays = parseInt(trayResult.rows[0].total) || 0;
    
    // คำนวณเปอร์เซ็นต์งานสำเร็จ
    const total_tasks = parseInt(taskResult.rows[0].total) || 0;
    const success_tasks = parseInt(taskResult.rows[0].success) || 0;
    const ontime_percentage = total_tasks > 0 ? Math.round((success_tasks / total_tasks) * 100) : 100;

    // คำนวณ trend
    const calculateTrend = (today, yesterday) => {
      if (yesterday === 0) return today > 0 ? 100 : 0;
      return Math.round(((today - yesterday) / yesterday) * 100);
    };

    res.json({
      today_inbound,
      today_outbound,
      total_trays,
      ontime_percentage,
      inbound_trend: calculateTrend(today_inbound, yesterday_inbound),
      outbound_trend: calculateTrend(today_outbound, yesterday_outbound),
      trays_trend: 0, // คำนวณถ้าต้องการ
      ontime_trend: 0 // คำนวณถ้าต้องการ
    });

  } catch (err) {
    console.error('Overview API Error:', err);
    res.status(500).json({ error: err.message });
  }
});


// USER MANAGEMENT APIs (เพิ่มใหม่ทั้งหมด)


// ✅ [GET] ดึงข้อมูลผู้ใช้ทั้งหมด
app.get('/api/users', async (req, res) => {
    try {
       const result = await pool.query(`
    SELECT id, username, role, created_at,
           (last_seen > NOW() - INTERVAL '2 minutes') as is_online
    FROM users ORDER BY id ASC
`);
        res.json(result.rows);
    } catch (err) {
        console.error('❌ Error fetching users:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ✅ [GET] ดึงข้อมูลผู้ใช้คนเดียว (สำหรับหน้าแก้ไข)
app.get('/api/users/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query(
            'SELECT id, username, role FROM users WHERE id = $1',
            [id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error(`❌ Error fetching user ${id}:`, err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ✅ [POST] เพิ่มผู้ใช้ใหม่
app.post('/api/users', async (req, res) => {
    const { username, password, role } = req.body;

    if (!username || !password || !role) {
        return res.status(400).json({ error: 'กรุณากรอกข้อมูลให้ครบถ้วน' });
    }

    try {
        const existingUser = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
        if (existingUser.rows.length > 0) {
            return res.status(409).json({ error: 'มีชื่อผู้ใช้นี้ในระบบแล้ว' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const result = await pool.query(
            'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id, username, role, created_at',
            [username, hashedPassword, role]
        );

        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('❌ Error creating user:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ✅ [PUT] แก้ไขข้อมูลผู้ใช้ (Role หรือ Password)
app.put('/api/users/:id', async (req, res) => {
    const { id } = req.params;
    const { role, password } = req.body;

    if (!role && !password) {
        return res.status(400).json({ error: 'ไม่มีข้อมูลให้อัปเดต' });
    }

    try {
        const updates = [];
        const queryParams = [];
        let paramIndex = 1;

        // เพิ่ม role เข้าไปใน query ถ้ามีการส่งมา
        if (role) {
            updates.push(`role = $${paramIndex++}`);
            queryParams.push(role);
        }

        // เพิ่ม password เข้าไปใน query ถ้ามีการส่งมา
        if (password) {
            const hashedPassword = await bcrypt.hash(password, 10);
            updates.push(`password_hash = $${paramIndex++}`);
            queryParams.push(hashedPassword);
        }

        queryParams.push(id); // เพิ่ม id เป็นพารามิเตอร์สุดท้ายสำหรับ WHERE

        const query = `
            UPDATE users 
            SET ${updates.join(', ')} 
            WHERE id = $${paramIndex} 
            RETURNING id, username, role
        `;

        const result = await pool.query(query, queryParams);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'ไม่พบผู้ใช้ที่ต้องการแก้ไข' });
        }

        res.json(result.rows[0]);
    } catch (err) {
        console.error(`❌ Error updating user ${id}:`, err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ✅ [DELETE] ลบผู้ใช้
app.delete('/api/users/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query(
            'DELETE FROM users WHERE id = $1 RETURNING id',
            [id]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'ไม่พบผู้ใช้ที่ต้องการลบ' });
        }
        
        console.log(`🗑️ Deleted user with ID: ${id}`);
        res.json({ message: 'ลบผู้ใช้สำเร็จ' });
    } catch (err) {
        console.error(`❌ Error deleting user ${id}:`, err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ✅ [เพิ่มใหม่] API สำหรับ Ping เพื่ออัปเดต last_seen
app.post('/api/users/ping', async (req, res) => {
    const { userId } = req.body;
    if (!userId) {
        return res.status(400).json({ error: 'Missing userId' });
    }
    try {
        // อัปเดตเวลาล่าสุดของผู้ใช้คนนั้นๆ ให้เป็นเวลาปัจจุบัน
        await pool.query(
            'UPDATE users SET last_seen = NOW() WHERE id = $1',
            [userId]
        );
        res.sendStatus(200); // ส่งแค่สถานะ OK กลับไป ไม่ต้องมีข้อมูล
    } catch (err) {
        console.error('❌ Ping Error:', err.message);
        res.sendStatus(500);
    }
});


// ===============================================
// ✅ GLOBAL VARIABLES FOR LIGHT CONTROL (IN BACKEND)
// ===============================================
let lightSchedules = {}; // Stores loaded schedules from database (Backend's cache)
let currentLightState = {}; // Stores current state of lights (intensity, isManuallyOverridden) in Backend

// ✅ MQTT Command Queue for Backend Publishing
const mqttCommandQueue = [];
let isProcessingMqttQueue = false;

// Funct// ✅ ฟังก์ชันจัดการคิวที่แก้ไขแล้ว (เพิ่ม Delay เป็น 500ms)
async function processMqttQueue() {
    if (mqttCommandQueue.length === 0) {
        isProcessingMqttQueue = false;
        return;
    }

    isProcessingMqttQueue = true;
    const command = mqttCommandQueue.shift(); // ดึงคำสั่งแรกออกจากคิว

    try {
        mqttClient.publish(command.topic, command.payload);
        console.log(`📤 MQTT Publish >> ${command.topic}`, command.payload);
    } catch (error) {
        console.error('❌ MQTT Publish Error:', error.message);
    }

    // --- 💡 [จุดที่แก้ไข] เพิ่มเวลาหน่วงเป็น 500ms ---
    // เพื่อให้ ESP32 และไดรเวอร์ Modbus มีเวลาประมวลผลมากขึ้น
    await delay(3000); 
    
    processMqttQueue(); // เรียกตัวเองเพื่อทำงานกับคำสั่งถัดไปในคิว
}


// ✅ [ULTIMATE & PROVEN MAPPING] - แก้ไขตามผลการทดสอบจริง
function getLightParams(floor, type) {
    const floorNum = parseInt(floor);

    const settings = {
        // ✅ ชั้น 1 (ยืนยันแล้ว)
        FLOOR_1_SETTINGS: { 
            'light-white': { layer: 1, dir: 7 },
            'light-red':   { layer: 1, dir: 5 }, // 👈 แก้ไข dir ของไฟแดง
            'fan':         { layer: 1, dir: 101 } 
        },
        // ✅ ชั้น 2
        FLOOR_2_SETTINGS: { 
            'light-white': { layer: 2, dir: 7 }, 
            'light-red':   { layer: 2, dir: 5 }, // 👈 แก้ไข dir ของไฟแดง
            'fan':         { layer: 1, dir: 103 } 
        },
        // ✅ ชั้น 3
        FLOOR_3_SETTINGS: { 
            'light-white': { layer: 1, dir: 3 }, 
            'light-red':   { layer: 1, dir: 1 }, // 👈 แก้ไข dir ของไฟแดง
            'fan':         { layer: 2, dir: 101 } 
        },
        // ✅ ชั้น 4
        FLOOR_4_SETTINGS: { 
            'light-white': { layer: 3, dir: 7 }, 
            'light-red':   { layer: 3, dir: 5 }, // 👈 แก้ไข dir ของไฟแดง
            'fan':         { layer: 3, dir: 101 } 
        },
        // ✅ ชั้น 5
        FLOOR_5_SETTINGS: { 
            'light-white': { layer: 3, dir: 3 }, 
            'light-red':   { layer: 3, dir: 1 }, // 👈 แก้ไข dir ของไฟแดง
            'fan':         { layer: 3, dir: 103 } 
        }
    };

    const mapping = {
        1: settings.FLOOR_1_SETTINGS,
        2: settings.FLOOR_2_SETTINGS,
        3: settings.FLOOR_3_SETTINGS,
        4: settings.FLOOR_4_SETTINGS,
        5: settings.FLOOR_5_SETTINGS,
    };

    return mapping[floorNum] ? mapping[floorNum][type] : null;
}
// 2. Function to send MQTT commands (uses queue)
function sendLightCommandToHardware(layer, dir, distance) {
    const topic = "LED"; // This topic should match what ESP32 subscribes to
    const payload = JSON.stringify({
        Key: "Apple",
        command: "DIM", 
        layer: layer,
        dir: dir,
        distance: parseInt(distance)
    });

    mqttCommandQueue.push({ topic, payload });
    if (!isProcessingMqttQueue) {
        processMqttQueue(); // Start processing the queue if not already running
    }
}

// 3. Function to check if current time is within schedule (Thailand Time - GMT+7)
function isTimeWithin(onTimeStr, offTimeStr) {
    if (!onTimeStr || !offTimeStr) return false;

    const now = new Date();
    // Adjust to Thailand Time (GMT+7)
    const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
    const thTime = new Date(utc + (3600000 * 7)); // 3600000 ms = 1 hour

    const [onHours, onMinutes] = onTimeStr.split(':').map(Number);
    const onDate = new Date(thTime.getFullYear(), thTime.getMonth(), thTime.getDate(), onHours, onMinutes, 0);

    const [offHours, offMinutes] = offTimeStr.split(':').map(Number);
    const offDate = new Date(thTime.getFullYear(), thTime.getMonth(), thTime.getDate(), offHours, offMinutes, 0);

    // Handle overnight schedules (e.g., 23:00 - 02:00)
    if (offDate <= onDate) {
        if (thTime < onDate) { // Current time is before 'on' time today (schedule started yesterday)
            onDate.setDate(onDate.getDate() - 1);
        } else { // Current time is after 'on' time today (schedule ends tomorrow)
            offDate.setDate(offDate.getDate() + 1);
        }
    }
    return thTime >= onDate && thTime < offDate;
}



// 4. Main Scheduler Logic (Backend) - ฉบับแก้ไข
function startAutomaticLightScheduler() {
    console.log("⏰ Light Scheduler Initialized in Backend (v2 - Corrected Override Logic).");
    const schedulerInterval = setInterval(async () => {
        try {
            // ❌ ไม่มีการเรียก await loadSchedulesFromDB(); ในนี้แล้ว

            for (let floor = 1; floor <= 5; floor++) {
                ['light-white', 'light-red', 'fan'].forEach(type => {
                    const key = `${floor}-${type}`;
                    const schedule = lightSchedules[key];
                    
                    if (!currentLightState[key]) {
                        currentLightState[key] = { intensity: 0, isManuallyOverridden: false };
                    }
                    const state = currentLightState[key];
                    const params = getLightParams(floor, type);
                    if (!params) return;

                    const shouldBeOnBySchedule = schedule && schedule.enabled && isTimeWithin(schedule.on, schedule.off);

                    if (state.isManuallyOverridden) {
                        // เมื่อถูก Manual Override, Scheduler จะไม่ยุ่งเกี่ยวเลย
                    } 
                    else if (shouldBeOnBySchedule) {
                        // ไม่ถูก Override และตารางบอกว่า "ควรเปิด"
                        if (state.intensity !== schedule.intensity) {
                            console.log(`⏰ ACTION: Turning ON ${key} to ${schedule.intensity}% (ตามตาราง)`);
                            sendLightCommandToHardware(params.layer, params.dir, schedule.intensity);
                            state.intensity = schedule.intensity;
                        }
                    } 
                    else {
                        // ไม่ถูก Override และตารางบอกว่า "ควรปิด"
                        if (state.intensity > 0) {
                            console.log(`⏰ ACTION: Turning OFF ${key} (สิ้นสุดตาราง/ไม่มีตาราง)`);
                            sendLightCommandToHardware(params.layer, params.dir, 0);
                            state.intensity = 0;
                        }
                    }
                });
            }
        } catch (err) {
            console.error("❌ Scheduler Error:", err);
        }
    }, 5000); // ตรวจสอบทุก 5 วินาที
}

// 5. Function to load schedules from database (Backend)
async function loadSchedulesFromDB() {
    try {
        const { rows } = await pool.query('SELECT * FROM light_schedules ORDER BY floor, type');
        const newSchedules = {};
        rows.forEach(row => {
            const key = `${row.floor}-${row.type}`;
            newSchedules[key] = {
                intensity: row.intensity,
                on: row.on_time,
                off: row.off_time,
                enabled: row.enabled,
            };
        });
        lightSchedules = newSchedules; // Update backend's cache of schedules
        console.log(`✅ Loaded ${rows.length} light schedules from database.`);
    } catch (err) {
        console.error('❌ Failed to load light schedules from database:', err);
    }
}

// ===============================================
// ✅ LIGHT CONTROL API Endpoints (Backend)
// ===============================================
app.post('/api/lights/schedule', async (req, res) => {
    const { floor, type, intensity, onTime, offTime, enabled } = req.body;
    try {
        const query = `
            INSERT INTO light_schedules (floor, type, intensity, on_time, off_time, enabled, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, NOW())
            ON CONFLICT (floor, type) DO UPDATE SET
                intensity = EXCLUDED.intensity,
                on_time = EXCLUDED.on_time,
                off_time = EXCLUDED.off_time,
                enabled = EXCLUDED.enabled,
                updated_at = NOW()
            RETURNING *;
        `;
        const { rows } = await pool.query(query, [floor, type, parseInt(intensity), onTime, offTime, enabled]);

        const key = `${rows[0].floor}-${rows[0].type}`;
        if (currentLightState[key]) {
            currentLightState[key].isManuallyOverridden = false;
            console.log(`🔄 Reset Manual Override for ${key}.`);
        }

        await loadSchedulesFromDB(); // ✅ เพิ่มบรรทัดนี้เข้ามา เพื่อโหลดข้อมูลใหม่ทันที

        console.log('✅ DB Updated:', rows[0].floor, rows[0].type);
        res.json({ message: 'บันทึกตารางเวลาสำเร็จ', schedule: rows[0] });
        
    } catch (err) {
        console.error('❌ Error saving schedule to DB:', err);
        res.status(500).json({ error: 'เกิดข้อผิดพลาดในการบันทึกข้อมูล' });
    }
});

// GET /api/lights/schedule - Fetch all schedules (โค้ดเดิมถูกต้องแล้ว)
app.get('/api/lights/schedule', async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT * FROM light_schedules ORDER BY floor, type');
        const formattedSchedules = {};
        rows.forEach(row => {
            const key = `${row.floor}-${row.type}`;
            formattedSchedules[key] = {
                intensity: row.intensity,
                on: row.on_time,
                off: row.off_time,
                enabled: row.enabled,
            };
        });
        res.json(formattedSchedules);
    } catch (err) {
        console.error('❌ Error fetching schedules from DB:', err);
        res.status(500).json({ error: 'เกิดข้อผิดพลาดในการดึงข้อมูล' });
    }
});

// DELETE /api/lights/schedule/all - Clear all schedules (โค้ดเดิมถูกต้องแล้ว)
app.delete('/api/lights/schedule/all', async (req, res) => {
    try {
        // First, turn off all lights controlled by schedule
        for (let floor = 1; floor <= 5; floor++) { // Loop all 5 floors
            ['light-white', 'light-red', 'fan'].forEach(type => {
                const params = getLightParams(floor, type);
                if (params) {
                    sendLightCommandToHardware(params.layer, params.dir, 0); // Send DIM 0
                }
            });
        }
        
        // Then, truncate the database table
        await pool.query('TRUNCATE TABLE light_schedules RESTART IDENTITY;');
        
        // Reset Backend's cache and state variables
        lightSchedules = {};
        currentLightState = {}; // All lights are now off and not manually overridden
        
        console.log('🗑️ All light schedules cleared from DB and Backend cache. Lights commanded OFF.');
        res.json({ message: 'ล้างข้อมูลการตั้งเวลาทั้งหมดสำเร็จ' });
        
    } catch (err) {
        console.error('❌ Error clearing all schedules:', err);
        res.status(500).json({ error: 'เกิดข้อผิดพลาดในการล้างข้อมูล' });
    }
});

// --- API for real-time light control (Manual commands from Frontend) ---
// ✅ โค้ดใหม่ที่แก้ไขแล้ว
app.post('/api/lights/control', async (req, res) => {
    const { floor, type, distance } = req.body;
    const id = `${floor}-${type}`;

    if (!currentLightState[id]) {
        currentLightState[id] = { intensity: 0, isManuallyOverridden: false };
    }
    currentLightState[id].intensity = parseInt(distance);
    currentLightState[id].isManuallyOverridden = parseInt(distance) !== 0;

    // 🟢 ไม่มีการเรียก sendLightCommandToHardware จากตรงนี้แล้ว

    res.json({ message: "รับค่าเรียบร้อย" });
});
// POST /api/lights/off/all - Force turn off all lights (global button)
app.post('/api/lights/off/all', async (req, res) => {
    console.log('🚨 FORCE SHUTDOWN: Received command to turn off all lights from Frontend.');

    for (let floor = 1; floor <= 5; floor++) { // วนลูป 5 ชั้น
        ['light-white', 'light-red', 'fan'].forEach(type => {
            const key = `${floor}-${type}`;
            const params = getLightParams(floor, type); // ดึงค่า layer, dir ที่ถูกต้อง

            if (params) {
                // --- ✨ [จุดที่แก้ไข] เพิ่มการเรียกใช้ฟังก์ชันนี้เพื่อส่งคำสั่งปิดจริงๆ ---
                sendLightCommandToHardware(params.layer, params.dir, 0); 

                // อัปเดตสถานะใน Backend (ส่วนนี้ถูกต้องอยู่แล้ว)
                if (!currentLightState[key]) {
                    currentLightState[key] = { intensity: 0, isManuallyOverridden: false };
                }
                currentLightState[key].intensity = 0;
                currentLightState[key].isManuallyOverridden = true; 
            }
        });
    }
    res.json({ message: 'ส่งคำสั่งปิดไฟทั้งหมดเรียบร้อย' });
});
// ✅ [NEW & STABLE] Endpoint สำหรับรับข้อมูล Schedule ทั้งหมดในครั้งเดียว
app.post('/api/lights/schedule/batch', async (req, res) => {
    const schedules = req.body; // รับ Array ของ schedules ทั้งหมด
    const client = await pool.connect(); // เชื่อมต่อ Database

    try {
        await client.query('BEGIN'); //  TRANSACTION START

        for (const schedule of schedules) {
            const { floor, type, intensity, onTime, offTime, enabled } = schedule;
            const query = `
                INSERT INTO light_schedules (floor, type, intensity, on_time, off_time, enabled, updated_at)
                VALUES ($1, $2, $3, $4, $5, $6, NOW())
                ON CONFLICT (floor, type) DO UPDATE SET
                    intensity = EXCLUDED.intensity,
                    on_time = EXCLUDED.on_time,
                    off_time = EXCLUDED.off_time,
                    enabled = EXCLUDED.enabled,
                    updated_at = NOW();
            `;
            await client.query(query, [floor, type, intensity, onTime, offTime, enabled]);

            // รีเซ็ตสถานะ Manual Override เมื่อมีการบันทึก Schedule
            const key = `${floor}-${type}`;
            if (currentLightState[key]) {
                currentLightState[key].isManuallyOverridden = false;
            }
        }

        await client.query('COMMIT'); // TRANSACTION END (SAVE)
        console.log(`✅ Batch updated ${schedules.length} schedules successfully.`);

        await loadSchedulesFromDB(); // โหลดข้อมูลใหม่ทั้งหมดเข้าหน่วยความจำ **เพียงครั้งเดียว**

        res.json({ message: 'บันทึกตารางเวลาทั้งหมดสำเร็จ' });

    } catch (err) {
        await client.query('ROLLBACK'); // TRANSACTION END (CANCEL)
        console.error('❌ Error in batch schedule update:', err);
        res.status(500).json({ error: 'เกิดข้อผิดพลาดในการบันทึกข้อมูล' });
    } finally {
        client.release(); // คืนการเชื่อมต่อให้ Pool
    }
});

// NEW API: GET /api/lights/status - Frontend polls this to get current light states
app.get('/api/lights/status', (req, res) => {
    res.json(currentLightState); // Send the Backend's current state to Frontend
});

// ===============================================
// ✅ INITIALIZE SCHEDULER & LOAD DATA (ON SERVER START)
// ===============================================
// Load schedules from DB once when server starts
loadSchedulesFromDB(); 
// Start the scheduler loop in the backend
startAutomaticLightScheduler();




// API สำหรับบันทึกค่าที่เปลี่ยนแปลง (Pending) ลง DB
app.post('/api/lights/pending', async (req, res) => {
    const { userId, floor, type, intensity } = req.body;
    try {
        // ใช้ "UPSERT" logic: ถ้ามีข้อมูลเดิมอยู่แล้วให้อัปเดต, ถ้าไม่มีให้เพิ่มใหม่
        const query = `
            INSERT INTO light_pending_changes (user_id, floor, type, intensity)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (user_id, floor, type) DO UPDATE SET
                intensity = EXCLUDED.intensity,
                created_at = NOW();
        `;
        await pool.query(query, [userId, floor, type, intensity]);
        res.status(200).json({ message: 'Pending change saved.' });
    } catch (err) {
        console.error('❌ Error saving pending change:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// API สำหรับดึงค่าที่ค้างอยู่ทั้งหมดของผู้ใช้
app.get('/api/lights/pending', async (req, res) => {
    const { userId } = req.query;
    try {
        const { rows } = await pool.query(
            'SELECT floor, type, intensity FROM light_pending_changes WHERE user_id = $1',
            [userId]
        );
        res.json(rows);
    } catch (err) {
        console.error('❌ Error fetching pending changes:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// API สำหรับลบค่าที่ค้างอยู่ของชั้นนั้นๆ (หลังจากกดยืนยันแล้ว)
app.delete('/api/lights/pending/:floor', async (req, res) => {
    const { floor } = req.params;
    const { userId } = req.body; // รับ userId จาก body เพื่อความปลอดภัย
    try {
        await pool.query(
            'DELETE FROM light_pending_changes WHERE user_id = $1 AND floor = $2',
            [userId, floor]
        );
        res.status(200).json({ message: 'Pending changes cleared for floor.' });
    } catch (err) {
        console.error('❌ Error deleting pending changes:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/sensors', (req, res) => {
    const stationId = 1; // สมมติว่ามีสถานีเดียว
    const state = stationStates[stationId];
    
    // หากยังไม่ได้รับข้อมูล ให้ส่งค่า default กลับไป
    const sensorStatus = state?.latestAgvSensorStatus || {
        tray_sensor: false,
        pos_sensor_1: false,
        pos_sensor_2: false
    };
    
    res.json(sensorStatus);
});

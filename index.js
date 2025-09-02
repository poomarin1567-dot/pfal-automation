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

// ✅ Enhanced Rate Limiting (improved security)
const requestCounts = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const MAX_REQUESTS = 200; // ลดจาก 1000 เป็น 200 requests per minute


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
    console.error('❌ Health check failed:', err.message, err.stack);
    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: err.message
    });
  }
});


// ✅ Logging Activity Function
// ✅ Log Queue สำหรับป้องกัน connection pool overflow
const logQueue = [];
let isProcessingQueue = false;

async function processLogQueue() {
  if (isProcessingQueue || logQueue.length === 0) return;
  
  isProcessingQueue = true;
  
  while (logQueue.length > 0) {
    const logData = logQueue.shift();
    try {
      await pool.query(`
        INSERT INTO logs (user_id, activity, action_type, category, station, floor, slot, veg_type, description)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `, [logData.userId, logData.activity, logData.action_type, logData.category, logData.station, logData.floor, logData.slot, logData.veg_type, logData.description]);
      
      console.log("📘 Log saved:", logData.activity);
    } catch (err) {
      console.error("❌ Logging failed:", err.message);
      // ใส่กลับเข้า queue หากล้มเหลว
      if (logQueue.length < 100) { // จำกัดขนาด queue
        logQueue.unshift(logData);
      }
      break; // หยุดประมวลผลชั่วคราว
    }
    
    // หน่วงเวลาเล็กน้อยเพื่อลด load
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  
  isProcessingQueue = false;
}

async function logActivity({ userId, activity, action_type, category = null, station = null, floor = null, slot = null, veg_type = null, description = null }) {
  // เพิ่มเข้า queue แทนการรัน query ทันที
  const safeDescription = description || activity || 'ไม่ระบุ';
  logQueue.push({ userId, activity, action_type, category, station, floor, slot, veg_type, description: safeDescription });
  
  // เริ่มประมวลผล queue หากยังไม่ได้ทำ
  setImmediate(processLogQueue);
}

// ✅ LOGIN API (ไม่มี session tracking)
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  
  // Input validation
  if (!username || !password) {
    return res.status(400).json({ error: 'กรุณากรอกชื่อผู้ใช้และรหัสผ่าน' });
  }

  try {
    console.log(`🔍 Looking for user: "${username}"`);
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    const user = result.rows[0];

    if (!user) {
      console.log(`❌ User "${username}" not found`);
      return res.status(400).json({ error: 'ชื่อผู้ใช้ไม่ถูกต้อง' });
    }

    // ตรวจสอบรหัสผ่าน
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(400).json({ error: 'รหัสผ่านไม่ถูกต้อง' });
    }

    console.log("✅ Login success for:", user.username);

    // อัปเดต last_seen
    await pool.query('UPDATE users SET last_seen = NOW() WHERE id = $1', [user.id]);

    // บันทึก log
    await logActivity({
      userId: user.id,
      activity: 'เข้าสู่ระบบ',
      action_type: 'login',
      category: 'เข้าสู่ระบบ',
      description: `ผู้ใช้เข้าสู่ระบบ`
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

// ในไฟล์ index.js
app.post('/api/tray/inbound', async (req, res) => {
  // 1. ⭐️ [แก้ไข] รับ work_order_id และ planting_plan_id จาก body ที่ส่งมาจากหน้าเว็บ
  const {
    username, station, floor, slot, veg_type, quantity,
    batch_id, seeding_date, notes, tray_id: existing_tray_id,
    work_order_id, planting_plan_id 
  } = req.body;

  const created_at = new Date();

  try {
    // (ส่วนการตรวจสอบข้อมูล user, slot check เหมือนเดิม)
    const userRes = await pool.query(`SELECT id FROM users WHERE username = $1`, [username]);
    if (userRes.rows.length === 0) return res.status(404).json({ error: 'ไม่พบผู้ใช้งานนี้' });
    const userId = userRes.rows[0].id;

    const slotCheckRes = await pool.query(`SELECT status FROM tray_inventory WHERE floor = $1 AND slot = $2`, [floor, slot]);
    if (slotCheckRes.rows.length > 0 && (slotCheckRes.rows[0].status === 'on_shelf' || slotCheckRes.rows[0].status === 'IN_STORAGE')) {
        return res.status(409).json({ error: `ช่อง ${slot} บนชั้น ${floor} มีถาดวางอยู่แล้ว` });
    }
    
    // (ส่วนการสร้าง Tray ID, Log, History เหมือนเดิม)
    const isReturning = !!existing_tray_id;
    const tray_id = isReturning ? existing_tray_id : await generateNextTrayId();
    const description = `วางถาดใหม่ ${veg_type} (ID: ${tray_id}) ที่ชั้น ${floor}/${slot}`;
    await logActivity({ userId, activity: description, action_type: 'tray_inbound', category: 'วางถาด', station, floor, slot, veg_type, description: notes || description });
    await pool.query(`INSERT INTO tray_history (tray_id, action_type, floor, slot, veg_type, username, station_id, created_at) VALUES ($1, 'inbound', $2, $3, $4, $5, $6, $7)`, [tray_id, floor, slot, veg_type, username, station, created_at]);
    await pool.query(`INSERT INTO task_monitor (tray_id, action_type, floor, slot, station_id, status, username, created_at, veg_type, plant_quantity, batch_id, seeding_date, notes) VALUES ($1, 'inbound', $2, $3, $4, 'pending', $5, $6, $7, $8, $9, $10, $11)`, [tray_id, floor, slot, station, username, created_at, veg_type, parseInt(quantity), batch_id, seeding_date, notes]);
    
    // Trigger Flow การทำงานของ Automation
    const stationId = parseInt(station);
    const state = stationStates[stationId];
    if (state.flowState === 'idle') {
      state.targetFloor = parseInt(floor);
      state.targetSlot = parseInt(slot);
      state.taskType = 'inbound';
      state.trayId = tray_id;
      state.isReturning = isReturning;
      state.vegType = veg_type;
      state.username = username;
      state.plantQuantity = parseInt(quantity);
      state.batchId = batch_id;
      state.seedingDate = seeding_date;
      state.notes = notes;
      state.stationId = stationId;
      
      // 2. ⭐️ [แก้ไข] เพิ่มการส่ง work_order_id และ planting_plan_id เข้าไปใน state
      state.workOrderId = work_order_id; 
      state.plantingPlanId = planting_plan_id;
      
      state.flowState = 'inbound_start_lift_tray';
      console.log(`[Trigger] 🚀 เริ่ม flow INBOUND (Tray: ${state.trayId}, WO: ${state.workOrderId}) → ชั้น ${floor}, ช่อง ${slot}`);
      handleFlow(stationId);
      return res.json({ message: "รับคำสั่งเรียบร้อย เริ่มดำเนินการ" });
    } else {
      return res.status(409).json({ error: `ระบบกำลังทำงานอื่นอยู่ (${state.flowState})` });
    }
  } catch (err) {
    console.error('❌ Inbound Tray Error:', err.message, err.stack);
    return res.status(500).json({ error: 'Server error: Internal Server Error' });
  }
});
// ✅ Real-time Work Order update function for outbound actions
async function updateWorkOrdersOnOutbound(trayId, reason, actionType = 'outbound') {
  try {
    // หา planting plan ที่เกี่ยวข้องกับ tray นี้
    const planResult = await pool.query(`
      SELECT ti.planting_plan_id, pp.id, pp.plan_id, pp.vegetable_type
      FROM tray_inventory ti
      LEFT JOIN planting_plans pp ON ti.planting_plan_id = pp.id
      WHERE ti.tray_id = $1 AND pp.status != 'completed'
    `, [trayId]);
    
    if (planResult.rows.length === 0) {
      console.log(`⚠️ No active planting plan found for tray: ${trayId}`);
      return null;
    }
    
    const planData = planResult.rows[0];
    const plantingPlanId = planData.planting_plan_id;
    
    // ตรวจสอบว่ามี work order ที่เกี่ยวข้องหรือไม่
    let workOrderId = null;
    
    if (reason === 'เก็บเกี่ยวทั้งหมด' || reason === 'ตัดแต่ง / เก็บเกี่ยวบางส่วน') {
      // หา harvest work order ที่มีอยู่
      const harvestWO = await pool.query(`
        SELECT id, work_order_number, status 
        FROM work_orders 
        WHERE planting_plan_id = $1 AND task_type = 'harvest' 
        ORDER BY created_at DESC 
        LIMIT 1
      `, [plantingPlanId]);
      
      if (harvestWO.rows.length > 0) {
        workOrderId = harvestWO.rows[0].id;
        
        // อัปเดต status เป็น 'in_progress' หรือ 'completed'
        const newStatus = reason === 'เก็บเกี่ยวทั้งหมด' ? 'completed' : 'in_progress';
        await pool.query(`
          UPDATE work_orders 
          SET status = $1, updated_at = NOW() 
          WHERE id = $2
        `, [newStatus, workOrderId]);
        
        console.log(`✅ Updated harvest work order ${harvestWO.rows[0].work_order_number} to ${newStatus}`);
        
        // หากเป็นเก็บเกี่ยวทั้งหมด ให้อัปเดต planting plan เป็น completed
        if (reason === 'เก็บเกี่ยวทั้งหมด') {
          await pool.query(`
            UPDATE planting_plans 
            SET status = 'completed', actual_harvest_date = CURRENT_DATE, updated_at = NOW()
            WHERE id = $1
          `, [plantingPlanId]);
          
          console.log(`✅ Completed planting plan: ${planData.plan_id}`);
        }
      }
    } else if (reason === 'กำจัดทิ้ง') {
      // สำหรับการกำจัด ให้มาร์ค planting plan เป็น disposed
      await pool.query(`
        UPDATE planting_plans 
        SET status = 'disposed', actual_harvest_date = CURRENT_DATE, 
            harvest_notes = 'กำจัดทิ้ง', updated_at = NOW()
        WHERE id = $1
      `, [plantingPlanId]);
      
      // อัปเดต work orders ทั้งหมดที่เกี่ยวข้องให้เป็น cancelled
      await pool.query(`
        UPDATE work_orders 
        SET status = 'cancelled', updated_at = NOW()
        WHERE planting_plan_id = $1 AND status IN ('pending', 'in_progress')
      `, [plantingPlanId]);
      
      console.log(`✅ Disposed planting plan: ${planData.plan_id} and cancelled related work orders`);
    }
    
    return workOrderId;
    
  } catch (err) {
    console.error('❌ Error updating work orders on outbound:', err.message);
    return null;
  }
}

// [index.js] - แก้ไขฟังก์ชัน app.post('/api/tray/outbound', ...) ให้สมบูรณ์
// [index.js] - 🎯 [FINAL FIX] แก้ไขฟังก์ชัน app.post('/api/tray/outbound', ...) ที่ต้นตอ

app.post('/api/tray/outbound', async (req, res) => {
  const { username, station, floor, slot, reason, destination } = req.body;
  const created_at = new Date();

  try {
    const userRes = await pool.query(`SELECT id FROM users WHERE username = $1`, [username]);
    const userId = userRes.rows[0]?.id;
    if (!userId) {
      return res.status(404).json({ error: 'ไม่พบผู้ใช้งานนี้' });
    }

    const trayInfoRes = await pool.query(
      'SELECT * FROM tray_inventory WHERE floor = $1 AND slot = $2 AND station_id = $3', 
      [floor, slot, station]
    );

    if (trayInfoRes.rows.length === 0) {
      return res.status(404).json({ error: `ไม่พบถาดในตำแหน่งที่ระบุ (Station: ${station}, Floor: ${floor}, Slot: ${slot})` });
    }
    const trayData = trayInfoRes.rows[0];

    // ✅ Outbound operation - ไม่ต้องสร้าง work_order เพิ่ม เพราะเป็นการนำออกธรรมดา

    const description = `นำถาด ${trayData.veg_type} (ID: ${trayData.tray_id}) ออกจากชั้น ${floor}/${slot} (เหตุผล: ${reason})`;
    await logActivity({
        userId, activity: description, action_type: 'tray_outbound', category: 'นำถาดออก',
        station, floor, slot, veg_type: trayData.veg_type,
        description: `เหตุผล: ${reason}, ปลายทาง: ${destination || '-'}`
    });

    await pool.query(
      `INSERT INTO tray_history (tray_id, action_type, floor, slot, veg_type, username, station_id, created_at)
       VALUES ($1, 'outbound', $2, $3, $4, $5, $6, $7)`,
      [trayData.tray_id, floor, slot, trayData.veg_type, username, station, created_at]
    );
    
    // ✅ ส่วนนี้คือส่วนที่ถูกต้องและจำเป็นสำหรับการติดตามงาน
    await pool.query(
      `INSERT INTO task_monitor (
          tray_id, action_type, floor, slot, station_id, status, username, created_at,
          veg_type, plant_quantity, batch_id, seeding_date, notes, reason
       )
       VALUES ($1, 'outbound', $2, $3, $4, 'pending', $5, $6, $7, $8, $9, $10, $11, $12)`,
       [
           trayData.tray_id, floor, slot, station, username, created_at,
           trayData.veg_type || 'N/A',
           trayData.plant_quantity || 0,
           trayData.batch_id, 
           trayData.seeding_date, 
           trayData.notes,
           reason
       ]
    );
    
    // ✅ Real-time Work Order Update - อัปเดต work orders ทันทีเมื่อมี outbound action
    const updatedWorkOrderId = await updateWorkOrdersOnOutbound(trayData.tray_id, reason, 'outbound');
    if (updatedWorkOrderId) {
      console.log(`✅ Updated work order ID: ${updatedWorkOrderId} for tray: ${trayData.tray_id}`);
    }
    
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
    console.error('❌ Outbound Tray Error:', err.message, err.stack);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

app.post('/api/workstation/complete', async (req, res) => {
    const { tray_id, station_id } = req.body;
    try {
        // 1. อัปเดต task เดิมให้เป็น success (เหมือน dispose)
        const taskResult = await pool.query(
            `UPDATE task_monitor SET status = 'success', completed_at = NOW() 
             WHERE station_id = $1 AND status = 'at_workstation' 
             RETURNING tray_id, reason, action_type`,
            [station_id]
        );

        // 1.1. Real-time Work Order Update - อัปเดตเมื่อ workstation complete
        if (taskResult.rows.length > 0) {
            const completedTrayId = taskResult.rows[0].tray_id;
            const reason = taskResult.rows[0].reason;
            const actionType = taskResult.rows[0].action_type;
            
            // หากเป็น outbound task ให้อัปเดต work orders
            if (actionType === 'outbound' && reason) {
                const updatedWorkOrderId = await updateWorkOrdersOnOutbound(completedTrayId, reason, actionType);
                if (updatedWorkOrderId) {
                    console.log(`✅ [Workstation Complete] Updated work order ID: ${updatedWorkOrderId} for tray: ${completedTrayId}`);
                }
            }
            
            // หา work order และ planting plan ที่เกี่ยวข้องกับ tray นี้ (legacy logic)
            const woResult = await pool.query(`
                SELECT wo.planting_plan_id, wo.task_type 
                FROM work_orders wo 
                WHERE wo.tray_id = $1 AND wo.task_type = 'outbound' 
                ORDER BY wo.created_at DESC LIMIT 1
            `, [completedTrayId]);
            
            if (woResult.rows.length > 0 && woResult.rows[0].planting_plan_id) {
                const planId = woResult.rows[0].planting_plan_id;
                
                await pool.query(`
                    UPDATE planting_plans 
                    SET status = 'completed', completed_by = $2, completed_at = NOW(), updated_at = NOW() 
                    WHERE id = $1
                `, [planId, req.body.username || 'system']);
            }
        }

        // 2. รีเซ็ต Flow State กลับเป็น idle (เหมือน dispose)
        if (stationStates[station_id]) {
            stationStates[station_id].flowState = 'idle';
        }

        console.log(`✅ [Workstation] Completed task for tray ${tray_id} without deleting from inventory.`);
        res.json({ message: 'เคลียร์งานที่ Workstation สำเร็จ' });
    } catch (err) {
        console.error('❌ Complete Workstation Task Error:', err.message, err.stack);
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
    console.error("❌ เกิดข้อผิดพลาดในการสร้าง Tray ID:", err.message, err.stack);
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

    // ไม่เก็บ log สำหรับ STOP

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

// ✅ WATER CONTROL API ENDPOINTS
// Home Water System (Profile-based)
app.post('/api/mqtt-command', async (req, res) => {
  try {
    const { type, topic, payload } = req.body;
    
    // Validate request
    if (!type || !payload) {
      return res.status(400).json({ error: 'Missing required fields: type, payload' });
    }

    let mqttTopic, mqttMessage;

    if (type === 'home') {
      // Home system: {"Key":"1097BD225248","Profile":"1","Device":"Open"}
      mqttTopic = 'water/home';
      mqttMessage = JSON.stringify({
        Key: "142B2FC933E0", // <--- แก้ไขตรงนี้
        Profile: payload.Profile,
        Device: payload.Device
      });
    } else if (type === 'layer') {
      // Layer system: {"Key":"1097BD225248","Device":"1","Status":"Open"}
      mqttTopic = 'water/layer';
      mqttMessage = JSON.stringify({
       Key: "142B2FC933E0", // <--- แก้ไขตรงนี้
        Device: payload.Device,
        Status: payload.Status
      });
    } else if (type === 'valve') {
      // Valve system: {"Key":"1097BD225248","Device":"1","Status":"Open"}
      mqttTopic = 'water/valve';
      mqttMessage = JSON.stringify({
        Key: "1097BD225248",
        Device: payload.Device,
        Status: payload.Status
      });
    } else {
      return res.status(400).json({ error: 'Invalid type. Use "home", "layer", or "valve"' });
    }

    // Publish to MQTT
    console.log(`📡 Publishing to MQTT topic: ${mqttTopic}`);
    console.log(`📡 Message: ${mqttMessage}`);
    
    mqttClient.publish(mqttTopic, mqttMessage, { qos: 1 }, (err) => {
      if (err) {
        console.error('❌ MQTT Publish Error:', err);
        return res.status(500).json({ 
          success: false, 
          error: 'Failed to publish MQTT message',
          details: err.message 
        });
      }
      
      console.log('✅ MQTT message published successfully');
      res.json({ 
        success: true, 
        message: 'Water command sent successfully',
        topic: mqttTopic,
        payload: mqttMessage
      });
    });

  } catch (error) {
    console.error('❌ Water command API error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error',
      details: error.message 
    });
  }
});

// ✅✅✅ [ โค้ดที่ถูกต้อง 100% ] คัดลอกไปวางทับฟังก์ชันเดิมได้เลย ✅✅✅

mqttClient.on('message', async (topic, message) => { // 👈 เพิ่ม async ตรงนี้
  const messageStr = message.toString().trim();
  console.log(`📨 MQTT Message received on topic ${topic}:`, messageStr);

  try {
    let data;
    let jsonString = messageStr;

    if (messageStr.includes('=')) {
      jsonString = messageStr.substring(messageStr.indexOf('=') + 1).trim();
    }
    if ((jsonString.startsWith("'") && jsonString.endsWith("'")) || (jsonString.startsWith('"') && jsonString.endsWith('"'))) {
      jsonString = jsonString.substring(1, jsonString.length - 1);
    }

    try {
      data = JSON.parse(jsonString);
      console.log('✨ Parsed data successfully as JSON:', data);
    } catch (parseError) {
      console.warn('⚠️ Could not parse as JSON, using raw string.');
      data = { raw: messageStr }; // เก็บข้อความดิบไว้ถ้า parse ไม่ได้
    }

    // ✨✨✨ [ ส่วนที่เพิ่มเข้ามาใหม่ทั้งหมด ] ✨✨✨
    // ตรวจสอบว่านี่คือข้อความตอบกลับจาก ESP32 ที่ทำงานเสร็จแล้วหรือไม่
    if (data.Result === 'Success' && data.Device && data.Status) {
        
        const deviceId = parseInt(data.Device);
        const newStatus = data.Status.toLowerCase(); // 'open' or 'close'

        // คำนวณ floor และ valve จาก deviceId
        const floorId = Math.ceil(deviceId / 18);
        const valveId = deviceId - ((floorId - 1) * 18);

        try {
            // อัปเดตสถานะในฐานข้อมูล water_valves
            await pool.query(`
                UPDATE water_valves 
                SET status = $1, last_status_received = CURRENT_TIMESTAMP, last_updated = CURRENT_TIMESTAMP
                WHERE device_id = $2
            `, [newStatus, deviceId]);

            console.log(`✅ [Water] Device ${deviceId} → ${newStatus} (Floor: ${floorId}, Valve: ${valveId})`);

        } catch (dbError) {
            console.error(`❌ [Water] Device ${deviceId} update failed:`, dbError.message);
        }
    }
    // ✨✨✨ [ สิ้นสุดส่วนที่เพิ่มเข้ามาใหม่ ] ✨✨✨


    // ส่วนการส่งข้อมูลไปหน้าเว็บยังทำงานเหมือนเดิม
    const wsMessage = JSON.stringify({
      type: 'water_response',
      topic: topic,
      data: data,
      timestamp: new Date().toISOString()
    });

    clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(wsMessage);
      }
    });

  } catch (e) {
    console.error('❌ FATAL Error processing MQTT message. Raw string:', messageStr, 'Error:', e.message);
  }
});



// ✅ START SERVER with WebSocket
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, '0.0.0.0', async () => {
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

// ✅ Global error handlers for unhandled promises
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
});

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
    // ✅ JOIN กับ planting_plans และคำนวณอายุถาดในหน่วยชั่วโมงและวัน
    const result = await pool.query(`
      SELECT 
        ti.*,
        COALESCE(ti.harvest_date, pp.harvest_date) as harvest_date,
        pp.vegetable_type as variety,  -- แก้ไขจาก pp.variety
        pp.plan_id as batch_number,   -- ใช้ plan_id แทน batch_number
        COALESCE(ti.notes, pp.notes) as plan_notes,
        -- ✅ คำนวณอายุถาดเป็นชั่วโมง
        EXTRACT(EPOCH FROM (NOW() - ti.time_in)) / 3600 as age_hours,
        -- ✅ คำนวณอายุถาดเป็นวัน (ทศนิยม)
        EXTRACT(EPOCH FROM (NOW() - ti.time_in)) / 86400 as age_days,
        -- ✅ คำนวณอายุถาดเป็นวันเต็ม (จำนวนเต็ม)
        FLOOR(EXTRACT(EPOCH FROM (NOW() - ti.time_in)) / 86400) as age
      FROM tray_inventory ti
      LEFT JOIN planting_plans pp ON ti.planting_plan_id = pp.id
      WHERE ti.station_id = $1 
      ORDER BY ti.floor, ti.slot
    `, [stationId]);
    
    res.json(result.rows);
  } catch (err) {
    console.error(`Error fetching tray inventory for station ${stationId}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});
// ในไฟล์ index.js (เพิ่ม API นี้เข้าไป)

// ✅ [เพิ่มใหม่] API สำหรับดึงถาดที่กำลังปลูก (แก้ปัญหาข้อมูลซ้ำซ้อน)
app.get('/api/tray-inventory/planting-progress', async (req, res) => {
  try {
    // ✨✨✨ [จุดสำคัญ] ✨✨✨
    // แก้ไข SQL Query ให้ JOIN จาก tray_inventory ไปยัง planting_plans โดยตรง
    // เพื่อป้องกันการแสดงผลซ้ำซ้อนจาก work_orders หลายใบ
    const result = await pool.query(`
      SELECT 
        ti.*, -- เลือกข้อมูลทั้งหมดจาก tray_inventory
        pp.plan_id,
        pp.vegetable_type as plan_vegetable_type,
        pp.plant_date,
        pp.priority,
        pp.notes as plan_notes,
        pp.status as plan_status
      FROM 
        tray_inventory ti
      LEFT JOIN 
        planting_plans pp ON ti.planting_plan_id = pp.id
      WHERE 
        ti.status = 'on_shelf' 
      ORDER BY 
        ti.harvest_date ASC, ti.time_in DESC
    `);
    
    console.log(`📊 พบถาดที่กำลังปลูก (In-Progress): ${result.rows.length} รายการ`);
    res.json(result.rows);
    
  } catch (err) {
    console.error('Error fetching planting progress trays:', err.message);
    res.status(500).json({ error: 'Server error while fetching planting progress' });
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

// ✅ API สำหรับส่งออกประวัติ Tray Master
app.get('/api/tray-history', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        ti.tray_id,
        ti.veg_type,
        ti.plant_quantity,
        ti.batch_id,
        ti.seeding_date,
        ti.status,
        ti.floor,
        ti.slot,
        ti.time_in,
        ti.time_out,
        ti.updated_at,
        ti.notes,
        ti.harvest_date,
        pp.plan_id,
        pp.vegetable_type as plan_vegetable_type,
        pp.plant_date,
        pp.priority,
        pp.notes as plan_notes,
        pp.status as plan_status
      FROM tray_inventory ti
      LEFT JOIN planting_plans pp ON ti.planting_plan_id = pp.id
      ORDER BY ti.updated_at DESC, ti.time_in DESC
    `);
    
    console.log(`📄 ส่งออกประวัติ Tray Master: ${result.rows.length} รายการ`);
    res.json(result.rows);
    
  } catch (err) {
    console.error('❌ Error fetching tray history:', err.message);
    res.status(500).json({ error: 'ไม่สามารถดึงข้อมูลประวัติได้', details: err.message });
  }
});

// ✅ API สำหรับดึงข้อมูล Task History
app.get('/api/tasks/history', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        id,
        task_id,
        task_description as description,
        tray_id,
        assigned_user,
        status,
        priority,
        created_at,
        updated_at,
        completed_at,
        notes
      FROM task_monitor
      ORDER BY created_at DESC
    `);
    
    console.log(`📄 ดึงข้อมูล Task History: ${result.rows.length} รายการ`);
    res.json(result.rows);
    
  } catch (err) {
    console.error('❌ Error fetching task history:', err.message);
    res.status(500).json({ error: 'ไม่สามารถดึงข้อมูล Task History ได้', details: err.message });
  }
});

// ✅ API สำหรับดึงข้อมูล User Activity Logs
app.get('/api/user-logs', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        id,
        username,
        user_id,
        action_type,
        description,
        ip_address,
        timestamp,
        session_id,
        additional_data
      FROM user_activity_logs
      ORDER BY timestamp DESC
      LIMIT 1000
    `);
    
    console.log(`📄 ดึงข้อมูล User Logs: ${result.rows.length} รายการ`);
    res.json(result.rows);
    
  } catch (err) {
    console.error('❌ Error fetching user logs:', err.message);
    // ถ้าตาราง user_activity_logs ไม่มี ให้ส่ง array ว่าง
    res.json([]);
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

    // Debug ข้อมูลที่ได้จาก API
    console.log("🔍 โหลดข้อมูลถาด:", data.length, "รายการ");

    // เพิ่มการตรวจสอบว่า DOM พร้อมหรือไม่
    const grid = document.querySelector(".tray-grid");
    if (grid) {
      renderTrayGrid(); // เรียกเมื่อ DOM พร้อม
      console.log("✅ โหลดข้อมูลถาดสำเร็จ", data.length, "รายการ");
    } else {
      console.log("⚠️ DOM ยังไม่พร้อม - จะโหลดใหม่เมื่อเปลี่ยนหน้า");
    }
  } catch (err) {
    console.error("❌ โหลด tray inventory ล้มเหลว", err);
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
// ✅ [แก้ไข] API สำหรับ Summary Cards ในหน้า Overview
app.get('/api/overview/summary-cards', async (req, res) => {
  try {
    const stationId = req.query.station || '1';

    // 1. Inbound/Outbound วันนี้ (ส่วนนี้ถูกต้องแล้ว)
    const todayStatsRes = await pool.query(
      `SELECT
         SUM(CASE WHEN action_type = 'inbound' THEN 1 ELSE 0 END) as today_inbound,
         SUM(CASE WHEN action_type = 'outbound' THEN 1 ELSE 0 END) as today_outbound
       FROM tray_history
       WHERE station_id = $1 AND created_at >= CURRENT_DATE`,
      [stationId]
    );

    // 2. ✅✅✅ [ส่วนที่แก้ไข] จำนวนถาดในคลังทั้งหมดจากตาราง tray_inventory ✅✅✅
    const totalTraysRes = await pool.query(
      `SELECT COUNT(*) FROM tray_inventory WHERE station_id = $1 AND status = 'on_shelf'`,
      [stationId]
    );
    
    // 3. % งานที่ตรงเวลา (ตัวอย่าง)
    const onTimePercentage = 100;

    res.json({
      today_inbound: parseInt(todayStatsRes.rows[0].today_inbound) || 0,
      today_outbound: parseInt(todayStatsRes.rows[0].today_outbound) || 0,
      total_trays: parseInt(totalTraysRes.rows[0].count) || 0, // <--- ใช้ผลลัพธ์จาก Query ที่ถูกต้อง
      ontime_percentage: onTimePercentage 
    });

  } catch (err) {
    console.error("❌ Error fetching summary cards data:", err.message);
    res.status(500).json({ error: 'Server error' });
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

// [index.js] - ค้นหาฟังก์ชัน initializeTables แล้วนำโค้ดนี้ไปวางทับของเดิมทั้งหมด

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
        created_by VARCHAR(100),
        completed_by VARCHAR(100),
        completed_at TIMESTAMP,
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
    // ✅ รับข้อมูลครบถ้วนจากภายนอก
    const { 
      vegetable_name, 
      level, 
      planting_date, 
      harvest_date, 
      plant_count, 
      variety, 
      batch_number, 
      source_system, 
      external_plan_id,
      // ✅ เพิ่มข้อมูลที่อาจขาดหาย
      priority = 'normal',
      notes = '',
      created_by = 'external_system'
    } = req.body;
    
    // ✅ Validate ข้อมูลที่จำเป็น
    if (!vegetable_name || !level || !planting_date || !harvest_date || !plant_count) {
      return res.status(400).json({ 
        error: 'Missing required fields: vegetable_name, level, planting_date, harvest_date, plant_count' 
      });
    }

    // ✅ บันทึกข้อมูลแผนการปลูกพร้อมข้อมูลเพิ่มเติม
    const planResult = await pool.query(`
      INSERT INTO planting_plans (
        external_plan_id, vegetable_type, level_required, plant_date, harvest_date, 
        plant_count, variety, batch_number, source_system, status, notes, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'received', $10, $11)
      RETURNING *
    `, [external_plan_id, vegetable_name, level, planting_date, harvest_date, plant_count, variety || '', batch_number || '', source_system || 'external', notes, created_by]);

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

// ✅✅✅ [FINAL & TESTED VERSION] API ดึงรายการแผนการปลูก ✅✅✅
app.get('/api/planting-plans', async (req, res) => {
  try {
    const { status, vegetable_type, limit = 50 } = req.query;
    
    let baseQuery = `
      SELECT 
        id, plan_id, vegetable_type, plant_date, harvest_date, actual_harvest_date,
        plant_count, level_required, priority, status, notes, harvest_notes,
        created_by, completed_by, completed_at,
        created_at, updated_at, batch_number, variety
      FROM planting_plans
    `;
    
    const params = [];
    let finalQuery = '';

    // ⭐️ [จุดแก้ไขสำคัญ] แยกตรรกะการกรองให้ชัดเจนและตรงไปตรงมา
    let whereConditions = [];
    
    if (status && status.trim() !== '') {
      whereConditions.push(`status = $${params.length + 1}`);
      params.push(status.trim());
    }
    
    if (vegetable_type && vegetable_type.trim() !== '') {
      whereConditions.push(`vegetable_type = $${params.length + 1}`);
      params.push(vegetable_type.trim());
    }
    
    if (whereConditions.length > 0) {
      finalQuery = `${baseQuery} WHERE ${whereConditions.join(' AND ')} ORDER BY created_at DESC LIMIT $${params.length + 1}`;
    } else {
      finalQuery = `${baseQuery} ORDER BY created_at DESC LIMIT $${params.length + 1}`;
    }
    params.push(parseInt(limit));
    
    const result = await pool.query(finalQuery, params);
    
    res.json({
      success: true,
      planting_plans: result.rows,
      count: result.rows.length
    });

  } catch (err) {
    console.error('❌ Error in /api/planting-plans:', err.message);
    res.status(500).json({ 
      success: false, 
      error: 'Server error while fetching planting plans.'
    });
  }
});

app.post('/api/sync-civic-data', async (req, res) => {
  try {
    const { plans } = req.body;
    
    if (!plans || !Array.isArray(plans)) {
      return res.status(400).json({ 
        error: 'ข้อมูล plans ไม่ถูกต้อง ต้องเป็น array'
      });
    }

    let processedPlans = [];
    let errors = [];

    for (const planData of plans) {
      try {
        // ✅ [แก้ไข] เปลี่ยน vegetable_type เป็น vegetable_name ให้ตรงกับ Schema
        const { 
          vegetable_name,      
          planting_date,          
          harvest_date, 
          plant_count,         
          external_plan_id,
          level
        } = planData;

        // ตรวจสอบข้อมูลที่จำเป็น
        if (!vegetable_name || !planting_date || !harvest_date || !plant_count) {
          errors.push({
            external_plan_id,
            error: 'ข้อมูลไม่ครบ: vegetable_name, planting_date, harvest_date, plant_count'
          });
          continue;
        }

        // ✅ [แก้ไข] บันทึกแผนการปลูกด้วยชื่อ column ที่ถูกต้อง
        const planResult = await pool.query(`
          INSERT INTO planting_plans (
            external_plan_id, vegetable_name, planting_date, harvest_date,
            plant_count, level, status, notes
          ) VALUES ($1, $2, $3, $4, $5, $6, 'received', 'Synced from Civic Platform')
          RETURNING *
        `, [
          external_plan_id, 
          vegetable_name, 
          planting_date, 
          harvest_date, 
          plant_count,
          level || 1
        ]);

        const plan = planResult.rows[0];
        
        // ... (ส่วนการสร้าง work order เหมือนเดิม ไม่ต้องแก้ไข) ...
        const workOrderNumber = `WO-CIVIC-${Date.now()}-${plan.id}`;
        await pool.query(`
          INSERT INTO work_orders (
            planting_plan_id, work_order_number, task_type, vegetable_name,
            plant_count, level, target_date, priority, status
          ) VALUES ($1, $2, 'planting', $3, $4, $5, $6, 'high', 'pending')
        `, [
          plan.id, `${workOrderNumber}-PLANT`, vegetable_name, plant_count, level || 1, planting_date
        ]);
        await pool.query(`
          INSERT INTO work_orders (
            planting_plan_id, work_order_number, task_type, vegetable_name,
            plant_count, level, target_date, priority, status
          ) VALUES ($1, $2, 'harvest', $3, $4, $5, $6, 'normal', 'pending')
        `, [
          plan.id, `${workOrderNumber}-HARVEST`, vegetable_name, plant_count, level || 1, harvest_date
        ]);

        processedPlans.push(plan);
        
      } catch (planError) {
        console.error('❌ Error processing plan:', planError.message);
        errors.push({
          civic_plan_id: planData.external_plan_id,
          error: planError.message
        });
      }
    }

    console.log(`✅ ประมวลผล ${processedPlans.length} แผนจาก Civic Platform สำเร็จ`);
    
    res.json({
      success: true,
      message: `ประมวลผลแผนการปลูก ${processedPlans.length} รายการสำเร็จ`,
      processed_plans: processedPlans,
      errors: errors,
      summary: {
        total_received: plans.length,
        successfully_processed: processedPlans.length,
        errors: errors.length
      }
    });

  } catch (err) {
    console.error('❌ Error syncing civic data:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ฟังก์ชันช่วยหาชั้นที่ว่าง
async function findAvailableLevel(targetDate) {
  try {
    // หาชั้นที่มีแผนการปลูกน้อยที่สุดในช่วงเวลาใกล้เคียง
    const result = await pool.query(`
      SELECT level, COUNT(*) as plan_count
      FROM planting_plans 
      WHERE planting_date::date BETWEEN $1::date - INTERVAL '7 days' AND $1::date + INTERVAL '7 days'
      GROUP BY level
      ORDER BY plan_count ASC, level ASC
      LIMIT 1
    `, [targetDate]);
    
    if (result.rows.length > 0) {
      return result.rows[0].level;
    }
    
    // หากไม่มีข้อมูล ให้เริ่มจากชั้น 1
    return 1;
    
  } catch (err) {
    console.error('❌ Error finding available level:', err.message);
    return 1; // default to level 1
  }
}

// Removed unused data-consistency-check API

const stationStates = {
  1: {
    flowState: 'idle',
    latestLiftStatus: {},
    latestAgvStatus: {},
    latestAgvSensorStatus: {},
    latestAirQualityData: {},
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
  mqttClient.subscribe("automation/station1/air/quality");
  mqttClient.subscribe('Layer_2/#', (err) => {
    if (!err) {
      console.log("✅ MQTT Subscribed successfully to all water topics (water/#)");
    } else {
      console.error("❌ Failed to subscribe to water topics:", err);
    }
  });
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
        
        // Set debounce timer (50ms) - เร็วกว่าเดิม
        state.sensorDebounceTimer = setTimeout(() => {
          // เก็บสถานะล่าสุดไว้ใน state object
          state.latestAgvSensorStatus = payload;
          
          // ✅ ส่งข้อมูล sensor เฉพาะตอนที่เปลี่ยนแปลงผ่าน WebSocket
          broadcastToClients('sensor_update', payload);
          console.log('📡 Sensor data changed (fast), broadcasted to', clients.size, 'clients');
          
          // Clear timer reference
          state.sensorDebounceTimer = null;
        }, 50); // 50ms debounce delay - เร็วขึ้น 6 เท่า
      }
    } catch (err) {
      console.error('❌ Failed to parse AGV sensor MQTT payload:', err.message);
    }
  }
  
  // ✅ [เพิ่มใหม่] Logic สำหรับรับข้อมูลเซ็นเซอร์อากาศ (CO2, Temperature, Humidity)
  if (topic === 'automation/station1/air/quality' || msg.includes('CO2:') || msg.includes('Temp:') || msg.includes('Humidity:')) {
    try {
      let airData = {};
      
      // ถ้าเป็น JSON format
      if (msg.startsWith('{')) {
        airData = JSON.parse(msg);
      } 
      // ถ้าเป็น text format จาก log
      else if (msg.includes('CO2:') && msg.includes('Temp:') && msg.includes('Humidity:')) {
        const co2Match = msg.match(/CO2:\s*(\d+)\s*ppm/);
        const tempMatch = msg.match(/Temp:\s*([\d.]+)°C/);
        const humidityMatch = msg.match(/Humidity:\s*([\d.]+)%/);
        
        if (co2Match && tempMatch && humidityMatch) {
          airData = {
            co2: parseInt(co2Match[1]),
            temperature: parseFloat(tempMatch[1]),
            humidity: parseFloat(humidityMatch[1]),
            last_updated: new Date().toISOString()
          };
        }
      }
      
      if (airData.co2 || airData.temperature || airData.humidity) {
        // เก็บข้อมูลล่าสุดไว้ใน state
        state.latestAirQualityData = {
          ...state.latestAirQualityData,
          ...airData,
          last_updated: new Date().toISOString()
        };
        
        // ✅ บันทึกข้อมูลลงฐานข้อมูล
        try {
          await pool.query(`
            INSERT INTO air_quality_logs (station_id, co2_ppm, temperature_celsius, humidity_percent)
            VALUES ($1, $2, $3, $4)
          `, [
            stationId,
            airData.co2 || null,
            airData.temperature || null,
            airData.humidity || null
          ]);
          console.log('💾 Air quality data saved to database');
        } catch (dbError) {
          console.error('❌ Failed to save air quality data to database:', dbError.message);
        }
        
        // ส่งข้อมูลผ่าน WebSocket
        broadcastToClients('air_quality_update', state.latestAirQualityData);
        console.log('🌡️ Air quality data updated:', state.latestAirQualityData);
      }
    } catch (err) {
      console.error('❌ Failed to parse air quality data:', err.message);
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
    res.status(500).json({ error: 'Server error' });
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

// ✅ [แก้ไข] API สำหรับดึงประวัติของถาด (ใช้ task_monitor เป็นหลัก)
app.get('/api/tray/history/:tray_id', async (req, res) => {
  const { tray_id } = req.params;
  try {
    const result = await pool.query(
      `SELECT 
         tm.*, 
         to_char(tm.created_at, 'DD/MM/YYYY HH24:MI:SS') as "timestamp_th"
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

// 🔋 API สำหรับดึงข้อมูลแบตเตอรี่ RGV
app.get('/api/rgv/battery', (req, res) => {
  // ❗ ตัวอย่างข้อมูล - ในการใช้งานจริงควรดึงจากระบบ RGV หรือ Database
  
  // สุ่มค่าแบตเตอรี่เพื่อจำลองการทำงาน (ในการใช้งานจริงให้ดึงจากระบบ RGV)
  const batteryPercentage = Math.floor(Math.random() * (95 - 15) + 15); // 15-95%
  
  // คำนวณเวลาการใช้งานที่เหลือ (ประมาณการ)
  // สมมติว่า RGV ใช้แบตเตอรี่เฉลี่ย 12% ต่อชั่วโมง
  const averageUsagePerHour = 12;
  const estimatedHoursRemaining = Math.round((batteryPercentage / averageUsagePerHour) * 10) / 10;
  
  // กำหนดสถานะแบตเตอรี่
  let batteryStatus, batteryLevel;
  if (batteryPercentage >= 70) {
    batteryStatus = 'ดีมาก';
    batteryLevel = 'high';
  } else if (batteryPercentage >= 50) {
    batteryStatus = 'ดี';
    batteryLevel = 'high';
  } else if (batteryPercentage >= 30) {
    batteryStatus = 'ปานกลาง';
    batteryLevel = 'medium';
  } else if (batteryPercentage >= 15) {
    batteryStatus = 'ต่ำ';
    batteryLevel = 'low';
  } else {
    batteryStatus = 'วิกฤต';
    batteryLevel = 'critical';
  }
  
  // ข้อมูลเพิ่มเติม
  const lastChargedTime = new Date(Date.now() - Math.random() * 8 * 60 * 60 * 1000); // สุ่มเวลาชาร์จล่าสุดภายใน 8 ชม.
  const chargingCycles = Math.floor(Math.random() * 50) + 150; // จำนวนครั้งที่ชาร์จ
  
  const batteryData = {
    success: true,
    timestamp: new Date().toISOString(),
    battery: {
      percentage: batteryPercentage,
      level: batteryLevel,
      status: batteryStatus,
      estimatedHoursRemaining: estimatedHoursRemaining,
      lastChargedAt: lastChargedTime.toISOString(),
      chargingCycles: chargingCycles,
      voltage: (12.8 + (batteryPercentage / 100) * 2.4).toFixed(1), // สมมติ 12.8V - 15.2V
      temperature: (25 + Math.random() * 10).toFixed(1), // อุณหภูมิ 25-35°C
      health: batteryPercentage > 80 ? 'excellent' : batteryPercentage > 60 ? 'good' : batteryPercentage > 30 ? 'fair' : 'poor'
    }
  };
  
  res.json(batteryData);
});

// 📸 API สำหรับ Image Processing - การสแกนผัก
// API สำหรับดึงภาพจากกล้อง 4 ตัว
app.get('/api/image-processing/cameras/:cameraId/stream', (req, res) => {
  const cameraId = req.params.cameraId;
  
  // ❗ ตัวอย่างข้อมูล - ในการใช้งานจริงควรเชื่อมต่อกับกล้องจริง
  const cameraData = {
    success: true,
    camera: {
      id: cameraId,
      name: getCameraName(cameraId),
      status: 'active',
      // ในการใช้งานจริง ส่ง stream URL หรือ base64 image
      streamUrl: `/api/camera/stream/CAM00${cameraId}`,
      resolution: '1920x1080',
      fps: 30,
      lastUpdate: new Date().toISOString()
    }
  };
  
  res.json(cameraData);
});

// API สำหรับการประมวลผลรูปภาพและตรวจจับผัก
app.post('/api/image-processing/scan', async (req, res) => {
  const { cameraId, imageData } = req.body;
  
  // ❗ ตัวอย่างการจำลอง AI Processing
  // ในการใช้งานจริงจะต้องเชื่อมต่อกับ AI Model สำหรับตรวจจับผัก
  
  const startTime = Date.now();
  
  // จำลองเวลาในการประมวลผล (100-500ms)
  await new Promise(resolve => setTimeout(resolve, Math.random() * 400 + 100));
  
  const processingTime = Date.now() - startTime;
  
  // ตัวอย่างผลการตรวจจับผัก (จำลอง)
  const mockVegetables = [
    { name: 'ผักกาดขาว', confidence: 0.95, position: { x: 120, y: 80, width: 60, height: 40 } },
    { name: 'ผักบุ้งจีน', confidence: 0.87, position: { x: 200, y: 150, width: 80, height: 50 } },
    { name: 'คะน้า', confidence: 0.92, position: { x: 50, y: 200, width: 70, height: 45 } }
  ];
  
  // สุ่มจำนวนผักที่ตรวจพบ (0-3 ชนิด)
  const detectedCount = Math.floor(Math.random() * 4);
  const detectedVegetables = mockVegetables.slice(0, detectedCount);
  
  const scanResult = {
    success: true,
    timestamp: new Date().toISOString(),
    camera: {
      id: cameraId,
      name: getCameraName(cameraId)
    },
    processing: {
      time: processingTime,
      algorithm: 'CNN-ResNet50',
      modelVersion: 'v2.1.0'
    },
    results: {
      totalDetected: detectedVegetables.length,
      vegetables: detectedVegetables,
      averageConfidence: detectedVegetables.length > 0 
        ? Math.round(detectedVegetables.reduce((sum, veg) => sum + veg.confidence, 0) / detectedVegetables.length * 100) / 100
        : 0
    }
  };
  
  res.json(scanResult);
});

// API สำหรับดึงสถิติการประมวลผล
app.get('/api/image-processing/stats', (req, res) => {
  // ❗ ตัวอย่างข้อมูลสถิติ - ในการใช้งานจริงควรเก็บไว้ใน Database
  const stats = {
    success: true,
    timestamp: new Date().toISOString(),
    daily: {
      totalScanned: Math.floor(Math.random() * 500) + 100,
      accuracyRate: 92.5 + Math.random() * 5, // 92.5-97.5%
      averageProcessingTime: Math.floor(Math.random() * 100) + 150, // 150-250ms
      activeCameras: 4
    },
    cameras: [
      { id: 1, name: 'กล้องบน', processed: Math.floor(Math.random() * 150) + 50, accuracy: 95.2 },
      { id: 2, name: 'กล้องล่าง', processed: Math.floor(Math.random() * 150) + 50, accuracy: 93.8 },
      { id: 3, name: 'กล้องซ้าย', processed: Math.floor(Math.random() * 150) + 50, accuracy: 94.1 },
      { id: 4, name: 'กล้องขวา', processed: Math.floor(Math.random() * 150) + 50, accuracy: 91.7 }
    ],
    vegetableTypes: [
      { name: 'ผักกาดขาว', count: Math.floor(Math.random() * 50) + 20 },
      { name: 'ผักบุ้งจีน', count: Math.floor(Math.random() * 40) + 15 },
      { name: 'คะน้า', count: Math.floor(Math.random() * 35) + 10 },
      { name: 'ผักชี', count: Math.floor(Math.random() * 30) + 8 },
      { name: 'กะหล่ำปลี', count: Math.floor(Math.random() * 25) + 5 }
    ]
  };
  
  res.json(stats);
});

// API สำหรับการควบคุมระบบ Image Processing
app.post('/api/image-processing/control', (req, res) => {
  const { action, cameraId } = req.body;
  
  let message = '';
  let success = true;
  
  switch (action) {
    case 'start':
      message = cameraId ? `เริ่มการประมวลผลกล้อง ${getCameraName(cameraId)}` : 'เริ่มการประมวลผลทุกกล้อง';
      break;
    case 'stop':
      message = cameraId ? `หยุดการประมวลผลกล้อง ${getCameraName(cameraId)}` : 'หยุดการประมวลผลทุกกล้อง';
      break;
    case 'capture':
      message = cameraId ? `ถ่ายภาพจากกล้อง ${getCameraName(cameraId)}` : 'ถ่ายภาพจากทุกกล้อง';
      break;
    default:
      message = 'คำสั่งไม่ถูกต้อง';
      success = false;
  }
  
  res.json({
    success,
    message,
    timestamp: new Date().toISOString(),
    action,
    cameraId: cameraId || 'all'
  });
});

// ฟังก์ชันช่วยสำหรับแปลง ID เป็นชื่อกล้อง
function getCameraName(cameraId) {
  const cameraNames = {
    '1': 'กล้องบน (Top Camera)',
    '2': 'กล้องล่าง (Bottom Camera)', 
    '3': 'กล้องซ้าย (Left Camera)',
    '4': 'กล้องขวา (Right Camera)'
  };
  return cameraNames[cameraId] || `กล้อง ${cameraId}`;
}

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
        console.error(`❌ [updateTaskStatus] Failed to update task_monitor to ${newStatus} for station ${stationId}:`);
        console.error(`   - Error Message: ${err.message}`);
        console.error(`   - Error Code: ${err.code}`);
        console.error(`   - Error Detail: ${err.detail || 'N/A'}`);
        console.error(`   - SQL State: ${err.sqlState || 'N/A'}`);
        console.error(`   - Full Error:`, err);
    }
}


function logState(stationId, msg) {
  console.log(`\x1b[36m[Flow] Station ${stationId} → ${msg}\x1b[0m`);
}


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

// ฟังก์ชัน handleFlow
case 'wait_tray_action_done':
  if (state.trayActionDone) {
    logState(stationId, 'ทำงานกับถาดเสร็จ → กำลังอัปเดตฐานข้อมูล...');

    try {
      if (state.taskType === 'inbound') {
        
        // ✅ [โค้ดแก้ไขที่สำคัญ]
        // ดึง harvest_date จาก planting_plans มาเก็บไว้ใน tray_inventory
        let harvestDate = null;
        if (state.plantingPlanId) {
            const planResult = await pool.query(
                `SELECT harvest_date FROM planting_plans WHERE id = $1`,
                [state.plantingPlanId]
            );
            if (planResult.rows.length > 0) {
                harvestDate = planResult.rows[0].harvest_date;
            }
        }
        
        // บันทึกถาดใหม่ลง inventory พร้อมข้อมูลจาก Plan
        await pool.query(
          `INSERT INTO tray_inventory (tray_id, veg_type, floor, slot, username, time_in, plant_quantity, batch_id, seeding_date, notes, status, station_id, planting_plan_id, harvest_date) 
           VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7, $8, $9, 'on_shelf', $10, $11, $12)`,
          [
            state.trayId, state.vegType, state.targetFloor, state.targetSlot,
            state.username, state.plantQuantity, state.batchId,
            state.seedingDate, state.notes, state.stationId,
            state.plantingPlanId, // 👈 บันทึก ID ของ Plan
            harvestDate           // 👈 บันทึกวันเก็บเกี่ยว
          ]
        );
        console.log(`✅ [DB] Inbound: Added new tray ${state.trayId} to inventory.`);
        
        // อัปเดต work_order ให้ผูกกับ tray_id ที่สร้างขึ้นใหม่
        if (state.workOrderId) {
          await pool.query(
            `UPDATE work_orders SET tray_id = $1 WHERE id = $2`,
            [state.trayId, state.workOrderId]
          );
          console.log(`✅ [DB] Linked tray_id ${state.trayId} to work_order_id ${state.workOrderId}.`);
        }

      } else if (state.taskType === 'outbound') {
        await pool.query(
            `UPDATE tray_inventory SET status = 'AT_WORKSTATION' WHERE tray_id = $1`,
            [state.trayId]
        );
        console.log(`[Status Update] Tray ${state.trayId} status changed to AT_WORKSTATION.`);
      }
      
    } catch (dbError) {
      console.error("❌ [DB IMMEDIATE] Error during DB operation:", dbError.message, dbError.stack);
      state.flowState = 'idle';
      await updateTaskStatus('error', stationId);
      return;
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

    logState(stationId, '[WORKSTATION] เปลี่ยนสถานะเป็น "รอที่ Workstation"');
    await updateTaskStatus('at_workstation', stationId); // อัปเดต Task ใน DB

    // รีเซ็ต Flow State กลับเป็น idle ทันทีเพื่อให้ระบบพร้อมรับงานใหม่
    logState(stationId, 'Flow การนำออกเสร็จสมบูรณ์ → รีเซ็ตสถานะเป็น Idle');
    state.flowState = 'idle';
    state.taskType = null;
    state.targetFloor = null;
    state.targetSlot = null;
    state.trayId = null;
    // ไม่ต้องเรียก handleFlow(stationId) ต่อ เพราะเราต้องการให้ระบบหยุดรอคำสั่งใหม่
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




//  API สำหรับเช็คว่ามีถาดรออยู่ที่ Workstation หรือไม่
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
// ในไฟล์ index.js
app.post('/api/workstation/dispose', async (req, res) => {
    const { tray_id, station_id } = req.body;
    try {
        // ✨✨✨ [แก้ไขลำดับการทำงานใหม่ทั้งหมด] ✨✨✨
        // 1. ค้นหา Planting Plan ID จากถาด ก่อนที่จะลบข้อมูลใดๆ ทั้งสิ้น
        const trayDataResult = await pool.query(
            `SELECT planting_plan_id FROM tray_inventory WHERE tray_id = $1`,
            [tray_id]
        );

        // 2. เก็บค่า planId ไว้ในตัวแปร (ถ้ามี)
        const planId = (trayDataResult.rows.length > 0) ? trayDataResult.rows[0].planting_plan_id : null;
        if (planId) {
            console.log(`[Dispose Flow] Found Planting Plan ID: ${planId} for Tray ID: ${tray_id}.`);
        } else {
            console.warn(`[Dispose Flow] ⚠️ Could not find a matching Planting Plan ID for Tray ID: ${tray_id} before deletion.`);
        }

        // 3. ลบถาดออกจาก inventory
        await pool.query(
            `DELETE FROM tray_inventory WHERE tray_id = $1`,
            [tray_id]
        );
        console.log(`🗑️ [Workstation] Deleted tray ${tray_id} from inventory.`);

        // 4. อัปเดต task เดิมให้เป็น success
        const taskUpdateResult = await pool.query(
            `UPDATE task_monitor SET status = 'success', completed_at = NOW() 
             WHERE station_id = $1 AND status = 'at_workstation' AND tray_id = $2 
             RETURNING *`,
            [station_id, tray_id]
        );

        // 5. หลังจากทุกอย่างสำเร็จแล้ว จึงค่อยอัปเดตสถานะของ Plan
        if (taskUpdateResult.rowCount > 0 && planId) {
            await pool.query(
                `UPDATE planting_plans 
                 SET status = 'completed', completed_by = $2, completed_at = NOW(), updated_at = NOW() 
                 WHERE id = $1`,
                [planId, req.body.username || 'system']
            );
            console.log(`✅ [DB] Updated Planting Plan ID: ${planId} to 'completed' status.`);
        }

        // 6. รีเซ็ต Flow State กลับเป็น idle
        if (stationStates[station_id]) {
            stationStates[station_id].flowState = 'idle';
        }

        res.json({ message: 'กำจัดถาดและอัปเดตสถานะเรียบร้อย' });

    } catch (err) {
        console.error('❌ Dispose Tray Error:', err.message, err.stack);
        res.status(500).json({ error: 'Server error during dispose: ' + err.message });
    }
});















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
    socket.write(`Connection: keep-alive\r\n`);  // ✅ เปลี่ยนเป็น keep-alive สำหรับ real-time streaming
    socket.write(`Cache-Control: no-cache\r\n`);
    socket.write(`\r\n`);
  });

  // ✅ ปรับแต่ง socket สำหรับ real-time performance
  socket.setTimeout(0); // ไม่มี timeout
  socket.setNoDelay(true); // ส่งข้อมูลทันทีไม่รอ buffer

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

        res.writeHead(200, { 
          'Content-Type': contentType,
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0',
          'X-Accel-Buffering': 'no' // ปิด buffering สำหรับ nginx
        });
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
            updates.push(`password = $${paramIndex++}`);
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



app.post('/api/planting/receive', async (req, res) => {
  const {
    external_plan_id,  // ✅ รับจากเว็บอื่น
    vegetable_type,    // ✅ แก้ไขจาก vegetable_name
    plant_date,        // ✅ แก้ไขจาก planting_date
    harvest_date,      // ✅ ถูกต้อง
    plant_count,       // ✅ ถูกต้อง
    level_required,    // ✅ เพิ่มใหม่
    notes,
    // ✅ เพิ่มข้อมูลเพิ่มเติมที่อาจส่งมา
    variety = '',
    batch_number = '',
    source_system = 'civic_platform',
    priority = 'normal',
    created_by = 'civic_system'
  } = req.body;

  console.log('📥 รับข้อมูลแผนการปลูก:', req.body);
  
  // ✅ แก้ไขการตรวจสอบให้ใช้ external_plan_id
  if (!external_plan_id || !vegetable_type || !plant_date || !harvest_date || !plant_count) {
    return res.status(400).json({
      success: false,
      error: 'ข้อมูลไม่ครบถ้วน ต้องมี: external_plan_id, vegetable_type, plant_date, harvest_date, plant_count'
    });
  }
  
  try {
    // ✅ บันทึกข้อมูลแผนการปลูกพร้อมข้อมูลครบถ้วน
    const result = await pool.query(
      `INSERT INTO planting_plans (
        plan_id, vegetable_type, plant_date, harvest_date, 
        plant_count, level_required, notes, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'received') 
       RETURNING *`,
      [external_plan_id, vegetable_type, plant_date, harvest_date, plant_count, level_required || 1, notes || '']
    );
    
    console.log('✅ บันทึกสำเร็จ:', result.rows[0]);
    
    res.json({ 
      success: true,
      message: "บันทึกแผนการปลูกสำเร็จ",
      data: result.rows[0]
    });
    
  } catch (err) {
    console.error('❌ Error:', err.message);
    console.error('❌ Detail:', err.detail);
    console.error('❌ Code:', err.code);
    
    res.status(500).json({ 
      success: false,
      error: err.message,
      detail: err.detail,
      code: err.code
    });
  }
});

// ✅ API สำหรับดึงรายการแผนการปลูก


// =============================================================================
// 🌱 ENHANCED API ENDPOINTS - ใช้ Views ใหม่ + Auto Navigate + Harvest Alerts
// =============================================================================
// Removed unused pending-inbound-tasks API
// ✅ 2. แก้ไข API ดึงรายการ Outbound Tasks (ใช้ View + Harvest Alerts)
app.get('/api/planting/pending-outbound-tasks', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        wo.*,
        pp.plan_id,
        -- ✅ เพิ่มสถานะการเก็บเกี่ยวเพื่อเปลี่ยนสี UI
        CASE 
          WHEN wo.target_date <= CURRENT_DATE - INTERVAL '3 days' THEN 'overdue_harvest'
          WHEN wo.target_date <= CURRENT_DATE THEN 'ready_to_harvest'
          ELSE 'normal'
        END as harvest_alert_status,
        
        -- ✅ หาตำแหน่งปัจจุบันของถาด
        ti.floor,
        ti.slot,
        ti.time_in
      FROM work_orders wo
      LEFT JOIN planting_plans pp ON wo.planting_plan_id = pp.id
      LEFT JOIN tray_inventory ti ON pp.plan_id = ti.tray_id
      WHERE wo.task_type = 'harvest' AND wo.status = 'pending'
      ORDER BY wo.target_date ASC
    `);
    
    console.log(`🌾 พบ Outbound Tasks: ${result.rows.length} รายการ`);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Get Pending Outbound Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
// ในไฟล์ index.js
app.post('/api/planting/plan/:id/quick-inbound-wo', async (req, res) => {
  const { id: planting_plan_id } = req.params;
  const { created_by } = req.body;

  try {
    // ✨✨✨ [จุดแก้ไขที่ 1] เพิ่ม `notes` เข้าไปใน SELECT statement ✨✨✨
    const planResult = await pool.query(`
      SELECT id, plan_id, vegetable_type, plant_date, harvest_date, 
             plant_count, level_required, status, notes 
      FROM planting_plans 
      WHERE id = $1
    `, [planting_plan_id]);
    
    if (planResult.rows.length === 0) {
      return res.status(404).json({ error: 'ไม่พบแผนการปลูก' });
    }
    
    const plan = planResult.rows[0];
    const workOrderNumber = `WO-${new Date().getFullYear()}-${Date.now().toString().slice(-5)}`;
    
    const result = await pool.query(`
      INSERT INTO work_orders (
        work_order_number, planting_plan_id, task_type, vegetable_type, 
        plant_count, level, target_date, created_by, status
      ) VALUES ($1, $2, 'inbound', $3, $4, $5, $6, $7, 'pending') 
      RETURNING *
    `, [
      workOrderNumber, 
      planting_plan_id, 
      plan.vegetable_type,
      plan.plant_count,
      plan.level_required,
      plan.plant_date,
      created_by || 'system'
    ]);
    
    res.status(201).json({
      success: true,
      work_order: result.rows[0],
      auto_navigate: {
        page: 'tray-inbound',
        data: {
          work_order_id: result.rows[0].id,
          vegetable_type: plan.vegetable_type,
          plant_count: plan.plant_count,
          plant_date: plan.plant_date,
          harvest_date: plan.harvest_date,
          // ✨✨✨ [จุดแก้ไขที่ 2] ตรวจสอบให้แน่ใจว่า `plan.notes` ถูกส่งไปจริงๆ ✨✨✨
          notes: plan.notes, 
          planting_plan_id: planting_plan_id
        }
      },
      message: `สร้างใบงาน ${workOrderNumber} สำเร็จ`
    });
    
  } catch (err) {
    console.error('❌ Create Inbound Work Order Error:', err.message);
    res.status(500).json({ 
      error: 'เกิดข้อผิดพลาดในการสร้างใบงาน: ' + err.message 
    });
  }
});


// ✅ 4. แก้ไข API สร้างใบงาน Outbound
// ✅ API สำหรับสร้างใบงาน Outbound จาก Planting Plan
app.post('/api/planting/plan/:planId/quick-outbound-wo', async (req, res) => {
  const { planId } = req.params;
  const { created_by } = req.body;
  
  try {
    console.log(`🚀 Creating outbound work order for planting plan: ${planId}`);
    
    // ดึงข้อมูล planting plan
    const planResult = await pool.query(`
      SELECT * FROM planting_plans WHERE id = $1
    `, [planId]);
    
    if (planResult.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'ไม่พบ Planting Plan' 
      });
    }
    
    const plan = planResult.rows[0];
    
    // ดึงถาดที่เกี่ยวข้องกับ plan นี้
    const trayResult = await pool.query(`
      SELECT ti.*, wo.work_order_number 
      FROM tray_inventory ti
      LEFT JOIN work_orders wo ON wo.tray_id = ti.tray_id
      WHERE wo.planting_plan_id = $1 
        AND wo.task_type = 'inbound'
        AND ti.status = 'on_shelf'
      LIMIT 1
    `, [planId]);
    
    if (trayResult.rows.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'ไม่พบถาดที่เกี่ยวข้องกับแผนการปลูกนี้' 
      });
    }
    
    const tray = trayResult.rows[0];
    
    // สร้างเลขใบงาน
    const workOrderNumber = `WO-OUT-${Date.now().toString().slice(-8)}`;
    
    // สร้างใบงาน outbound
    const workOrderResult = await pool.query(`
      INSERT INTO work_orders (
        work_order_number, planting_plan_id, task_type, vegetable_type, 
        level, plant_count, target_date, created_by, status, tray_id, 
        current_floor, current_slot, created_at
      ) VALUES ($1, $2, 'outbound', $3, $4, $5, $6, $7, 'pending', $8, $9, $10, NOW())
      RETURNING *
    `, [
      workOrderNumber, planId, plan.vegetable_type, 
      plan.level_required, plan.plant_count, plan.harvest_date, 
      created_by || 'system', tray.tray_id, tray.floor, tray.slot
    ]);
    
    const workOrder = workOrderResult.rows[0];
    
    console.log(`✅ สร้างใบงาน Outbound: ${workOrderNumber} สำหรับ Plan ${planId}`);
    
    res.json({
      success: true,
      message: 'สร้างใบงาน Outbound สำเร็จ',
      work_order_number: workOrderNumber,
      work_order_id: workOrder.id,
      tray_id: tray.tray_id,
      plan_id: planId
    });
    
  } catch (err) {
    console.error('❌ Error creating outbound work order:', err.message);
    res.status(500).json({ 
      success: false, 
      error: 'เกิดข้อผิดพลาดในการสร้างใบงาน Outbound' 
    });
  }
});

app.post('/api/trays/:tray_id/quick-outbound-wo', async (req, res) => {
  const { tray_id } = req.params;
  const { created_by } = req.body;
  
  try {
    // ดึงข้อมูลถาดพร้อม planting plan ที่เกี่ยวข้อง
    const trayResult = await pool.query(`
      SELECT 
        ti.*, 
        wo.planting_plan_id,
        pp.harvest_date,
        pp.vegetable_type
      FROM tray_inventory ti
      LEFT JOIN work_orders wo ON ti.batch_id = wo.work_order_number
      LEFT JOIN planting_plans pp ON wo.planting_plan_id = pp.id
      WHERE ti.tray_id = $1
    `, [tray_id]);
    
    if (trayResult.rows.length === 0) {
      return res.status(404).json({ error: 'ไม่พบข้อมูลถาด' });
    }
    
    const tray = trayResult.rows[0];
    const workOrderNumber = `WO-${new Date().getFullYear()}-${Date.now().toString().slice(-5)}`;
    
    // สร้างใบงาน Outbound
    const woResult = await pool.query(`
      INSERT INTO work_orders (
        work_order_number, planting_plan_id, task_type, vegetable_name, 
        plant_count, target_date, created_by, status, tray_id, 
        current_floor, current_slot
      ) VALUES ($1, $2, 'outbound', $3, $4, CURRENT_DATE, $5, 'pending', $6, $7, $8) 
      RETURNING *
    `, [
      workOrderNumber, tray.planting_plan_id, tray.veg_type, 
      tray.plant_quantity, created_by, tray_id, 
      tray.floor, tray.slot
    ]);
    
    console.log(`✅ สร้างใบงาน Outbound: ${workOrderNumber} สำหรับถาด ${tray_id}`);
    
    res.status(201).json({
      success: true,
      work_order: woResult.rows[0],
      tray_info: {
        tray_id,
        location: `ชั้น ${tray.floor} / ช่อง ${tray.slot}`,
        vegetable_type: tray.veg_type,
        plant_quantity: tray.plant_quantity
      },
      message: `สร้างใบงาน ${workOrderNumber} สำเร็จ - พร้อมเก็บเกี่ยว`
    });
    
  } catch (err) {
    console.error('❌ Create Outbound Work Order Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ✅ 5. แก้ไข API ดึงรายการ Work Orders (ใช้ View ใหม่)
app.get('/api/work-orders', async (req, res) => {
  try {
    const { status, task_type } = req.query;
    
    // ✅ แก้ไขให้ใช้ JOIN แทน View ที่ขาดหายไป
    let query = `
      SELECT 
        wo.*,
        pp.plan_id,
        pp.vegetable_type as plan_vegetable_type
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
    
    console.log(`📋 พบ Work Orders: ${result.rows.length} รายการ (status: ${status || 'all'})`);
    
    res.json({
      success: true,
      work_orders: result.rows
    });
  } catch (err) {
    console.error('❌ Error fetching work orders:', err.message);
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});
// ✅ 1. แก้ไข API อัปเดตสถานะ Work Order ใน index.js
app.put('/api/work-orders/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status, completed_by, actual_count } = req.body;

  try {
    // ดึงข้อมูล work order ก่อนอัปเดต
    const woResult = await pool.query(`
      SELECT wo.*, pp.status as plan_status 
      FROM work_orders wo
      LEFT JOIN planting_plans pp ON wo.planting_plan_id = pp.id
      WHERE wo.id = $1
    `, [id]);

    if (woResult.rows.length === 0) {
      return res.status(404).json({ error: 'ไม่พบใบงาน' });
    }

    const workOrder = woResult.rows[0];

    // อัปเดต work order
    const updateResult = await pool.query(`
      UPDATE work_orders 
      SET status = $1, 
          actual_count = $2, 
          updated_at = NOW()
      WHERE id = $3
      RETURNING *
    `, [status, actual_count, id]);

    // ❌ เอาการอัปเดต completed ออกจากที่นี่ - ให้อัปเดตใน /api/workstation/complete เท่านั้น
    // planting plan จะเป็น completed เมื่อยืนยัน outbound ผ่าน workstation เท่านั้น

    // ✅ อัปเดตสถานะ Planting Plan เมื่อเริ่มงาน inbound (แบบเงียบๆ)
    if (status === 'in_progress' && (workOrder.task_type === 'inbound' || workOrder.task_type === 'planting') && workOrder.planting_plan_id) {
      await pool.query(`
        UPDATE planting_plans 
        SET status = 'in_progress', 
            updated_at = NOW()
        WHERE id = $1
      `, [workOrder.planting_plan_id]);
    }

    res.json({
      success: true,
      work_order: updateResult.rows[0],
      message: `อัปเดตสถานะเป็น ${status} สำเร็จ`
    });

  } catch (err) {
    console.error('❌ Error updating work order status:', err.message);
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

app.post('/api/inbound/complete', async (req, res) => {
  const {
    work_order_id, floor, slot, veg_type, quantity,
    batch_id, seeding_date, notes, username, station
  } = req.body;

  try {
    // ... (ส่วนการตรวจสอบข้อมูลเหมือนเดิม) ...
    if (!work_order_id || !floor || !slot || !veg_type) {
      return res.status(400).json({ error: 'ข้อมูลจากฟอร์มไม่ครบถ้วน' });
    }
    const userRes = await pool.query(`SELECT id FROM users WHERE username = $1`, [username]);
    if (userRes.rows.length === 0) return res.status(404).json({ error: 'ไม่พบผู้ใช้งานนี้' });
    const slotCheckRes = await pool.query(`SELECT tray_id FROM tray_inventory WHERE floor = $1 AND slot = $2 AND status = 'on_shelf'`, [floor, slot]);
    if (slotCheckRes.rows.length > 0) {
      return res.status(409).json({ error: `ช่อง ${slot} บนชั้น ${floor} มีถาดวางอยู่แล้ว` });
    }

    const newTrayId = await generateNextTrayId();

    const updateResult = await pool.query(`
      UPDATE work_orders SET status = 'in_progress', tray_id = $1, current_floor = $2, current_slot = $3
      WHERE id = $4 RETURNING *
    `, [newTrayId, floor, slot, work_order_id]);

    if (updateResult.rowCount === 0) {
        return res.status(404).json({ error: 'ไม่พบใบงานที่ต้องการอัปเดต' });
    }
    const workOrder = updateResult.rows[0];

    // ✅✅✅ [เพิ่มส่วนนี้] อัปเดตสถานะ Planting Plan เป็น 'in_progress' ✅✅✅
    if (workOrder.planting_plan_id) {
      await pool.query(`
        UPDATE planting_plans SET status = 'in_progress', updated_at = NOW()
        WHERE id = $1
      `, [workOrder.planting_plan_id]);
      console.log(`✅ Updated planting plan ${workOrder.planting_plan_id} to in_progress.`);
    }

    // ... (ส่วนการ Trigger Flow การทำงานของ Automation เหมือนเดิม) ...
    const stationId = parseInt(station);
    const state = stationStates[stationId];
    if (state.flowState === 'idle') {
      state.targetFloor = parseInt(floor);
      state.targetSlot = parseInt(slot);
      state.taskType = 'inbound';
      state.trayId = newTrayId;
      state.isReturning = false;
      state.vegType = workOrder.vegetable_name;
      state.username = username;
      state.plantQuantity = workOrder.plant_count;
      state.batchId = workOrder.batch_id;
      state.seedingDate = workOrder.target_date;
      state.notes = workOrder.description;
      state.stationId = stationId;
      state.workOrderId = work_order_id;
      state.flowState = 'inbound_start_lift_tray';
      console.log(`[Trigger] 🚀 เริ่ม flow INBOUND จาก Work Order ID: ${work_order_id} → ชั้น ${floor}, ช่อง ${slot}`);
      handleFlow(stationId);
      return res.json({ message: "รับคำสั่งเรียบร้อย เริ่มดำเนินการ" });
    } else {
      await pool.query(`UPDATE work_orders SET status = 'pending', tray_id = NULL, current_floor = NULL, current_slot = NULL WHERE id = $1`, [work_order_id]);
      return res.status(409).json({ error: `ระบบกำลังทำงานอื่นอยู่ (${state.flowState})` });
    }
  } catch (err) {
    console.error('❌ Inbound Complete (from Work Order) Error:', err.message);
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// ✅ เพิ่ม API endpoint ใน index.js สำหรับแก้ไข status
app.post('/api/planting-plans/fix-status', async (req, res) => {
  try {
    
    // แก้ไข plans ที่มี status เป็น null หรือไม่ถูกต้อง
    const result = await pool.query(`
      UPDATE planting_plans 
      SET status = 'received', updated_at = NOW()
      WHERE status IS NULL OR status = '' OR status NOT IN ('received', 'in_progress', 'completed', 'cancelled')
      RETURNING id, plan_id, vegetable_type, status
    `);
    
    console.log(`✅ แก้ไขสำเร็จ ${result.rows.length} รายการ`);
    
    res.json({
      success: true,
      message: `แก้ไข status สำเร็จ ${result.rows.length} รายการ`,
      updated_plans: result.rows
    });
    
  } catch (err) {
    console.error('❌ Error fixing status:', err.message);
    res.status(500).json({ 
      success: false,
      error: err.message 
    });
  }
});

// ✅ เพิ่ม API endpoint สำหรับอัปเดตสถานะแผนการปลูก
app.put('/api/planting-plans/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, actual_harvest_date } = req.body;
    
    const validStatuses = ['received', 'in_progress', 'completed', 'cancelled'];
    
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        error: `Status ต้องเป็นหนึ่งใน: ${validStatuses.join(', ')}`
      });
    }
    
    // ✅ เพิ่มการตรวจสอบการเก็บเกี่ยวก่อนกำหนด
    let harvestAlert = null;
    if (status === 'completed' && actual_harvest_date) {
      const planResult = await pool.query(`
        SELECT harvest_date FROM planting_plans WHERE id = $1
      `, [id]);
      
      if (planResult.rows.length > 0) {
        const plannedHarvestDate = new Date(planResult.rows[0].harvest_date);
        const actualHarvestDate = new Date(actual_harvest_date);
        
        if (actualHarvestDate < plannedHarvestDate) {
          const daysDifference = Math.ceil((plannedHarvestDate - actualHarvestDate) / (1000 * 60 * 60 * 24));
          harvestAlert = {
            type: 'early_harvest',
            message: `เก็บเกี่ยวก่อนกำหนด ${daysDifference} วัน`,
            planned_date: plannedHarvestDate.toISOString().split('T')[0],
            actual_date: actual_harvest_date,
            days_early: daysDifference
          };
        }
      }
    }
    
    const updateQuery = status === 'completed' && actual_harvest_date 
      ? `UPDATE planting_plans 
         SET status = $1, updated_at = NOW(), completed_at = NOW(), actual_harvest_date = $3
         WHERE id = $2
         RETURNING *`
      : `UPDATE planting_plans 
         SET status = $1, updated_at = NOW()
         WHERE id = $2
         RETURNING *`;
    
    const params = status === 'completed' && actual_harvest_date 
      ? [status, id, actual_harvest_date]
      : [status, id];
    
    const result = await pool.query(updateQuery, params);
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'ไม่พบแผนการปลูก'
      });
    }
    
    console.log(`✅ อัปเดตสถานะ plan ${id} เป็น ${status}`);
    
    res.json({
      success: true,
      message: `อัปเดตสถานะเป็น ${status} สำเร็จ`,
      plan: result.rows[0],
      harvest_alert: harvestAlert
    });
    
  } catch (err) {
    console.error('❌ Error updating status:', err.message);
    res.status(500).json({ 
      success: false,
      error: err.message 
    });
  }
});
// ✅ 8. API ใหม่: ดึงสถิติ Dashboard
app.get('/api/planting/dashboard-stats', async (req, res) => {
  try {
    const stats = await pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE task_type = 'inbound' AND status = 'pending') as pending_inbound,
        COUNT(*) FILTER (WHERE task_type = 'harvest' AND status = 'pending') as pending_outbound,
        COUNT(*) FILTER (WHERE task_type = 'harvest' AND status = 'pending' AND target_date <= CURRENT_DATE) as ready_harvest,
        COUNT(*) FILTER (WHERE task_type = 'harvest' AND status = 'pending' AND target_date <= CURRENT_DATE - INTERVAL '3 days') as overdue_harvest
      FROM work_orders
    `);
    
    const workOrderStats = await pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE status = 'pending') as pending_orders,
        COUNT(*) FILTER (WHERE status = 'in_progress') as active_orders,
        COUNT(*) FILTER (WHERE status = 'completed' AND DATE(updated_at) = CURRENT_DATE) as completed_today
      FROM work_orders
    `);
    
    res.json({
      success: true,
      stats: {
        ...stats.rows[0],
        ...workOrderStats.rows[0]
      }
    });
    
  } catch (err) {
    console.error('❌ Dashboard Stats Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// 🎯 สรุปการเปลี่ยนแปลง API:
// =============================================================================
/*
✅ 1. /api/planting/pending-inbound-tasks → ใช้ v_pending_tasks View
✅ 2. /api/planting/pending-outbound-tasks → ใช้ v_pending_tasks + harvest alerts  
✅ 3. /api/planting/plan/:id/quick-inbound-wo → เพิ่ม auto_navigate response
✅ 4. /api/trays/:tray_id/quick-outbound-wo → เพิ่มข้อมูล tray location
✅ 5. /api/work-orders → ใช้ v_work_order_details View
✅ 6. /api/work-orders/:id/status → เพิ่มตรรกะ tray update
✅ 7. /api/inbound/complete → API ใหม่สำหรับจบงาน inbound
✅ 8. /api/planting/dashboard-stats → API สถิติ dashboard
*/

// =============================================================================
// 🌱 PLANTING PLAN HISTORY + OUTBOUND ACTIONS API
// =============================================================================

// ✅ API ใหม่สำหรับดึงประวัติรวม (Planting Plans + Outbound Actions)
app.get('/api/planting-plans/complete-history', async (req, res) => {
  try {
    const { limit = 50 } = req.query;
    
    // ดึงข้อมูล Planting Plans ที่เสร็จสิ้น
    const completedPlansQuery = `
      SELECT 
        'planting_plan' as source_type,
        pp.id,
        pp.plan_id,
        pp.vegetable_type,
        pp.plant_count,
        pp.status,
        pp.plant_date,
        pp.harvest_date,
        pp.actual_harvest_date,
        pp.harvest_notes,
        pp.created_by,
        pp.completed_by,
        pp.completed_at,
        pp.created_at,
        pp.updated_at,
        wo.work_order_number as command_used,
        'completed' as action_type
      FROM planting_plans pp
      LEFT JOIN work_orders wo ON pp.id = wo.planting_plan_id AND wo.task_type = 'harvest'
      WHERE pp.status = 'completed'
    `;
    
    // ดึงข้อมูล Outbound Actions (เก็บเกี่ยว + กำจัดทิ้ง)
    const outboundActionsQuery = `
      SELECT 
        'outbound_action' as source_type,
        tm.task_id as id,
        CONCAT('OUT-', tm.task_id) as plan_id,
        COALESCE(ti.veg_type, pp.vegetable_type, 'ไม่ระบุ') as vegetable_type,
        tm.plant_quantity as plant_count,
        'completed' as status,
        ti.seeding_date as plant_date,
        NULL as harvest_date,
        tm.created_at::date as actual_harvest_date,
        tm.notes as harvest_notes,
        tm.username as created_by,
        tm.username as completed_by,
        tm.completed_at,
        tm.created_at,
        tm.created_at as updated_at,
        COALESCE(wo.work_order_number, CONCAT('MANUAL-', tm.task_id)) as command_used,
        tm.reason as action_type
      FROM task_monitor tm
      LEFT JOIN tray_inventory ti ON tm.tray_id = ti.tray_id
      LEFT JOIN planting_plans pp ON ti.planting_plan_id = pp.id
      LEFT JOIN work_orders wo ON tm.work_order_id = wo.id
      WHERE tm.action_type = 'outbound' 
        AND tm.status = 'success'
        AND tm.reason IN ('เก็บเกี่ยวทั้งหมด', 'ตัดแต่ง / เก็บเกี่ยวบางส่วน', 'กำจัดทิ้ง')
    `;
    
    // รวมข้อมูลทั้งสองและเรียงตามวันที่
    const combinedQuery = `
      (${completedPlansQuery})
      UNION ALL
      (${outboundActionsQuery})
      ORDER BY updated_at DESC
      LIMIT $1
    `;
    
    const result = await pool.query(combinedQuery, [parseInt(limit)]);
    
    res.json({
      success: true,
      history_items: result.rows,
      count: result.rows.length
    });
    
  } catch (err) {
    console.error('❌ Error in /api/planting-plans/complete-history:', err.message);
    res.status(500).json({ 
      success: false, 
      error: 'Server error while fetching complete history.'
    });
  }
});

// =============================================================================
// 🌱 PLANTING PLAN DETAILS API
// =============================================================================

// ในไฟล์ index.js
// ✅ API สำหรับดูรายละเอียด planting plan พร้อมถาดที่เกี่ยวข้อง
app.get('/api/planting-plans/:id/details', async (req, res) => {
  try {
    const { id } = req.params;
    
    // ✨✨✨ [จุดแก้ไขสำคัญ] ✨✨✨
    // แปลง id ที่รับเข้ามาให้เป็น Integer ก่อนเสมอ
    // และแก้ไข Query ให้เปรียบเทียบ id (ที่เป็น integer) กับ id ของตาราง
    const planIdAsInt = parseInt(id);
    if (isNaN(planIdAsInt)) {
        return res.status(400).json({ success: false, error: 'รูปแบบ ID ของแผนไม่ถูกต้อง' });
    }

    // ดึงข้อมูล planting plan โดยใช้ id ที่เป็น INTEGER พร้อมข้อมูลการเก็บเกี่ยว
    const planResult = await pool.query(`
      SELECT 
        pp.*,
        to_char(pp.plant_date, 'DD/MM/YYYY') as plant_date_formatted,
        to_char(pp.harvest_date, 'DD/MM/YYYY') as harvest_date_formatted,
        to_char(pp.actual_harvest_date, 'DD/MM/YYYY') as actual_harvest_date_formatted,
        to_char(pp.created_at, 'DD/MM/YYYY HH24:MI') as created_at_formatted,
        to_char(pp.completed_at, 'DD/MM/YYYY HH24:MI') as completed_at_formatted,
        CASE 
          WHEN pp.actual_harvest_date IS NOT NULL AND pp.actual_harvest_date < pp.harvest_date 
          THEN pp.harvest_date - pp.actual_harvest_date 
          ELSE NULL 
        END as days_early_harvest
      FROM planting_plans pp 
      WHERE pp.id = $1
    `, [planIdAsInt]); // 👈 ใช้ planIdAsInt ที่แปลงแล้ว
    
    if (planResult.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'ไม่พบแผนการปลูก' 
      });
    }
    
    const plan = planResult.rows[0];
    
    // ดึงข้อมูลถาดที่เกี่ยวข้อง - ปรับปรุงให้หาข้อมูลมากขึ้น
    const traysResult = await pool.query(`
      SELECT 
        ti.*,
        to_char(ti.time_in, 'DD/MM/YYYY HH24:MI') as time_in_formatted,
        to_char(ti.seeding_date, 'DD/MM/YYYY') as seeding_date_formatted
      FROM tray_inventory ti 
      WHERE ti.planting_plan_id = $1
         OR (ti.veg_type = $2 AND ti.status IN ('on_shelf', 'picked'))
      ORDER BY ti.tray_id
      LIMIT 50
    `, [plan.id, plan.vegetable_type]); // 👈 หาทั้งจาก plan_id และ vegetable_type
    
    // ดึง task history ที่เกี่ยวข้อง - ปรับปรุงให้หาข้อมูลมากขึ้น
    const taskHistoryResult = await pool.query(`
      SELECT tm.*,
        to_char(tm.created_at, 'DD/MM/YYYY HH24:MI') as created_at_formatted
      FROM task_monitor tm
      WHERE (
        tm.tray_id IN (
          SELECT ti.tray_id FROM tray_inventory ti WHERE ti.planting_plan_id = $1
        )
        OR tm.veg_type = $2
        OR (
          tm.action_type = 'outbound' 
          AND tm.status = 'success'
        )
      )
      ORDER BY tm.created_at DESC
      LIMIT 100
    `, [plan.id, plan.vegetable_type]);

    // ดึงข้อมูล work orders ที่เกี่ยวข้อง - ปรับปรุงให้หาข้อมูลมากขึ้น
    const workOrdersResult = await pool.query(`
      SELECT 
        wo.*,
        to_char(wo.target_date, 'DD/MM/YYYY') as target_date_formatted,
        to_char(wo.created_at, 'DD/MM/YYYY HH24:MI') as created_at_formatted
      FROM work_orders wo 
      WHERE wo.planting_plan_id = $1
         OR (wo.vegetable_type = $2 AND wo.status IN ('pending', 'completed', 'in_progress'))
      ORDER BY wo.created_at DESC
      LIMIT 30
    `, [plan.id, plan.vegetable_type]); // 👈 หาทั้งจาก plan_id และ vegetable_type
    
    // คำนวณสถิติจากข้อมูลจริง
    const directTrays = traysResult.rows.filter(tray => tray.planting_plan_id == plan.id);
    const relatedTrays = traysResult.rows.filter(tray => tray.veg_type === plan.vegetable_type);
    const directWorkOrders = workOrdersResult.rows.filter(wo => wo.planting_plan_id == plan.id);
    const relatedWorkOrders = workOrdersResult.rows.filter(wo => wo.vegetable_type === plan.vegetable_type);
    
    const stats = {
      total_trays: directTrays.length > 0 ? directTrays.length : relatedTrays.length,
      total_plants: directTrays.length > 0 
        ? directTrays.reduce((sum, tray) => sum + (tray.plant_quantity || 0), 0)
        : relatedTrays.reduce((sum, tray) => sum + (tray.plant_quantity || 0), 0),
      work_orders_count: directWorkOrders.length > 0 ? directWorkOrders.length : relatedWorkOrders.length,
      pending_work_orders: (directWorkOrders.length > 0 ? directWorkOrders : relatedWorkOrders).filter(wo => wo.status === 'pending').length,
      completed_work_orders: (directWorkOrders.length > 0 ? directWorkOrders : relatedWorkOrders).filter(wo => wo.status === 'completed').length,
      // เพิ่มข้อมูลการประมาณจาก task history
      estimated_activity: taskHistoryResult.rows.filter(task => task.veg_type === plan.vegetable_type).length
    };

    res.json({
      success: true,
      plan: plan,
      trays: traysResult.rows,
      tray_inventory: traysResult.rows, // alias สำหรับ compatibility
      work_orders: workOrdersResult.rows,
      task_history: taskHistoryResult.rows,
      stats: stats
    });
    
  } catch (err) {
    console.error('❌ Error in /api/planting-plans/:id/details:', err.message);
    res.status(500).json({ 
      success: false, 
      error: 'Server error while fetching plan details.'
    });
  }
});

// =============================================================================
// 🔧 API ENDPOINTS สำหรับ WORK ORDER TASKS
// =============================================================================

// ดึงรายการ tasks ของ work order
app.get('/api/work-orders/:id/tasks', async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await pool.query(`
      SELECT 
        wot.*,
        wo.work_order_number,
        wo.task_type,
        wo.vegetable_type
      FROM work_order_tasks wot
      JOIN work_orders wo ON wot.work_order_id = wo.id
      WHERE wot.work_order_id = $1
      ORDER BY wot.sequence_order ASC
    `, [id]);
    
    console.log(`📋 พบ tasks สำหรับ work order ${id}: ${result.rows.length} รายการ`);
    
    res.json({
      success: true,
      tasks: result.rows,
      work_order_id: id
    });
  } catch (err) {
    console.error('❌ Error fetching work order tasks:', err.message);
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

// อัปเดตสถานะ task
app.put('/api/work-order-tasks/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, assigned_to, actual_duration } = req.body;
    
    const validStatuses = ['pending', 'in_progress', 'completed', 'cancelled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid status' 
      });
    }
    
    let updateQuery = `
      UPDATE work_order_tasks 
      SET status = $1
    `;
    let params = [status];
    
    if (assigned_to) {
      params.push(assigned_to);
      updateQuery += `, assigned_to = $${params.length}`;
    }
    
    if (status === 'completed') {
      updateQuery += `, completed_at = NOW()`;
      
      if (actual_duration) {
        params.push(actual_duration);
        updateQuery += `, actual_duration = $${params.length}`;
      }
    }
    
    params.push(id);
    updateQuery += ` WHERE id = $${params.length} RETURNING *`;
    
    const result = await pool.query(updateQuery, params);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Task not found' 
      });
    }
    
    console.log(`✅ อัปเดตสถานะ task ${id} เป็น ${status}`);
    
    res.json({
      success: true,
      task: result.rows[0]
    });
  } catch (err) {
    console.error('❌ Error updating task status:', err.message);
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

// ดึงรายการ tasks ทั้งหมด (สำหรับ dashboard)
app.get('/api/work-order-tasks', async (req, res) => {
  try {
    const { status, assigned_to } = req.query;
    
    let query = `
      SELECT 
        wot.*,
        wo.work_order_number,
        wo.task_type,
        wo.vegetable_type,
        pp.plan_id
      FROM work_order_tasks wot
      JOIN work_orders wo ON wot.work_order_id = wo.id
      LEFT JOIN planting_plans pp ON wo.planting_plan_id = pp.id
      WHERE 1=1
    `;
    const params = [];
    
    if (status) {
      params.push(status);
      query += ` AND wot.status = $${params.length}`;
    }
    
    if (assigned_to) {
      params.push(assigned_to);
      query += ` AND wot.assigned_to = $${params.length}`;
    }
    
    query += ` ORDER BY wo.target_date ASC, wot.sequence_order ASC`;
    
    const result = await pool.query(query, params);
    
    console.log(`📋 พบ work order tasks: ${result.rows.length} รายการ`);
    
    res.json({
      success: true,
      tasks: result.rows
    });
  } catch (err) {
    console.error('❌ Error fetching work order tasks:', err.message);
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

// ✅ API สำหรับสถิติ Outbound (เก็บเกี่ยว/กำจัด)
app.get('/api/task-monitor/outbound-stats', async (req, res) => {
  try {
    console.log('📊 Calculating outbound statistics...');
    
    // นับงานที่เสร็จสิ้น
    const completedOutbound = await pool.query(`
      SELECT COUNT(*) as completed_count,
             COALESCE(SUM(tm.plant_quantity), 0) as total_plants
      FROM task_monitor tm
      WHERE tm.action_type = 'outbound' 
        AND tm.status = 'success'
        AND tm.reason IN ('เก็บเกี่ยวทั้งหมด', 'ตัดแต่ง / เก็บเกี่ยวบางส่วน', 'กำจัดทิ้ง')
    `);
    
    // นับงานเดือนนี้
    const thisMonth = new Date().getMonth() + 1; // JavaScript month is 0-based
    const thisYear = new Date().getFullYear();
    
    const thisMonthOutbound = await pool.query(`
      SELECT COUNT(*) as this_month_count
      FROM task_monitor tm
      WHERE tm.action_type = 'outbound' 
        AND tm.status = 'success'
        AND tm.reason IN ('เก็บเกี่ยวทั้งหมด', 'ตัดแต่ง / เก็บเกี่ยวบางส่วน', 'กำจัดทิ้ง')
        AND EXTRACT(MONTH FROM tm.completed_at) = $1
        AND EXTRACT(YEAR FROM tm.completed_at) = $2
    `, [thisMonth, thisYear]);
    
    const stats = {
      completed: parseInt(completedOutbound.rows[0].completed_count) || 0,
      plants: parseInt(completedOutbound.rows[0].total_plants) || 0,
      thisMonth: parseInt(thisMonthOutbound.rows[0].this_month_count) || 0
    };
    
    console.log(`📊 Outbound stats: ${JSON.stringify(stats)}`);
    res.json(stats);
    
  } catch (err) {
    console.error('❌ Error calculating outbound stats:', err.message);
    res.status(500).json({ 
      completed: 0, 
      plants: 0, 
      thisMonth: 0,
      error: 'Failed to calculate stats' 
    });
  }
});

// ✅✅✅ [เพิ่มใหม่] API สำหรับหน้า Overview เพื่อเช็คสถานะ Sensor (เฉพาะ RGV 3 ตัว) ✅✅✅
app.get('/api/sensors', async (req, res) => {
  try {
    const stationId = req.query.station_id || 1;
    const state = stationStates[stationId];
    
    // ดึงข้อมูลล่าสุดจาก State ที่ได้รับผ่าน MQTT
    const sensorData = state?.latestAgvSensorStatus || {};

    // ส่งข้อมูล sensor ทั้งหมดสำหรับหน้า monitor sensor
    // ส่งข้อมูล sensor ทั้งหมด (lift และ AGV ที่มีอยู่แล้ว)
    res.json({
      // RGV sensors
      tray_sensor: sensorData.tray_sensor || false,
      pos_sensor1: sensorData.pos_sensor1 || false,
      pos_sensor2: sensorData.pos_sensor2 || false,
      limit_agv_1: sensorData.limit_agv_1 || false,
      limit_agv_2: sensorData.limit_agv_2 || false,
      agv_on: sensorData.agv_on || false,
      
      // Lift sensors
      gripper_f1: sensorData.gripper_f1 || false,
      gripper_f2: sensorData.gripper_f2 || false,
      gripper_f3: sensorData.gripper_f3 || false,
      gripper_f4: sensorData.gripper_f4 || false,
      gripper_f5: sensorData.gripper_f5 || false,
      limit_top: sensorData.limit_top || false,
      limit_bottom: sensorData.limit_bottom || false,
      emergency_btn: sensorData.emergency_btn || false
    });

  } catch (error) {
    console.error('❌ Error in /api/sensors (RGV 3-sensor):', error.message);
    res.status(500).json({
      error: 'Failed to fetch RGV sensor data'
    });
  }
});

// ✅ AIR QUALITY SENSOR API ENDPOINT
app.get('/api/air-quality', async (req, res) => {
  try {
    const stationId = req.query.station_id || 1;
    const limit = parseInt(req.query.limit) || 1; // จำนวนข้อมูลที่ต้องการ (ค่าเริ่มต้น: ข้อมูลล่าสุด 1 รายการ)
    
    // ดึงข้อมูลจากฐานข้อมูล
    const result = await pool.query(`
      SELECT 
        co2_ppm,
        temperature_celsius,
        humidity_percent,
        recorded_at
      FROM air_quality_logs 
      WHERE station_id = $1 
      ORDER BY recorded_at DESC 
      LIMIT $2
    `, [stationId, limit]);
    
    if (result.rows.length === 0) {
      // ถ้าไม่มีข้อมูลในฐานข้อมูล ใช้ข้อมูลจาก state แทน
      const state = stationStates[stationId];
      const airData = state?.latestAirQualityData || {};
      
      return res.json({
        co2: airData.co2 || 400,
        temperature: airData.temperature || 25.0,
        humidity: airData.humidity || 60.0,
        last_updated: airData.last_updated || new Date().toISOString(),
        status: 'success',
        source: 'memory'
      });
    }
    
    if (limit === 1) {
      // ส่งข้อมูลรายการเดียว
      const data = result.rows[0];
      res.json({
        co2: data.co2_ppm,
        temperature: data.temperature_celsius,
        humidity: data.humidity_percent,
        last_updated: data.recorded_at,
        status: 'success',
        source: 'database'
      });
    } else {
      // ส่งข้อมูลหลายรายการ
      res.json({
        data: result.rows.map(row => ({
          co2: row.co2_ppm,
          temperature: row.temperature_celsius,
          humidity: row.humidity_percent,
          recorded_at: row.recorded_at
        })),
        count: result.rows.length,
        status: 'success',
        source: 'database'
      });
    }

  } catch (error) {
    console.error('❌ Error in /api/air-quality:', error.message);
    res.status(500).json({
      error: 'Failed to fetch air quality data',
      status: 'error'
    });
  }
});

// ✅ WATER SYSTEM DATABASE API ENDPOINTS
// GET water system data from database
app.get('/api/water-system', async (req, res) => {
  try {
    // ดึงข้อมูลการตั้งค่าระบบน้ำ
    const settingsResult = await pool.query(`
      SELECT ec_value, water_level, is_active, last_updated, updated_by
      FROM water_system_settings 
      ORDER BY id DESC LIMIT 1
    `);
    
    // ดึงข้อมูลวาล์วทั้งหมด
    const valvesResult = await pool.query(`
      SELECT floor_id, valve_id, device_id, status, usage_percent, 
             last_command_sent, last_status_received, last_updated
      FROM water_valves 
      ORDER BY floor_id, valve_id
    `);
    
    // ดึงสถิติ
    const statsResult = await pool.query(`
      SELECT * FROM water_floor_summary
    `);
    
    const settings = settingsResult.rows[0] || { 
      ec_value: 1.5, 
      water_level: 75, 
      is_active: false 
    };
    
    // จัดกลุ่มวาล์วตาม floor
    const floors = {};
    valvesResult.rows.forEach(valve => {
      if (!floors[valve.floor_id]) {
        floors[valve.floor_id] = { id: valve.floor_id, valves: [] };
      }
      floors[valve.floor_id].valves.push({
        id: valve.valve_id,
        status: valve.status,
        usage: valve.usage_percent,
        deviceId: valve.device_id,
        lastUpdated: valve.last_updated
      });
    });
    
    res.json({
      homeSettings: {
        ecValue: parseFloat(settings.ec_value),
        waterLevel: parseInt(settings.water_level),
        isActive: settings.is_active
      },
      floors: Object.values(floors),
      stats: statsResult.rows
    });
    
  } catch (error) {
    console.error('❌ Error fetching water system data:', error);
    res.status(500).json({ error: 'Failed to fetch water system data' });
  }
});

// POST valve command with database logging
app.post('/api/water-valve-command', async (req, res) => {
  try {
    const { floorId, valveId, status, userId } = req.body;
    
    if (!floorId || !valveId || !status) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const deviceId = ((floorId - 1) * 18) + valveId;
    
    // สร้าง payload สำหรับ MQTT
    const payload = {
      Key: "1097BD225248",
      Device: deviceId.toString(),
      Status: status === 'open' ? "Open" : "Close"
    };
    
    const startTime = Date.now();
    
    // บันทึก log การส่งคำสั่ง
    const logResult = await pool.query(`
      INSERT INTO water_system_logs 
      (device_id, floor_id, valve_id, command_type, action, sent_payload, status, user_id)
      VALUES ($1, $2, $3, 'valve', $4, $5, 'sent', $6)
      RETURNING id
    `, [deviceId, floorId, valveId, status, JSON.stringify(payload), userId || 'system']);
    
    const logId = logResult.rows[0].id;
    
    // ส่งคำสั่งผ่าน MQTT (ใช้ topic เดิมที่ ESP32 รู้จัก)
    const mqttTopic = 'water/layer';
    const mqttMessage = JSON.stringify(payload);
    
    mqttClient.publish(mqttTopic, mqttMessage, { qos: 1 }, async (err) => {
      const responseTime = Date.now() - startTime;
      
      if (err) {
        // อัปเดท log เมื่อเกิดข้อผิดพลาด
        await pool.query(`
          UPDATE water_system_logs 
          SET status = 'failed', result = 'mqtt_error', response_time_ms = $1
          WHERE id = $2
        `, [responseTime, logId]);
        
        return res.status(500).json({ 
          success: false, 
          error: 'Failed to send MQTT command',
          logId: logId
        });
      }
      
      // อัปเดท log เมื่อส่งสำเร็จ
      await pool.query(`
        UPDATE water_system_logs 
        SET status = 'published', result = 'success', response_time_ms = $1
        WHERE id = $2
      `, [responseTime, logId]);
      
      // อัปเดทสถานะในฐานข้อมูล (optimistic update)
      await pool.query(`
        UPDATE water_valves 
        SET status = $1, last_command_sent = CURRENT_TIMESTAMP, last_updated = CURRENT_TIMESTAMP
        WHERE floor_id = $2 AND valve_id = $3
      `, [status, floorId, valveId]);
    });
    
    res.json({ 
      success: true, 
      message: 'Valve command sent',
      deviceId: deviceId,
      logId: logId
    });
    
  } catch (error) {
    console.error('❌ Error in valve command:', error);
    res.status(500).json({ error: 'Failed to process valve command' });
  }
});

// POST update valve status from backend response
app.post('/api/water-valve-status', async (req, res) => {
  try {
    const { deviceId, status, responseData } = req.body;
    
    if (!deviceId || !status) {
      return res.status(400).json({ error: 'Missing device ID or status' });
    }
    
    // คำนวณ floor และ valve จาก device ID
    const floorId = Math.ceil(deviceId / 18);
    const valveId = deviceId - ((floorId - 1) * 18);
    
    // อัปเดทสถานะในฐานข้อมูล
    await pool.query(`
      UPDATE water_valves 
      SET status = $1, last_status_received = CURRENT_TIMESTAMP, last_updated = CURRENT_TIMESTAMP
      WHERE device_id = $2
    `, [status.toLowerCase(), deviceId]);
    
    // อัปเดท log ถ้ามี response data
    if (responseData) {
      await pool.query(`
        UPDATE water_system_logs 
        SET received_response = $1, result = 'completed'
        WHERE device_id = $2 AND status = 'published'
        ORDER BY created_at DESC LIMIT 1
      `, [JSON.stringify(responseData), deviceId]);
    }
    
    res.json({ 
      success: true, 
      message: 'Valve status updated',
      floorId: floorId,
      valveId: valveId
    });
    
  } catch (error) {
    console.error('❌ Error updating valve status:', error);
    res.status(500).json({ error: 'Failed to update valve status' });
  }
});
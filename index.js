const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const pool = require('./db');
const path = require('path');
const WebSocket = require('ws');
const compression = require('compression');
const { ModbusSlave, LIGHT_CONTROL_CONFIG, getLightRegisterAddress, sendModbusCommand } = require('./light_control_modbus');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
require('dotenv').config();

// ✅ Performance optimization: Enable Node.js optimizations
if (process.env.NODE_ENV !== 'development') {
  process.env.NODE_OPTIONS = '--max-old-space-size=4096 --optimize-for-size';
}

// ✅ Memory management: Periodic garbage collection
setInterval(() => {
  if (global.gc && process.memoryUsage().heapUsed > 100 * 1024 * 1024) {
    global.gc();
  }
}, 60000); // Every minute


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

// ✅ Light Control Queue System (เหมือน task queue)
const lightCommandQueue = [];
let isProcessingLightQueue = false;

async function processLightQueue() {
  if (isProcessingLightQueue || lightCommandQueue.length === 0) return;

  isProcessingLightQueue = true;

  while (lightCommandQueue.length > 0) {
    const command = lightCommandQueue.shift();

    try {
      // Processing light command

      // แยก floor จาก lightId (L1-1 -> floor=1)
      const floorMatch = command.lightId.match(/L(\d+)-/);
      if (!floorMatch) {
        console.error(`❌ Invalid lightId format: ${command.lightId}`);
        continue;
      }
      const floor = parseInt(floorMatch[1]);

      // ส่งคำสั่ง MQTT ด้วย parameters ที่ถูกต้อง
      sendModbusCommand(mqttClient, floor, command.lightId, command.deviceType, command.intensity);

      // Light command sent to MQTT
    } catch (err) {
      console.error(`❌ Error sending light command:`, err.message);
    }

    // Delay 0.5 วินาทีก่อนส่งคำสั่งถัดไป (ลดจาก 2 วินาที เพื่อความเร็ว)
    if (lightCommandQueue.length > 0) {
      await delay(500);
    }
  }

  isProcessingLightQueue = false;
  // Light queue empty
}

function addLightCommandToQueue(lightId, deviceType, isOn, intensity) {
  lightCommandQueue.push({ lightId, deviceType, isOn, intensity });
  // Added to light queue
  processLightQueue(); // เริ่มประมวลผล
}

const app = express();

// ✅ Security headersุ
app.use((req, res, next) => {
  res.header('X-Content-Type-Options', 'nosniff');
  res.header('X-Frame-Options', 'DENY');
  res.header('X-XSS-Protection', '1; mode=block');
  res.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// ✅ Performance optimization: Enable compression
app.use(compression({
  level: 6,
  threshold: 1024,
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  }
}));

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Performance optimization middleware
app.use((req, res, next) => {
  // Only disable cache for API endpoints, allow caching for static assets
  if (req.path.startsWith('/api/')) {
    res.set({
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
  } else {
    // Cache static files for 1 hour
    res.set({
      'Cache-Control': 'public, max-age=3600'
    });
  }
  next();
});

// ✅ Enhanced Rate Limiting (improved security)
const requestCounts = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const MAX_REQUESTS = 500; // เพิ่มเป็น 500 requests per minute

// Clean up old entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of requestCounts.entries()) {
    if (now > data.resetTime) {
      requestCounts.delete(ip);
    }
  }
}, 300000);


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
// ✅ REPORTS API ENDPOINTS
// GET statistics for reports page
app.get('/api/reports/statistics', async (req, res) => {
  try {
    const { station } = req.query;
    const stationId = parseInt(station); // แปลงเป็น integer
    // Fetching statistics

    // Total planted (จาก plant_count ใน planting_plans) - นับเฉพาะที่ไม่ยกเลิก
    const plantedResult = await pool.query(`
      SELECT COALESCE(SUM(plant_count), 0) as total
      FROM planting_plans
      WHERE station_id = $1 AND status != 'cancelled'
    `, [stationId]);

    // Total inbound tasks (นับจำนวนถาดที่มีสถานะ active)
    let totalInbound = 0;
    try {
      const inboundResult = await pool.query(`
        SELECT COUNT(DISTINCT tray_id) as total
        FROM tray_inventory
        WHERE station_id = $1 AND status = 'active'
      `, [stationId]);
      totalInbound = parseInt(inboundResult.rows[0].total);
    } catch (err) {
      console.log('tray_inventory table issue, trying alternative:', err.message);
      // ลองนับจาก planting_plans แทน
      try {
        const altResult = await pool.query(`
          SELECT COUNT(*) as total
          FROM planting_plans
          WHERE station_id = $1 AND status IN ('pending', 'in_progress')
        `, [stationId]);
        totalInbound = parseInt(altResult.rows[0].total);
      } catch {
        totalInbound = 0;
      }
    }

    // Total outbound tasks (จากการเก็บเกี่ยวที่เสร็จแล้ว)
    const outboundResult = await pool.query(`
      SELECT COUNT(*) as total
      FROM planting_plans
      WHERE station_id = $1 AND actual_harvest_date IS NOT NULL
    `, [stationId]);

    // Total work orders - ลองหาจากตารางที่มีจริง
    let totalWorkOrders = 0;
    try {
      // ลองจาก work_orders ก่อน
      const woResult = await pool.query(`
        SELECT COUNT(*) as total
        FROM work_orders
        WHERE station_id = $1
      `, [stationId]);
      totalWorkOrders = parseInt(woResult.rows[0].total);
    } catch (woError) {
      // ถ้าไม่มีตาราง work_orders ลองจาก work_order_tasks
      try {
        const wotResult = await pool.query(`
          SELECT COUNT(*) as total
          FROM work_order_tasks
          WHERE station_id = $1
        `, [stationId]);
        totalWorkOrders = parseInt(wotResult.rows[0].total);
      } catch (wotError) {
        console.log('No work orders table found, using 0');
        totalWorkOrders = 0;
      }
    }

    const stats = {
      totalPlanted: parseInt(plantedResult.rows[0].total) || 0,
      totalInbound: totalInbound,
      totalOutbound: parseInt(outboundResult.rows[0].total) || 0,
      totalWorkOrders: totalWorkOrders
    };

    // Statistics fetched
    res.json(stats);
  } catch (error) {
    console.error('Error fetching reports statistics:', error);
    res.status(500).json({
      error: 'Failed to fetch statistics',
      details: error.message,
      totalPlanted: 0,
      totalInbound: 0,
      totalOutbound: 0,
      totalWorkOrders: 0
    });
  }
});

// GET planting records
app.get('/api/reports/planting-records', async (req, res) => {
  try {
    const { station, page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;
    const stationId = parseInt(station); // แปลงเป็น integer

    // Fetching planting records

    // Query ดึงข้อมูลจริงจากตาราง
    const result = await pool.query(`
      SELECT
        pp.*,
        u.username
      FROM planting_plans pp
      LEFT JOIN users u ON pp.created_by = u.username
      WHERE pp.station_id = $1
      ORDER BY pp.created_at DESC
      LIMIT $2 OFFSET $3
    `, [stationId, limit, offset]);

    // Count total records
    const countResult = await pool.query(`
      SELECT COUNT(*) as total
      FROM planting_plans
      WHERE station_id = $1
    `, [stationId]);

    const total = parseInt(countResult.rows[0].total);
    // Found records

    // แปลงข้อมูลให้ตรงกับที่ frontend ต้องการ
    const formattedData = result.rows.map(row => ({
      planting_date: row.plant_date || row.planting_date || row.created_at,
      batch_id: row.batch_number || row.batch_id || '',
      variety_name: row.variety || '',
      plant_quantity: row.plant_count || row.quantity || 0,
      target_floor: row.level_required || row.level || row.floor || 1,
      status: row.status || 'pending',
      vegetable_type: row.vegetable_type || row.vegetable_name || '',
      harvest_date: row.harvest_date || null,
      actual_harvest_date: row.actual_harvest_date || null,
      username: row.username || 'System',
      created_at: row.created_at
    }));

    res.json({
      data: formattedData,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('❌ Error fetching planting records:', error.message);
    console.error('Stack:', error.stack);

    // ส่ง empty response แทน error
    res.json({
      data: [],
      pagination: { page: 1, limit: 50, total: 0, totalPages: 0 }
    });
  }
});

// GET work orders with pagination
app.get('/api/reports/work-orders', async (req, res) => {
  try {
    const { station, page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;
    const stationId = parseInt(station);

    // Fetching work orders

    // ดึงข้อมูลจาก planting_plans ที่มี status = 'in_progress'
    const result = await pool.query(`
      SELECT
        pp.id as work_order_id,
        pp.plan_id as work_order_number,
        pp.created_at,
        'planting' as type,
        pp.batch_number as batch_id,
        pp.status,
        0 as progress,
        pp.vegetable_type as vegetable_name,
        pp.level_required as target_floor,
        pp.plant_count,
        pp.plant_count as actual_count,
        pp.plant_date as target_date,
        pp.harvest_date,
        pp.completed_at,
        COALESCE(u.username, pp.created_by, 'System') as username,
        pp.priority,
        pp.variety
      FROM planting_plans pp
      LEFT JOIN users u ON pp.created_by = u.username
      WHERE pp.station_id = $1 AND pp.status = 'in_progress'
      ORDER BY pp.created_at DESC
      LIMIT $2 OFFSET $3
    `, [stationId, limit, offset]);

    // Count total
    const countResult = await pool.query(`
      SELECT COUNT(*) as total
      FROM planting_plans
      WHERE station_id = $1 AND status = 'in_progress'
    `, [stationId]);

    const total = parseInt(countResult.rows[0].total);
    // Found work orders

    res.json({
      data: result.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Error fetching work orders:', error);
    console.error('Error details:', error.message);
    res.status(500).json({
      error: 'Failed to fetch work orders',
      details: error.message,
      data: [],
      pagination: { page: 1, limit: 50, total: 0, totalPages: 0 }
    });
  }
});

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
    const result = await pool.query('SELECT id, username, password_hash, role FROM users WHERE username = $1', [username]);
    const user = result.rows[0];

    if (!user) {
      return res.status(400).json({ error: 'ชื่อผู้ใช้ไม่ถูกต้อง' });
    }

    // ตรวจสอบรหัสผ่าน
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(400).json({ error: 'รหัสผ่านไม่ถูกต้อง' });
    }

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
    work_order_id, planting_plan_id,
    // 🌊 รับฟิลด์ระบบน้ำและค่า EC, pH, water_close_date
    water_system, ec_value, ph_value, water_close_date
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

      // 🌊 เพิ่มฟิลด์ระบบน้ำและค่า EC, pH, water_close_date
      state.waterSystem = water_system;
      state.ecValue = ec_value;
      state.phValue = ph_value;
      state.waterCloseDate = water_close_date;

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
    await updateWorkOrdersOnOutbound(trayData.tray_id, reason, 'outbound');
    
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
                await updateWorkOrdersOnOutbound(completedTrayId, reason, actionType);
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
  const station = parseInt(req.query.station);

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

// ✅ LIGHT CONTROL API ENDPOINTS
// Get light control status
app.get('/api/lights/status', async (req, res) => {
  try {
    // ดึงข้อมูลจาก Database
    const result = await pool.query(`
      SELECT
        l.light_id,
        l.floor,
        l.position,
        l.name,
        json_agg(
          json_build_object(
            'device_type', d.device_type,
            'is_on', d.is_on,
            'intensity', d.intensity,
            'schedule_enabled', d.schedule_enabled,
            'schedule_on_time', d.schedule_on_time,
            'schedule_off_time', d.schedule_off_time
          )
        ) as devices
      FROM light_control_lights l
      LEFT JOIN light_control_devices d ON l.light_id = d.light_id
      GROUP BY l.light_id, l.floor, l.position, l.name
      ORDER BY l.floor, l.position
    `);

    // คำนวณ is_on แบบ real-time ตามเวลาปัจจุบัน
    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();

    const processedData = result.rows.map(light => {
      const processedDevices = light.devices.map(device => {
        // ถ้าเปิดตั้งเวลาอัตโนมัติ → คำนวณตามเวลา
        if (device.schedule_enabled && device.schedule_on_time && device.schedule_off_time) {
          const onMinutes = parseInt(device.schedule_on_time.split(':')[0]) * 60 + parseInt(device.schedule_on_time.split(':')[1]);
          const offMinutes = parseInt(device.schedule_off_time.split(':')[0]) * 60 + parseInt(device.schedule_off_time.split(':')[1]);

          let shouldBeOn = false;
          if (onMinutes > offMinutes) {
            // ข้ามวัน
            shouldBeOn = currentMinutes >= onMinutes || currentMinutes < offMinutes;
          } else {
            shouldBeOn = currentMinutes >= onMinutes && currentMinutes < offMinutes;
          }

          return { ...device, is_on: shouldBeOn };
        }
        // ถ้าไม่ได้เปิดตั้งเวลา → ใช้ค่าจาก Database (manual control)
        return device;
      });

      return { ...light, devices: processedDevices };
    });

    res.json(processedData);
  } catch (err) {
    console.error("❌ Fetch light status error:", err.message);
    console.error("❌ Stack trace:", err.stack);
    res.status(500).json({ error: "ไม่สามารถดึงข้อมูลสถานะไฟได้", details: err.message });
  }
});

// Get light schedules
app.get('/api/lights/schedule', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        d.*,
        l.name as light_name,
        l.floor,
        l.position
      FROM light_control_devices d
      JOIN light_control_lights l ON d.light_id = l.light_id
      WHERE d.schedule_enabled = true
      ORDER BY l.floor, l.position, d.schedule_on_time
    `);
    res.json(result.rows);
  } catch (err) {
    console.error("❌ Fetch light schedules error:", err.message);
    console.error("❌ Stack trace:", err.stack);
    res.status(500).json({ error: "ไม่สามารถดึงข้อมูลตารางเวลาไฟได้", details: err.message });
  }
});

// Update light status (manual control) - ใช้ Queue
app.post('/api/lights/control', async (req, res) => {
  const { deviceId, lightId, deviceType, isOn, intensity, userId, scheduleEnabled } = req.body;

  try {
    // อัพเดทโดยใช้ light_id และ device_type แทน id
    // ถ้ามี scheduleEnabled ให้อัพเดทด้วย (สำหรับ Manual Control)
    if (scheduleEnabled !== undefined) {
      await pool.query(
        `UPDATE light_control_devices
         SET is_on = $1, intensity = $2, schedule_enabled = $3, updated_at = NOW()
         WHERE light_id = $4 AND device_type = $5`,
        [isOn, intensity, scheduleEnabled, lightId, deviceType]
      );
    } else {
      await pool.query(
        `UPDATE light_control_devices
         SET is_on = $1, intensity = $2, updated_at = NOW()
         WHERE light_id = $3 AND device_type = $4`,
        [isOn, intensity, lightId, deviceType]
      );
    }

    // ส่งคำสั่งผ่าน Queue (ไม่ส่งตรง)
    addLightCommandToQueue(lightId, deviceType, isOn, intensity);

    // ส่ง WebSocket update ให้ UI
    broadcastToClients('light_update', {
      lightId,
      deviceType,
      isOn,
      intensity
    });

    // Log activity
    await logActivity({
      userId,
      activity: `${isOn ? 'เปิด' : 'ปิด'}${deviceType} ID: ${lightId} ความเข้ม ${intensity}%`,
      action_type: 'light',
      category: 'Light Control'
    });

    res.json({ success: true, message: "เพิ่มคำสั่งเข้า Queue แล้ว" });
  } catch (err) {
    console.error("❌ Light control error:", err.message);
    res.status(500).json({ error: "ไม่สามารถควบคุมไฟได้" });
  }
});

// Save light schedule (single)
app.post('/api/lights/schedule', async (req, res) => {
  const { deviceId, scheduleEnabled, scheduleOnTime, scheduleOffTime, userId } = req.body;

  try {
    await pool.query(
      `UPDATE light_control_devices
       SET schedule_enabled = $1,
           schedule_on_time = $2,
           schedule_off_time = $3,
           updated_at = NOW()
       WHERE id = $4`,
      [scheduleEnabled, scheduleOnTime, scheduleOffTime, deviceId]
    );

    await logActivity({
      userId,
      activity: `ตั้งเวลาไฟ Device ID: ${deviceId} ${scheduleOnTime} - ${scheduleOffTime}`,
      action_type: 'light',
      category: 'Light Schedule'
    });

    res.json({ success: true, message: "บันทึกตารางเวลาสำเร็จ" });
  } catch (err) {
    console.error("❌ Save schedule error:", err.message);
    res.status(500).json({ error: "ไม่สามารถบันทึกตารางเวลาได้" });
  }
});

// Save light schedules in batch (189 schedules with MQTT rate limiting)
app.post('/api/lights/schedule/batch', async (req, res) => {
  const schedules = req.body;

  if (!Array.isArray(schedules)) {
    return res.status(400).json({ error: "Invalid data format" });
  }

  // Processing batch schedule update

  const client = await pool.connect();

  try {
    // เริ่ม Transaction
    await client.query('BEGIN');

    let successCount = 0;
    let errorCount = 0;
    const commandsToQueue = []; // เก็บคำสั่งไว้ส่งหลัง commit สำเร็จ

    // ประมวลผลทีละรายการเพื่อป้องกัน MQTT ล้น (แต่ยังเร็วพอ)
    for (let i = 0; i < schedules.length; i++) {
      const schedule = schedules[i];
      const { floor, fixture, type, enabled, onTime, offTime, intensity } = schedule;
      const lightId = `L${floor}-${fixture}`;

      // Map type to device_type
      const deviceTypeMap = {
        'light-white': 'whiteLight',
        'light-red': 'redLight',
        'fan': 'fan'
      };
      const deviceType = deviceTypeMap[type];

      // คำนวณว่าควรเปิดหรือปิดตามเวลาปัจจุบัน
      let shouldBeOn = false;
      if (enabled) {
        const now = new Date();
        const currentMinutes = now.getHours() * 60 + now.getMinutes();
        const onMinutes = parseInt(onTime.split(':')[0]) * 60 + parseInt(onTime.split(':')[1]);
        const offMinutes = parseInt(offTime.split(':')[0]) * 60 + parseInt(offTime.split(':')[1]);

        if (onMinutes > offMinutes) {
          // ข้ามวัน
          shouldBeOn = currentMinutes >= onMinutes || currentMinutes < offMinutes;
        } else {
          shouldBeOn = currentMinutes >= onMinutes && currentMinutes < offMinutes;
        }

        // Schedule calculation
      }

      // อัปเดตฐานข้อมูล (เพิ่ม is_on ตามเวลาปัจจุบัน)
      await client.query(
        `UPDATE light_control_devices
         SET schedule_enabled = $1,
             schedule_on_time = $2,
             schedule_off_time = $3,
             intensity = $4,
             is_on = $5,
             updated_at = NOW()
         WHERE light_id = $6 AND device_type = $7`,
        [enabled, onTime, offTime, intensity, shouldBeOn, lightId, deviceType]
      );

      // เก็บคำสั่งไว้ส่งทีหลัง (หลัง COMMIT สำเร็จ)
      // ✅ ส่งคำสั่งทั้ง enabled และ disabled (ปิดอุปกรณ์ที่ไม่ติ๊ก)
      if (enabled) {
        commandsToQueue.push({
          lightId,
          deviceType,
          isOn: shouldBeOn,
          intensity: shouldBeOn ? intensity : 0
        });
      } else {
        // ถ้าไม่ได้ติ๊ก → ส่งคำสั่งปิดอุปกรณ์
        commandsToQueue.push({
          lightId,
          deviceType,
          isOn: false,
          intensity: 0
        });
      }

      successCount++;

      // แสดง progress ทุก 20 รายการ
      if ((i + 1) % 20 === 0) {
        // Batch progress
      }
    }

    // ถ้าทุกอย่างสำเร็จ ให้ COMMIT
    await client.query('COMMIT');
    // Transaction committed

    // ส่งคำสั่งเข้า Queue หลัง COMMIT สำเร็จ
    commandsToQueue.forEach(cmd => {
      addLightCommandToQueue(cmd.lightId, cmd.deviceType, cmd.isOn, cmd.intensity);
    });
    // Added commands to MQTT queue

    // Log activity (ใช้ userId = 1 ถ้าไม่มี)
    const userId = schedules[0]?.userId || 1;
    await logActivity({
      userId: Number(userId),
      activity: `ตั้งเวลาอุปกรณ์แบบ Batch (${successCount}/${schedules.length} รายการ)`,
      action_type: 'light',
      category: 'Light Schedule Batch'
    });

    res.json({
      success: true,
      message: `บันทึกตารางเวลาสำเร็จ ${successCount} รายการ`,
      successCount,
      errorCount: 0,
      queuedCommands: commandsToQueue.length
    });
  } catch (err) {
    // ถ้ามีข้อผิดพลาด ให้ ROLLBACK
    await client.query('ROLLBACK');
    console.error("❌ Batch schedule error - ROLLED BACK:", err.message);
    res.status(500).json({ error: "ไม่สามารถบันทึกตารางเวลาแบบ batch ได้ (ยกเลิกทั้งหมด)" });
  } finally {
    client.release();
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
      // Home system: {"Key":"142B2FC933E0","Profile":"1.5","Volume":"30","Device":"Open"}
      mqttTopic = 'water/home';
      mqttMessage = JSON.stringify({
        Key: "142B2FC933E0",
        Profile: payload.Profile,
        Volume: payload.Volume,
        Device: payload.Device
      });
    } else if (type === 'layer') {
      // Layer system: {"Key":"1097BD225248","Device":"1","Status":"Open"}
      mqttTopic = 'water/layer';
      mqttMessage = JSON.stringify({
       Key: "ECE334469544", // <--- แก้ไขตรงนี้
        Device: payload.Device,
        Status: payload.Status
      });
    } else if (type === 'valve') {
      // Valve system: {"Key":"1097BD225248","Device":"1","Status":"Open"}
      mqttTopic = 'water/valve';
      mqttMessage = JSON.stringify({
        Key: "ECE334469544",
        Device: payload.Device,
        Status: payload.Status
      });
    } else {
      return res.status(400).json({ error: 'Invalid type. Use "home", "layer", or "valve"' });
    }

    // Publish to MQTT
    mqttClient.publish(mqttTopic, mqttMessage, { qos: 1 }, (err) => {
      if (err) {
        console.error('❌ MQTT Publish Error:', err);
        return res.status(500).json({ 
          success: false, 
          error: 'Failed to publish MQTT message',
          details: err.message 
        });
      }

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
// ✅ Performance optimization: HTTP server settings
const server = require('http').createServer(app);
server.keepAliveTimeout = 5000;
server.headersTimeout = 6000;
server.timeout = 30000;

// ✅ ระบบตรวจสอบตารางเวลาอัตโนมัติ (Auto Schedule Checker)
async function checkLightSchedules() {
  try {
    const now = new Date();
    const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    // Checking schedules

    // ดึงข้อมูล schedules ที่เปิดใช้งาน
    const result = await pool.query(`
      SELECT
        d.id,
        d.light_id,
        d.device_type,
        d.is_on,
        d.intensity,
        d.schedule_on_time,
        d.schedule_off_time,
        l.floor,
        l.position,
        l.name
      FROM light_control_devices d
      JOIN light_control_lights l ON d.light_id = l.light_id
      WHERE d.schedule_enabled = true
    `);

    if (!result || !result.rows) {
      console.error('❌ Failed to fetch schedule data');
      return;
    }

    // Found devices with schedule enabled

    let onCount = 0;
    let offCount = 0;

    for (const device of result.rows) {
      // คำนวณว่าควรเปิดหรือปิดตามช่วงเวลา
      const currentMinutes = now.getHours() * 60 + now.getMinutes();
      const onMinutes = parseInt(device.schedule_on_time.split(':')[0]) * 60 + parseInt(device.schedule_on_time.split(':')[1]);
      const offMinutes = parseInt(device.schedule_off_time.split(':')[0]) * 60 + parseInt(device.schedule_off_time.split(':')[1]);

      let shouldBeOn;
      if (onMinutes > offMinutes) {
        // ข้ามวัน (เช่น 18:00 - 06:00)
        shouldBeOn = currentMinutes >= onMinutes || currentMinutes < offMinutes;
      } else {
        // ปกติ (เช่น 06:00 - 18:00)
        shouldBeOn = currentMinutes >= onMinutes && currentMinutes < offMinutes;
      }

      // ถ้าควรเปิด แต่ตอนนี้ปิดอยู่
      if (shouldBeOn && !device.is_on) {
        // Auto ON

        // อัปเดตฐานข้อมูล
        await pool.query(
          `UPDATE light_control_devices SET is_on = true, updated_at = NOW() WHERE id = $1`,
          [device.id]
        );

        // ส่งคำสั่งผ่าน Queue
        addLightCommandToQueue(device.light_id, device.device_type, true, device.intensity);
        onCount++;

        // ส่ง WebSocket update
        broadcastToClients('light_update', {
          lightId: device.light_id,
          deviceType: device.device_type,
          isOn: true,
          intensity: device.intensity
        });
      }

      // ถ้าควรปิด แต่ตอนนี้เปิดอยู่
      if (!shouldBeOn && device.is_on) {
        // Auto OFF

        // อัปเดตฐานข้อมูล
        await pool.query(
          `UPDATE light_control_devices SET is_on = false, updated_at = NOW() WHERE id = $1`,
          [device.id]
        );

        // ส่งคำสั่งผ่าน Queue
        addLightCommandToQueue(device.light_id, device.device_type, false, 0);
        offCount++;

        // ส่ง WebSocket update
        broadcastToClients('light_update', {
          lightId: device.light_id,
          deviceType: device.device_type,
          isOn: false,
          intensity: 0
        });
      }
    }

    if (onCount > 0 || offCount > 0) {
      // Schedule check complete
    }
  } catch (err) {
    console.error('❌ Error checking light schedules:', err.message);
    console.error('❌ Stack trace:', err.stack);
  }
}

server.listen(PORT, '0.0.0.0', async () => {
  console.log(`🚀 Server is running at http://0.0.0.0:${PORT}`);
  console.log(`📊 Memory usage: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB`);

  // ✅ เริ่มระบบตรวจสอบตารางเวลาอัตโนมัติ (ทุก 1 นาที)
  setInterval(checkLightSchedules, 60000);
  console.log('⏰ Light schedule checker started (every 1 minute)');
});

// ✅ WebSocket Server for real-time updates
const wss = new WebSocket.Server({ server });
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);

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
  if (wss.clients.size === 0) return; // Skip if no clients
  
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      clients.delete(ws);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 60000); // เพิ่มจาก 30 เป็น 60 วินาที

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

    // ✅ ป้องกัน "" ส่งเข้าฐานข้อมูล (จะ error) และป้องกัน NaN
    const parsedStation = station === "" || station === null || station === undefined ? null : station;
    const parsedFloor = floor === "" || floor === null || floor === undefined || isNaN(parseInt(floor)) ? null : parseInt(floor);
    const parsedSlot = slot === "" || slot === null || slot === undefined || isNaN(parseInt(slot)) ? null : parseInt(slot);
    const parsedVegType = veg_type === "" || veg_type === null || veg_type === undefined ? null : veg_type;

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
  const stationId = req.query.station; 
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


// ✅ [เพิ่มใหม่] API สำหรับดึงถาดที่กำลังปลูก (แก้ปัญหาข้อมูลซ้ำซ้อน)
app.get('/api/tray-inventory/planting-progress', async (req, res) => {
  try {
    const { station } = req.query;
    // ✨✨✨ [จุดสำคัญ] ✨✨✨
    // JOIN จาก tray_inventory ไปยัง planting_plans เพื่อหลีกเลี่ยงข้อมูลซ้ำจาก work_orders
    // และรองรับการกรองตามสถานี (station_id) หากมีการระบุมา

    let baseQuery = `
      SELECT
        ti.*, -- เลือกข้อมูลทั้งหมดจาก tray_inventory
        pp.plan_id,
        pp.vegetable_type as plan_vegetable_type,
        pp.plant_date,
        pp.priority,
        pp.notes as plan_notes,
        pp.status as plan_status,
        pp.water_system,
        pp.ec_value,
        pp.ph_value,
        pp.water_close_date as plan_water_close_date
      FROM
        tray_inventory ti
      LEFT JOIN
        planting_plans pp ON ti.planting_plan_id = pp.id
      WHERE
        ti.status = 'on_shelf'
    `;

    const params = [];
    if (station) {
      baseQuery += ` AND ti.station_id = $1`;
      params.push(parseInt(station));
    }

    baseQuery += ` ORDER BY ti.harvest_date ASC, ti.time_in DESC`;

    const result = await pool.query(baseQuery, params);

    // Found in-progress trays
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

    // เพิ่มการตรวจสอบว่า DOM พร้อมหรือไม่
    const grid = document.querySelector(".tray-grid");
    if (grid) {
      renderTrayGrid(); // เรียกเมื่อ DOM พร้อม
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

//  Overview API สำหรับหน้า overview
app.get('/api/overview', async (req, res) => {
  try {
    const station = parseInt(req.query.station);
    
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

//  Summary Cards API
//   API สำหรับ Summary Cards ในหน้า Overview
app.get('/api/overview/summary-cards', async (req, res) => {
  try {
    const stationId = req.query.station;

    // 1. Inbound/Outbound วันนี้ (ส่วนนี้ถูกต้องแล้ว)
    const todayStatsRes = await pool.query(
      `SELECT
         SUM(CASE WHEN action_type = 'inbound' THEN 1 ELSE 0 END) as today_inbound,
         SUM(CASE WHEN action_type = 'outbound' THEN 1 ELSE 0 END) as today_outbound
       FROM tray_history
       WHERE station_id = $1 AND created_at >= CURRENT_DATE`,
      [stationId]
    );

    // 2.จำนวนถาดในคลังทั้งหมดจากตาราง tray_inventory ✅✅✅
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

//  API สำหรับดึงข้อมูลตามชั่วโมง (24 ชั่วโมงย้อนหลัง)
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

//  API สำหรับดึงข้อมูลกราฟย้อนหลัง 30 วัน
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

//  - ค้นหาฟังก์ชัน initializeTables แล้วนำโค้ดนี้ไปวางทับของเดิมทั้งหมด

const initializeTables = async () => {
  try {
    // ตาราง planting_plans - เก็บข้อมูลแผนการปลูกจากภายนอก
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

    //  ตาราง work_orders - ใบงานที่สร้างจากแผนการปลูก
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

    //  ตาราง work_order_tasks - รายละเอียดงานย่อย
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
  } catch (err) {
    console.error('❌ Error initializing tables:', err.message);
  }
};


// เรียกใช้ฟังก์ชันสร้างตาราง
initializeTables();

//  API endpoint สำหรับรับข้อมูลแผนการปลูกจากภายนอก
app.post('/api/planting-plan', async (req, res) => {
  try {
    //  รับข้อมูลครบถ้วนจากภายนอก
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
      //  เพิ่มข้อมูลที่อาจขาดหาย
      priority = 'normal',
      notes = '',
      created_by = 'external_system',
      //  🌊 เพิ่มฟิลด์ใหม่: ระบบน้ำและค่า EC, pH
      water_system,
      ec_value,
      ph_value
    } = req.body;
    
    //  Validate ข้อมูลที่จำเป็น
    if (!vegetable_name || !level || !planting_date || !harvest_date || !plant_count) {
      return res.status(400).json({ 
        error: 'Missing required fields: vegetable_name, level, planting_date, harvest_date, plant_count' 
      });
    }

    // บันทึกข้อมูลแผนการปลูกพร้อมข้อมูลเพิ่มเติม
    const planResult = await pool.query(`
      INSERT INTO planting_plans (
        external_plan_id, vegetable_type, level_required, plant_date, harvest_date,
        plant_count, variety, batch_number, source_system, status, notes, created_by,
        water_system, ec_value, ph_value
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'received', $10, $11, $12, $13, $14)
      RETURNING *
    `, [external_plan_id, vegetable_name, level, planting_date, harvest_date, plant_count, variety || '', batch_number || '', source_system || 'external', notes, created_by, water_system, ec_value, ph_value]);

    const plan = planResult.rows[0];

    //  สร้างใบงานอัตโนมัติ
    const workOrderNumber = `WO-${Date.now()}-${plan.id}`;
    
    // สร้างใบงานปลูก
    const plantingOrder = await pool.query(`
      INSERT INTO work_orders (
        planting_plan_id, work_order_number, task_type, vegetable_name,
        level, target_date, plant_count, priority, status,
        water_system, ec_value, ph_value
      ) VALUES ($1, $2, 'planting', $3, $4, $5, $6, 'high', 'pending', $7, $8, $9)
      RETURNING *
    `, [plan.id, `${workOrderNumber}-PLANT`, vegetable_name, level, planting_date, plant_count, water_system, ec_value, ph_value]);

    // สร้างใบงานเก็บเกี่ยว
    const harvestOrder = await pool.query(`
      INSERT INTO work_orders (
        planting_plan_id, work_order_number, task_type, vegetable_name,
        level, target_date, plant_count, priority, status,
        water_system, ec_value, ph_value
      ) VALUES ($1, $2, 'harvest', $3, $4, $5, $6, 'normal', 'pending', $7, $8, $9)
      RETURNING *
    `, [plan.id, `${workOrderNumber}-HARVEST`, vegetable_name, level, harvest_date, plant_count, water_system, ec_value, ph_value]);

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

//  [FINAL & TESTED VERSION] API ดึงรายการแผนการปลูก 
app.get('/api/planting-plans', async (req, res) => {
  try {
    const { status, vegetable_type, limit = 50, station } = req.query;

    let baseQuery = `
      SELECT
        pp.id, pp.plan_id, pp.vegetable_type, pp.plant_date, pp.harvest_date, pp.actual_harvest_date,
        pp.plant_count, pp.level_required, pp.priority, pp.status, pp.notes, pp.harvest_notes,
        pp.created_by, pp.completed_by, pp.completed_at,
        pp.created_at, pp.updated_at, pp.batch_number, pp.variety, pp.station_id,
        pp.water_system, pp.ec_value, pp.ph_value, pp.water_close_date
      FROM planting_plans pp
    `;

    const params = [];
    let finalQuery = '';

    // ⭐️ [จุดแก้ไขสำคัญ] แยกตรรกะการกรองให้ชัดเจนและตรงไปตรงมา
    let whereConditions = [];

    if (station) {
      whereConditions.push(`pp.station_id = $${params.length + 1}`);
      params.push(parseInt(station));
    }

    if (status && status.trim() !== '') {
      whereConditions.push(`pp.status = $${params.length + 1}`);
      params.push(status.trim());
    }

    if (vegetable_type && vegetable_type.trim() !== '') {
      whereConditions.push(`pp.vegetable_type = $${params.length + 1}`);
      params.push(vegetable_type.trim());
    }

    if (whereConditions.length > 0) {
      finalQuery = `${baseQuery} WHERE ${whereConditions.join(' AND ')} ORDER BY pp.created_at DESC LIMIT $${params.length + 1}`;
    } else {
      finalQuery = `${baseQuery} ORDER BY pp.created_at DESC LIMIT $${params.length + 1}`;
    }
    params.push(parseInt(limit));

    console.log('🔍 Query:', finalQuery);
    console.log('🔍 Params:', params);

    const result = await pool.query(finalQuery, params);

    console.log(`✅ Found ${result.rows.length} planting plans`);

    res.json({
      success: true,
      planting_plans: result.rows,
      count: result.rows.length
    });

  } catch (err) {
    console.error('❌ Error in /api/planting-plans:', err.message);
    console.error('❌ Stack:', err.stack);
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
        //  [แก้ไข] เปลี่ยน vegetable_type เป็น vegetable_name ให้ตรงกับ Schema
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

        //  [แก้ไข] บันทึกแผนการปลูกด้วยชื่อ column ที่ถูกต้อง
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
  },
  2: {
    flowState: 'idle',
    latestLiftStatus: {},
    latestAgvStatus: {},
    latestAgvSensorStatus: {},
    latestAirQualityData: {},
    trayActionDone: false,
    targetFloor: null,
    targetSlot: null,
    taskType: null,
    sensorDebounceTimer: null
  },
  3: {
    flowState: 'idle',
    latestLiftStatus: {},
    latestAgvStatus: {},
    latestAgvSensorStatus: {},
    latestAirQualityData: {},
    trayActionDone: false,
    targetFloor: null,
    targetSlot: null,
    taskType: null,
    sensorDebounceTimer: null
  },
  4: {
    flowState: 'idle',
    latestLiftStatus: {},
    latestAgvStatus: {},
    latestAgvSensorStatus: {},
    latestAirQualityData: {},
    trayActionDone: false,
    targetFloor: null,
    targetSlot: null,
    taskType: null,
    sensorDebounceTimer: null
  },
  5: {
    flowState: 'idle',
    latestLiftStatus: {},
    latestAgvStatus: {},
    latestAgvSensorStatus: {},
    latestAirQualityData: {},
    trayActionDone: false,
    targetFloor: null,
    targetSlot: null,
    taskType: null,
    sensorDebounceTimer: null
  }
};

// =================================================================
// 🔵 MQTT Client Setup
// =================================================================
// MQTT Connect Event
mqttClient.on('connect', () => {
  //  Subscribe Topic ของ Lift, AGV, และ Tray สำหรับทุก station (1-5)
  for (let i = 1; i <= 5; i++) {
    mqttClient.subscribe(`automation/station${i}/lift/status`);
    mqttClient.subscribe(`automation/station${i}/agv/status`);
    mqttClient.subscribe(`automation/station${i}/lift/tray_action_done`);
    mqttClient.subscribe(`automation/station${i}/agv/sensors`);
    mqttClient.subscribe(`automation/station${i}/air/quality`);
  }
  mqttClient.subscribe('Layer_2/#', (err) => {
    if (err) {
      console.error("❌ Failed to subscribe to water topics:", err);
    }
  });
});

  


// MQTT Message Handler (รวม Logic ของ Lift, AGV, และ Tray)
mqttClient.on('message', async (topic, message) => {
  const msg = message.toString();

  // แยก station ID จาก topic (รองรับทุก station 1-5)
  let stationId = 1; // default
  const stationMatch = topic.match(/station(\d+)/);
  if (stationMatch) {
    stationId = parseInt(stationMatch[1]);
  }

  const state = stationStates[stationId];
  if (!state) return; // ป้องกันข้อผิดพลาดหากไม่มี state

//  Logic สำหรับรับข้อมูลเซ็นเซอร์ AGV พร้อม Debounce
  if (topic.includes('/agv/sensors')) {
    try {
      const payload = JSON.parse(msg);
      
      //  เช็คว่าข้อมูลเปลี่ยนแปลงหรือไม่ก่อนส่ง
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

          //  ส่งข้อมูล sensor เฉพาะตอนที่เปลี่ยนแปลงผ่าน WebSocket
          broadcastToClients('sensor_update', payload);

          // Clear timer reference
          state.sensorDebounceTimer = null;
        }, 50); // 50ms debounce delay - เร็วขึ้น 6 เท่า
      }
    } catch (err) {
      console.error('❌ Failed to parse AGV sensor MQTT payload:', err.message);
    }
  }
  
  // Logic สำหรับรับข้อมูลเซ็นเซอร์อากาศ (CO2, Temperature, Humidity)
  if (topic.includes('/air/quality') || msg.includes('CO2:') || msg.includes('Temp:') || msg.includes('Humidity:')) {
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
        
        //  บันทึกข้อมูลลงฐานข้อมูล
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
        } catch (dbError) {
          console.error('❌ Failed to save air quality data to database:', dbError.message);
        }

        // ส่งข้อมูลผ่าน WebSocket
        broadcastToClients('air_quality_update', state.latestAirQualityData);
      }
    } catch (err) {
      console.error('❌ Failed to parse air quality data:', err.message);
    }
  }
  
  // 🔽 Logic สำหรับ Lift Status
  if (topic.includes('/lift/status')) {
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
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
        ON CONFLICT (station) DO UPDATE
        SET floor = EXCLUDED.floor,
            moving = EXCLUDED.moving,
            emergency = EXCLUDED.emergency,
            recovery = EXCLUDED.recovery,
            step = EXCLUDED.step,
            updated_at = EXCLUDED.updated_at
      `, [stationId, floor, moving, emergency, recovery, step]);

      console.log(`✅ [DB] Updated lift_status Station ${stationId} → Floor:`, floor, "| Step:", step, "| Moving:", moving, "| EM:", emergency, "| Recovery:", recovery);
      handleFlow(stationId);

    } catch (err) {
      console.error("❌ Failed to update lift_status:", err.message);
      console.error("🔸 Raw message:", msg);
    }
  }

  // 🔽 Logic สำหรับ AGV Status
  if (topic.includes('/agv/status')) {
    try {
      const payload = JSON.parse(msg);
      state.latestAgvStatus = payload; // เก็บสถานะล่าสุด
      console.log(`[MQTT] 📡 รับ AGV Status Station ${stationId}:`, payload.status);

      // ✅ [แก้ไข] ลบ Logic การอัปเดต DB ออกจากส่วนนี้ แล้วเรียก handleFlow อย่างเดียว
      handleFlow(stationId);

    } catch (err) {
      console.error('❌ Failed to parse AGV status MQTT payload:', err.message);
    }
  }

  // 🔽 Logic เมื่อถาดทำงานเสร็จ
  if (topic.includes('/lift/tray_action_done')) {
    state.trayActionDone = true;
    console.log(`[Tray] ✅ ถาดทำงานเสร็จแล้ว Station ${stationId}`);
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
  const stationId = parseInt(req.query.station);
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
      mqttClient.publish(`automation/station${stationId}/tray/command`, JSON.stringify({ command: 'pickup_tray' }));
      state.flowState = 'inbound_wait_for_tray_lift';
      break;

    case 'inbound_wait_for_tray_lift':
      if (state.trayActionDone) {
        logState(stationId, `[INBOUND] ยกถาดสำเร็จ → รอ 0.5 วินาที`);
        await delay(500);
        state.trayActionDone = false;
        logState(stationId, `[INBOUND] เริ่มเคลื่อนที่`);
        if (state.targetFloor === 1) {
          logState(stationId, 'ชั้น 1 → ไม่ใช้ลิฟต์ → ไป slot ทันที');
          mqttClient.publish(`automation/station${stationId}/agv/command`, JSON.stringify({ command: getGoToSlotCommand(state.targetSlot) }));
          state.flowState = 'wait_agv_at_slot';
        } else {
          logState(stationId, 'ชั้น ≠ 1 → ต้องใช้ลิฟต์ → เริ่มต้น AGV ไป lift');
          mqttClient.publish(`automation/station${stationId}/agv/command`, JSON.stringify({ command: 'go_lift' }));
          state.flowState = 'wait_agv_at_lift';
        }
      }
      break;

    case 'start':
      logState(stationId, `[OUTBOUND] เริ่มต้น → เริ่มเคลื่อนที่ไป Slot`);
      if (state.targetFloor === 1) {
        mqttClient.publish(`automation/station${stationId}/agv/command`, JSON.stringify({ command: getGoToSlotCommand(state.targetSlot) }));
        state.flowState = 'wait_agv_at_slot';
      } else {
        mqttClient.publish(`automation/station${stationId}/agv/command`, JSON.stringify({ command: 'go_lift' }));
        state.flowState = 'wait_agv_at_lift';
      }
      break;

    case 'wait_agv_at_lift':
      if (agv?.location === 'at_lift') {
        logState(stationId, 'AGV ถึง Lift → รอ 0.5 วินาทีเพื่อความเสถียร');
        await delay(500);
        logState(stationId, 'AGV ถึง Lift → ยกลิฟต์ขึ้นชั้นเป้าหมาย');
        mqttClient.publish(`automation/station${stationId}/lift/command`, JSON.stringify({ action: 'moveTo', floor: state.targetFloor }));
        state.flowState = 'lift_moving_up';
      }
      break;

    case 'lift_moving_up':
      if (!lift?.moving && lift?.floor === state.targetFloor) {
        logState(stationId, `Lift ถึงชั้น ${state.targetFloor} → รอ 0.5 วินาที`);
        await delay(500);
        logState(stationId, `Lift ถึงชั้น ${state.targetFloor} → AGV ไปยัง slot`);
        mqttClient.publish(`automation/station${stationId}/agv/command`, JSON.stringify({ command: getGoToSlotCommand(state.targetSlot) }));
        state.flowState = 'wait_agv_at_slot';
      }
      break;

    case 'wait_agv_at_slot':
      if (agv?.location === 'at_slot') {
        logState(stationId, `AGV ถึงช่องแล้ว → รอ 0.5 วินาทีเพื่อความเสถียร`);
        await delay(500);
        const trayCommand = (state.taskType === 'inbound') ? 'place_tray' : 'pickup_tray';
        logState(stationId, `AGV ถึงช่องแล้ว → สั่ง ${trayCommand}`);
        mqttClient.publish(`automation/station${stationId}/tray/command`, JSON.stringify({ command: trayCommand }));
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
          `INSERT INTO tray_inventory (tray_id, veg_type, floor, slot, username, time_in, plant_quantity, batch_id, seeding_date, notes, status, station_id, planting_plan_id, harvest_date, water_system, ec_value, ph_value, water_close_date)
           VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7, $8, $9, 'on_shelf', $10, $11, $12, $13, $14, $15, $16)`,
          [
            state.trayId, state.vegType, state.targetFloor, state.targetSlot,
            state.username, state.plantQuantity, state.batchId,
            state.seedingDate, state.notes, state.stationId,
            state.plantingPlanId, // 👈 บันทึก ID ของ Plan
            harvestDate,          // 👈 บันทึกวันเก็บเกี่ยว
            state.waterSystem,    // 🌊 บันทึกระบบน้ำ
            state.ecValue,        // ⚡ บันทึกค่า EC
            state.phValue,        // 💧 บันทึกค่า pH
            state.waterCloseDate  // 💦 บันทึกวันปิดน้ำ
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

    if (state.targetFloor === 1) {
      logState(stationId, 'ชั้น 1 → AGV กลับบ้านเลย');
      mqttClient.publish(`automation/station${stationId}/agv/command`, JSON.stringify({ command: 'go_home' }));
      state.flowState = 'wait_agv_home';
    } else {
      logState(stationId, 'ชั้น ≠ 1 → AGV กลับไปที่ lift');
      mqttClient.publish(`automation/station${stationId}/agv/command`, JSON.stringify({ command: 'go_lift' }));
      state.flowState = 'wait_agv_return_to_lift';
    }
  }
  break;

    case 'wait_agv_return_to_lift':
      if (agv?.location === 'at_lift') {
        logState(stationId, 'AGV กลับถึง Lift → รอ 0.5 วินาที');
        await delay(500);
        logState(stationId, 'AGV กลับถึง Lift → สั่งลิฟต์ลงชั้น 1');
        mqttClient.publish(`automation/station${stationId}/lift/command`, JSON.stringify({ action: 'moveTo', floor: 1 }));
        state.flowState = 'lift_moving_down';
      }
      break;

    case 'lift_moving_down':
      if (!lift?.moving && lift?.floor === 1) {
        logState(stationId, 'Lift ลงถึงชั้น 1 → รอ 0.5 วินาที');
        await delay(500);
        logState(stationId, 'Lift ลงถึงชั้น 1 → AGV กลับบ้าน');
        mqttClient.publish(`automation/station${stationId}/agv/command`, JSON.stringify({ command: 'go_home' }));
        state.flowState = 'wait_agv_home';
      }
      break;

    case 'wait_agv_home':
      if (agv?.location === 'home' || agv?.location === 'at_home') {
        logState(stationId, 'AGV ถึงบ้านแล้ว → รอ 0.5 วินาที');
        await delay(500);
        if (state.taskType === 'outbound') {
          logState(stationId, '[OUTBOUND] AGV ถึงบ้านแล้ว → สั่งวางถาด (place_tray)');
          mqttClient.publish(`automation/station${stationId}/tray/command`, JSON.stringify({ command: 'place_tray' }));
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
    const stationId = req.query.station;

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
    const station = parseInt(req.query.station);
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
// 💡 API Endpoints สำหรับระบบควบคุมแสงสว่าง (Modbus RTU)
// ===============================================

// GET /api/light-control/status - ดึงสถานะไฟทั้งหมด
app.get('/api/light-control/status', async (req, res) => {
    try {
        const { rows: lights } = await pool.query('SELECT * FROM light_control_lights ORDER BY floor, position');
        const { rows: devices } = await pool.query('SELECT * FROM light_control_devices ORDER BY light_id, device_type');

        const result = lights.map(light => {
            const lightDevices = devices.filter(d => d.light_id === light.light_id);
            return {
                lightId: light.light_id,
                floor: light.floor,
                position: light.position,
                name: light.name,
                devices: {
                    whiteLight: lightDevices.find(d => d.device_type === 'whiteLight') || {},
                    redLight: lightDevices.find(d => d.device_type === 'redLight') || {},
                    fan: lightDevices.find(d => d.device_type === 'fan') || {}
                }
            };
        });

        res.json(result);
    } catch (error) {
        console.error('❌ Error fetching light status:', error);
        res.status(500).json({ error: 'เกิดข้อผิดพลาดในการดึงข้อมูล' });
    }
});

// POST /api/light-control/control - ควบคุมไฟแบบ Manual
app.post('/api/light-control/control', async (req, res) => {
    const { lightId, deviceType, intensity, isOn } = req.body;

    try {
        // ดึงข้อมูลโคมไฟ
        const { rows } = await pool.query(
            'SELECT floor FROM light_control_lights WHERE light_id = $1',
            [lightId]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: 'ไม่พบโคมไฟที่ระบุ' });
        }

        const floor = rows[0].floor;
        const finalIntensity = isOn ? intensity : 0;

        // ส่งคำสั่ง Modbus
        sendModbusCommand(mqttClient, floor, lightId, deviceType, finalIntensity);

        // บันทึกสถานะลง Database
        await pool.query(
            `UPDATE light_control_devices
             SET is_on = $1, intensity = $2, updated_at = NOW()
             WHERE light_id = $3 AND device_type = $4`,
            [isOn, intensity, lightId, deviceType]
        );

        res.json({
            message: 'ส่งคำสั่งสำเร็จ',
            lightId,
            deviceType,
            intensity: finalIntensity
        });

    } catch (error) {
        console.error('❌ Error controlling light:', error);
        res.status(500).json({ error: 'เกิดข้อผิดพลาดในการควบคุมไฟ' });
    }
});

// POST /api/light-control/schedule - อัพเดทตารางเวลา
app.post('/api/light-control/schedule', async (req, res) => {
    const { lightId, deviceType, scheduleEnabled, scheduleOnTime, scheduleOffTime, intensity } = req.body;

    try {
        await pool.query(
            `UPDATE light_control_devices
             SET schedule_enabled = $1,
                 schedule_on_time = $2,
                 schedule_off_time = $3,
                 intensity = $4,
                 updated_at = NOW()
             WHERE light_id = $5 AND device_type = $6`,
            [scheduleEnabled, scheduleOnTime, scheduleOffTime, intensity, lightId, deviceType]
        );

        res.json({ message: 'บันทึกตารางเวลาสำเร็จ' });

    } catch (error) {
        console.error('❌ Error updating schedule:', error);
        res.status(500).json({ error: 'เกิดข้อผิดพลาดในการบันทึกตารางเวลา' });
    }
});

// POST /api/light-control/debug - เครื่องมือทดสอบ Modbus
app.post('/api/light-control/debug', async (req, res) => {
    const { slaveId, functionCode, registerAddress, value } = req.body;

    try {
        const slave = new ModbusSlave(slaveId);
        let modbusFrame;

        if (functionCode === 0x03 || functionCode === 0x04) {
            // Read operation
            modbusFrame = slave.modbusRTUGenerator(functionCode, registerAddress, 1);
        } else {
            // Write operation
            modbusFrame = slave.modbusWriteRTUGenerator(functionCode, registerAddress, value);
        }

        const hexString = modbusFrame.map(b => b.toString(16).padStart(2, '0')).join('');

        const mqttPayload = JSON.stringify({
            slaveId,
            register: registerAddress,
            value: value || 0,
            modbusFrame: hexString,
            debug: true,
            timestamp: new Date().toISOString()
        });

        mqttClient.publish(LIGHT_CONTROL_CONFIG.MQTT_TOPIC, mqttPayload);

        res.json({
            message: 'ส่งคำสั่งทดสอบสำเร็จ',
            modbusFrame: hexString,
            payload: mqttPayload
        });

    } catch (error) {
        console.error('❌ Error in debug command:', error);
        res.status(500).json({ error: 'เกิดข้อผิดพลาดในการส่งคำสั่งทดสอบ' });
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
    created_by = 'civic_system',

    // ✅ เพิ่มค่า EC / pH ที่ส่งมา (อาจมีหรือไม่มีก็ได้)
   
  } = req.body;

  console.log('📥 รับข้อมูลแผนการปลูก:', req.body);
  
  if (!external_plan_id || !vegetable_type || !plant_date || !harvest_date || !plant_count) {
    return res.status(400).json({
      success: false,
      error: 'ข้อมูลไม่ครบถ้วน ต้องมี: external_plan_id, vegetable_type, plant_date, harvest_date, plant_count'
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // ✅ 1. บันทึกลง planting_plans
    const insertPlan = await client.query(
      `INSERT INTO planting_plans (
        plan_id, vegetable_type, plant_date, harvest_date, 
        plant_count, level_required, notes, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'received')
       RETURNING *`,
      [
        external_plan_id,
        vegetable_type,
        plant_date,
        harvest_date,
        plant_count,
        level_required || 1,
        notes || ''
      ]
    );

    const plan = insertPlan.rows[0];

    // ✅ 2. ถ้ามีค่า ec_value หรือ ph_value → บันทึกลง environment_logs
    if (ec_value !== null || ph_value !== null) {
      await client.query(
        `INSERT INTO environment_logs (
          plan_id, ec_value, ph_value, logged_at
        ) VALUES ($1, $2, $3, NOW())`,
        [external_plan_id, ec_value, ph_value]
      );
    }

    await client.query('COMMIT');

    console.log('✅ บันทึกแผนและสภาพแวดล้อมสำเร็จ:', plan);

    res.json({
      success: true,
      message: "บันทึกแผนการปลูกสำเร็จ",
      data: plan
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Error:', err.message);
    console.error('❌ Detail:', err.detail);
    console.error('❌ Code:', err.code);

    res.status(500).json({
      success: false,
      error: err.message,
      detail: err.detail,
      code: err.code
    });

  } finally {
    client.release();
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
    //  ดึงข้อมูล planting plan รวมฟิลด์ระบบน้ำและค่า EC, pH, water_close_date
    const planResult = await pool.query(`
      SELECT id, plan_id, vegetable_type, plant_date, harvest_date,
             plant_count, level_required, status, notes,
             water_system, ec_value, ph_value, water_close_date
      FROM planting_plans
      WHERE id = $1
    `, [planting_plan_id]);
    
    if (planResult.rows.length === 0) {
      return res.status(404).json({ error: 'ไม่พบแผนการปลูก' });
    }
    
    const plan = planResult.rows[0];
    const workOrderNumber = `WO-${new Date().getFullYear()}-${Date.now().toString().slice(-5)}`;

    // 🌊 คำนวณวันปิดน้ำอัตโนมัติ (2 วันก่อนเก็บเกี่ยว) สำหรับระบบน้ำเวียน
    let waterCloseDate = plan.water_close_date;
    if (!waterCloseDate && plan.harvest_date && (plan.water_system === 'circulating' || plan.water_system === 'circulation' || plan.water_system === 'น้ำเวียน')) {
      const harvestDate = new Date(plan.harvest_date);
      harvestDate.setDate(harvestDate.getDate() - 2); // ลบ 2 วัน
      waterCloseDate = harvestDate;
      console.log(`📅 คำนวณวันปิดน้ำอัตโนมัติ: ${waterCloseDate.toISOString().split('T')[0]} (2 วันก่อนเก็บเกี่ยว)`);
    }

    const result = await pool.query(`
      INSERT INTO work_orders (
        work_order_number, planting_plan_id, task_type, vegetable_type,
        plant_count, level, target_date, created_by, status,
        water_system, ec_value, ph_value, water_close_date
      ) VALUES ($1, $2, 'inbound', $3, $4, $5, $6, $7, 'pending', $8, $9, $10, $11)
      RETURNING *
    `, [
      workOrderNumber,
      planting_plan_id,
      plan.vegetable_type,
      plan.plant_count,
      plan.level_required,
      plan.plant_date,
      created_by || 'system',
      plan.water_system,
      plan.ec_value,
      plan.ph_value,
      waterCloseDate
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
          notes: plan.notes,
          planting_plan_id: planting_plan_id,
          //  🌊 เพิ่มข้อมูลระบบน้ำและค่า EC, pH, water_close_date (ที่คำนวณแล้ว)
          water_system: plan.water_system,
          ec_value: plan.ec_value,
          ph_value: plan.ph_value,
          water_close_date: waterCloseDate // ใช้ waterCloseDate ที่คำนวณแล้ว
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

    // 🌊 คำนวณวันปิดน้ำอัตโนมัติ (2 วันก่อนเก็บเกี่ยว) สำหรับระบบน้ำเวียน
    let waterCloseDate = plan.water_close_date;
    if (!waterCloseDate && plan.harvest_date && (plan.water_system === 'circulating' || plan.water_system === 'circulation' || plan.water_system === 'น้ำเวียน')) {
      const harvestDate = new Date(plan.harvest_date);
      harvestDate.setDate(harvestDate.getDate() - 2); // ลบ 2 วัน
      waterCloseDate = harvestDate;
      console.log(`📅 คำนวณวันปิดน้ำอัตโนมัติ (Outbound): ${waterCloseDate.toISOString().split('T')[0]} (2 วันก่อนเก็บเกี่ยว)`);
    }

    // สร้างใบงาน outbound
    const workOrderResult = await pool.query(`
      INSERT INTO work_orders (
        work_order_number, planting_plan_id, task_type, vegetable_type,
        level, plant_count, target_date, created_by, status, tray_id,
        current_floor, current_slot, created_at,
        water_system, ec_value, ph_value, water_close_date
      ) VALUES ($1, $2, 'outbound', $3, $4, $5, $6, $7, 'pending', $8, $9, $10, NOW(), $11, $12, $13, $14)
      RETURNING *
    `, [
      workOrderNumber, planId, plan.vegetable_type,
      plan.level_required, plan.plant_count, plan.harvest_date,
      created_by || 'system', tray.tray_id, tray.floor, tray.slot,
      plan.water_system, plan.ec_value, plan.ph_value, waterCloseDate
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
    const { status, task_type, station } = req.query;

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

    if (station) {
      params.push(parseInt(station));
      query += ` AND wo.station_id = $${params.length}`;
    }

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

    //   อัปเดตสถานะ Planting Plan เป็น 'in_progress' 
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
//  สรุปการเปลี่ยนแปลง API:
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
        pp.water_system,
        pp.water_close_date,
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
        ti.water_system as water_system,
        NULL as water_close_date,
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
    
    // ✅ ดึงข้อมูลถาดที่เกี่ยวข้องกับ plan นี้เท่านั้น
    const traysResult = await pool.query(`
      SELECT
        ti.*,
        to_char(ti.time_in, 'DD/MM/YYYY HH24:MI') as time_in_formatted,
        to_char(ti.seeding_date, 'DD/MM/YYYY') as seeding_date_formatted
      FROM tray_inventory ti
      WHERE ti.planting_plan_id = $1
      ORDER BY ti.tray_id
      LIMIT 50
    `, [plan.id]);
    
    // ✅ ดึง task history ที่เกี่ยวข้องกับ plan นี้เท่านั้น (ผ่าน tray_id และ work_order_id)
    const taskHistoryResult = await pool.query(`
      SELECT tm.*,
        to_char(tm.created_at, 'DD/MM/YYYY HH24:MI') as created_at_formatted
      FROM task_monitor tm
      WHERE tm.tray_id IN (
              SELECT ti.tray_id FROM tray_inventory ti WHERE ti.planting_plan_id = $1
            )
         OR tm.work_order_id IN (
              SELECT wo.id FROM work_orders wo WHERE wo.planting_plan_id = $1
            )
      ORDER BY tm.created_at DESC
      LIMIT 100
    `, [plan.id]);

    // ✅ ดึงข้อมูล work orders ที่เกี่ยวข้องกับ planting_plan นี้เท่านั้น
    const workOrdersResult = await pool.query(`
      SELECT
        wo.*,
        to_char(wo.target_date, 'DD/MM/YYYY') as target_date_formatted,
        to_char(wo.created_at, 'DD/MM/YYYY HH24:MI') as created_at_formatted
      FROM work_orders wo
      WHERE wo.planting_plan_id = $1
      ORDER BY wo.created_at DESC
      LIMIT 30
    `, [plan.id]); // ✅ ดึงเฉพาะ work orders ที่เชื่อมกับ plan นี้เท่านั้น

    // คำนวณสถิติจากข้อมูลจริง
    const directTrays = traysResult.rows.filter(tray => tray.planting_plan_id == plan.id);
    const directWorkOrders = workOrdersResult.rows;

    const stats = {
      total_trays: directTrays.length,
      total_plants: directTrays.reduce((sum, tray) => sum + (tray.plant_quantity || 0), 0) || plan.plant_count,
      work_orders_count: directWorkOrders.length,
      pending_work_orders: directWorkOrders.filter(wo => wo.status === 'pending').length,
      completed_work_orders: directWorkOrders.filter(wo => wo.status === 'completed').length,
      estimated_activity: taskHistoryResult.rows.filter(task =>
        task.plan_id === plan.plan_id ||
        taskHistoryResult.rows.some(t => directTrays.some(tray => tray.tray_id === t.tray_id))
      ).length
    };

    res.json({
      success: true,
      plan: plan,
      trays: directTrays, // ✅ ส่งเฉพาะถาดที่เชื่อมกับ plan นี้
      tray_inventory: directTrays, // alias สำหรับ compatibility
      work_orders: directWorkOrders, // ✅ ส่งเฉพาะ work orders ที่เชื่อมกับ plan นี้
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
    const stationId = req.query.station_id;
    const state = stationStates[stationId];
    
    // ดึงข้อมูลล่าสุดจาก State ที่ได้รับผ่าน MQTT
    const sensorData = state?.latestAgvSensorStatus || {};

    // ✅ ใช้ข้อมูลจริงจาก MQTT เท่านั้น - หากไม่มีข้อมูลแสดงว่าไม่ได้เชื่อมต่อ
    const hasRealData = Object.keys(sensorData).length > 0;
    
    if (hasRealData) {
      // ส่งข้อมูลจริงที่ได้รับจาก MQTT
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
        emergency_btn: sensorData.emergency_btn || false,
        _status: 'real_data',
        _last_update: new Date().toISOString()
      });
    } else {
      // ไม่มีข้อมูลจาก MQTT = อุปกรณ์ไม่ได้เชื่อมต่อ
      res.status(503).json({
        error: 'No sensor data available',
        message: 'AGV/RGV hardware not connected to MQTT broker',
        _status: 'no_hardware_connection',
        _last_checked: new Date().toISOString()
      });
    }

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
    const stationId = req.query.station_id;
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
// GET water system status (สำหรับ Overview)
app.get('/api/water/status', async (req, res) => {
  try {
    const { station } = req.query;

    // ดึงข้อมูลวาล์วทั้งหมด
    const valvesResult = await pool.query(`
      SELECT valve_id, status
      FROM water_valves
      ORDER BY floor_id, valve_id
    `);

    // ดึงสถานะระบบน้ำ
    const settingsResult = await pool.query(`
      SELECT is_active
      FROM water_system_settings
      ORDER BY id DESC LIMIT 1
    `);

    const isSystemActive = settingsResult.rows[0]?.is_active || false;
    const valves = valvesResult.rows.map(v => ({
      id: v.valve_id,
      status: v.status
    }));

    res.json({
      status: isSystemActive ? 'active' : 'idle',
      valves: valves,
      timestamp: new Date()
    });
  } catch (error) {
    console.error('❌ Error fetching water status:', error);
    res.status(500).json({ error: 'Failed to fetch water status' });
  }
});

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

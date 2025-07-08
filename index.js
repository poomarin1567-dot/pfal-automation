const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const pool = require('./db');
const path = require('path');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms)); // ✅ เพิ่มบรรทัดนี้
require('dotenv').config();

const mqtt = require('mqtt');  // ✅ เพิ่มบรรทัดนี้

// ✅ เชื่อมต่อกับ MQTT Server
const mqttClient = mqtt.connect("mqtt://automate.cat-smartgrow.com", {
  username: "test_01",
  password: "Test01!"
});




const app = express();
app.use(cors());
app.use(express.json());

// ✅ Serve frontend files
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
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



// ✅ REGISTER
app.post('/api/register', async (req, res) => {
  const { username, password, role } = req.body;
  console.log("\uD83D\uDCE8 register request", username, role);

  if (!username || !password || !role) {
    return res.status(400).json({ error: 'กรอกข้อมูลไม่ครบ' });
  }

  try {
    const check = await pool.query("SELECT * FROM users WHERE username = $1", [username]);
    if (check.rows.length > 0) {
      console.log("⚠️ Username already exists:", username);
      return res.status(409).json({ error: "Username นี้มีอยู่แล้ว" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const result = await pool.query(
      "INSERT INTO users (username, password_hash, role, created_at) VALUES ($1, $2, $3, NOW()) RETURNING *",
      [username, hashedPassword, role]
    );

    console.log("✅ Inserted user:", result.rows[0]);

    res.json({ message: "สมัครสมาชิกสำเร็จ", user: result.rows[0] });
  } catch (err) {
    console.error("❌ Register error:", err);
    res.status(500).json({ error: "เกิดข้อผิดพลาดที่เซิร์ฟเวอร์" });
  }
});


// ✅ LOGIN
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
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

// ✅ START SERVER
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server is running at http://0.0.0.0:${PORT}`);
});

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



async function simulateTrayInbound(veg, currentStation, floor, slot) {
  try {
    const res = await fetch("http://localhost:3000/api/tray/inbound", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: 1, // ✅ แก้เป็น user จริง
        veg_type: veg,
        station: currentStation,
        floor: parseInt(floor),
        slot: parseInt(slot)
      })
    });

    const result = await res.json();
    console.log("✅ Inbound Result:", result);
  } catch (err) {
    console.error("❌ Inbound Error:", err.message);
  }
}

async function simulateTrayOutbound(veg, currentStation, floor, slot) {
  try {
    const res = await fetch("http://localhost:3000/api/tray/outbound", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: 1,
        veg_type: veg,
        station: currentStation,
        floor: parseInt(floor),
        slot: parseInt(slot)
      })
    });

    const result = await res.json();
    console.log("✅ Outbound Result:", result);
  } catch (err) {
    console.error("❌ Outbound Error:", err.message);
  }
}

const stationStates = {
  1: {
    flowState: 'idle',
    latestLiftStatus: {},
    latestAgvStatus: {},
    trayActionDone: false,
    targetFloor: null,
    targetSlot: null,
    taskType: null // 'inbound' หรือ 'outbound'
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
});

// MQTT Message Handler (รวม Logic ของ Lift, AGV, และ Tray)
mqttClient.on('message', async (topic, message) => {
  const msg = message.toString();
  const stationId = 1; // รองรับสถานีเดียว (station 1) ในระบบปัจจุบัน
  const state = stationStates[stationId];
  if (!state) return; // ป้องกันข้อผิดพลาดหากไม่มี state

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

// ✅ GET Task History (เฉพาะงานที่จบสำเร็จ)
app.get('/api/task/history', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT tray_id, action_type, floor, slot, station_id, status, created_at, completed_at, username
      FROM task_monitor
      WHERE status = 'success'
      ORDER BY completed_at DESC
    `);
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
    console.error('❌ Stream socket error:', err);
    if (!res.headersSent) res.status(500).send('Proxy failed');
    else res.end();
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




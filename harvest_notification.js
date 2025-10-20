// ระบบแจ้งเตือนการเก็บเกี่ยว
const { Pool } = require('pg');

const pool = new Pool({
  host: '192.168.20.50',
  port: 5432,
  user: 'postgres',
  password: '123456',
  database: 'pfal'
});

// ฟังก์ชันเพิ่มใน API สำหรับตรวจสอบการเก็บก่อนกำหนด
async function validateHarvestDate(req, res, next) {
  try {
    const { tray_id, action_type, reason } = req.body;
    
    // ตรวจสอบเฉพาะการ outbound
    if (action_type === 'outbound' && tray_id) {
      const result = await pool.query(`
        SELECT 
          ti.tray_id,
          ti.veg_type,
          ti.time_in,
          pp.harvest_date,
          pp.plant_date,
          pp.plan_id,
          -- คำนวณจำนวนวันที่ผ่านมา
          EXTRACT(EPOCH FROM (NOW() - ti.time_in)) / 86400 as days_planted,
          -- คำนวณจำนวนวันก่อนกำหนดเก็บ
          EXTRACT(EPOCH FROM (pp.harvest_date - NOW())) / 86400 as days_before_harvest
        FROM tray_inventory ti
        LEFT JOIN planting_plans pp ON ti.planting_plan_id = pp.id
        WHERE ti.tray_id = $1
      `, [tray_id]);
      
      if (result.rows.length > 0) {
        const tray = result.rows[0];
        const daysBeforeHarvest = Math.floor(tray.days_before_harvest);
        const daysPlanted = Math.floor(tray.days_planted);
        
        // แจ้งเตือนถ้าเก็บก่อนกำหนดมากกว่า 2 วัน
        if (daysBeforeHarvest > 2) {
          return res.status(400).json({
            error: 'early_harvest_warning',
            message: `⚠️ แจ้งเตือน: การเก็บเกี่ยวก่อนกำหนด`,
            details: {
              tray_id: tray.tray_id,
              vegetable: tray.veg_type,
              plan_id: tray.plan_id,
              harvest_date: tray.harvest_date,
              days_planted: daysPlanted,
              days_before_harvest: daysBeforeHarvest,
              warning_message: `ถาด ${tray.tray_id} (${tray.veg_type}) ปลูกมา ${daysPlanted} วัน ยังไม่ถึงวันเก็บเกี่ยว (อีก ${daysBeforeHarvest} วัน)`
            },
            confirm_required: true
          });
        }
        
        // แจ้งเตือนถ้าเพิ่งปลูกไม่นาน (น้อยกว่า 7 วัน)
        if (daysPlanted < 7) {
          return res.status(400).json({
            error: 'too_early_harvest',
            message: `🚨 เตือน: เก็บเกี่ยวเร็วเกินไป`,
            details: {
              tray_id: tray.tray_id,
              vegetable: tray.veg_type,
              days_planted: daysPlanted,
              warning_message: `ถาด ${tray.tray_id} (${tray.veg_type}) เพิ่งปลูก ${daysPlanted} วัน ควรรอให้โตก่อน`
            },
            confirm_required: true
          });
        }
      }
    }
    
    next(); // ผ่านการตรวจสอบแล้ว
  } catch (err) {
    console.error('❌ Harvest validation error:', err.message);
    next(); // ให้ดำเนินการต่อแม้เกิดข้อผิดพลาด
  }
}

module.exports = {
  validateHarvestDate,
  pool
};